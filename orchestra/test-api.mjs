import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
const port = 4493, base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['orchestra/server.mjs'], { env: { ...process.env, PORT: String(port), TRUST_PROXY: '1', PUBLIC_URL:'https://orchestra.example.test' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { server.stdout.on('data', x => { if (String(x).includes('Agent Orchestra')) resolve(); }); server.once('error', reject); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
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
