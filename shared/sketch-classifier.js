/* ==========================================================================
   Sketch recogniser - $P point-cloud matcher over REAL human drawings.

   Templates come from three places, all treated the same way:
     1. Google's Quick, Draw! dataset (CC BY 4.0) - ~24 real drawings for each
        of ~45 categories, downloaded once into quickdraw-templates.json.
        These are how strangers actually draw a house, which no hand-made
        template ever captures.
     2. A handful of idealised built-ins (kept as a fallback if the JSON is
        missing).
     3. Whatever the committee records with R at the stall (localStorage).

   $P (Vatavu, Anthony & Wobbrock 2012) treats a drawing as an unordered
   cloud of points, so stroke order, direction and count do not matter -
   essential for air drawing, where people draw everything in one wobbly
   stroke. With ~1100 templates the full greedy match is too slow to run
   several times a second, so matching is two-stage: a cheap one-directional
   nearest-neighbour pass ranks every template (after an aspect-ratio
   prefilter), and only the best STAGE1_KEEP get the full $P treatment.

   Interface (unchanged for callers):
       classify(strokes) -> [{label, prob}, ...]   sorted, sums to ~1
       addTemplate(label, strokes), userCount(label), clearUserTemplates()
   New: `ready` (a promise: real templates loaded), categories(), stats().
   `strokes` = array of strokes, each an array of {x,y} in NORMALISED screen
   coordinates (what the user sees - mirror-corrected by the caller).
   ========================================================================== */

export const BUILTIN_CATEGORIES = [
  "house","tree","fish","star","sun","car",
  "snake","clock","ladder","umbrella","banana","envelope",
];
export const CATEGORIES = BUILTIN_CATEGORIES;   // legacy name

const N = 32;
const STORE_KEY = "bunfight.pictionary.templates.v2";   // v2: mirror-corrected
const SOFTMAX_K = 2.4;
const STAGE1_KEEP = 64;
const KNN = 3;                                           // category score = mean of its best 3 matches
// The shapes the stall actually uses. Chosen from a held-out evaluation over
// all 44 downloaded categories: these are the simple, distinct ones a point-
// cloud matcher gets right. The rest (tree 2/16, spider, bird, dog, mushroom
// vs umbrella, donut vs clock, face vs smiley face, moon vs banana, bus vs
// envelope, pizza...) were better left out than guessed at - every dropped
// shape was also a distractor for the ones kept. Pass null to use everything.
export const STALL_CATEGORIES = [
  "apple","banana","car","clock","cloud","cup","envelope","eye","fish","flower",
  "fork","guitar","hat","house","ice cream","ladder","light bulb","rainbow",
  "smiley face","snake","star","sun","t-shirt","umbrella",
];
export let ACTIVE_CATEGORIES = new Set(STALL_CATEGORIES);
export function setActiveCategories(list) { ACTIVE_CATEGORIES = list ? new Set(list) : null; }
const ASPECT_TOL = 0.8;                                  // |ln(aspect ratio)| allowed
const QUICKDRAW_URL = new URL("./quickdraw-templates.json", import.meta.url).href;

/* ---------- $P core on typed arrays ------------------------------------- */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].id === pts[i - 1].id) d += dist(pts[i - 1], pts[i]);
  return d;
}

// uniform arc-length resampling, never interpolating across a pen lift
function resample(strokes, n) {
  const pts = [];
  strokes.forEach((s, id) => { for (const p of s) pts.push({ x: p.x, y: p.y, id }); });
  if (pts.length < 2) return null;
  const total = pathLength(pts);
  if (total <= 1e-6) return null;
  const I = total / (n - 1);
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let D = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].id !== pts[i - 1].id) continue;
    const d = dist(pts[i - 1], pts[i]);
    if (D + d >= I) {
      const t = Math.min(Math.max((I - D) / d, 0), 1);
      const q = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
                  y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y), id: pts[i].id };
      out.push({ x: q.x, y: q.y });
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...out[out.length - 1] });
  return out.slice(0, n);
}

