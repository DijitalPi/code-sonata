import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN, TIERS, seat, tierOf, validBlock, blockPrice, blockSeats, taken, canPlace, blockArc, seatAt, noteAngle, litBlocks, cleanSeats, cleanHolder, SEAT_LIMITS } from './web/seats.mjs';

test('the amphitheatre holds about ten thousand seats, each with one id', () => {
  assert.ok(PLAN.count >= 9500 && PLAN.count <= 10500, `count ${PLAN.count}`);
  const ids = new Set();
  for (const ring of PLAN.rings) for (let c = 0; c < ring.cols; c++) ids.add(seat(ring.k, c).id);
  assert.equal(ids.size, PLAN.count);
  assert.equal(TIERS.reduce((sum, t) => sum + t.seats, 0), PLAN.count);
});

test('seats sit outside the orchestra, inside the hall, and never on top of each other', () => {
  const inner = PLAN.rings[0], outer = PLAN.rings.at(-1);
  assert.ok(inner.r - PLAN.pitch / 2 > 1.05, 'first row clears the stage edge (1.05)');
  assert.ok(outer.r + PLAN.pitch / 2 <= PLAN.outer + 1e-9);
  for (const ring of PLAN.rings) {
    const width = Math.PI * ring.r / ring.cols;          // arc length of one seat
    assert.ok(width > PLAN.pitch * .8 && width < PLAN.pitch * 1.25, `ring ${ring.k} seat width ${width}`);
    const first = seat(ring.k, 0), last = seat(ring.k, ring.cols - 1);
    assert.ok(first.a > -90 && last.a < 90);
  }
});

test('a seat keeps its id and place whatever the screen: the plan has no screen size in it', async () => {
  const again = await import('./web/seats.mjs?again');
  assert.deepEqual(again.seat(7, 120), seat(7, 120));
  assert.equal(seat(0, 0).id, 'r0c0');
});

test('front rows cost most, back rows least, and a block is priced by its own tier', () => {
  assert.deepEqual(TIERS.map(t => t.price), [25, 10, 3]);
  assert.equal(tierOf(0).price, 25);
  assert.equal(tierOf(PLAN.rings.length - 1).price, 3);
  const front = { ring: 0, col: 10, width: 4, depth: 2 };
  assert.ok(validBlock(front));
  assert.equal(blockPrice(front), 4 * 2 * 25);
  assert.equal(blockSeats(front).length, 8);
  const back = { ring: PLAN.rings.length - 3, col: 0, width: 2, depth: 3 };
  assert.equal(blockPrice(back), 2 * 3 * 3);
});

test('a block never crosses a tier, the hall edge, or the size limit', () => {
  const lastFront = TIERS[0].rings[1];                    // last ring index of the front tier
  assert.equal(validBlock({ ring: lastFront, col: 0, width: 1, depth: 2 }), false, 'crosses into the middle tier');
  assert.equal(validBlock({ ring: 0, col: PLAN.rings[0].cols - 2, width: 3, depth: 1 }), false, 'past the right edge');
  assert.equal(validBlock({ ring: 0, col: -1, width: 1, depth: 1 }), false);
  assert.equal(validBlock({ ring: 0, col: 0, width: SEAT_LIMITS.width + 1, depth: 1 }), false);
  assert.equal(validBlock({ ring: 0, col: 0, width: 1, depth: SEAT_LIMITS.depth + 1 }), false);
  assert.equal(validBlock({ ring: 0, col: 1.5, width: 1, depth: 1 }), false);
  assert.equal(validBlock({ ring: '0', col: 0, width: 1, depth: 1 }), false);
});

test('a new block cannot sit on a sold seat', () => {
  const sold = [{ ring: 2, col: 50, width: 3, depth: 2 }];
  const used = taken(sold);
  assert.equal(used.size, 6);
  assert.equal(canPlace({ ring: 3, col: 52, width: 2, depth: 1 }, used), false);
  assert.equal(canPlace({ ring: 2, col: 53, width: 2, depth: 2 }, used), true);
  assert.equal(canPlace({ ring: 7, col: 0, width: 1, depth: 2 }, used), false, 'invalid blocks are never placeable');
});

