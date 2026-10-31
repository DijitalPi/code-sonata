import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, add } from './fake-dom.mjs';

// The seat panel and the hall, as far as buy.js reaches into them.
const doc = install();
const panel = add(doc.body, 'aside', { id: 'panel' });
for (const id of ['seats-title', 'seat-tiers', 'seat-price', 'seat-count', 'seat-place', 'seat-status', 'seat-form', 'seat-image',
  'seat-name', 'seat-link', 'seat-preview', 'seat-pay', 'seat-again', 'seat-pay-status', 'holders', 'holders-lead']) add(panel, 'div', { id });
add(panel, 'input', { id: 'seat-width' }).value = '3';
add(panel, 'input', { id: 'seat-depth' }).value = '2';
const canvas = add(add(doc.body, 'main', { class: 'stage' }), 'canvas', { id: 'hall' });
const ghosts = [];
const amfi = { holders: () => [], setGhost: (ghost) => ghosts.push(ghost), hit: () => null };
const { setupBuying } = await import('./web/buy.js');
setupBuying({ canvas, geometry: () => ({}), amfi });

const view = (name) => dispatchEvent(new CustomEvent('view', { detail: name }));
const key = (name) => dispatchEvent(Object.assign(new Event('keydown'), { key: name }));

test('going to another view while placing a block ends the placing', () => {
  view('seats');
  doc.getElementById('seat-place').onclick();
  assert.ok(doc.body.classList.contains('is-placing'));
  const status = doc.getElementById('seat-status').textContent;
  view('home');
  assert.ok(!doc.body.classList.contains('is-placing'), 'the hall is no longer in placing mode');
  assert.ok(doc.querySelector('.place-bar').hidden, 'the placing bar is gone');
  assert.equal(ghosts.at(-1), null, 'no block is left drawn in the hall');
  key('Enter');
  assert.equal(doc.getElementById('seat-status').textContent, status, 'Enter no longer picks a place behind the new view');
});