// uniform scale to a unit box (aspect preserved), centred on the origin,
// packed into a Float32Array [x0,y0,x1,y1,...]; aspect kept for prefiltering
function prepare(strokes) {
  const r = resample(strokes, N);
  if (!r) return null;
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of r) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                       minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const w = maxX - minX, h = maxY - minY, size = Math.max(w, h, 1e-6);
  const f = new Float32Array(2 * N);
  let cx = 0, cy = 0;
  for (let i = 0; i < N; i++) { f[2 * i] = (r[i].x - minX) / size; f[2 * i + 1] = (r[i].y - minY) / size;
                                cx += f[2 * i]; cy += f[2 * i + 1]; }
  cx /= N; cy /= N;
  for (let i = 0; i < N; i++) { f[2 * i] -= cx; f[2 * i + 1] -= cy; }
  return { pts: f, aspect: Math.log(Math.max(w, 1e-4) / Math.max(h, 1e-4)) };
}

// stage 1: sum over query points of nearest template point (one direction,
// no matching bookkeeping). Cheap, and a good enough ranking to shortlist.
function quickDist(a, b) {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const ax = a[2 * i], ay = a[2 * i + 1];
    let best = Infinity;
    for (let j = 0; j < N; j++) {
      const dx = ax - b[2 * j], dy = ay - b[2 * j + 1];
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    sum += Math.sqrt(best);
  }
  return sum;
}

function cloudDistance(a, b, start) {
  const matched = new Uint8Array(N);
  let sum = 0, i = start;
  do {
    const ax = a[2 * i], ay = a[2 * i + 1];
    let min = Infinity, index = -1;
    for (let j = 0; j < N; j++) {
      if (matched[j]) continue;
      const dx = ax - b[2 * j], dy = ay - b[2 * j + 1];
      const d = dx * dx + dy * dy;
      if (d < min) { min = d; index = j; }
    }
    matched[index] = 1;
    sum += (1 - ((i - start + N) % N) / N) * Math.sqrt(min);
    i = (i + 1) % N;
  } while (i !== start);
  return sum;
}

function greedyMatch(a, b) {
  const step = Math.max(1, Math.floor(Math.sqrt(N)));
  let min = Infinity;
  for (let i = 0; i < N; i += step) min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i));
  return min;
}

/* ---------- built-in fallback templates --------------------------------- */

const arc = (cx, cy, r, a0, a1, n = 22, ry = r) => {
  const s = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n);
    s.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * ry }); } return s; };
const line = (x0, y0, x1, y1, n = 8) => { const s = [];
  for (let i = 0; i <= n; i++) s.push({ x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n }); return s; };
const poly = (pl, n = 8) => { const s = [];
  for (let i = 1; i < pl.length; i++) { const a = pl[i - 1], b = pl[i];
    for (let k = 0; k <= n; k++) s.push({ x: a[0] + (b[0] - a[0]) * k / n, y: a[1] + (b[1] - a[1]) * k / n }); }
  return s; };
const TAU = Math.PI * 2;

