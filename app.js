/*
 * Kintsugi
 *
 * Step 1: as someone writes "What was hard?", a crack grows across the bowl.
 *         Adding it leaves the crack open. Many cracks can be open at once.
 * Step 2: they pick an open crack and write what helped, or, if nothing did,
 *         something good that happened. Pressing "Mend with gold" fills that crack with gold.
 * Hovering over a crack or a gold seam shows the words behind it.
 * "Keep this bowl" saves it, named, as a keepsake; "My bowls" opens them again, replaying
 * each one's story with the same hover.
 *
 * Words are never sent anywhere. While making a bowl they live only in memory; keeping a
 * bowl stores it (words included) in this browser's localStorage, on this device only.
 * The crack's shape comes from a random seed, not the words.
 */
'use strict';

/* ==========================================================================
   Bowl state: the single source of truth
   ==========================================================================
   Each crack is { id, seed, start, createdAt, hard, mend }:
     seed      - integer that drives the random generator (same seed = same crack)
     start     - where the crack begins on the rim, from -1 (left) to 1 (right)
     createdAt - timestamp, useful for ordering once cracks come from a server
     hard      - the words for "What was hard?"
     mend      - null while the crack is open, then { kind: 'helped' | 'good', text, at }

   To share one bowl later (e.g. Firebase), sync this array. Note that syncing would
   send people's words to everyone viewing the bowl; sync only seed/start/mend.kind
   if the words should stay on the device where they were written.
   For a record arriving from elsewhere, call
   drawCrack(generateCrack(record.seed, record.start), record) to show it.
*/
const bowl = {
  cracks: [],
};

/* Interface state that isn't part of the bowl itself */
const ui = {
  draft: null,        // crack growing while "What was hard?" is being typed, not yet added
  selectedId: null,   // open crack that step 2 will mend
  nextId: 1,
  generation: 0,      // bumped on reset or view change so a running sample or replay stops
  shapes: new Map(),  // crack id -> drawn crack (geometry + SVG elements)
  keptId: null,       // keepsake this bowl was last kept as, so keeping again updates it
  viewing: null,      // keepsake being shown on the stage, or null while making a bowl
  stash: null,        // the bowl in progress, set aside while a keepsake is shown
};

/* Keepsakes: [{ id, name, keptAt, cracks: [crack records] }], newest first, in localStorage */
const STORE_KEY = 'kintsugi.keepsakes.v1';

/* ==========================================================================
   Geometry (SVG units, viewBox 0 0 800 620)
   ========================================================================== */
const G = {
  CX: 400,        // horizontal center
  RIM_Y: 200,     // y of the rim's left and right edges
  RX: 300,        // rim ellipse radii
  RY: 70,
  FOOT_Y: 478,    // where the body meets the foot
  HW_BOTTOM: 96,  // half-width of the body at the foot
};

/* Color of an open crack; chosen to read clearly against the glaze in index.html */
const CRACK_COLOR = '#efe3cc'; // a fine cream hairline on the dark glaze

/* How typing maps to progress: a first keystroke makes a small nick, ~45 characters completes the line */
const TYPING_FULL_AT = 45;
const TYPING_MIN = 0.12;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SAMPLES = [
  { hard: 'Moving to a new city alone', kind: 'helped', mend: 'Weekly video calls with my sister' },
  { hard: 'Failing my first midterm', kind: 'helped', mend: 'Office hours and a study group' },
  { hard: 'A long stretch of feeling lonely', kind: 'good', mend: 'Found a café that feels like home' },
  { hard: 'Not getting the internship', kind: 'helped', mend: 'A mentor who went over my resume with me' },
  { hard: 'Months of burnout', kind: null, mend: null }, // left open, to show a crack still waiting
];

/* ==========================================================================
   Seeded random numbers
   ========================================================================== */

