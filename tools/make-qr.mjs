/* ==========================================================================
   Builds media/aisoc-qr.svg - the QR card in the shell's bottom-right corner.

   Only needs running again if the link or the logo changes:
     npm install --prefix tools qrcode
     node tools/make-qr.mjs

   Put the society logo at media/aisoc-logo.png (or .jpg / .svg) and it goes
   in the middle; without one the middle gets an "AI SOC" monogram.

   Why it still scans with a logo on top of it: error correction level H
   survives up to 30% of the code being wrong, the logo covers about 10% of it,
   and the three corner squares - which scanners use to find the code - are
   redrawn in the right proportions, never covered. Every colour is dark
   enough to count as black to a scanner, on a white card with a 3-module
   margin.
   ========================================================================== */
import QRCode from "qrcode";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LINK = "https://linktr.ee/AISoc";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "media", "aisoc-qr.svg");

// Purples, to match the logo. Every one has a relative luminance of 0.13 or
// less, so a scanner reads each as dark against the white card even when
// the code is small or out of focus.
const DEEP = "#4C1D95", PURPLE = "#6D28D9", ORCHID = "#86198F", FUCHSIA = "#A21CAF",
      INDIGO = "#4338CA", INK = "#1E1333";

const qr = QRCode.create(LINK, { errorCorrectionLevel: "H" });
const N = qr.modules.size;
const Q = 3;                                  // quiet margin around the code, in modules
const W = N + Q * 2;                          // card width
const H = W + 5;                              // plus a strip for the link text
const LOGO = 9;                              // centre cut-out in modules (odd, so centred)
const lo = (N - LOGO) / 2;

const n = v => +v.toFixed(3);
const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= N - 7) || (r >= N - 7 && c < 7);
const isLogo = (r, c) => r >= lo && r < lo + LOGO && c >= lo && c < lo + LOGO;
const on = (r, c) => r >= 0 && c >= 0 && r < N && c < N &&
  !!qr.modules.get(r, c) && !isFinder(r, c) && !isLogo(r, c);

// One data module. Corners facing empty space are rounded, so runs of modules
// read as smooth blobs; sides touching a neighbour overlap it very slightly so
// no hairline seam shows when the card is scaled down.
function modulePath(r, c) {
  const x = c + Q, y = r + Q, R = 0.5, e = 0.02;
  const up = on(r - 1, c), dn = on(r + 1, c), lf = on(r, c - 1), rt = on(r, c + 1);
  const x0 = x - (lf ? e : 0), x1 = x + 1 + (rt ? e : 0);
  const y0 = y - (up ? e : 0), y1 = y + 1 + (dn ? e : 0);
  const tl = !up && !lf ? R : 0, tr = !up && !rt ? R : 0;
  const br = !dn && !rt ? R : 0, bl = !dn && !lf ? R : 0;
  return `M${n(x0 + tl)} ${n(y0)}H${n(x1 - tr)}` +
    (tr ? `A${tr} ${tr} 0 0 1 ${n(x1)} ${n(y0 + tr)}` : "") + `V${n(y1 - br)}` +
    (br ? `A${br} ${br} 0 0 1 ${n(x1 - br)} ${n(y1)}` : "") + `H${n(x0 + bl)}` +
    (bl ? `A${bl} ${bl} 0 0 1 ${n(x0)} ${n(y1 - bl)}` : "") + `V${n(y0 + tl)}` +
    (tl ? `A${tl} ${tl} 0 0 1 ${n(x0 + tl)} ${n(y0)}` : "") + "Z";
}

function roundRect(x, y, w, h, r) {
  return `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${r} ${r} 0 0 1 ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}A${r} ${r} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${r} ${r} 0 0 1 ${n(x)} ${n(y + h - r)}V${n(y + r)}` +
    `A${r} ${r} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

// Corner square: a 7-module ring, a 1-module gap, a 3-module centre - the
// 1:1:3:1:1 proportions scanners look for, just with rounded corners.
function eye(r0, c0, colour) {
  const x = c0 + Q, y = r0 + Q;
  return `<path fill="${INK}" fill-rule="evenodd" d="${roundRect(x, y, 7, 7, 2.2)}${roundRect(x + 1, y + 1, 5, 5, 1.4)}"/>` +
    `<path fill="${colour}" d="${roundRect(x + 2, y + 2, 3, 3, 1)}"/>`;
}

const logoFile = ["png", "jpg", "jpeg", "svg"]
  .map(ext => join(ROOT, "media", "aisoc-logo." + ext)).find(existsSync);
const bs = LOGO - 0.8, bx = Q + lo + 0.4, mid = Q + N / 2;
const box = `x="${n(bx)}" y="${n(bx)}" width="${n(bs)}" height="${n(bs)}" rx="1.5"`;
let badge;
if (logoFile) {
  const ext = logoFile.split(".").pop().toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : "image/jpeg";
  const data = readFileSync(logoFile).toString("base64");
  badge = `<clipPath id="logo"><rect ${box}/></clipPath>` +
    `<rect ${box} fill="#fff" stroke="url(#ink)" stroke-width=".3"/>` +
    `<image href="data:${mime};base64,${data}" x="${n(bx + .45)}" y="${n(bx + .45)}" ` +
    `width="${n(bs - .9)}" height="${n(bs - .9)}" preserveAspectRatio="xMidYMid meet" clip-path="url(#logo)"/>`;
} else {
  badge = `<rect ${box} fill="url(#badge)"/>` +
    `<text x="${mid}" y="${n(mid + .55)}" text-anchor="middle" font-size="3.3" font-weight="900" fill="#fff" letter-spacing="-.12">AI</text>` +
    `<text x="${mid}" y="${n(mid + 1.85)}" text-anchor="middle" font-size="1.15" font-weight="800" fill="#fff" letter-spacing=".32">SOC</text>`;
}

const data = [];
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (on(r, c)) data.push(modulePath(r, c));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 10}" height="${H * 10}" font-family="'Helvetica Neue',Arial,sans-serif" role="img" aria-label="QR code for ${LINK}">
<defs>
<linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="${Q}" y1="${Q}" x2="${Q + N}" y2="${Q + N}"><stop offset="0" stop-color="${DEEP}"/><stop offset=".5" stop-color="${PURPLE}"/><stop offset="1" stop-color="${ORCHID}"/></linearGradient>
<linearGradient id="badge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PURPLE}"/><stop offset="1" stop-color="${FUCHSIA}"/></linearGradient>
<linearGradient id="cap" gradientUnits="userSpaceOnUse" x1="${n(W * .5)}" y1="0" x2="${n(W * .78)}" y2="0"><stop offset="0" stop-color="${PURPLE}"/><stop offset="1" stop-color="${FUCHSIA}"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" rx="4" fill="#fff"/>
<path fill="url(#ink)" d="${data.join("")}"/>
${eye(0, 0, PURPLE)}${eye(0, N - 7, FUCHSIA)}${eye(N - 7, 0, INDIGO)}
${badge}
<text x="${n(W / 2)}" y="${n(W + 2.1)}" text-anchor="middle" font-size="2.5" font-weight="800" letter-spacing=".05"><tspan fill="#8B7FA8">linktr.ee/</tspan><tspan fill="url(#cap)">AISoc</tspan></text>
</svg>
`;

writeFileSync(OUT, svg);
console.log(`wrote ${OUT}: version ${qr.version}, ${N}x${N} modules, ECC H, ` +
  (logoFile ? "logo " + logoFile : "monogram (no media/aisoc-logo.* found)"));
