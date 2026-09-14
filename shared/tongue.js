/* ==========================================================================
   Tongue detection + contour tracing.

   Detecting it and outlining it are two different jobs, so they use two
   different region rules:

     DECIDE  - only unambiguous ground: inside the mouth opening, and the
               chin strip below the lower lip. Lips are excluded entirely,
               because lips are also redder than skin and would fire the
               colour test on their own.
     OUTLINE - same mask, then largest connected blob, then a radial contour
               from that blob's centroid. A tongue is roughly star-convex
               from its middle, so casting rays outward gives an ordered,
               noise-tolerant outline that follows its real shape.

   Colour is always judged relative to THIS PERSON'S cheek skin, so it
   behaves the same across skin tones and under whatever lighting the hall has.
   ========================================================================== */

export const TONGUE = {
  rednessGain:  1.15,   // must be this much redder than their own cheek skin
  minSat:       0.18,
  minLumRatio:  0.30,   // brighter than this fraction of skin luminance (kills the dark cavity)
  minOpen:      0.09,   // inner-lip gap / mouth width. Below this the lips are shut and a
                        // tongue is IMPOSSIBLE - nothing is sampled at all.
  lipBrighter:  1.06,   // to pass through the lip band a pixel must be this much brighter
  lipPaler:     0.85,   // ...or this much less saturated than the sampled lip colour
  minArea:      0.10,   // region must cover this fraction of the opening's area
  minSeeds:     2,      // ...and contain at least this many seed cells from the opening
  maxParts:     1,      // one tongue
  rays:         56,     // contour resolution
  step:         2,      // pixel sampling step
};

export function sampleSkin(ctx, pts, idx, W, H) {
  let r = 0, g = 0, b = 0, n = 0;
  for (const i of idx) {
    const x = Math.round(pts[i].x * W), y = Math.round(pts[i].y * H);
    if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
    let d; try { d = ctx.getImageData(x - 1, y - 1, 3, 3).data; } catch (e) { continue; }
    for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; n++; }
  }
  if (!n) return null;
  r /= n; g /= n; b /= n;
  return { r, g, b, redness: r / (g + b + 1),
           lum: 0.299 * r + 0.587 * g + 0.114 * b };
}

// x-range of a polygon at a given scanline, or null if the line misses it
function spanAt(poly, y) {
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
      const t = Math.abs(b.y - a.y) < 1e-6 ? 0 : (y - a.y) / (b.y - a.y);
      const x = a.x + t * (b.x - a.x);
      lo = Math.min(lo, x); hi = Math.max(hi, x);
    }
  }
  return lo > hi ? null : [lo, hi];
}

// Every 4-connected blob in the mask, biggest first. Iterative flood fill -
// a recursive one blows the stack on a big mouth.
// Plural on purpose: the excluded lip band splits a protruding tongue into
// an in-mouth lobe and a chin lobe, and both are really tongue.
function findBlobs(mask, mw, mh) {
  const seen = new Uint8Array(mw * mh);
  const blobs = [];
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    stack.length = 0; stack.push(i); seen[i] = 1;
    const cells = [];
    while (stack.length) {
      const p = stack.pop();
      cells.push(p);
      const x = p % mw, y = (p / mw) | 0;
      if (x > 0      && mask[p - 1]  && !seen[p - 1])  { seen[p - 1] = 1;  stack.push(p - 1); }
      if (x < mw - 1 && mask[p + 1]  && !seen[p + 1])  { seen[p + 1] = 1;  stack.push(p + 1); }
      if (y > 0      && mask[p - mw] && !seen[p - mw]) { seen[p - mw] = 1; stack.push(p - mw); }
      if (y < mh - 1 && mask[p + mw] && !seen[p + mw]) { seen[p + mw] = 1; stack.push(p + mw); }
    }
    blobs.push(cells);
  }
  return blobs.sort((a, b) => b.length - a.length);
}

