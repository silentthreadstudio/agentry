// make-icons.mjs — renders the raster icons from the tape mark (public/favicon.svg).
// Run by hand when the mark changes: `node scripts/make-icons.mjs`. The outputs are committed
// static files, so the build and CI need no renderer. Needs `rsvg-convert` (librsvg) on PATH.
//
// Writes into public/:
//   icon-192.png, icon-512.png   the mark on its rounded paper tile (purpose "any")
//   icon-maskable-512.png        the bars on a full-bleed paper square, inside the 80% safe zone
//   apple-touch-icon.png (180)   full-bleed square; iOS applies its own corner mask
//   favicon.ico                  16, 32 and 48 px PNG frames in one ICO
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PAPER = "#EEF0F2";
// The three bars of the mark, in its 32-unit space (from favicon.svg).
const BARS = `<rect x="4" y="6" width="24" height="6" rx="2" fill="#FF7A3D"/>
<rect x="4" y="13" width="16" height="6" rx="2" fill="#5B3DF5"/>
<rect x="4" y="20" width="20" height="6" rx="2" fill="#2ED3A0"/>`;

/** Full-bleed paper square with the bars scaled by `scale` about the centre. */
function square(size, scale) {
  const t = (16 * (1 - scale)).toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
<rect width="32" height="32" fill="${PAPER}"/>
<g transform="translate(${t} ${t}) scale(${scale})">${BARS}</g>
</svg>`;
}

function render(svg, size) {
  return execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size)], { input: svg });
}

const tile = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");
const out = (name, buf) => writeFileSync(join(PUBLIC, name), buf);

out("icon-192.png", render(tile, 192));
out("icon-512.png", render(tile, 512));
// Maskable: content half-diagonal 15.6 units; scale 0.9 keeps it inside the 40% radius circle.
out("icon-maskable-512.png", render(square(512, 0.9), 512));
out("apple-touch-icon.png", render(square(180, 1.05), 180));

// ICO: a 6-byte header, one 16-byte directory entry per frame, then the PNG frames.
const sizes = [16, 32, 48];
const frames = sizes.map((s) => render(tile, s));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0);
  e.writeUInt8(s, 1);
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(frames[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += frames[i].length;
  return e;
});
out("favicon.ico", Buffer.concat([header, ...entries, ...frames]));
console.log("[icons] wrote icon-192, icon-512, icon-maskable-512, apple-touch-icon, favicon.ico");