/* mulberry32: small, fast, good-enough PRNG. Returns a function giving floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* A fresh seed for a new crack. Deliberately unrelated to what was typed. */
function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/* Scrambles an integer into a well-spread seed (used for reproducible sample seeds). */
function hashInt(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ==========================================================================
   Bowl shape
   ========================================================================== */

/* Half-width of the bowl body at height y: widest at the rim, rounding in to the foot. */
function halfWidthAt(y) {
  const t = clamp((y - G.RIM_Y) / (G.FOOT_Y - G.RIM_Y), 0, 1);
  return G.HW_BOTTOM + (G.RX - G.HW_BOTTOM) * Math.pow(1 - Math.pow(t, 2.2), 0.55);
}

/* y of the front lip of the rim (the lower half of the rim ellipse) at x. */
function rimFrontY(x) {
  const dx = (x - G.CX) / G.RX;
  if (Math.abs(dx) >= 1) return G.RIM_Y;
  return G.RIM_Y + G.RY * Math.sqrt(1 - dx * dx);
}

/* True if (x, y) is on the outside of the bowl body, at least `margin` from its edge. */
function insideBody(x, y, margin) {
  if (y > G.FOOT_Y - margin) return false;
  if (y < rimFrontY(x) + margin * 0.3) return false;
  return Math.abs(x - G.CX) <= halfWidthAt(y) - margin;
}

/* SVG path for the outside of the body: down the left side, across the base, up the right, back along the front lip. */
function bodyPathD() {
  const N = 64;
  const left = [];
  for (let i = 0; i <= N; i++) {
    // Sample more densely near the base, where the curve turns fastest
    const t = Math.sin((i / N) * Math.PI / 2);
    const y = G.RIM_Y + (G.FOOT_Y - G.RIM_Y) * t;
    left.push([G.CX - halfWidthAt(y), y]);
  }
  const right = left.map(([x, y]) => [2 * G.CX - x, y]).reverse();
  const fmt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;

  return (
    `M ${left.map(fmt).join(' L ')} ` +
    `Q ${G.CX} ${G.FOOT_Y + 14} ${fmt(right[0])} ` +
    `L ${right.map(fmt).join(' L ')} ` +
    `A ${G.RX} ${G.RY} 0 0 1 ${G.CX - G.RX} ${G.RIM_Y} Z`
  );
}

/* Applies the computed geometry to the static bowl elements in index.html. */
function buildBowl() {
  const body = bodyPathD();
  document.getElementById('bowl-body').setAttribute('d', body);
  document.getElementById('bowl-underside').setAttribute('d', body);
  document.getElementById('body-clip-path').setAttribute('d', body);

  const setEllipse = (id, rx, ry) => {
    const el = document.getElementById(id);
    el.setAttribute('cx', G.CX);
    el.setAttribute('cy', G.RIM_Y);
    el.setAttribute('rx', rx);
    el.setAttribute('ry', ry);
  };
  setEllipse('bowl-interior', G.RX, G.RY);
  setEllipse('bowl-rim', G.RX - 1, G.RY - 1);
  setEllipse('bowl-rim-inner', G.RX - 9, G.RY - 5);

  const f = G.FOOT_Y;
  const w = G.HW_BOTTOM;
  document.getElementById('bowl-foot').setAttribute('d',
    `M ${G.CX - w + 4} ${f - 8} L ${G.CX - w + 12} ${f + 22} ` +
    `Q ${G.CX} ${f + 34} ${G.CX + w - 12} ${f + 22} L ${G.CX + w - 4} ${f - 8} Z`);
}

/* ==========================================================================
   Crack generation
   ========================================================================== */

/*
 * Picks a rim position for a new crack, preferring spots far from existing cracks
 * so the bowl fills evenly. Seeded, so the same seed and bowl give the same result.
 */
function chooseStart(seed) {
  const rand = mulberry32(seed ^ 0x5bd1e995);
  const taken = bowl.cracks.map((c) => c.start);
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < 6; i++) {
    const u = rand() * 1.6 - 0.8;
    const score = taken.length ? Math.min(...taken.map((s) => Math.abs(s - u))) : 1;
    if (score > bestScore) {
      best = u;
      bestScore = score;
    }
  }
  return best;
}

/*
 * Builds the shape of one crack from its seed.
 * Returns { seed, start, main: [[x, y], ...], branches: [{ points, at }] },
 * where `at` is the index on the main path where the branch splits off.
 */
function generateCrack(seed, start) {
  const rand = mulberry32(seed);
  const fallbackStart = rand() * 1.6 - 0.8;
  const u = start ?? fallbackStart;

  // Start on the front lip of the rim
  let x = G.CX + u * G.RX * 0.95;
  let y = rimFrontY(x) + 1.5;

  // Head downward and inward, toward a point low on the bowl nearer the center
  const tx = G.CX + u * G.RX * (0.1 + rand() * 0.4);
  const ty = G.FOOT_Y - 20 - rand() * 130;
  let angle = Math.atan2(ty - y, tx - x);

  const main = [[x, y]];
  const branches = [];
  const steps = 9 + Math.floor(rand() * 10);

  for (let i = 0; i < steps; i++) {
    // Steer toward the target with a lot of wobble, never pointing upward
    const toward = Math.atan2(ty - y, tx - x);
    angle += (toward - angle) * 0.3 + (rand() - 0.5) * 1.1;
    angle = clamp(angle, 0.25, Math.PI - 0.25);

    const len = 9 + rand() * 14;
    const nx = x + Math.cos(angle) * len;
    const ny = y + Math.sin(angle) * len;

    // A jittered midpoint makes each segment look fractured rather than straight
    const jitter = (rand() - 0.5) * 5;
    const mx = (x + nx) / 2 - Math.sin(angle) * jitter;
    const my = (y + ny) / 2 + Math.cos(angle) * jitter;

    if (!insideBody(nx, ny, 8) || !insideBody(mx, my, 6)) break;
    main.push([mx, my], [nx, ny]);
    x = nx;
    y = ny;

    if (i >= 1 && i < steps - 1 && branches.length < 4 && rand() < 0.32) {
      const branch = generateBranch(rand, x, y, angle, main.length - 1);
      if (branch) branches.push(branch);
    }
  }

  return { seed, start: u, main, branches };
}

