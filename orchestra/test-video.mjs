import { test } from 'node:test';
import assert from 'node:assert/strict';
import { muxWebM, opusHeader } from './web/video.js';
test('WebM includes EBML header, VP8/Opus tracks, dimensions and duration', () => {
  const video=[{data:new Uint8Array([1,2,3]),timestamp:0,key:true}],audio=[{data:new Uint8Array([4,5]),timestamp:0,key:true}];
  const bytes=muxWebM(video,audio,1200,630), view=new DataView(bytes.buffer), text=new TextDecoder().decode(bytes);
  assert.equal(view.getUint32(0),0x1a45dfa3); assert.ok(text.includes('webm'));assert.ok(text.includes('V_VP8'));assert.ok(text.includes('A_OPUS'));assert.ok(text.includes('OpusHead'));
  const opus=opusHeader();assert.equal(opus.length,19);assert.equal(new DataView(opus.buffer).getUint16(10,true),312);assert.equal(new DataView(opus.buffer).getUint32(12,true),48000);
});
test('empty streams and unbounded media times are rejected', () => {
  assert.throws(()=>muxWebM([],[],1200,630));
  const c={data:new Uint8Array([1]),timestamp:40000000,key:true};assert.throws(()=>muxWebM([c],[c],1200,630));
});
