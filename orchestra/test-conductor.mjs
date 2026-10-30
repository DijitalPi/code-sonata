import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConductor, DRUMS } from './web/conductor.mjs';
import { startDemo, DEMO_MACHINES } from './web/demo.js';
import { readFile } from 'node:fs/promises';

// Drives a conductor for `ms` of virtual time in 25 ms ticks, as the server's timer does.
function run(conductor, ms, start = 1_700_000_000_000) {
  for (let t = start; t < start + ms; t += 25) conductor.tick(t, 25);
  return conductor.out.splice(0);
}
const busy = (sections) => () => ({ working: sections.reduce((a, b) => a + b, 0), total: 9, active: sections, listening: 1 });

test('a working orchestra plays bounded notes from the song grid', () => {
  const c = createConductor({ population: busy([1, 2, 1, 1, 1, 0, 1, 1, 1]) });
  for (let i = 0; i < 400; i++) c.steps += 3, c.tick(1_700_000_000_000 + i * 25, 25);
  const notes = c.out.splice(0);
  assert.ok(notes.length > 20);
  for (const [at, pitch, velocity, duration, voice] of notes) {
    assert.ok(Number.isFinite(at) && pitch >= 0 && pitch <= 127 && velocity >= 1 && velocity <= 120 && duration > 0);
    assert.ok(voice >= 0 && voice <= 11);
  }
});

test('with nobody working but someone listening, only the house pianist plays', () => {
  const c = createConductor({ population: () => ({ working: 0, total: 0, active: Array(9).fill(0), listening: 1 }) });
  const notes = run(c, 8000);
  assert.ok(notes.length > 5);
  assert.equal(c.house, true);
  assert.deepEqual([...new Set(notes.map((n) => n[4]))], [0]);
});

test('an empty hall is silent and the clock rests', () => {
  const c = createConductor({ population: () => ({ working: 0, total: 0, active: Array(9).fill(0), listening: 0 }) });
  assert.equal(run(c, 4000).length, 0);
  assert.equal(c.clock, 0);
});

test('the demo concert plays in the browser alone: labelled, local, never the server', async () => {
  const frames = [];
  const stop = startDemo({ onFrame: (f) => frames.push(f), tickMs: 25, frameMs: 250 });
  await new Promise((r) => setTimeout(r, 1600));
  stop();
  const count = frames.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(frames.length, count, 'stop() ends the demo');
  assert.ok(count >= 4);
  assert.ok(frames.every((f) => f.demo === true));
  assert.equal(frames[0].seats.flat().filter(Boolean).length, DEMO_MACHINES);
  assert.ok(frames.some((f) => f.notes.length));
  assert.ok(frames.some((f) => f.players === DEMO_MACHINES && f.countryCount > 5));
  assert.ok(frames.every((f) => f.notes.every((n) => n[4] === DRUMS || (n[1] >= 0 && n[1] <= 127))));
  const source = await readFile(new URL('./web/demo.js', import.meta.url), 'utf8');
  assert.equal(/fetch\(|EventSource|sendBeacon|XMLHttpRequest/.test(source), false);
});

test('flow plays loops: bounded notes, a beat, scenes; without the option a conductor plays songs', () => {
  const site = createConductor({ population: busy([1, 1, 0, 1, 0, 0, 0, 1, 0]) });
  assert.equal(site.flow, null);
  const c = createConductor({ population: busy([1, 1, 0, 1, 0, 0, 0, 1, 0]), flow: true, style: 'synthwave', leadMs: 150 });
  const notes = [];
  for (let i = 0; i < 6000; i++) { if (i % 40 === 0) c.steps += 1; c.tick(1_700_000_000_000 + i * 25, 25); notes.push(...c.out.splice(0)); }
  assert.ok(notes.length > 500);
  assert.ok(notes.some((n) => n[4] === DRUMS));
  assert.ok(notes.every(([at, p, v, d, voice]) => Number.isFinite(at) && p >= 0 && p <= 127 && v >= 1 && v <= 120 && d > 0 && d <= 10 && voice >= 0 && voice <= 11));
  assert.ok(c.flow.count >= 2, 'a second scene within two and a half minutes');
});

test('in an empty hall with listeners the loops go on as the house pianist: piano only, no beat', () => {
  const c = createConductor({ population: () => ({ working: 0, total: 0, active: Array(9).fill(0), listening: 1 }), flow: true });
  const notes = run(c, 20_000);
  assert.ok(notes.length > 20);
  assert.equal(c.house, true);
  assert.deepEqual([...new Set(notes.map((n) => n[4]))], [0]);
  assert.match(c.flowTitle(), /^Akış · /);
});