/* A small side branch splitting off the main crack at (x, y). */
function generateBranch(rand, x, y, parentAngle, at) {
  const side = rand() < 0.5 ? -1 : 1;
  let angle = parentAngle + side * (0.55 + rand() * 0.6);
  const points = [[x, y]];
  const steps = 2 + Math.floor(rand() * 4);

  for (let i = 0; i < steps; i++) {
    angle = clamp(angle + (rand() - 0.5) * 0.7, -0.2, Math.PI + 0.2);
    const len = 5 + rand() * 10;
    const nx = x + Math.cos(angle) * len;
    const ny = y + Math.sin(angle) * len;
    if (!insideBody(nx, ny, 6)) break;
    points.push([nx, ny]);
    x = nx;
    y = ny;
  }
  return points.length > 1 ? { points, at } : null;
}

/* ==========================================================================
   Drawing
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

function pathD(points) {
  return 'M ' + points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ');
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

function svgPath(points, attrs) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD(points));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  for (const [k, v] of Object.entries(attrs)) path.setAttribute(k, v);
  return path;
}

/*
 * A path that can be partly drawn by setting stroke-dashoffset.
 * The dash pattern is set up so offset `hidden` shows nothing and offset 0 shows the whole path.
 */
function makeStrokePath(points, attrs) {
  const el = svgPath(points, attrs);
  const length = polylineLength(points);
  el.style.strokeDasharray = `${length} ${length + 10}`;
  return { el, length, hidden: length + 5 };
}

/*
 * Adds a crack (fissure, gold seam, and a hover area) to the bowl.
 * With a record, it is drawn in that record's state: an open crack, or a mended one.
 * Without one it starts invisible, for a draft that grows as someone types.
 * `into` draws somewhere other than the main bowl (e.g. a gallery thumbnail), without hover links.
 */
function drawCrack(crack, record = null, into = null) {
  const group = document.createElementNS(SVG_NS, 'g');
  const crackLayer = document.createElementNS(SVG_NS, 'g');
  const goldLayer = document.createElementNS(SVG_NS, 'g');
  const hitLayer = document.createElementNS(SVG_NS, 'g');
  group.append(crackLayer, goldLayer, hitLayer);

  const lines = [
    { points: crack.main, at: 0, isMain: true },
    ...crack.branches.map((b) => ({ points: b.points, at: b.at, isMain: false })),
  ];

  // Distance along the main crack to each point, so branches start when the crack or gold reaches them
  const mainDist = [0];
  for (let i = 1; i < crack.main.length; i++) {
    const [ax, ay] = crack.main[i - 1];
    const [bx, by] = crack.main[i];
    mainDist.push(mainDist[i - 1] + Math.hypot(bx - ax, by - ay));
  }
  const mainLength = mainDist[mainDist.length - 1] || 1;

  crack.parts = lines.map((line) => {
    const fissure = makeStrokePath(line.points, {
      stroke: CRACK_COLOR,
      'stroke-opacity': '0.9',
      'stroke-width': line.isMain ? '1.5' : '1',
    });
    // Gold seam: two soft, wide strokes for the glow under a bright core, all on the crack's exact path.
    // (Plain strokes rather than a blur filter, which some browsers draw slightly shifted.)
    const core = line.isMain ? 3.4 : 2.2;
    const gold = [
      makeStrokePath(line.points, { stroke: '#f3cf6e', 'stroke-opacity': '0.14', 'stroke-width': core * 3.2 }),
      makeStrokePath(line.points, { stroke: '#f3cf6e', 'stroke-opacity': '0.28', 'stroke-width': core * 1.9 }),
      makeStrokePath(line.points, { stroke: 'url(#gold)', 'stroke-width': core }),
    ];
    // Wide, invisible stroke that catches the pointer
    const hit = svgPath(line.points, {
      class: 'crack-hit',
      stroke: '#000',
      'stroke-opacity': '0',
      'stroke-width': '16',
      'pointer-events': 'stroke',
    });
    crackLayer.append(fissure.el);
    goldLayer.append(...gold.map((g) => g.el));
    hitLayer.append(hit);
    return { fissure, gold, isMain: line.isMain, startFrac: mainDist[line.at] / mainLength };
  });

  crack.group = group;
  crack.mainLength = mainLength;

  const drawn = record ? 1 : 0;
  const mended = record && record.mend ? 1 : 0;
  setCrackProgress(crack, drawn, 0);
  animateGold(crack, mended, 0);
  if (record && !into) linkRecord(crack, record);

  (into || document.getElementById('cracks')).append(group);
  return crack;
}