export const TEMPLATE_SHAPES = {
  house: [[ poly([[.2,.9],[.2,.45],[.8,.45],[.8,.9],[.2,.9]]), poly([[.2,.45],[.5,.15],[.8,.45]]) ]],
  tree:  [[ arc(.5,.4,.28,0,TAU), poly([[.44,.68],[.44,.92]]), poly([[.56,.68],[.56,.92]]) ]],
  fish:  [[ arc(.44,.5,.3,0,TAU,22,.22), poly([[.74,.5],[.94,.3],[.94,.7],[.74,.5]]) ]],
  star:  [[ (() => { const pts = []; for (let i = 0; i < 10; i++) {
              const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? .17 : .40;
              pts.push([.5 + Math.cos(a) * r, .5 + Math.sin(a) * r]); } pts.push(pts[0]); return poly(pts, 4); })() ]],
  sun:   [[ arc(.5,.5,.24,0,TAU), ...[0,1,2,3,4,5,6,7].map(i => { const a = i * TAU / 8;
            return line(.5 + Math.cos(a) * .30, .5 + Math.sin(a) * .30, .5 + Math.cos(a) * .46, .5 + Math.sin(a) * .46, 4); }) ]],
  car:   [[ poly([[.08,.7],[.12,.5],[.32,.5],[.42,.34],[.7,.34],[.78,.5],[.92,.5],[.92,.7],[.08,.7]]),
            arc(.28,.72,.10,0,TAU,12), arc(.72,.72,.10,0,TAU,12) ]],
  snake: [[ (() => { const s = []; for (let i = 0; i <= 48; i++) { const t = i / 48;
            s.push({ x: .06 + t * .88, y: .5 + Math.sin(t * TAU * 1.6) * .22 }); } return s; })() ]],
  clock: [[ arc(.5,.5,.38,0,TAU), line(.5,.5,.5,.24,6), line(.5,.5,.70,.56,6) ]],
  ladder:[[ line(.32,.08,.32,.92,14), line(.68,.08,.68,.92,14),
            ...[0,1,2,3].map(i => line(.32,.24 + i * .18,.68,.24 + i * .18,5)) ]],
  umbrella: [[ arc(.5,.55,.40,Math.PI,TAU,20), line(.5,.55,.5,.90,8), arc(.42,.90,.08,0,Math.PI,8) ]],
  banana:[[ [...arc(.5,.28,.40,Math.PI * .12,Math.PI * .88,20), ...arc(.5,.44,.40,Math.PI * .88,Math.PI * .12,20)] ]],
  envelope: [[ poly([[.1,.28],[.9,.28],[.9,.72],[.1,.72],[.1,.28]]), poly([[.1,.28],[.5,.56],[.9,.28]]) ]],
};

/* ---------- data helpers ------------------------------------------------- */

/** Quick, Draw! simplified strokes ([[x..],[y..]] or [[x,y],..] pairs, 0-255)
 *  -> our normalised {x,y} strokes. */
export function quickdrawToStrokes(drawing) {
  return drawing.map(s => {
    if (s.length && Array.isArray(s[0]) && s[0].length === 2 && !Array.isArray(s[0][0]) && s.length !== 2)
      return s.map(p => ({ x: p[0] / 255, y: p[1] / 255 }));           // [[x,y],...]
    if (s.length === 2 && Array.isArray(s[0]) && Array.isArray(s[1]) && s[0].length !== 2)
      return s[0].map((x, i) => ({ x: x / 255, y: s[1][i] / 255 }));   // [[xs],[ys]]
    return s.map(p => ({ x: p[0] / 255, y: p[1] / 255 }));
  });
}

function loadUser() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch (e) { return []; } }
function saveUser(list) { try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) {} }

/* ---------- classifier --------------------------------------------------- */

