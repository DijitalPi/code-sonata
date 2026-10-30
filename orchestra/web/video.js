// Offline WebCodecs + a small, bounded WebM muxer. No recording clock or server upload.
// Primary references: w3.org/TR/webcodecs/ and matroska.org/technical/codec_specs.html
const utf8 = text => new TextEncoder().encode(text);
const join = parts => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.byteLength; } return out;
};
function integer(value, length) {
  let number = BigInt(value);
  if (!length) { length = 1; while (number >= 1n << BigInt(length * 8)) length++; }
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(number & 255n); number >>= 8n; } return out;
}
function size(value) {
  let length = 1; while (BigInt(value) >= (1n << BigInt(7 * length)) - 1n) length++;
  return integer(BigInt(value) | 1n << BigInt(7 * length), length);
}
const element = (id, data) => join([integer(id), size(data.byteLength), data]);
const uint = (id, value) => element(id, integer(value));
const text = (id, value) => element(id, utf8(value));
const master = (id, parts) => element(id, join(parts));
const float = (id, value) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value); return element(id, bytes); };
export function opusHeader(preSkip = 312) {
  const bytes = new Uint8Array(19); bytes.set(utf8('OpusHead')); bytes[8] = 1; bytes[9] = 1;
  const view = new DataView(bytes.buffer); view.setUint16(10, preSkip, true); view.setUint32(12, 48000, true); return bytes;
}
export function muxWebM(video, audio, width, height, description = opusHeader(), seconds = 12) {
  if (!video.length || !audio.length) throw new Error('Ses veya video kareleri kodlanamadı. WAV ve PNG kullan.');
  const header = master(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)]);
  const info = master(0x1549a966, [uint(0x2ad7b1, 1000000), float(0x4489, seconds * 1000), text(0x4d80, 'Agent Orchestra'), text(0x5741, 'Agent Orchestra')]);
  const preSkip = description.length >= 12 ? new DataView(description.buffer, description.byteOffset, description.byteLength).getUint16(10, true) : 312;
  const tracks = master(0x1654ae6b, [
    master(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), text(0x86, 'V_VP8'), uint(0x23e383, 100000000), master(0xe0, [uint(0xb0, width), uint(0xba, height)])]),
    master(0xae, [uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), text(0x86, 'A_OPUS'), element(0x63a2, description), uint(0x56aa, Math.round(preSkip / 48000 * 1e9)), uint(0x56bb, 80000000), master(0xe1, [float(0xb5, 48000), uint(0x9f, 1)])]),
  ]);
  const chunks = [...video.map(c => ({ ...c, track: 1 })), ...audio.map(c => ({ ...c, track: 2 }))].sort((a,b) => a.timestamp - b.timestamp);
  const blocks = chunks.map(chunk => {
    const time = Math.max(0, Math.round(chunk.timestamp / 1000));
    if (time > 32767) throw new Error('An süresi bu video biçimi için fazla uzun.');
    const block = new Uint8Array(4 + chunk.data.length); block[0] = 0x80 | chunk.track;
    new DataView(block.buffer).setInt16(1, time); block[3] = chunk.key ? 0x80 : 0; block.set(chunk.data, 4);
    return element(0xa3, block);
  });
  return join([header, master(0x18538067, [info, tracks, master(0x1f43b675, [uint(0xe7, 0), ...blocks])])]);
}
export async function encodeVideo(canvas, wav, signal, progress = () => {}) {
  const videoConfig = { codec: 'vp8', width: canvas.width, height: canvas.height, bitrate: 800000, framerate: 10, latencyMode: 'quality' };
  const audioConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 };
  if (!(await VideoEncoder.isConfigSupported(videoConfig)).supported || !(await AudioEncoder.isConfigSupported(audioConfig)).supported) throw new Error('Bu cihaz video kodlamayı desteklemiyor. WAV ve PNG dosyalarını kullan.');
  const video = [], audio = []; let description = opusHeader(), failure = null;
  const capture = destination => chunk => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); destination.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' }); };
  const videoEncoder = new VideoEncoder({ output: capture(video), error: error => { failure = error; } });
  const audioEncoder = new AudioEncoder({ output(chunk, metadata) {
    capture(audio)(chunk);
    const d = metadata?.decoderConfig?.description;
    if (d) description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
  }, error: error => { failure = error; } });
  const check = () => { if (signal.aborted) throw new DOMException('İptal edildi', 'AbortError'); if (failure) throw failure; };
  const view = new DataView(wav), channels = view.getUint16(22, true), rate = view.getUint32(24, true), frames = view.getUint32(40, true) / (2 * channels);
  const sample = (index) => { let sum = 0; for (let ch = 0; ch < channels; ch++) sum += view.getInt16(44 + (index * channels + ch) * 2, true); return sum / channels / 32768; };   // stereo is mixed to mono
  try {
    videoEncoder.configure(videoConfig); audioEncoder.configure(audioConfig);
    for (let i = 0; i < 120; i++) {
      check(); const frame = new VideoFrame(canvas, { timestamp: i * 100000, duration: 100000 });
      videoEncoder.encode(frame, { keyFrame: i % 30 === 0 }); frame.close();
      if (i % 10 === 9) { await videoEncoder.flush(); progress(Math.round((i + 1) / 240 * 100)); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    for (let i = 0; i < 600; i++) {
      check(); const samples = new Float32Array(960);
      for (let j = 0; j < 960; j++) {
        const position = (i * 960 + j) * rate / 48000, index = Math.floor(position), fraction = position - index;
        const first = index < frames ? sample(index) : 0;
        const next = index + 1 < frames ? sample(index + 1) : first;
        samples[j] = first + (next - first) * fraction;
      }
      const data = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: i * 20000, data: samples });
      audioEncoder.encode(data); data.close();
      // Flush once at the end: an Opus flush inserts padding and would overlap subsequent timestamps.
      if (i % 50 === 49) { progress(50 + Math.round((i + 1) / 600 * 50)); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    await videoEncoder.flush(); await audioEncoder.flush(); check();
    return new Blob([muxWebM(video, audio, canvas.width, canvas.height, description)], { type: 'video/webm' });
  } finally { if (videoEncoder.state !== 'closed') videoEncoder.close(); if (audioEncoder.state !== 'closed') audioEncoder.close(); }
}