/* Connects a drawn crack to its bowl record so hovering and selecting can find it. */
function linkRecord(crack, record) {
  crack.group.dataset.id = record.id;
  ui.shapes.set(record.id, crack);
}

/* ==========================================================================
   Progress: how much of a crack, or of its gold, is showing (0 to 1)
   ========================================================================== */

/* Sets how much of one path is drawn, sliding there over `duration` ms. */
function reveal(part, frac, duration, easing = 'cubic-bezier(0.3, 0.1, 0.3, 1)') {
  const el = part.el;
  const offset = frac <= 0 ? part.hidden : part.length * (1 - frac);
  getComputedStyle(el).strokeDashoffset; // flush the current value so the transition starts from it
  el.style.transition = duration > 0 ? `stroke-dashoffset ${duration}ms ${easing}` : 'none';
  el.style.strokeDashoffset = `${offset}px`;
}

/* A side branch fills once the main line has passed the point where it splits off. */
function branchFrac(part, frac) {
  if (part.isMain) return frac;
  if (frac >= 1) return 1;
  return clamp((frac - part.startFrac) / 0.25, 0, 1);
}

/* Grows (or shrinks) the dark crack to `frac` of its full length. */
function setCrackProgress(crack, frac, duration, easing) {
  for (const part of crack.parts) reveal(part.fissure, branchFrac(part, frac), duration, easing);
}

/* Flows gold into the crack up to `frac` of its length. */
function animateGold(crack, frac, duration, easing) {
  for (const part of crack.parts) {
    for (const layer of part.gold) reveal(layer, branchFrac(part, frac), duration, easing);
  }
}

/* How far along a line should be for a given amount of typed text. */
function typingFrac(text) {
  const len = text.trim().length;
  return len === 0 ? 0 : TYPING_MIN + (1 - TYPING_MIN) * Math.min(1, len / TYPING_FULL_AT);
}

/* A small shake of the whole bowl. `strength` 1 is a full shake, smaller is gentler. */
function shakeBowl(strength = 1) {
  if (reduceMotion) return;
  const s = strength;
  document.getElementById('bowl-shake').animate(
    [
      { transform: 'none' },
      { transform: `translateX(${-4 * s}px) rotate(${-0.7 * s}deg)` },
      { transform: `translateX(${4 * s}px) rotate(${0.6 * s}deg)` },
      { transform: `translateX(${-2 * s}px) rotate(${-0.3 * s}deg)` },
      { transform: `translateX(${1 * s}px) rotate(${0.1 * s}deg)` },
      { transform: 'none' },
    ],
    { duration: 300 + 300 * s, easing: 'ease-out' }
  );
}