// Cast rays from the centroid; the last blob cell along each ray is the edge.
// Small gaps are tolerated so a highlight or a tooth shadow doesn't cut it short.
function radialContour(mask, mw, mh, cells, rays) {
  let cx = 0, cy = 0;
  for (const p of cells) { cx += p % mw; cy += (p / mw) | 0; }
  cx /= cells.length; cy /= cells.length;

  const at = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= mw || yi >= mh) return 0;
    return mask[yi * mw + xi];
  };

  const maxR = Math.hypot(mw, mh);
  const out = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    let last = 0, gap = 0;
    for (let r = 1; r < maxR; r++) {
      if (at(cx + dx * r, cy + dy * r)) { last = r; gap = 0; }
      else if (++gap > 2) break;
    }
    out.push({ x: cx + dx * last, y: cy + dy * last });
  }

  // circular moving average - takes the jaggedness off without losing shape
  const sm = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
    sm.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 });
  }
  return sm;
}

/**
 * @returns {null|{found, polys, apFrac, belFrac, box, debugPx}}
 *          polys are closed rings in canvas pixel coordinates, ready to stroke.
 */
/**
 * Seam-anchored tongue detection.
 *
 *   1. If the lips are not parted (inner gap < minOpen x mouth width), a
 *      tongue is impossible. Return at once. This alone removes the
 *      closed-lips false positive - there is nothing to confuse a lip with.
 *   2. Sample this person's cheek skin AND lower-lip colour.
 *   3. Pixels INSIDE the opening that look like tongue (relative to skin) are
 *      seeds. Region-grow from the seeds: through the lip band only where the
 *      pixel is brighter or paler than the lip (a tongue draped over the lip
 *      is; the lip itself is not), then down over the chin strip.
 *   4. The tongue is the largest grown region that contains enough seeds and
 *      enough area. Its outline is traced radially.
 *
 * Everything is relative to the person (skin, lip), so it behaves the same
 * across skin tones and lighting.
 */
