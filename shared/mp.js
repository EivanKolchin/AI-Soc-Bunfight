/* ==========================================================================
   MediaPipe task creation that is actually verified, plus honest failure
   reporting.

   Lessons from a real machine, in order:
     1. Creating a task proves nothing. On some machines createFromOptions
        succeeds and then every single frame throws
          Cannot read properties of undefined (reading 'activeTexture')
        So a configuration is only accepted after it survives a real
        detect call on a test frame.
     2. The CPU delegate is not WebGL-free. It moves inference off the GPU,
        but frames are still uploaded as WebGL textures.
     3. By default tasks-vision renders into an OffscreenCanvas. WebGL on an
        OffscreenCanvas can fail on machines where WebGL on a normal page
        canvas works fine. tasks-vision accepts `canvas` in its options, so
        we also try handing it an ordinary <canvas>.
   ========================================================================== */

const ATTEMPT_TIMEOUT_MS = 30000;

const CONFIGS = [
  { delegate: "GPU", canvas: "default" },   // what tasks-vision does on its own
  { delegate: "GPU", canvas: "page" },      // ordinary <canvas> instead of OffscreenCanvas
  { delegate: "CPU", canvas: "page" },
  { delegate: "CPU", canvas: "default" },
];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- probing ------------------------------------------------------ */

function probeContext(canvas, type) {
  const r = { ok: false, reason: "", renderer: "", version: "" };
  let gl = null;
  try { gl = canvas.getContext(type); }
  catch (e) { r.reason = "getContext threw: " + (e && e.message); return r; }
  if (!gl) { r.reason = "refused"; return r; }
  try {
    if (gl.isContextLost && gl.isContextLost()) { r.reason = "lost immediately"; return r; }
    r.version = String(gl.getParameter(gl.VERSION) || "");
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    r.renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
                        || gl.getParameter(gl.RENDERER) || "");
    // the exact operation that throws 'activeTexture' when GL is missing
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([0, 0, 0, 255]));
    const err = gl.getError();
    gl.deleteTexture(tex);
    if (err !== gl.NO_ERROR) { r.reason = "texture upload failed (gl error " + err + ")"; return r; }
    r.ok = true;
  } catch (e) {
    r.reason = "texture test threw: " + (e && e.message);
  } finally {
    // hand the context back - constrained machines allow very few live ones
    try { const l = gl.getExtension("WEBGL_lose_context"); if (l) l.loseContext(); } catch (e) {}
  }
  return r;
}

/** WebGL 2 on a page canvas, WebGL 1, and WebGL 2 on an OffscreenCanvas,
 *  reported separately - they fail independently. */
export function webglProbe() {
  const page2 = probeContext(document.createElement("canvas"), "webgl2");
  const page1 = probeContext(document.createElement("canvas"), "webgl");
  let off2 = { ok: false, reason: "OffscreenCanvas not supported" };
  if (typeof OffscreenCanvas !== "undefined") {
    try { off2 = probeContext(new OffscreenCanvas(2, 2), "webgl2"); }
    catch (e) { off2 = { ok: false, reason: "threw: " + (e && e.message) }; }
  }
  const renderer = page2.renderer || page1.renderer || off2.renderer || "";
  return {
    ok: page2.ok,
    webgl2: page2.ok, webgl1: page1.ok, offscreenWebgl2: off2.ok,
    reason: page2.ok ? "" : ("webgl2: " + page2.reason),
    offscreenReason: off2.reason || "",
    renderer,
    version: page2.version || page1.version || "",
    software: /swiftshader|software|llvmpipe|microsoft basic/i.test(renderer),
  };
}

export function webglAvailable() { return webglProbe().ok; }

export function isWebglFailure(err) {
  const m = ((err && err.message) || String(err || "")).toLowerCase();
  return m.includes("activetexture") || m.includes("webgl") || m.includes("kgpuservice")
      || m.includes("startgraph") || m.includes("gl context");
}

/* ---------- creation ----------------------------------------------------- */

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out after " + ms / 1000 + "s")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Push one frame through the real pipeline. This is what catches the machine
// where creation works and every frame fails.
function smokeTest(task, runningMode) {
  const frame = document.createElement("canvas");
  frame.width = frame.height = 64;
  const g = frame.getContext("2d");
  g.fillStyle = "#777"; g.fillRect(0, 0, 64, 64);
  if (runningMode === "VIDEO") task.detectForVideo(frame, performance.now());
  else task.detect(frame);
}

/**
 * Try each configuration until one both creates AND processes a frame.
 *
 * @param tune       optional (delegate) => extra options (e.g. fewer faces on CPU)
 * @param onAttempt  optional ({phase:"start"|"done", ...}) progress callback
 * @returns {{task, delegate, canvas, attempts, probe}}
 * @throws  Error with .attempts and .probe attached when nothing works
 */