/* Keeps the gold gradient sliding along forever so the seams shimmer. */
function startShimmer() {
  const gradient = document.getElementById('gold');
  const vx = 180; // matches x2/y2 of the gradient; with spreadMethod="reflect"
  const vy = 70;  // the pattern repeats every 2 vector lengths, so this loops seamlessly
  function frame(time) {
    const k = (time / 5000) % 2;
    gradient.setAttribute('gradientTransform', `translate(${(k * vx).toFixed(2)} ${(k * vy).toFixed(2)})`);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ==========================================================================
   Step 1: what was hard -> a crack
   ========================================================================== */

/* Starts a new crack the moment someone begins typing, and grows it with every character. */
function onHardInput() {
  const text = els.hard.value;
  if (text.trim() === '') {
    discardDraft();
    return;
  }
  if (!ui.draft) {
    const seed = randomSeed();
    ui.draft = drawCrack(generateCrack(seed, chooseStart(seed)));
    shakeBowl(0.5);
    setStatus('A crack is forming…');
  }
  setCrackProgress(ui.draft, typingFrac(text), 350);
}

/* Removes a crack that was being typed but then erased. */
function discardDraft() {
  if (!ui.draft) return;
  ui.draft.group.remove();
  ui.draft = null;
  render();
}

/* Adds a crack to the bowl state and snaps it open to full length. Returns the new record. */
function addCrack(crack, hardText) {
  const record = {
    id: ui.nextId++,
    seed: crack.seed,
    start: crack.start,
    createdAt: Date.now(),
    hard: hardText,
    mend: null,
  };
  bowl.cracks.push(record);
  linkRecord(crack, record);

  shakeBowl(1);
  setCrackProgress(crack, 1, 450, 'steps(5, end)');

  // The crack just written about is the one step 2 mends next
  selectCrack(record.id);
  return record;
}

function onHardSubmit(event) {
  event.preventDefault();
  const text = els.hard.value.trim();
  if (text === '') {
    setStatus('Write what was hard first, and watch the crack form.');
    els.hard.focus();
    return;
  }
  commitDraft();
  els.hard.focus();
}

/* Turns whatever is typed in "What was hard?" into an open crack. Returns its record. */
function commitDraft() {
  const text = els.hard.value.trim();
  if (!ui.draft) onHardInput();
  const crack = ui.draft;
  ui.draft = null;
  els.hardForm.reset();
  return addCrack(crack, text);
}

/* ==========================================================================
   Step 2: what helped, or something good -> gold
   ========================================================================== */

const openCracks = () => bowl.cracks.filter((c) => !c.mend);
const findRecord = (id) => bowl.cracks.find((c) => c.id === id);

/* Chooses which open crack step 2 will mend. It breathes softly on the bowl so it's clear which one. */
function selectCrack(id) {
  const previous = ui.shapes.get(ui.selectedId);
  if (previous) previous.group.classList.remove('is-selected');

  ui.selectedId = id;
  const next = ui.shapes.get(id);
  if (next) next.group.classList.add('is-selected');
  render();
}

/*
 * Seals a crack with gold. Gold only ever flows here, after "Mend with gold" is pressed,
 * and it runs along the crack's own path, from the rim down, then into each branch.
 * Afterwards the most recent crack still open becomes the next one to mend.
 */
function mendCrack(id, kind, text, duration = 2800) {
  const record = findRecord(id);
  const crack = ui.shapes.get(id);
  if (!record || !crack || record.mend) return;

  record.mend = { kind, text, at: Date.now() }; // `at` lets a keepsake replay mends in order
  crack.group.classList.remove('is-selected');
  animateGold(crack, 1, duration, 'cubic-bezier(0.35, 0.1, 0.4, 1)');

  const open = openCracks();
  ui.selectedId = null;
  if (open.length) selectCrack(open[open.length - 1].id);
  render();
}

function onMendSubmit(event) {
  event.preventDefault();
  const text = els.mend.value.trim();

  // Written a difficulty but not added it yet? Add it now, so the gold mends that crack.
  if (els.hard.value.trim() !== '' && text !== '') commitDraft();

  if (ui.selectedId === null) {
    setStatus('There are no open cracks to mend yet.');
    return;
  }
  if (text === '') {
    setStatus(mendKind() === 'helped'
      ? 'Write what helped, or choose “Something good”.'
      : 'Write something good that happened, however small.');
    els.mend.focus();
    return;
  }
  const id = ui.selectedId;
  els.mend.value = '';
  mendCrack(id, mendKind(), text);

  // Each new crack starts by asking what helped
  els.kindHelped.checked = true;
  onKindChange();
}

const mendKind = () => (els.kindGood.checked ? 'good' : 'helped');

/* Switches the step 2 prompt between "What helped?" and "something good". */
function onKindChange() {
  const good = mendKind() === 'good';
  els.mendLabel.textContent = good ? 'What’s something good that happened?' : 'What helped?';
  els.mendHint.hidden = good;
  els.mend.focus();
}

/* ==========================================================================
   Panel and status
   ========================================================================== */

function setStatus(message) {
  els.status.textContent = message;
}

/* Refreshes everything in the panel that depends on the bowl state. */
function render() {
  const open = openCracks();
  const mended = bowl.cracks.length - open.length;

  // List of open cracks to choose from
  els.openList.replaceChildren(...open.map((record) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crack-choice';
    button.setAttribute('aria-pressed', String(record.id === ui.selectedId));
    const label = document.createElement('span');
    label.textContent = record.hard; // textContent, never innerHTML: these are the visitor's words
    button.append(label);
    button.addEventListener('click', () => selectCrack(record.id));
    return button;
  }));

  const none = open.length === 0;
  els.noOpen.hidden = !none;
  els.noOpen.textContent = bowl.cracks.length
    ? 'Every crack is mended. Add another difficulty above whenever you are ready.'
    : 'Add something that was hard first. Its crack will wait here to be mended.';
  els.mend.disabled = none;
  els.mendBtn.disabled = none;
  els.kindFieldset.disabled = none;
  els.keepBtn.disabled = bowl.cracks.length === 0;

  if (bowl.cracks.length === 0) {
    setStatus('An unbroken bowl, waiting.');
  } else {
    setStatus(`${bowl.cracks.length} ${bowl.cracks.length === 1 ? 'crack' : 'cracks'} · ${mended} mended with gold`);
  }
}

/* ==========================================================================
   Hover: show the words behind a crack or seam
   ========================================================================== */

function showTooltip(id, clientX, clientY) {
  const record = findRecord(id);
  if (!record) return;

  const row = (labelText, labelClass, text) => {
    const div = document.createElement('div');
    div.className = 'tip-row';
    const label = document.createElement('span');
    label.className = `tip-label ${labelClass}`;
    label.textContent = labelText;
    div.append(label, document.createTextNode(text));
    return div;
  };

  const rows = [row('What was hard', 'hard', record.hard)];
  if (record.mend) {
    rows.push(row(record.mend.kind === 'helped' ? 'What helped' : 'Something good', 'gold', record.mend.text));
  } else {
    const open = document.createElement('div');
    open.className = 'tip-open';
    open.textContent = 'Still open, waiting for gold.';
    rows.push(open);
  }
  els.tooltip.replaceChildren(...rows);
  els.tooltip.hidden = false;
  moveTooltip(clientX, clientY);

  for (const [shapeId, shape] of ui.shapes) shape.group.classList.toggle('is-hover', shapeId === id);
}

/* Places the tooltip near the pointer, kept inside the window. */
function moveTooltip(clientX, clientY) {
  const tip = els.tooltip;
  const pad = 16;
  const { width, height } = tip.getBoundingClientRect();
  let x = clientX + 18;
  let y = clientY + 18;
  if (x + width > window.innerWidth - pad) x = clientX - width - 18;
  if (y + height > window.innerHeight - pad) y = clientY - height - 18;
  tip.style.left = `${Math.max(pad, x)}px`;
  tip.style.top = `${Math.max(pad, y)}px`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
  for (const shape of ui.shapes.values()) shape.group.classList.remove('is-hover');
}

/* The id of the crack under the pointer, or null (drafts have no id and no words yet). */
function crackIdAt(target) {
  const group = target.closest && target.closest('#cracks > g[data-id]');
  return group ? Number(group.dataset.id) : null;
}

function setupHover() {
  const layer = document.getElementById('cracks');

  layer.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const id = crackIdAt(e.target);
    if (id === null) return hideTooltip();
    if (els.tooltip.hidden || !ui.shapes.get(id).group.classList.contains('is-hover')) {
      showTooltip(id, e.clientX, e.clientY);
    } else {
      moveTooltip(e.clientX, e.clientY);
    }
  });
  layer.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') hideTooltip();
  });

  // Tap (touch) shows the words; clicking an open crack also picks it for mending (not in a keepsake)
  layer.addEventListener('click', (e) => {
    const id = crackIdAt(e.target);
    if (id === null) return;
    showTooltip(id, e.clientX, e.clientY);
    const record = findRecord(id);
    if (!ui.viewing && record && !record.mend && id !== ui.selectedId) selectCrack(id);
  });
  document.addEventListener('pointerdown', (e) => {
    if (crackIdAt(e.target) === null) hideTooltip();
  });
}

