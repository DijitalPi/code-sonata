import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
const port = 4493, base = `http://127.0.0.1:${port}`;
const EVENT_KEY = 'event-test-key-0123456789', METRICS_KEY = 'metrics-test-key-0123456789';
// Test tools may label simulated machines only on a server that allows it (never in production).
async function start(port, env) {
  const child = spawn(process.execPath, ['orchestra/server.mjs'], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', x => { if (String(x).includes('Agent Orchestra')) resolve(); }); child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`))); });
  return child;
}
// First SSE message of a stream. The network may split it anywhere: read until it is complete.
async function streamHello(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '';
  while (!/(^|\n)data: [^\n]*\n\n/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  return JSON.parse(text.match(/(?:^|\n)data: ([^\n]*)\n\n/)[1]);
}
const server = await start(port, { TRUST_PROXY: '1', ALLOW_SIMULATION: '1', EVENT_KEYS: EVENT_KEY, METRICS_KEY, PUBLIC_URL: 'https://orchestra.example.test' });
// A machine asleep past the 30 s seat timeout, then back: on a server of its own, run alongside the other tests.
async function sleepAndReturn() {
  const p2 = port + 7, url = `http://127.0.0.1:${p2}`, child = await start(p2, { TRUST_PROXY: '1' });
  const play = async (id, from) => (await fetch(url + '/api/play', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify({ id, steps: 1, working: true }) })).json();
  const ids = ['a1', 'b2', 'c3', 'd4'].map((x) => x.repeat(16));
  try {
    const seats = [];
    for (const [i, id] of ids.slice(0, 3).entries()) seats.push((await play(id, `192.0.2.${170 + i}`)).section);
    const awake = setInterval(() => { play(ids[0], '192.0.2.170'); play(ids[1], '192.0.2.171'); }, 5000);
    try {
      await new Promise((r) => setTimeout(r, 32_000));               // the third machine sleeps; its seat expires
      const newcomer = (await play(ids[3], '192.0.2.173')).section;   // and a newcomer takes that empty section
      const back = (await play(ids[2], '192.0.2.172')).section;
      return { seats, newcomer, back };
    } finally { clearInterval(awake); }
  } finally { child.kill(); await once(child, 'exit'); }
}
const returning = sleepAndReturn();
let ip = 1;
async function post(path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${ip++}`, ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
try {
  await test('pair waiting, private activity, exclusive machine and unpair lifecycle', async () => {
    const created = await post('/api/pair', {}); assert.equal(created.status, 201); assert.match(created.body.pair, /^[a-f0-9]{48}$/);
    const pair = created.body.pair;
    let me = await post('/api/me', { pair }); assert.equal(me.body.waiting, true); assert.equal(me.body.steps, 0);
    const body = { id: 'a'.repeat(32), pair, steps: 5, working: true, sessions: 2, activity: { edit: 3, read: 2, prompt: 'must not be stored' }, tools: { codex: 2 } };
    const player = await post('/api/play', body, { 'x-forwarded-for': '192.0.2.80' }); assert.equal(player.status, 200);
    me = await post('/api/me', { pair }); assert.equal(me.body.connected, true); assert.equal(me.body.steps, 5); assert.equal(me.body.activity.edit, 3); assert.equal(me.body.activity.read, 2); assert.equal(me.body.activity.prompt, undefined); assert.equal(me.body.sessions, 2);
    const controller = new AbortController(); const response = await fetch(base + '/api/stream', { signal: controller.signal });
    const reader = response.body.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value); controller.abort();
    assert.equal(chunk.includes(pair), false); assert.equal(chunk.includes(body.id), false); assert.equal(chunk.includes('must not be stored'), false);
    // A used key never moves to another machine; that machine still plays, anonymously.
    const other = await post('/api/play', { ...body, id: 'b'.repeat(32) }); assert.equal(other.status, 200); assert.equal(other.body.pair, 'used');
    me = await post('/api/me', { pair }); assert.equal(me.body.steps, 5);
    assert.equal((await post('/api/play', body, { 'x-forwarded-for': '192.0.2.81' })).status, 429);
    assert.equal((await post('/api/unpair', { pair })).status, 200);
    assert.equal((await post('/api/me', { pair })).status, 404);
    // Unpairing ends the private view only: the machine keeps playing in the shared orchestra.
    const after = await post('/api/play', body, { 'x-forwarded-for': '192.0.2.80' }); assert.equal(after.status, 200); assert.equal(after.body.pair, 'expired');
  });
  await test('an office pairs everyone in it, one address cannot exhaust pairing for everyone', async () => {
    const headers = { 'x-forwarded-for': '192.0.2.60' }, codes = [];
    for (let i = 0; i < 33; i++) { if (i && i % 8 === 0) await new Promise((r) => setTimeout(r, 1100)); codes.push((await post('/api/pair', {}, headers)).status); }   // 8 page requests a second
    assert.deepEqual(codes, [...Array(32).fill(201), 429]);
  });
  await test('twelve pages on one address poll their own pairing without hitting a limit', async () => {
    const headers = { 'x-forwarded-for': '192.0.2.61' }, pairs = [];
    for (let i = 0; i < 12; i++) { if (i === 8) await new Promise((r) => setTimeout(r, 1100)); pairs.push((await post('/api/pair', {}, headers)).body.pair); }
    const codes = [];
    for (let round = 0; round < 4; round++) {   // every page polls once a round (the page itself: every 2 s)
      codes.push(...(await Promise.all(pairs.map((pair) => post('/api/me', { pair }, headers).then((r) => r.status)))));
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.deepEqual([...new Set(codes)], [200]);
  });
  await test('another site cannot make its visitors play, listen or count here', async () => {
    const id = '0b5e55ed'.padEnd(32, '0');
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }])
      assert.equal((await post('/api/play', { id, steps: 1, working: true }, headers)).status, 403, JSON.stringify(headers));
    assert.equal((await fetch(base + '/api/stream', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(base + '/api/metric', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{"name":"listen"}' })).status, 403);
    assert.equal((await post('/api/play', { id, steps: 1, working: true })).status, 200);   // the reader: JSON, no browser headers
  });
  await test('HEAD answers like GET, without a body', async () => {
    for (const path of ['/', '/api/health']) assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 200, path);
    const health = await (await fetch(base + '/api/health')).json();
    assert.ok(Math.abs(health.now - Date.now()) < 5000);
  });
  await test('an IPv6 subscriber counts as one address across its /64', async () => {
    const controllers = [], open = [];
    try {
      for (let i = 0; i < 32; i++) { const controller = new AbortController(); controllers.push(controller); const res = await fetch(base + '/api/stream', { signal: controller.signal, headers: { 'x-forwarded-for': `2001:db8:1:2::${(i + 1).toString(16)}` } }); open.push(res); assert.equal(res.status, 200); }
      assert.equal((await fetch(base + '/api/stream', { headers: { 'x-forwarded-for': '2001:db8:1:2:ffff:1:2:3' } })).status, 429);
      const other = new AbortController(); controllers.push(other);
      assert.equal((await fetch(base + '/api/stream', { signal: other.signal, headers: { 'x-forwarded-for': '2001:db8:1:3::1' } })).status, 200);
    } finally { controllers.forEach((c) => c.abort()); }
  });
  await test('a client cannot pick its country with a forged Cloudflare header', async () => {
    const hello = await streamHello(base + '/api/stream', { 'x-forwarded-for': '192.0.2.70', 'cf-ipcountry': 'TR' });
    assert.notEqual(hello.you.cc, 'TR');
  });
  await test('production ignores simulation labels; a Cloudflare deployment may trust its country header', async () => {
    const prodPort = 4496, prod = await start(prodPort, { TRUST_PROXY: '1', TRUST_CF: '1' });
    try {
      const hello = await streamHello(`http://127.0.0.1:${prodPort}/api/stream?simulation=1`, { 'x-forwarded-for': '192.0.2.71', 'cf-ipcountry': 'TR' });
      assert.equal(hello.simulatedListeners, 0);
      assert.equal(hello.you.cc, 'TR');
      const res = await fetch(`http://127.0.0.1:${prodPort}/api/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.72' }, body: JSON.stringify({ id: '9'.repeat(32), simulation: true, steps: 2 }) });
      assert.equal(res.status, 403);
      // Ten people from one country still make an orchestra: they spread over the sections.
      const sections = [];
      for (let i = 0; i < 10; i++) {
        const seat = await fetch(`http://127.0.0.1:${prodPort}/api/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}`, 'cf-ipcountry': 'TR' }, body: JSON.stringify({ id: (i + 10).toString(16).repeat(32).slice(0, 32), steps: 1, working: true }) });
        assert.equal(seat.status, 200); sections.push((await seat.json()).section);
      }
      assert.ok(new Set(sections).size >= 6, sections.join(','));
      assert.ok(sections.filter((s) => s === 'strings').length <= 3, sections.join(','));
      assert.equal(new Set(sections.slice(0, 9)).size, 9, sections.join(','));   // each newcomer a layer of its own first
    } finally { prod.kill(); await once(prod, 'exit'); }
  });
  await test('the hall plays loops; countries, teams and the league travel only when they change', async () => {
    const loopPort = 4498, hall = await start(loopPort, { TRUST_PROXY: '1' });
    const controller = new AbortController();
    try {
      const play = () => fetch(`http://127.0.0.1:${loopPort}/api/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.40' }, body: JSON.stringify({ id: 'c'.repeat(32), steps: 2, working: true }) });
      assert.equal((await play()).status, 200);
      const response = await fetch(`http://127.0.0.1:${loopPort}/api/stream`, { signal: controller.signal, headers: { 'x-forwarded-for': '198.51.100.41' } });
      const reader = response.body.getReader(), decoder = new TextDecoder(), frames = [];
      let text = '';
      const until = Date.now() + 3500;
      while (Date.now() < until) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (let i; (i = text.indexOf('\n\n')) >= 0; text = text.slice(i + 2)) { const line = text.slice(0, i).split('\n').find((l) => l.startsWith('data: ')); if (line) frames.push(JSON.parse(line.slice(6))); }
        if (frames.length % 4 === 0) await play();
      }
      const metas = frames.filter((f) => f.players !== undefined);
      assert.ok(metas.length >= 3, `${metas.length} meta frames`);
      assert.ok('countries' in metas[0] && 'league' in metas[0] && 'teams' in metas[0]);   // a new listener gets everything
      assert.ok(metas.slice(1).some((f) => !('countries' in f)), 'unchanged countries are not sent again');
      assert.match(metas.at(-1).song, /^Akış/);
      assert.equal(metas.at(-1).house, false);
      const notes = frames.flatMap((f) => f.notes || []);
      assert.ok(notes.some((n) => n[4] === 10), 'the loops have a beat');
      assert.ok(notes.every((n) => n[0] >= 0 && n[0] < 3000), 'note times are milliseconds after the frame');
    } finally { controller.abort(); hall.kill(); await once(hall, 'exit'); }
  });
  await test('an event link opens a shared venue network to the whole room', async () => {
    const venue = { 'x-forwarded-for': '192.0.2.90' }, controllers = [], open = [];   // responses kept: see the SSE admission test
    try {
      for (let i = 0; i < 12; i++) {
        const controller = new AbortController(); controllers.push(controller);
        const res = await fetch(`${base}/api/stream?event=${EVENT_KEY}`, { signal: controller.signal, headers: venue }); open.push(res);
        assert.equal(res.status, 200);
      }
      const machines = [];
      for (let i = 0; i < 15; i++) machines.push((await post('/api/play', { id: (i + 10).toString(16).padStart(32, 'e'), event: EVENT_KEY, steps: 1, working: true }, venue)).status);
      assert.deepEqual([...new Set(machines)], [200]);
      const pairs = [];
      for (let i = 0; i < 8; i++) pairs.push((await post('/api/pair', { event: EVENT_KEY }, venue)).status);
      assert.deepEqual([...new Set(pairs)], [201]);
      // A wrong key is no key: the ordinary per-address limits apply.
      const other = { 'x-forwarded-for': '192.0.2.91' };
      for (let i = 0; i < 32; i++) { const controller = new AbortController(); controllers.push(controller); open.push(await fetch(`${base}/api/stream?event=wrong-key-0123456789`, { signal: controller.signal, headers: other })); }
      assert.equal((await fetch(`${base}/api/stream?event=wrong-key-0123456789`, { headers: other })).status, 429);
    } finally { controllers.forEach(c => c.abort()); }
  });
  await test('daily counts without cookies or identities, readable only with the metrics key', async () => {
    const send = (name, from) => fetch(base + '/api/metric', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-forwarded-for': from }, body: JSON.stringify({ name }) });
    assert.equal((await send('listen', '192.0.2.110')).status, 204);
    assert.equal((await send('listen', '192.0.2.110')).status, 204);
    assert.equal((await send('listen', '192.0.2.111')).status, 204);
    assert.equal((await send('prompt', '192.0.2.112')).status, 400);
    assert.equal((await fetch(base + '/api/metrics')).status, 404);
    assert.equal((await fetch(base + '/api/metrics', { headers: { authorization: 'Bearer wrong' } })).status, 404);
    const read = await fetch(base + '/api/metrics', { headers: { authorization: `Bearer ${METRICS_KEY}` } });
    assert.equal(read.status, 200);
    const { days } = await read.json(), today = days[new Date().toISOString().slice(0, 10)];
    assert.deepEqual(today.listen, { count: 3, unique: 2 });
    assert.ok(today.machine.count > 0);   // new machines are counted by the server itself
    assert.equal(JSON.stringify(days).includes('192.0.2'), false);
  });
  await test('the page loads code and sound only from this site', async () => {
    const page = await fetch(base + '/');
    const csp = page.headers.get('content-security-policy') || '';
    for (const rule of ["default-src 'self'", "script-src 'self'", "connect-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(rule), rule);
    assert.equal(/https?:/.test(csp), false);
    const html = await page.text();
    assert.equal(html.includes('cdn.jsdelivr'), false);
    const engine = await fetch(base + '/vendor/smplr-1.1.0.mjs');
    assert.equal(engine.status, 200);
    assert.match(engine.headers.get('content-type'), /javascript/);
    assert.match(engine.headers.get('cache-control'), /immutable/);
  });
  await test('broken and oversized bodies still count against the address rate limit', async () => {
    const from = { 'x-forwarded-for': '192.0.2.120' };
    for (let i = 0; i < 9; i++) await fetch(base + '/api/metric', { method: 'POST', headers: from, body: '{not json' });
    assert.equal((await fetch(base + '/api/metric', { method: 'POST', headers: from, body: JSON.stringify({ name: 'visit' }) })).status, 429);
  });
  await test('a valid body near the size limit is judged by its bytes, not by how it was split', async () => {
    const head = '{"name":"visit","extra":"', tail = '"}';
    const emoji = '\u{1F600}'.repeat(200);                       // 800 bytes
    const body = head + emoji + 'a'.repeat(2046 - Buffer.byteLength(head + emoji + tail)) + tail;
    const bytes = Buffer.from(body), cut = Buffer.byteLength(head) + 2;   // inside the first emoji
    const status = await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.setNoDelay(true);
        socket.write(`POST /api/metric HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 192.0.2.121\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`);
        socket.write(bytes.subarray(0, cut));
        setTimeout(() => socket.write(bytes.subarray(cut)), 80);
      });
      let raw = ''; socket.on('data', d => raw += d); socket.on('end', () => resolve(Number(raw.split(' ')[1]))); socket.on('error', reject);
    });
    assert.equal(status, 204);
  });
  await test('malformed input cannot crash conductor or expose unsupported values', async () => {
    for (const body of [null, [], 3, 'x', {}]) assert.equal((await post('/api/play', body)).status, 400);
    const pair = (await post('/api/pair', {})).body.pair;
    assert.equal((await post('/api/play', { id: 'c'.repeat(32), pair, steps: 'Infinity', working: true, sessions: 'Infinity', tools: { claude: 'Infinity' } })).status, 200);
    const me = await post('/api/me', { pair }); assert.equal(me.body.steps, 0); assert.equal(me.body.sessions, 0);
    const unknown = await post('/api/play', { id: 'd'.repeat(32), pair: 'unknown' }); assert.equal(unknown.status, 200); assert.equal(unknown.body.pair, 'expired');
    assert.equal((await post('/api/pair', {}, { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post('/api/play', { id: 'e'.repeat(32), extra: 'ü'.repeat(1500) })).status, 413);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    const malformed = await new Promise((resolve,reject) => {
      const socket=connect(port,'127.0.0.1',()=>socket.write('GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      let raw=''; socket.setTimeout(3000,()=>socket.destroy(new Error('timeout')));
      socket.on('data',chunk=>raw+=chunk);socket.on('error',reject);socket.on('end',()=>resolve(raw));
    });
    assert.match(malformed,/HTTP\/1.1 400/);
    assert.equal((await fetch(base+'/api/health')).status,200);
  });
  await test('simulation is labelled and cannot create a personal contribution', async () => {
    const pair = (await post('/api/pair', {})).body.pair;
    const id = '1234567890abcdef1234567890abcdef';
    assert.equal((await post('/api/play', {id, simulation:true, pair, steps:3})).status, 403);
    assert.equal((await post('/api/play', {id, simulation:true, steps:3}, {'x-forwarded-for':'192.0.2.150'})).status, 200);
    assert.equal((await post('/api/play', {id, pair, steps:3}, {'x-forwarded-for':'192.0.2.150'})).status, 403);
    const hello = await streamHello(base + '/api/stream?simulation=1');
    assert.equal(hello.simulated, 1); assert.equal(hello.simulatedListeners, 1);
  });
  await test('static preview metadata, headers, path isolation and SSE admission', async () => {
    const page = await fetch(base + '/'); const html = await page.text();
    assert.ok(html.includes('content="https://orchestra.example.test/og.png"')); assert.ok(html.includes('rel="canonical"'));
    assert.equal(page.headers.get('x-frame-options'),'DENY'); assert.equal(page.headers.get('x-content-type-options'),'nosniff');
    assert.equal((await fetch(base+'/%2e%2e/agents.py')).status,404);
    assert.equal((await fetch(base+'/og.png')).status,200);
    // Keep every response: an unread fetch body that is garbage collected closes its stream (and frees its slot).
    const controllers=[], open=[];
    try {
      // An office of up to 32 listeners shares one address; the 33rd waits.
      for(let i=0;i<32;i++) { const controller=new AbortController();controllers.push(controller);const res=await fetch(base+'/api/stream',{signal:controller.signal,headers:{'x-forwarded-for':'192.0.2.201'}});open.push(res);assert.equal(res.status,200); }
      assert.equal((await fetch(base+'/api/stream',{headers:{'x-forwarded-for':'192.0.2.201'}})).status,429);
    } finally { controllers.forEach(c=>c.abort()); }
  });
  await test('an office of twelve machines on one address all play', async () => {
    const office = { 'x-forwarded-for': '192.0.2.220' };
    for (let round = 0; round < 3; round++) {
      const ids = Array.from({ length: 12 }, (_, i) => `0ff1ce${i.toString(16).padStart(2, '0')}`.padEnd(32, '0'));
      const statuses = await Promise.all(ids.map((id) => post('/api/play', { id, steps: 1, working: true }, office).then((r) => r.status)));
      assert.deepEqual(statuses, Array(12).fill(200), `round ${round}`);
    }
  });
  await test('the standalone reader is served as text from this site', async () => {
    const res = await fetch(base + '/reader.py');
    assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /^text\/plain/);
    const source = await res.text();
    assert.ok(source.includes('def main()') && source.includes('/api/play'));
    assert.equal(/^\s*(import|from)\s+(sonata|melodies|agents|conductor)\b/m.test(source), false);
  });
  await test('fair play bounds activity total and request rate', async () => {
    const pair = (await post('/api/pair', {})).body.pair, headers = { 'x-forwarded-for': '192.0.2.100' };
    await post('/api/play', { id: 'f'.repeat(32), pair, steps: 200, activity: { edit: 200, read: 200 }, working: true }, headers);
    const me = await post('/api/me', { pair }); assert.equal(me.body.steps, 40); assert.equal(Object.values(me.body.activity).reduce((a,b) => a+b,0), 40);
    const responses = [];
    for (let i = 0; i < 12; i++) responses.push((await post('/api/me', { pair }, headers)).status);
    assert.ok(responses.includes(429));
  });
  await test('seat holders come cleaned from SEATS_FILE, and their images only from SEATS_DIR', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'seats-'));
    const holder = { id: 'acme', ring: 0, col: 0, width: 2, depth: 2, name: 'Acme', link: 'https://acme.example/', image: '/seat-images/acme.webp' };
    await writeFile(join(dir, 'seats.json'), JSON.stringify({ seats: [holder, { ...holder, id: 'js', col: 9, link: 'javascript:alert(1)' }, { ...holder, id: 'far', col: 20, image: 'https://cdn.example/x.png' }] }));
    await writeFile(join(dir, 'acme.webp'), 'RIFF0000WEBP');
    const p = port + 8, url = `http://127.0.0.1:${p}`, child = await start(p, { SEATS_FILE: join(dir, 'seats.json'), SEATS_DIR: dir });
    try {
      assert.deepEqual((await (await fetch(url + '/api/seats')).json()).seats.map((s) => s.id), ['acme']);
      const image = await fetch(url + '/seat-images/acme.webp');
      assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/webp');
      assert.equal((await image.text()), 'RIFF0000WEBP');
      for (const path of ['/seat-images/seats.json', '/seat-images/..%2Fseats.json', '/seat-images/ACME.webp', '/seat-images/x.svg']) assert.equal((await fetch(url + path)).status, 404, path);
    } finally { child.kill(); await once(child, 'exit'); await rm(dir, { recursive: true }); }
    assert.deepEqual((await (await fetch(base + '/api/seats')).json()).seats, [], 'no SEATS_FILE: no holders');
    assert.equal((await fetch(base + '/seat-images/acme.webp')).status, 404, 'no SEATS_DIR: no images');
  });
  await test('a machine that slept past its seat comes back to its own instrument', async () => {
    const { seats, newcomer, back } = await returning;
    assert.deepEqual(seats, ['piano', 'accordion', 'strings']);
    assert.equal(newcomer, 'choir');            // the sleeper's empty section is kept while another one is empty
    assert.equal(back, 'strings');
  });
} finally { server.kill(); await once(server, 'exit'); }
