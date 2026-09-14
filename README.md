# AI Society — bunfight stall

Two demos behind one shell. Press **1 / 2** to switch, from anywhere.
Both demos stay loaded: the second warms up in the background once the first
is ready, and switching just toggles which is visible (the hidden one pauses
its loop but keeps its camera), so it is instant instead of a reload.

```
bunfight/
  index.html          shell + demo switching (open this one)
  demos/mood.html     the mood detector
  demos/pictionary.html air pictionary
  media/mood/         drop .webm clips here for the punchline panel
  shared/tongue.js            tongue detection + contour tracing
  shared/sketch-classifier.js $P sketch recogniser over real Quick, Draw! drawings
  shared/quickdraw-templates.json  ~48 real drawings x 44 shapes (Google Quick, Draw!, CC BY 4.0)
  shared/quickdraw-test.json       held-out drawings used only to measure accuracy
  shared/mp.js                MediaPipe task creation, GPU -> CPU fallback
  shared/tongue-test.html     open in a browser - 3 assertions
  shared/delegate-test.html   open in a browser - checks GPU/CPU both work
  shared/sketch-test.html     open in a browser - 10 assertions
```

## Running it

**Double-click `start.bat`.** It finds Python, picks a free port, starts the
server, and opens the stall in **its own browser window with its own profile**
(`%LocalAppData%\bunfight-browser`, Edge or Chrome, whichever is installed).
Closing the black window stops the server.

Why a separate profile: your everyday browser profile can have WebGL switched
off for reasons unrelated to this folder - and the demos cannot run without
WebGL. A dedicated profile means a fresh GPU process every time. In that
window the camera prompt is auto-accepted, and its own settings and
Pictionary templates persist between days.

The pages need `localhost` rather than opening the files directly - browsers
block JavaScript modules over `file://`, which is why there is a launcher at
all. Every page detects being opened the wrong way and tells you.

If you would rather do it by hand:

```bash
python -m http.server 8124 --directory "C:/Users/eivan/Desktop/bunfight"
```

The folder is self-contained (models and wasm are vendored in `shared/`), so
copy the whole thing to the stall laptop and `start.bat` works from wherever
it lands.

## Why does start.bat open a separate browser window?

It is the same Edge (or Chrome), but a **separate profile in its own process**.
Two reasons:

- The demos need WebGL, and your everyday browser session can have it switched
  off for reasons that have nothing to do with this folder. On the development
  laptop, Edge's GPU process crashed once on the first day and Chromium keeps
  the GPU off until the browser fully quits - which it had not done for 56
  hours. A fresh profile means a fresh GPU process, every time.
- The stall window is launched with `--disable-gpu-process-crash-limit`, so one
  driver hiccup cannot switch WebGL off for the rest of the day. That flag
  cannot be applied to a browser that is already running.

The first time it asks for the camera, click **Allow** - the stall profile
remembers it. Its own settings and Pictionary templates persist between days.

## Mood detector

Each state is a **gated rule**: a primary feature must clear its own
threshold before any booster counts, with weights reflecting which MediaPipe
blendshapes are actually reliable. Genuine vs fake smile uses the eye crinkle
from both the cheek-squint and eye-squint channels. **Tired** is eyelid droop
measured against *your own* calibrated resting eye opening, smoothed so a
blink does not count. **Silly** fires when two or more exaggerated features
hit at once. A face doing nothing reads NATURAL.

The **tag above the head is live** (whoever leads right now, held 150 ms) -
the big verdict keeps its deliberate hysteresis. That is why the tag now
updates promptly while the verdict stays readable.

**Tongue.** The inner-lip seam is the anchor. If the lips are not parted
(gap under 9% of mouth width) a tongue is *impossible* and nothing is
sampled - that alone removes the lip-as-tongue error. When they are parted,
tongue-coloured pixels inside the opening are seeds, and the region grows
from those seeds: through the lip band only where the pixel is brighter or
paler than this person's sampled upper-lip colour (tongue over lip is; lip
is not), then down over the chin. Anything not connected to the seam is not
a tongue. Three agreeing frames are needed. `shared/tongue-test.html` covers
tongue out, open mouth with teeth, and closed red lips.