/* ==========================================================================
   Samples and reset
   ========================================================================== */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Plays a short demo: several cracks open, then most are mended one by one,
 * leaving one open. Seeds depend only on the crack count, so a fresh bowl looks the same every time.
 */
async function addSamples() {
  const gen = ui.generation;
  els.sampleBtn.disabled = true;
  const base = bowl.cracks.length;
  const added = [];

  for (let i = 0; i < SAMPLES.length; i++) {
    const seed = hashInt(base + i + 1);
    const crack = drawCrack(generateCrack(seed, chooseStart(seed)));
    added.push(addCrack(crack, SAMPLES[i].hard));
    await wait(700);
    if (gen !== ui.generation) return;
  }

  await wait(600);
  for (let i = 0; i < SAMPLES.length; i++) {
    if (gen !== ui.generation) return;
    if (!SAMPLES[i].kind) continue;
    selectCrack(added[i].id);
    mendCrack(added[i].id, SAMPLES[i].kind, SAMPLES[i].mend, 1200);
    await wait(1100);
  }
  if (gen === ui.generation) els.sampleBtn.disabled = false;
}

/* Empties the stage and stops any running sample or replay. Bowl state is left to the caller. */
function clearStage() {
  ui.generation++;
  document.getElementById('bowl-shake').getAnimations().forEach((a) => a.cancel());
  document.getElementById('cracks').replaceChildren();
  ui.shapes.clear();
  ui.draft = null;
  hideTooltip();
}

function resetBowl() {
  clearStage();
  bowl.cracks = [];
  ui.selectedId = null;
  ui.nextId = 1;
  ui.keptId = null; // a fresh bowl becomes a new keepsake when kept
  els.hardForm.reset();
  els.mendForm.reset();
  onKindChange();
  els.hard.focus();
  els.sampleBtn.disabled = false;
  render();
}

/* ==========================================================================
   Keepsakes: named bowls kept in this browser
   ========================================================================== */

