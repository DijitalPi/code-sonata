import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalNotes, liveNotes, deltaActivity, wavBytes, publicInvite } from './web/moment.js';
import { SONGS, PLANS, METERS } from './music.mjs';
test('personal output requires activity and has bounded harmonious notes', () => {
  assert.deepEqual(personalNotes({}), []);
  const notes = personalNotes({ edit: 300, bash: 300, read: 300, think: 300, done: 300 });
  assert.equal(notes.length, 60); assert.ok(notes.at(-1)[0] < 12000);
  assert.ok(notes.every(n => [0, 4, 7, 9].includes(n[1] % 12)));
  assert.deepEqual(deltaActivity({ edit: 5, read: 2 }, { edit: 3, read: 9 }), { edit: 2, bash: 0, read: 0, think: 0, done: 0 });
});
test('WAV is valid mono PCM, audible and never clips under dense mix', () => {
  const bytes = wavBytes(Array.from({ length: 400 }, () => [0, 69, 127, 3, 0]));
  const view = new DataView(bytes); assert.equal(new TextDecoder().decode(bytes.slice(0,4)), 'RIFF'); assert.equal(view.getUint32(24,true), 22050); assert.equal(view.getUint32(40,true), 12*22050*2);
  let peak = 0; for(let i=44;i<bytes.byteLength;i+=2) peak=Math.max(peak,Math.abs(view.getInt16(i,true))); assert.ok(peak > 1000 && peak < 27000);
});
test('invite removes secrets and unrelated query data', () => {
  assert.equal(publicInvite('http://localhost:4480/?secret=hidden#pair=private'), 'http://localhost:4480/?from=invite');
});
test('every song plan covers notes and ends on complete bars', () => {
  for (const [song, notes] of Object.entries(SONGS)) {
    assert.equal(PLANS[song].length, notes.length, song);
    const total = notes.reduce((sum,n) => sum+n[1],0), [meter,pickup] = METERS[song];
    // Pickup is balanced by a shortened closing bar before the repeated pickup.
    assert.equal(total % meter, 0, song);
    assert.ok(pickup >= 0 && pickup < meter, song);
    assert.ok(notes.every(n => n[1] > 0 && (n[0] === null || n[0] >= 0 && n[0] <= 127)), song);
  }
});

test('live motifs fit inside a polling interval and represent every active kind', () => {
 const notes = liveNotes({edit:40,bash:40,read:40,think:40,done:40});
 assert.equal(notes.length,10); assert.ok(Math.max(...notes.map(n=>n[0]+n[3]*1000)) < 2000);
 assert.deepEqual(liveNotes({}),[]);
});