## Mood detector keys

| key | does |
|-----|------|
| `F` | fullscreen |
| `SPACE` | recalibrate the current face |
| `V` | truth mode — real top-two margin instead of the confident % |
| `T` | tongue overlay — shows the search box and every pixel it classified |
| `D` | debug — live scores, calibration state, tongue fractions |
| `1` `2` | switch demo |

## Pictionary keys

| key | does |
|-----|------|
| point one finger | draw |
| open palm | rub out (use your other hand) |
| `N` | new word |
| `C` | clear the canvas |
| `R` | **teach it** - record what is on screen as an example of the current word |
| `X` | forget everything it was taught |

### How recognition works now

The recogniser is **$P**, a point-cloud template matcher, and its templates
are **real human drawings from Google's Quick, Draw! dataset** (CC BY 4.0) -
48 of them for each shape, downloaded once into
`shared/quickdraw-templates.json`. Idealised hand-made shapes never matched
how strangers draw a house; 48 strangers' houses do. $P ignores stroke order,
direction and count, which is what air drawing needs. A shape's score is the
mean of its three best template matches, so one freak template cannot win.

**24 shapes are switched on** (`STALL_CATEGORIES` in
`shared/sketch-classifier.js`): apple, banana, car, clock, cloud, cup,
envelope, eye, fish, flower, fork, guitar, hat, house, ice cream, ladder,
light bulb, rainbow, smiley face, snake, star, sun, t-shirt, umbrella. They
were chosen from a held-out evaluation over all 44 downloaded categories:
the simple, distinct shapes a point-cloud matcher gets right. The rest (tree
at 2/16, spider, bird, dog, mushroom vs umbrella, donut vs clock, face vs
smiley face, moon vs banana...) were better left out than guessed at, and
every one of them was also a distractor for the shapes kept. The downloads
are still there - add a name to the list to switch a shape back on.

Matching is two-stage so it stays fast: an aspect-ratio prefilter and a cheap
nearest-neighbour pass shortlist the best 64 templates, which get the full
$P match. Tens of milliseconds per guess.

`shared/sketch-test.html` measures top-1 / top-3 on **held-out drawings the
recogniser has never seen** and prints the current numbers in its RESULT
line. Air drawings are wobblier than mouse drawings, so expect a bit lower
live - the top-3 panel is the experience.

### Teach it before the day

`R` records whatever is on screen as a template for the current word, in
localStorage. The committee drawing each word twice in the air is still the
biggest single improvement available, because it captures *air* drawing.
`X` forgets everything taught.

### Drawing with a finger

Finger extension is the **bend angle at the middle joint on MediaPipe's 3D
world landmarks**, not 2D tip-to-wrist distance - the old method collapsed
whenever the hand tilted toward the camera.

Pointing is deliberately asymmetric. To **start** a stroke the rule is strict:
index straighter than 32 degrees, the other three fingers clearly curled, and
the index tip reaching 1.3x further from the wrist than the curled middle
finger - a proper pointed finger on a closed hand, not a loose hand with one
finger slightly ahead. To **keep** a stroke going the rule is loose: one
relaxed finger is tolerated, half-bent fingers keep their previous state, and
a stroke survives 260 ms without a pointing frame. Curl the finger to lift the
pen; open palm rubs out.

The hand detector runs at higher confidence than its defaults, and anything
the model is less than 75% sure is a hand, or that is too small to be one,
is ignored - that is what stopped a nose being mistaken for a hand.

Strokes are **data, re-rendered smoothed**: a 5-point moving average, drawn as
curves, with near-closed loops snapped shut (a circle drawn in the air never
quite meets itself). The live stroke is drawn smoothed every frame and
committed on pen-up; erasing edits the data and re-renders. The recogniser
sees the smoothed strokes, mirror-corrected to screen space.

## Tests

Both open directly in a browser, no runner:
`shared/tongue-test.html` and `shared/sketch-test.html`.
They run against synthetic input, so they work without a webcam. The tongue
one is how the dark-cavity false positive got caught - run it after touching
any threshold.

## Troubleshooting