function loadKeepsakes() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/* Returns false if the browser refuses (private mode, storage full or disabled). */
function storeKeepsakes(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const newKeepsakeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const formatDate = (ts) =>
  new Date(ts).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

const defaultName = () => `Bowl of ${formatDate(Date.now())}`;

function countText(cracks) {
  const mended = cracks.filter((c) => c.mend).length;
  return `${cracks.length} ${cracks.length === 1 ? 'crack' : 'cracks'} · ${mended} mended`;
}

/* Plain copies of the crack records, safe to store and independent of the live bowl. */
const copyRecords = (cracks) =>
  cracks.map(({ id, seed, start, createdAt, hard, mend }) => ({
    id, seed, start, createdAt, hard, mend: mend ? { ...mend } : null,
  }));

function updateBowlsButton() {
  const n = loadKeepsakes().length;
  els.bowlsBtn.textContent = n ? `My bowls (${n})` : 'My bowls';
}

/* Asks for a name. Keeping the same bowl again updates its keepsake instead of adding another. */
function openKeepDialog() {
  if (bowl.cracks.length === 0) return;
  const existing = loadKeepsakes().find((k) => k.id === ui.keptId);
  els.keepName.value = existing ? existing.name : '';
  els.keepName.placeholder = defaultName();
  els.keepDialog.showModal();
  els.keepName.focus();
}

function onKeepSubmit(event) {
  event.preventDefault();
  const name = els.keepName.value.trim() || defaultName();
  const keepsake = {
    id: ui.keptId || newKeepsakeId(),
    name,
    keptAt: Date.now(),
    cracks: copyRecords(bowl.cracks),
  };
  const list = loadKeepsakes().filter((k) => k.id !== keepsake.id);
  list.unshift(keepsake);
  els.keepDialog.close();

  if (!storeKeepsakes(list)) {
    setStatus('This browser would not let the bowl be kept. Storage may be full or turned off.');
    return;
  }
  ui.keptId = keepsake.id;
  updateBowlsButton();
  setStatus(`Kept as “${name}”. Find it in My bowls.`);
}

/* A small copy of the bowl with a keepsake's cracks, for the gallery. It shares the page's gradients, so the gold shimmers too. */
function bowlThumbnail(records) {
  const svg = els.bowlSvg.cloneNode(true);
  const layer = svg.querySelector('#cracks');
  layer.replaceChildren();
  svg.querySelector('defs').remove();
  svg.querySelector('title').remove();
  svg.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
  svg.removeAttribute('role');
  svg.removeAttribute('aria-labelledby');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'keepsake-thumb');
  for (const record of records) drawCrack(generateCrack(record.seed, record.start), record, layer);
  return svg;
}

function openGallery() {
  const list = loadKeepsakes();
  els.galleryEmpty.hidden = list.length > 0;
  els.galleryGrid.replaceChildren(...list.map((keepsake) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'keepsake-card';
    const name = document.createElement('span');
    name.className = 'keepsake-name';
    name.textContent = keepsake.name;
    const meta = document.createElement('span');
    meta.className = 'keepsake-meta';
    meta.textContent = `${formatDate(keepsake.keptAt)} · ${countText(keepsake.cracks)}`;
    card.append(bowlThumbnail(keepsake.cracks), name, meta);
    card.addEventListener('click', () => {
      els.gallery.close();
      viewKeepsake(keepsake.id);
    });
    return card;
  }));
  els.gallery.showModal();
}

/*
 * Shows a keepsake on the main stage and replays its story. The bowl in progress is set
 * aside (not lost) and comes back with "Back to my bowl".
 */
function viewKeepsake(id) {
  const keepsake = loadKeepsakes().find((k) => k.id === id);
  if (!keepsake) return;

  if (!ui.viewing) ui.stash = { cracks: bowl.cracks, selectedId: ui.selectedId, nextId: ui.nextId };
  clearStage();
  ui.viewing = keepsake;
  bowl.cracks = keepsake.cracks;
  ui.selectedId = null;

  els.makePanel.hidden = true;
  els.viewPanel.hidden = false;
  els.viewName.textContent = keepsake.name;
  els.viewMeta.textContent = `Kept ${formatDate(keepsake.keptAt)} · ${countText(keepsake.cracks)}`;
  els.stage.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  playStory();
}

/* Replays the viewed bowl: each crack opens in the order it was written, then gold fills them in the order they were mended. */
async function playStory() {
  const gen = ui.generation;
  const shapes = bowl.cracks.map((record) => {
    const crack = drawCrack(generateCrack(record.seed, record.start));
    linkRecord(crack, record);
    crack.group.classList.add('is-pending'); // not hoverable until it appears
    return crack;
  });
  setStatus('Replaying its story…');

  await wait(500);
  for (const crack of shapes) {
    if (gen !== ui.generation) return;
    crack.group.classList.remove('is-pending');
    shakeBowl(0.6);
    setCrackProgress(crack, 1, 450, 'steps(5, end)');
    await wait(650);
  }

  const mends = bowl.cracks
    .map((record, i) => ({ record, crack: shapes[i] }))
    .filter(({ record }) => record.mend)
    .sort((a, b) => (a.record.mend.at || 0) - (b.record.mend.at || 0));
  await wait(400);
  for (const { crack } of mends) {
    if (gen !== ui.generation) return;
    animateGold(crack, 1, 1800, 'cubic-bezier(0.35, 0.1, 0.4, 1)');
    await wait(1200);
  }
  if (gen === ui.generation) render();
}

