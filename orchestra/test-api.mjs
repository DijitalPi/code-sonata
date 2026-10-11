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
async function streamHello(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers });
  const text = new TextDecoder().decode((await response.body.getReader().read()).value);
  controller.abort();
  return JSON.parse(text.slice(text.indexOf('data: ') + 6).split('\n')[0]);
}
const server = await start(port, { TRUST_PROXY: '1', ALLOW_SIMULATION: '1', EVENT_KEYS: EVENT_KEY, METRICS_KEY, PUBLIC_URL: 'https://orchestra.example.test' });
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
  await test('one address cannot exhaust pairing for everyone', async () => {
    const headers = { 'x-forwarded-for': '192.0.2.60' }, codes = [];
    for (let i = 0; i < 6; i++) codes.push((await post('/api/pair', {}, headers)).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
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
    } finally { prod.kill(); await once(prod, 'exit'); }
  });
  await test('an event link opens a shared venue network to the whole room', async () => {
    const venue = { 'x-forwarded-for': '192.0.2.90' }, controllers = [];
    try {
      for (let i = 0; i < 12; i++) {
        const controller = new AbortController(); controllers.push(controller);
        assert.equal((await fetch(`${base}/api/stream?event=${EVENT_KEY}`, { signal: controller.signal, headers: venue })).status, 200);
      }
      const machines = [];
      for (let i = 0; i < 15; i++) machines.push((await post('/api/play', { id: (i + 10).toString(16).padStart(32, 'e'), event: EVENT_KEY, steps: 1, working: true }, venue)).status);
      assert.deepEqual([...new Set(machines)], [200]);
      const pairs = [];
      for (let i = 0; i < 8; i++) pairs.push((await post('/api/pair', { event: EVENT_KEY }, venue)).status);
      assert.deepEqual([...new Set(pairs)], [201]);
      // A wrong key is no key: the ordinary per-address limits apply.
      const other = { 'x-forwarded-for': '192.0.2.91' };
      for (let i = 0; i < 8; i++) { const controller = new AbortController(); controllers.push(controller); await fetch(`${base}/api/stream?event=wrong-key-0123456789`, { signal: controller.signal, headers: other }); }
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
    const controller=new AbortController();
    const response=await fetch(base+'/api/stream?simulation=1',{signal:controller.signal});
    const data=new TextDecoder().decode((await response.body.getReader().read()).value); controller.abort();
    assert.ok(data.includes('"simulated":1')); assert.ok(data.includes('"simulatedListeners":1'));
  });
  await test('static preview metadata, headers, path isolation and SSE admission', async () => {
    const page = await fetch(base + '/'); const html = await page.text();
    assert.ok(html.includes('content="https://orchestra.example.test/og.png"')); assert.ok(html.includes('rel="canonical"'));
    assert.equal(page.headers.get('x-frame-options'),'DENY'); assert.equal(page.headers.get('x-content-type-options'),'nosniff');
    assert.equal((await fetch(base+'/%2e%2e/agents.py')).status,404);
    assert.equal((await fetch(base+'/og.png')).status,200);
    const controllers=[];
    try {
      for(let i=0;i<8;i++) { const controller=new AbortController();controllers.push(controller);assert.equal((await fetch(base+'/api/stream',{signal:controller.signal,headers:{'x-forwarded-for':'192.0.2.201'}})).status,200); }
      assert.equal((await fetch(base+'/api/stream',{headers:{'x-forwarded-for':'192.0.2.201'}})).status,429);
    } finally { controllers.forEach(c=>c.abort()); }
  });
  await test('fair play bounds activity total and request rate', async () => {
    const pair = (await post('/api/pair', {})).body.pair, headers = { 'x-forwarded-for': '192.0.2.100' };
    await post('/api/play', { id: 'f'.repeat(32), pair, steps: 200, activity: { edit: 200, read: 200 }, working: true }, headers);
    const me = await post('/api/me', { pair }); assert.equal(me.body.steps, 40); assert.equal(Object.values(me.body.activity).reduce((a,b) => a+b,0), 40);
    const responses = [];
    for (let i = 0; i < 12; i++) responses.push((await post('/api/me', { pair }, headers)).status);
    assert.ok(responses.includes(429));
  });
} finally { server.kill(); await once(server, 'exit'); }
