// Instrument samples for the rich sound, served from this site instead of a third party at
// listening time. Downloads each file named in sounds.json once, checks its SHA-256 and stops on
// any mismatch, so a changed upstream file can never reach listeners. Safe to run again.
//
//   node orchestra/fetch-sounds.mjs            fetch missing files into orchestra/web/sounds/
//   node orchestra/fetch-sounds.mjs --check    exit 1 if a file is missing or different
//
// Samples: FluidR3 GM (Frank Wen), rendered by gleitz/midi-js-soundfonts, CC BY 3.0.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(HERE, "sounds.json"), "utf8"));
const check = process.argv.includes("--check");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let problems = 0;
for (const { path, sha256: expected } of manifest.files) {
  const target = join(HERE, "web", path);
  const have = await readFile(target).catch(() => null);
  if (have && sha256(have) === expected) continue;
  if (check) { console.log(`${have ? "different" : "missing"}: ${path}`); problems++; continue; }
  const response = await fetch(manifest.source + path.slice(manifest.prefix.length));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${path}: checksum mismatch, refusing to use it`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  console.log(`fetched ${path} (${(bytes.length / 1048576).toFixed(1)} MB)`);
}
if (problems) process.exit(1);
console.log(check ? "sounds: all present and verified" : "sounds: ready");