export async function createTask(Klass, fileset, options, tune, onAttempt) {
  const probe = webglProbe();
  const attempts = [];

  for (const cfg of CONFIGS) {
    if (onAttempt) onAttempt({ phase: "start", ...cfg });
    const started = performance.now();
    let task = null;
    try {
      const opts = {
        ...options, ...(tune ? tune(cfg.delegate) : {}),
        baseOptions: { ...options.baseOptions, delegate: cfg.delegate },
      };
      if (cfg.canvas === "page") opts.canvas = document.createElement("canvas");

      task = await withTimeout(Klass.createFromOptions(fileset, opts),
                               ATTEMPT_TIMEOUT_MS, "model start");
      smokeTest(task, opts.runningMode);

      const a = { ...cfg, ok: true, ms: Math.round(performance.now() - started) };
      attempts.push(a);
      if (onAttempt) onAttempt({ phase: "done", ...a });
      return { task, delegate: cfg.delegate, canvas: cfg.canvas, attempts, probe };
    } catch (e) {
      const a = { ...cfg, ok: false, ms: Math.round(performance.now() - started),
                  error: (e && e.message) || String(e) };
      attempts.push(a);
      if (onAttempt) onAttempt({ phase: "done", ...a });
      console.warn("[mediapipe] " + cfg.delegate + "/" + cfg.canvas + " failed: " + a.error);
      try { if (task && task.close) task.close(); } catch (_) {}
    }
  }

  const err = new Error("MediaPipe could not start in any configuration");
  err.attempts = attempts;
  err.probe = probe;
  throw err;
}

/** True when every attempt died for WebGL reasons - retrying with a
 *  different model URL cannot help, so the caller should not bother. */
export function isWebglOnlyFailure(err) {
  const a = (err && err.attempts) || [];
  return a.length > 0 && a.every(x => !x.ok && isWebglFailure({ message: x.error }));
}

/**
 * Local model first; CDN copy only if the local one failed to LOAD.
 * The old boot code retried the CDN after any failure, which on a machine
 * without WebGL meant running the same four doomed attempts twice.
 */
export async function createTaskWithFallback(Klass, fileset, localOptions, cdnOptions, tune, onAttempt) {
  try {
    return await createTask(Klass, fileset, localOptions, tune, onAttempt);
  } catch (localErr) {
    if (isWebglOnlyFailure(localErr) || !cdnOptions) throw localErr;
    console.warn("[mediapipe] local model failed to start, trying the CDN copy:",
                 localErr && localErr.message);
    return await createTask(Klass, fileset, cdnOptions, tune, onAttempt);
  }
}

/* ---------- camera ------------------------------------------------------- */

/** Turn a getUserMedia failure into a title + one-line instruction. */
export function describeCameraError(e) {
  const n = (e && e.name) || "";
  if (n === "NotReadableError" || n === "AbortError" || n === "TrackStartError")
    return { title: "CAMERA IS BUSY",
             detail: "another window or app is holding it - close any other browser window " +
                     "that opened this demo (your normal Edge), Teams, Zoom, the Camera app. " +
                     "retrying automatically" };
  if (n === "NotAllowedError" || n === "PermissionDeniedError" || n === "SecurityError")
    return { title: "CAMERA BLOCKED",
             detail: "click Allow when the browser asks for the camera - retrying" };
  if (n === "NotFoundError" || n === "DevicesNotFoundError")
    return { title: "NO CAMERA FOUND", detail: "plug one in - retrying" };
  if (n === "OverconstrainedError" || n === "ConstraintNotSatisfiedError")
    return { title: "CAMERA REJECTED SETTINGS", detail: "trying simpler settings" };
  return { title: "CAMERA ERROR", detail: ((e && e.message) || String(e)).slice(0, 120) };
}

const CAMERA_ATTEMPTS = [
  { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } },
  { video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
  { video: true },
];

/**
 * Open the webcam and keep trying until it works. At a stall the camera gets
 * grabbed by other things all day (a second browser window, Teams, the Camera
 * app), and "Could not start video source" once meant a dead screen until
 * someone reloaded. Now it explains, retries every few seconds, and carries on
 * the moment the device frees up. Also releases the camera when the page goes
 * away, so switching demos never leaves it locked.
 *
 * @param video     the <video> element to attach to
 * @param onStatus  (title, detail, err) - shown while waiting
 * @returns the MediaStream, with the video already playing and sized
 */
export async function openCamera(video, onStatus, opts) {
  const retryMs = (opts && opts.retryMs) || 3000;
  const attempts = (opts && opts.attempts) || CAMERA_ATTEMPTS;
  let round = 0;
  for (;;) {
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        await video.play();
        if (!video.videoWidth) {
          await new Promise(res => {
            const done = () => { video.removeEventListener("loadedmetadata", done); res(); };
            video.addEventListener("loadedmetadata", done);
            setTimeout(res, 1500);
          });
        }
        addEventListener("pagehide", () => stream.getTracks().forEach(t => t.stop()), { once: true });
        return stream;
      } catch (e) {
        lastErr = e;
        const n = e && e.name;
        // permission or no device: simpler constraints will not change that
        if (n === "NotAllowedError" || n === "NotFoundError" || n === "SecurityError") break;
      }
    }
    round++;
    const d = describeCameraError(lastErr);
    if (round <= 2) console.warn("[camera] " + (lastErr && lastErr.name) + ": " + (lastErr && lastErr.message));
    if (onStatus) onStatus(d.title, d.detail + (round > 1 ? "  (" + round + ")" : ""), lastErr);
    await new Promise(r => setTimeout(r, retryMs));
  }
}

