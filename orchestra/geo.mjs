// IP -> ISO country code, offline (DB-IP Lite, CC BY 4.0). The IP is never stored:
// callers keep only the two-letter code.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

let starts = new Uint32Array(0), ends = new Uint32Array(0), codes = new Uint16Array(0);
const table = [];          // index -> "TR"

export function loadGeo(path) {
  const text = gunzipSync(readFileSync(path)).toString("latin1");
  const rows = text.split("\n").length;
  starts = new Uint32Array(rows); ends = new Uint32Array(rows); codes = new Uint16Array(rows);
  const index = new Map();
  let n = 0, at = 0;
  while (at < text.length) {
    let stop = text.indexOf("\n", at);
    if (stop < 0) stop = text.length;
    const [a, b, cc] = text.slice(at, stop).split(",");
    at = stop + 1;
    const s = ipv4(a), e = ipv4(b);
    if (s === null || e === null || !/^[A-Z]{2}$/.test(cc || "")) continue;
    if (!index.has(cc)) { index.set(cc, table.length); table.push(cc); }
    starts[n] = s; ends[n] = e; codes[n] = index.get(cc); n++;
  }
  starts = starts.slice(0, n); ends = ends.slice(0, n); codes = codes.slice(0, n);
  return n;
}

export function ipv4(text) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(text || "").trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function country(ip) {
  const x = ipv4(ip);
  if (x === null) return null;
  let lo = 0, hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] > x) hi = mid - 1;
    else if (ends[mid] < x) lo = mid + 1;
    else return table[codes[mid]] === "ZZ" ? null : table[codes[mid]];
  }
  return null;
}