test('a point on screen finds its seat, and a block covers the arc of its seats', () => {
  const s = seat(10, 77);
  assert.deepEqual(seatAt(s.r, s.a), { k: 10, c: 77 });
  assert.equal(seatAt(1.0, 0), null, 'inside the orchestra');
  assert.equal(seatAt(PLAN.outer + .1, 0), null, 'outside the hall');
  const arc = blockArc({ ring: 10, col: 77, width: 3, depth: 2 });
  assert.ok(arc.a1 < s.a && arc.a2 > seat(10, 79).a);
  assert.ok(arc.r1 < s.r && arc.r2 > seat(11, 77).r);
});

test('notes light the blocks in their direction, low notes left and high notes right', () => {
  assert.equal(noteAngle(36), -90);
  assert.equal(noteAngle(96), 90);
  assert.equal(noteAngle(10), -90);
  assert.ok(Math.abs(noteAngle(66)) < 1e-9);
  const left = { ring: 0, col: 0, width: 4, depth: 1 }, right = { ring: 0, col: PLAN.rings[0].cols - 4, width: 4, depth: 1 };
  assert.deepEqual(litBlocks([left, right], noteAngle(37)), [left]);
  assert.deepEqual(litBlocks([left, right], noteAngle(95)), [right]);
  assert.deepEqual(litBlocks([left, right], 0), []);
});

test('only well-formed holders with a local image and an http link are shown', () => {
  const good = { id: 'acme', ring: 0, col: 0, width: 2, depth: 2, name: '  Acme Studio ', link: 'https://acme.example/', image: '/seat-images/acme.webp' };
  const out = cleanSeats({ seats: [
    good,
    { ...good, id: 'twin' },                                                        // sits on Acme: first one wins
    { ...good, id: 'js', col: 10, link: 'javascript:alert(1)' },
    { ...good, id: 'remote', col: 20, image: 'https://cdn.example/logo.png' },
    { ...good, id: 'long', col: 30, name: 'x'.repeat(41) },
    { ...good, id: 'BAD ID', col: 40 },
    { ...good, id: 'cross', ring: TIERS[0].rings[1], col: 50 },
    { ...good, id: 'plain', col: 60, image: undefined, link: 'http://plain.example' },
    null, 3, 'x',
  ] });
  assert.deepEqual(out.map(s => s.id), ['acme', 'plain']);
  assert.equal(out[0].name, 'Acme Studio');
  assert.equal(out[1].image, null);
  assert.deepEqual(cleanSeats(null), []);
  assert.deepEqual(cleanSeats({ seats: 'no' }), []);
});

test('a holder is a trimmed name of up to 40 characters and an http or https link', () => {
  assert.deepEqual(cleanHolder({ name: '  Acme ', link: 'https://a.example' }), { name: 'Acme', link: 'https://a.example/' });
  for (const bad of [{ name: ' ', link: 'https://a.example' }, { name: 'x'.repeat(41), link: 'https://a.example' },
    { name: 'A', link: 'javascript:alert(1)' }, { name: 'A', link: `https://a.example/${'x'.repeat(290)}` }, { name: 'A', link: 3 },
    { name: 7, link: 'https://a.example' }, null]) assert.equal(cleanHolder(bad), null, JSON.stringify(bad));
});

test('the hall keeps the blocks someone is paying for, well-formed ones only', async () => {
  const { createAmfi } = await import('./web/amfi.js');
  const hall = createAmfi(), b = { ring: TIERS[0].rings[0], col: 4, width: 2, depth: 1 };
  assert.deepEqual(hall.reserved(), []);
  hall.setReserved([b, { ring: -1, col: 0, width: 1, depth: 1 }, null]);
  assert.deepEqual(hall.reserved(), [b]);
});