function replayKeepsake() {
  if (!ui.viewing) return;
  clearStage();
  playStory();
}

/* Leaves the keepsake and puts the bowl in progress back exactly as it was. */
function backToMyBowl() {
  if (!ui.viewing) return;
  clearStage();
  const stash = ui.stash;
  ui.viewing = null;
  ui.stash = null;
  bowl.cracks = stash.cracks;
  ui.nextId = stash.nextId;
  ui.selectedId = null;
  for (const record of bowl.cracks) drawCrack(generateCrack(record.seed, record.start), record);

  els.viewPanel.hidden = true;
  els.makePanel.hidden = false;
  els.sampleBtn.disabled = false;
  const selected = findRecord(stash.selectedId);
  if (selected && !selected.mend) selectCrack(selected.id);
  if (els.hard.value.trim() !== '') onHardInput(); // regrow a crack that was being typed
  render();
}

function removeViewedKeepsake() {
  const keepsake = ui.viewing;
  if (!keepsake) return;
  if (!window.confirm(`Remove “${keepsake.name}” from My bowls? This can’t be undone.`)) return;
  storeKeepsakes(loadKeepsakes().filter((k) => k.id !== keepsake.id));
  if (ui.keptId === keepsake.id) ui.keptId = null;
  backToMyBowl();
  updateBowlsButton();
  setStatus(`Removed “${keepsake.name}”.`);
}

/* ==========================================================================
   Start
   ========================================================================== */

const byId = (id) => document.getElementById(id);
const els = {
  hardForm: byId('hard-form'),
  hard: byId('hard'),
  mendForm: byId('mend-form'),
  mend: byId('mend'),
  mendBtn: byId('mend-btn'),
  mendLabel: byId('mend-label'),
  mendHint: byId('mend-hint'),
  kindFieldset: byId('mend-kind'),
  kindHelped: byId('kind-helped'),
  kindGood: byId('kind-good'),
  openList: byId('open-cracks'),
  noOpen: byId('no-open'),
  status: byId('status'),
  tooltip: byId('tooltip'),
  sampleBtn: byId('sample-btn'),
  keepBtn: byId('keep-btn'),
  bowlsBtn: byId('bowls-btn'),
  bowlSvg: byId('bowl-svg'),
  stage: byId('stage'),
  makePanel: byId('make-panel'),
  viewPanel: byId('view-panel'),
  viewName: byId('view-name'),
  viewMeta: byId('view-meta'),
  keepDialog: byId('keep-dialog'),
  keepForm: byId('keep-form'),
  keepName: byId('keep-name'),
  gallery: byId('gallery'),
  galleryGrid: byId('gallery-grid'),
  galleryEmpty: byId('gallery-empty'),
};

/* Enter adds the entry; Shift+Enter still makes a new line. */
function submitOnEnter(textarea, form) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}

function init() {
  buildBowl();
  startShimmer();
  setupHover();
  render();

  els.hard.addEventListener('input', onHardInput);
  els.hardForm.addEventListener('submit', onHardSubmit);
  els.mendForm.addEventListener('submit', onMendSubmit);
  els.kindFieldset.addEventListener('change', onKindChange);
  submitOnEnter(els.hard, els.hardForm);
  submitOnEnter(els.mend, els.mendForm);

  els.sampleBtn.addEventListener('click', addSamples);
  byId('reset-btn').addEventListener('click', resetBowl);

  // Keepsakes
  updateBowlsButton();
  els.keepBtn.addEventListener('click', openKeepDialog);
  els.keepForm.addEventListener('submit', onKeepSubmit);
  byId('keep-cancel').addEventListener('click', () => els.keepDialog.close());
  els.bowlsBtn.addEventListener('click', openGallery);
  byId('gallery-close').addEventListener('click', () => els.gallery.close());
  byId('view-all-btn').addEventListener('click', openGallery);
  byId('replay-btn').addEventListener('click', replayKeepsake);
  byId('back-btn').addEventListener('click', backToMyBowl);
  byId('remove-btn').addEventListener('click', removeViewedKeepsake);
  // Clicking the dimmed area around the gallery closes it
  els.gallery.addEventListener('click', (e) => {
    if (e.target === els.gallery) els.gallery.close();
  });
}

init();