/* ---------- reporting ---------------------------------------------------- */

export function getWebglHelp() {
  const isEdge = /Edg\//i.test(navigator.userAgent);
  const isFirefox = /Firefox\//i.test(navigator.userAgent);
  const scheme = isEdge ? "edge" : "chrome";

  if (isFirefox) {
    return [
      "<b>1.</b> Open <code>about:config</code>, search for <code>webgl.disabled</code>, set it to <b>false</b>, then reload.",
      "<b>2.</b> Check <code>about:support</code> &mdash; ensure the WebGL Driver section is not blocked.",
      "<b>3.</b> Or run <code>start.bat</code> to launch an isolated hardware-accelerated stall window.",
      "Open <code>shared/delegate-test.html</code> for the full report.",
    ];
  }

  return [
    "<b>1.</b> Close this window and double-click <code>start.bat</code>. It opens the stall in a " +
      "<b>separate, clean browser profile</b>, which sidesteps whatever this profile has done to " +
      "WebGL (acceleration switched off, a privacy extension blocking canvas, or a GPU process " +
      "that crashed earlier and stayed off). This is the fix in almost every case.",
    "<b>2.</b> If you must use this window: open <code>" + scheme + "://settings/system</code>, " +
      "turn ON <b>Use graphics acceleration when available</b>, and Relaunch.",
    "<b>3.</b> Still nothing? <code>" + scheme + "://flags/#enable-unsafe-swiftshader</code> &rarr; " +
      "<b>Enabled</b> &rarr; relaunch. (Software WebGL for machines with no usable GPU.)",
    "<b>4.</b> <code>" + scheme + "://gpu</code> shows what the browser thinks of the GPU; if WebGL " +
      "says <i>Disabled</i> there, update the graphics driver.",
    "Open <code>shared/delegate-test.html</code> for the full report.",
  ];
}

export const WEBGL_HELP = getWebglHelp();

/** Turn a createTask failure into an accurate title + lines. It only claims
 *  WebGL is off when the probe actually says so. */
export function failureReport(err) {
  const probe = (err && err.probe) || webglProbe();
  const attempts = (err && err.attempts) || [];
  const help = getWebglHelp();
  let title, lines;

  if (!probe.webgl2 && !probe.webgl1) {
    title = "WEBGL IS TURNED OFF IN THIS BROWSER";
    lines = ["The camera works, but the model needs WebGL to handle camera frames " +
             "and this browser will not create a WebGL context."].concat(help);
  } else if (!probe.webgl2) {
    title = "THIS BROWSER ONLY OFFERS WEBGL 1";
    lines = ["MediaPipe needs WebGL 2. Getting only WebGL 1 usually means the graphics " +
             "driver is blocklisted or missing."].concat(help);
  } else {
    title = "THE MODEL COULD NOT START";
    lines = ["WebGL 2 works in this browser, but MediaPipe failed in all four setups " +
             "tried (GPU and CPU, each on two kinds of canvas). That points at the " +
             "graphics driver rather than a browser setting."].concat(help.slice(1));
  }

  if (attempts.length) {
    lines.push("<span style='opacity:.6'>" + attempts.map(a =>
      a.delegate + " / " + a.canvas + " canvas &rarr; " +
      (a.ok ? "ok" : "failed: " + escapeHtml(a.error.slice(0, 90)))).join("<br>") + "</span>");
  }
  lines.push("<span style='opacity:.5'>webgl2 " + probe.webgl2 + " &middot; webgl1 " +
             probe.webgl1 + " &middot; offscreen webgl2 " + probe.offscreenWebgl2 +
             (probe.renderer ? " &middot; " + escapeHtml(probe.renderer) : "") + "</span>");
  return { title, lines };
}

export function showFatalOverlay(title, lines) {
  let el = document.getElementById("__fatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "__fatal";
    el.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(5,5,7,.95);" +
      "color:#fff;font-family:'Helvetica Neue',Arial,sans-serif;display:flex;" +
      "align-items:center;justify-content:center;padding:5vw;overflow:auto";
    document.body.appendChild(el);
  }
  el.innerHTML =
    "<div style='max-width:880px'>" +
    "<div style='font-size:clamp(24px,4vw,50px);font-weight:900;letter-spacing:-.02em;" +
    "color:#FF3DDA;line-height:1.05'>" + title + "</div>" +
    lines.map(l => "<div style='font-size:clamp(13px,1.45vw,18px);line-height:1.75;" +
      "margin-top:13px;opacity:.9'>" + l + "</div>").join("") +
    "</div>";
  el.querySelectorAll("code").forEach(c => {
    c.style.cssText = "background:rgba(255,255,255,.12);padding:2px 7px;border-radius:3px;" +
      "font-family:ui-monospace,Consolas,monospace;font-size:.92em;user-select:all";
  });
}

export function clearFatalOverlay() {
  const el = document.getElementById("__fatal");
  if (el) el.remove();
}
