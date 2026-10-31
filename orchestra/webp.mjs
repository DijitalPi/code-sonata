// The width and height a WebP file says it has, read from its first chunk, or null for anything else.
// Seat logos arrive as WebP made in the buyer's browser; the server has no image library, so it checks the header.
export function webpSize(data) {
  if (!(data instanceof Uint8Array) || data.length < 30) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  let width = 0, height = 0;
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1;
  } else return null;
  return width && height ? { width, height } : null;
}