export function createClassifier(opts) {
  const templates = [];                    // {label, pts, aspect, source}
  let quickdrawCount = 0, quickdrawError = null;

  const active = (opts && opts.categories) ? new Set(opts.categories) : ACTIVE_CATEGORIES;
  const add = (label, strokes, source) => {
    if (active && !active.has(label) && source !== "user") return false;
    const p = prepare(strokes);
    if (p) templates.push({ label, pts: p.pts, aspect: p.aspect, source });
    return !!p;
  };

  for (const label of BUILTIN_CATEGORIES)
    for (const strokes of (TEMPLATE_SHAPES[label] || [])) add(label, strokes, "builtin");

  let userRaw = loadUser();
  for (const t of userRaw) add(t.label, t.strokes, "user");

  const url = (opts && opts.quickdrawUrl) || QUICKDRAW_URL;
  const ready = (typeof fetch === "function" ? fetch(url) : Promise.reject(new Error("no fetch")))
    .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(j => {
      const cats = j.categories || j;
      for (const [label, drawings] of Object.entries(cats))
        for (const d of drawings) if (add(label, quickdrawToStrokes(d), "quickdraw")) quickdrawCount++;
      return { quickdraw: quickdrawCount, templates: templates.length };
    })
    .catch(e => { quickdrawError = e; console.warn("[sketch] Quick, Draw! templates not loaded: " + e.message);
                  return { quickdraw: 0, templates: templates.length, error: e.message }; });

  const api = {
    kind: "$P+quickdraw",
    ready,

    categories() {
      return [...new Set(templates.map(t => t.label))].sort();
    },

    stats() {
      return { templates: templates.length, quickdraw: quickdrawCount,
               user: templates.filter(t => t.source === "user").length,
               categories: api.categories().length, error: quickdrawError && quickdrawError.message };
    },

    classify(strokes) {
      if (!strokes || !strokes.length) return [];
      const q = prepare(strokes);
      if (!q || !templates.length) return [];

      // stage 1: aspect prefilter + cheap ranking
      const ranked = [];
      for (const t of templates) {
        if (Math.abs(t.aspect - q.aspect) > ASPECT_TOL) continue;
        ranked.push({ t, d: quickDist(q.pts, t.pts) });
      }
      if (!ranked.length) for (const t of templates) ranked.push({ t, d: quickDist(q.pts, t.pts) });
      ranked.sort((a, b) => a.d - b.d);

      // stage 2: full $P on the shortlist; a category scores the MEAN of its
      // best KNN matches, so one freak close template cannot win on its own
      const per = new Map();
      for (const r of ranked.slice(0, STAGE1_KEEP)) {
        const d = greedyMatch(q.pts, r.t.pts);
        (per.get(r.t.label) || per.set(r.t.label, []).get(r.t.label)).push(d);
      }
      const best = new Map();
      for (const [label, ds] of per) {
        ds.sort((a, b) => a - b);
        const k = Math.min(KNN, ds.length);
        let m = 0; for (let i = 0; i < k; i++) m += ds[i];
        // fewer than KNN matches in the shortlist is itself weak evidence
        best.set(label, (m / k) * (1 + 0.06 * (KNN - k)));
      }
      // categories outside the shortlist still get a (worse) stage-1 score so
      // the panel can show them, scaled to be comparable
      for (const r of ranked.slice(STAGE1_KEEP)) if (!best.has(r.t.label)) best.set(r.t.label, r.d * 1.15);

      const dmin = Math.min(...best.values());
      const scored = [...best].map(([label, d]) => ({ label, w: Math.exp(-(d - dmin) * SOFTMAX_K) }));
      const total = scored.reduce((a, b) => a + b.w, 0) || 1;
      return scored.map(s => ({ label: s.label, prob: s.w / total })).sort((a, b) => b.prob - a.prob);
    },

    addTemplate(label, strokes) {
      if (!add(label, strokes, "user")) return 0;
      userRaw.push({ label, strokes }); saveUser(userRaw);
      return api.userCount(label);
    },

    userCount(label) {
      return templates.filter(t => t.source === "user" && (!label || t.label === label)).length;
    },

    clearUserTemplates() {
      for (let i = templates.length - 1; i >= 0; i--) if (templates[i].source === "user") templates.splice(i, 1);
      userRaw = []; saveUser(userRaw);
    },
  };
  return api;
}

/** 28x28 grayscale bitmap of the strokes - for anyone swapping in a CNN. */
export function rasterise(strokes, size = 28, pad = 2) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, size, size);
  const pts = strokes.flat();
  if (!pts.length) return new Float32Array(size * size);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                         minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const span = Math.max(maxX - minX, maxY - minY, 1e-4), k = (size - pad * 2) / span;
  g.strokeStyle = "#fff"; g.lineWidth = 1.6; g.lineCap = g.lineJoin = "round";
  for (const s of strokes) { if (s.length < 2) continue; g.beginPath();
    g.moveTo(pad + (s[0].x - minX) * k, pad + (s[0].y - minY) * k);
    for (let i = 1; i < s.length; i++) g.lineTo(pad + (s[i].x - minX) * k, pad + (s[i].y - minY) * k);
    g.stroke(); }
  const d = g.getImageData(0, 0, size, size).data, out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}