**`kGpuService ... emscripten_webgl_create_context()` or
`Cannot read properties of undefined (reading 'activeTexture')` or a
full-screen WEBGL IS TURNED OFF page**

WebGL is unavailable *in that browser window*. The demos cannot run without
it: MediaPipe uploads every camera frame as a WebGL texture, on the CPU
delegate too. Three things were learned on a real machine:

- **It was the profile, not the machine.** The everyday Edge profile had lost
  WebGL because its GPU process had crashed earlier and Chromium keeps the GPU
  off for the rest of that browser session (`--use-gl=disabled` on the GPU
  process). Edge had been running for 56 hours, so it never recovered. A
  fresh profile in a fresh process worked first time, on the real GPU.
- **Loading a model proves nothing.** Startup now only accepts a
  delegate/canvas setup after it has processed a test frame.
- **The default OffscreenCanvas can fail where a page canvas works**, so
  startup tries GPU and CPU on both.

`start.bat` fixes this by launching a dedicated profile with
`--disable-gpu-process-crash-limit` (one driver hiccup can no longer switch
WebGL off for the day) and `--enable-unsafe-swiftshader` (software WebGL as a
last resort; it does not demote a working GPU). Both were verified on this
machine: plain, with each flag, and with software rendering forced, the face
and hand models all started and processed frames.

If you *must* use a normal browser window instead: fully quit the browser
first (Edge keeps running in the background - use its tray icon or Task
Manager), then reopen. Then `edge://settings/system` -> graphics
acceleration ON; `edge://flags/#enable-unsafe-swiftshader` -> Enabled.

**Run `shared/delegate-test.html` on the stall laptop in advance.** It prints
each step as it happens and ends with a `RESULT` line. It also writes its
result into the page title, which is how the launcher was verified from
outside the browser.

**COULD NOT START VIDEO SOURCE** / **CAMERA IS BUSY**
Another process is holding the webcam. On Windows only one process can use it.
The usual culprit is a second browser window that opened this demo earlier -
close every other window or tab that had it open (in your normal Edge too),
and Teams / Zoom / the Camera app. The demos now say this on screen and
**retry every 3 seconds** on their own, so nothing needs reloading once the
camera is free. `CAMERA BLOCKED` means the permission was refused - click
Allow when asked. `NO CAMERA FOUND` means exactly that.

**Keys do nothing (D, T, V, SPACE, R)**
Fixed, but worth knowing why: the demos run inside an iframe in the shell, and
an iframe only receives keystrokes once it has focus. Before, if you had not
clicked inside the video area, every key went to the shell and the demo never
heard it. The shell now forwards unhandled keys into the demo and focuses it
on load, so keys work wherever you clicked last.

**The picture is live but nothing is drawn on it, and no verdict appears**
Detection is throwing every frame. It used to be swallowed silently, which
looked exactly like a dead backend. Both demos now count the failures, log the
first few to the console, and put `DETECTION FAILING` plus the message on
screen after ten in a row. Press `D` for the count.

**Demo goes blank after a refresh** — check the black console window from
`start.bat` is still open. Closing it stops the server; an already-loaded
page keeps running until it reloads.

## Before the day

1. **Go offline.** The wasm and the face model come from a CDN. Download
   `@mediapipe/tasks-vision@0.10.14/wasm` and `face_landmarker.task`, put them
   in `shared/`, and repoint the two URLs at the top of `demos/mood.html`.
   Pictionary needs `hand_landmarker.task` too. A flaky hall connection
   otherwise kills the stall at 10am.

2. **Tune the tongue detector** with `T` held down, under the actual lighting.
   The constants live in the `TONGUE` object at the top of `mood.html`.
   Test across a range of skin tones and lip colours — that part of the
   pipeline is the one that can behave unevenly between people.

3. **Write the verdicts.** `VERDICTS` at the top of `mood.html` is the whole
   joke. This is the highest-value job on the project and none of it is code.

4. **Fill `media/mood/`** with short muted `.webm` clips and list them in
   `MEDIA_LIBRARY`. Use webm, not gif — gif is a terrible codec and a hundred
   of them will choke the page. Pre-vetted local files only; a live GIF search
   on a big screen at a public stall will eventually show something you cannot
   defend.