export function detectTongue(ctx, pts, skin, rings, marks, W, H, wantDebug) {
  if (!skin) return null;
  const S = TONGUE.step;
  const P = i => ({ x: pts[i].x * W, y: pts[i].y * H });

  const inner = rings.lipsInner.map(P), outer = rings.lipsOuter.map(P);
  let oMinX = 1e9, oMaxX = -1e9, oMinY = 1e9, oMaxY = -1e9;
  for (const p of outer) { oMinX = Math.min(oMinX, p.x); oMaxX = Math.max(oMaxX, p.x);
                           oMinY = Math.min(oMinY, p.y); oMaxY = Math.max(oMaxY, p.y); }
  let iMinX = 1e9, iMaxX = -1e9, iMinY = 1e9, iMaxY = -1e9;
  for (const p of inner) { iMinX = Math.min(iMinX, p.x); iMaxX = Math.max(iMaxX, p.x);
                           iMinY = Math.min(iMinY, p.y); iMaxY = Math.max(iMaxY, p.y); }
  const outerW = oMaxX - oMinX, outerH = oMaxY - oMinY;
  const gap = (iMaxY - iMinY) / Math.max(outerW, 1);
  const mouthOpen = gap > TONGUE.minOpen;
  const base = { found: false, polys: [], mouthOpen, gap, apFrac: 0, belFrac: 0, seeds: 0, region: 0,
                 box: { x0: 0, y0: 0, x1: 0, y1: 0 }, debugPx: wantDebug ? [] : null, debugSeeds: wantDebug ? [] : null };
  if (!mouthOpen) return base;                                   // lips shut: impossible

  // Lip colour reference, sampled from the UPPER lip: midpoints between the
  // outer and inner upper-lip points (both rings run from the left corner
  // clockwise, so indices 12..18 are the upper lip). Not the lower lip - a
  // stuck-out tongue drapes over the lower lip, so sampling there would
  // measure the tongue and then reject it for looking like itself.
  let lr = 0, lg = 0, lb = 0, ln = 0;
  for (let k = 12; k <= 18; k++) {
    const x = Math.round((outer[k].x + inner[k].x) / 2), y = Math.round((outer[k].y + inner[k].y) / 2);
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
    let d; try { d = ctx.getImageData(x, y, 1, 1).data; } catch (e) { continue; }
    lr += d[0]; lg += d[1]; lb += d[2]; ln++;
  }
  const lip = ln ? { lum: (0.299 * lr + 0.587 * lg + 0.114 * lb) / ln,
                     sat: (() => { const r = lr / ln, g = lg / ln, b = lb / ln, mx = Math.max(r, g, b);
                                   return mx ? (mx - Math.min(r, g, b)) / mx : 0; })() }
                 : { lum: skin.lum * 0.8, sat: 0.4 };

  const chinY = pts[marks.chin].y * H;
  const stripBot = Math.min(chinY, oMaxY + (chinY - oMaxY) * 0.6);
  const pad = outerW * 0.10;
  const x0 = Math.max(0, Math.floor(oMinX - pad)), x1 = Math.min(W - 1, Math.ceil(oMaxX + pad));
  const y0 = Math.max(0, Math.floor(iMinY)), y1 = Math.min(H - 1, Math.ceil(stripBot));
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 10 || bh < 6) return base;

  let img; try { img = ctx.getImageData(x0, y0, bw, bh); } catch (e) { return null; }
  const d = img.data;
  const mw = Math.ceil(bw / S), mh = Math.ceil(bh / S);
  const mask = new Uint8Array(mw * mh);        // 1 = tongue-like and passable
  const seed = new Uint8Array(mw * mh);        // 1 = inside the opening (and tongue-like)

  const lumFloor = skin.lum * TONGUE.minLumRatio;
  const classify = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === 0) return 0;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < lumFloor) return 0;                              // cavity
    const sat = (mx - mn) / mx;
    if (!(r >= mx && sat > TONGUE.minSat && (r / (g + b + 1)) > skin.redness * TONGUE.rednessGain)) return 0;
    // 2 = also distinguishable from lip (brighter or paler); 1 = tongue-like only
    return (lum > lip.lum * TONGUE.lipBrighter || sat < lip.sat * TONGUE.lipPaler) ? 2 : 1;
  };

  let apN = 0, apHit = 0, belN = 0, belHit = 0, seedCount = 0;
  for (let my = 0; my < mh; my++) {
    const y = y0 + my * S; if (y > y1) break;
    const span = y <= iMaxY ? spanAt(inner, y) : null;
    // The lip band starts a couple of rows ABOVE the inner ring's lowest
    // point: that point is a narrow tip that samples no opening cells, and
    // without this the grown region could never bridge the one-row gap
    // between the opening and the lip - the tongue stopped at the seam.
    const inLipBand = y > iMaxY - 2 * S && y <= oMaxY;
    for (let mx = 0; mx < mw; mx++) {
      const x = x0 + mx * S; if (x > x1) break;
      const inOpening = !!span && x > span[0] + 1 && x < span[1] - 1;
      if (!inOpening && !inLipBand && y <= oMaxY) continue;    // upper lip / corners: never sampled
      const o = ((y - y0) * bw + (x - x0)) * 4;
      const c = classify(d[o], d[o + 1], d[o + 2]);
      const i = my * mw + mx;
      if (inOpening) { apN++; if (c) { apHit++; mask[i] = 1; seed[i] = 1; seedCount++;
                                       if (base.debugSeeds) base.debugSeeds.push({ x, y }); } }
      else if (inLipBand) { if (c === 2) mask[i] = 1; }        // lip band: only if it is NOT lip
      else { belN++; if (c === 2) { belHit++; mask[i] = 1; } }
      if (mask[i] && base.debugPx) base.debugPx.push({ x, y });
    }
  }
  base.apFrac = apN ? apHit / apN : 0; base.belFrac = belN ? belHit / belN : 0; base.seeds = seedCount;
  base.box = { x0, y0, x1, y1 };
  if (seedCount < TONGUE.minSeeds) return base;

  // grow: keep only components that contain seeds; pick the biggest
  const openingArea = Math.max(1, apN);
  let best = null, bestSeeds = 0;
  for (const blob of findBlobs(mask, mw, mh)) {
    let sc = 0; for (const c of blob) if (seed[c]) sc++;
    if (sc < TONGUE.minSeeds) continue;
    if (blob.length < TONGUE.minArea * openingArea) continue;
    if (!best || blob.length > best.length) { best = blob; bestSeeds = sc; }
  }
  if (!best) return base;

  let maxYm = 0; for (const c of best) maxYm = Math.max(maxYm, (c / mw) | 0);
  base.region = best.length; base.regionSeeds = bestSeeds;
  base.reachesBelowLip = y0 + maxYm * S > oMaxY;
  base.polys = [radialContour(mask, mw, mh, best, TONGUE.rays).map(p => ({ x: x0 + p.x * S, y: y0 + p.y * S }))];
  base.found = true;
  return base;
}
