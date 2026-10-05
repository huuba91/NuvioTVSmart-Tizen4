/* global module */
"use strict";

// Colour engine for the TV ambilight, ported from the PC's screen_sync.py so the TV and the PC
// look the same. What it does, and where the idea comes from:
//
// - Dominant colour, not the plain average: vivid and bright pixels count most (weight sat^2 * value),
//   so a red explosion beats a grey wall. Philips extracts a dominant/"feature" colour for the same
//   reason; a plain average turns most scenes muddy brown-grey.
// - One colour, not a blend: when an edge holds two different vivid colours (orange sunset next to a
//   blue sky) their average is a colour that is not on screen (pink-grey). The vivid pixels are
//   binned by hue, the strongest hue family wins (with a little stickiness so near-ties do not flip)
//   and pixels far from that hue stop counting, like HyperHDR's dominant-colour mode and Philips'
//   dominant colour per zone.
// - Light mixes linearly: colours are averaged after undoing the screen's gamma (2.2), like
//   HyperHDR's linear-sRGB pipeline.
// - Edges, not halves: left/right bulbs follow the outer 20% of the picture, as Ambilight samples
//   the screen border next to each light. Center follows the whole picture.
// - Static parts are ignored: pixels that have not changed for 10 s (letterbox and pillarbox bars,
//   channel logos, a paused player bar) fade to 5% weight. Black bars are also caught at once, like
//   Hyperion's black-border detector: near-black rows and columns at the picture's edges that
//   stay the same size for 3 pictures stop counting straight away.
// - Vividness: saturation x1.5, faded out on (nearly) black-and-white video so grey scenes give
//   neutral light instead of a tint from a tiny coloured element (Hyperion "saturation gain").
// - Never fully dark (15% floor) and a small bright highlight on a dark screen still lights the room.
// - Warm white only for an almost entirely white screen, with hysteresis so it does not flip.
// - Smoothing: a critically damped spring in Oklab with chroma kept apart, slow for gradual drifts and
//   near-instant on scene cuts (Philips' "follow video" speeds; Hyperion/HyperHDR smoothing).

var GAMMA = 2.2;
var EDGE = 0.2;
var MAX_COLUMNS = 96; // sample grid: a 320x180 capture becomes 80x45
var STATIC_AFTER = 10;
var STATIC_WEIGHT = 0.05;
var STATIC_DIFF = 0.02;
var VIVIDNESS = 1.5;
var GREY_BELOW = 0.002;
var FULL_COLOUR_ABOVE = 0.01;
var MIN_BRIGHTNESS = 0.15;
var NEUTRAL_BELOW = 0.01;
var WHITE_SCREEN = 0.85;
var COLOUR_ABOVE = 0.02;
var WHITE_BRIGHTNESS = 0.05;
var SMOOTHING = 0.6;
var CUT_SMOOTHING = 0.08;
var CUT_SIZE = 0.25;
var BLACK_LEVEL = 18; // 0..255: darker than this counts as a black bar
var MAX_BAR = 0.3; // a bar never covers more than this share of a side (a black scene is not a bar)
var BAR_FRAMES = 3; // a new bar size must be seen this many pictures in a row
var HUE_BINS = 24;
var HUE_WIDTH = 0.125; // pixels this far from the dominant hue (in turns, 45 degrees) no longer count
var HUE_STICKY = 0.8; // keep the previous dominant hue while it has at least 80% of the strongest one's weight

var LINEAR = (function () {
  var table = new Array(256);
  for (var i = 0; i < 256; i++) table[i] = Math.pow(i / 255, GAMMA);
  return table;
})();

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function emptySums() {
  return { n: 0, w: 0, wv: 0, hi: 0, wc: [0, 0, 0], c: [0, 0, 0] };
}

// Dominant colour from region totals: linear colour 0..1, brightness 0..1, colourfulness, overall.
function summarise(t) {
  var n = Math.max(t.n, 1e-6), colourfulness = (t.all !== undefined ? t.all : t.w) / n, colour, dominantV;
  if (t.w > 1e-6) {
    colour = [t.wc[0] / t.w, t.wc[1] / t.w, t.wc[2] / t.w];
    dominantV = t.wv / t.w;
  } else {
    colour = [t.c[0] / n, t.c[1] / n, t.c[2] / n];
    dominantV = 0;
  }
  var overall = t.hi / n;
  var brightness = colourfulness > NEUTRAL_BELOW ? Math.max(overall, 0.8 * dominantV) : overall;
  return { colour: colour, brightness: brightness, colourfulness: colourfulness, overall: overall };
}

function Analyser() {
  this.prev = null;
  this.still = null;
  this.cols = 0;
  this.rows = 0;
  this.bars = { top: 0, bottom: 0, left: 0, right: 0 };
  this.barSeen = { top: [0, 0], bottom: [0, 0], left: [0, 0], right: [0, 0] };
}

// Near-black rows/columns at each side, accepted once stable for BAR_FRAMES pictures.
Analyser.prototype.detectBars = function (r, g, b, cols, rows) {
  function dark(i) { return r[i] < BLACK_LEVEL && g[i] < BLACK_LEVEL && b[i] < BLACK_LEVEL; }
  function rowDark(y) { for (var x = 0; x < cols; x++) if (!dark(y * cols + x)) return false; return true; }
  function colDark(x) { for (var y = 0; y < rows; y++) if (!dark(y * cols + x)) return false; return true; }
  var limitY = Math.floor(rows * MAX_BAR), limitX = Math.floor(cols * MAX_BAR), found = {}, n;
  for (n = 0; n < limitY && rowDark(n); n++);
  found.top = n === limitY ? 0 : n;
  for (n = 0; n < limitY && rowDark(rows - 1 - n); n++);
  found.bottom = n === limitY ? 0 : n;
  for (n = 0; n < limitX && colDark(n); n++);
  found.left = n === limitX ? 0 : n;
  for (n = 0; n < limitX && colDark(cols - 1 - n); n++);
  found.right = n === limitX ? 0 : n;
  for (var side in found) {
    if (!Object.prototype.hasOwnProperty.call(found, side)) continue;
    var seen = this.barSeen[side];
    if (seen[0] === found[side]) seen[1]++;
    else { seen[0] = found[side]; seen[1] = 1; }
    if (seen[1] >= BAR_FRAMES) this.bars[side] = found[side];
  }
  return this.bars;
};

// The eight zones of a strip run round the back of the TV, named by where they sit on the picture.
var STRIP_ZONES = ["tl", "t", "tr", "r", "br", "b", "bl", "l"];

// image: { w, h, bpp, data } (decoded PNG). dt: seconds since the previous picture.
// withZones: also return the eight edge zones (STRIP_ZONES) for a surround strip.
Analyser.prototype.analyse = function (image, dt, withZones) {
  var step = Math.max(1, Math.ceil(image.w / MAX_COLUMNS));
  var cols = Math.floor((image.w - 1) / step) + 1, rows = Math.floor((image.h - 1) / step) + 1;
  var count = cols * rows, grey = image.bpp < 3, x, y, i, p, k;
  var r = new Array(count), g = new Array(count), b = new Array(count);
  for (y = 0, i = 0; y < rows; y++) {
    for (x = 0; x < cols; x++, i++) {
      p = (y * step * image.w + x * step) * image.bpp;
      r[i] = image.data[p];
      g[i] = image.data[grey ? p : p + 1];
      b[i] = image.data[grey ? p : p + 2];
    }
  }

  // Seconds each sample has been unchanged.
  if (!this.prev || this.cols !== cols || this.rows !== rows) {
    this.bars = { top: 0, bottom: 0, left: 0, right: 0 };
    this.barSeen = { top: [0, 0], bottom: [0, 0], left: [0, 0], right: [0, 0] };
    this.prev = { r: r, g: g, b: b };
    this.still = new Array(count);
    for (i = 0; i < count; i++) this.still[i] = 0;
    this.cols = cols; this.rows = rows;
  }
  var limit = STATIC_DIFF * 255, moving = 0;
  for (i = 0; i < count; i++) {
    var changed = Math.abs(r[i] - this.prev.r[i]) > limit || Math.abs(g[i] - this.prev.g[i]) > limit ||
      Math.abs(b[i] - this.prev.b[i]) > limit;
    this.still[i] = changed ? 0 : this.still[i] + dt;
    if (this.still[i] < STATIC_AFTER) moving++;
  }
  this.prev = { r: r, g: g, b: b };
  // (Nearly) everything still, e.g. paused: use the whole picture at full weight.
  var allCount = moving < count * 0.1;
  var mask = new Array(count);
  for (i = 0; i < count; i++) {
    mask[i] = allCount ? 1 : Math.max(STATIC_WEIGHT, Math.min(1, 1 - (this.still[i] - STATIC_AFTER) / 2));
  }
  var bars = this.detectBars(r, g, b, cols, rows);
  for (y = 0, i = 0; y < rows; y++) {
    for (x = 0; x < cols; x++, i++) {
      if (y < bars.top || y >= rows - bars.bottom || x < bars.left || x >= cols - bars.right) mask[i] = 0;
    }
  }

  // The moving picture's own left and right edge (skips static pillarbox bars).
  var x0 = 0, x1 = cols, first = -1, last = -1, live = 0;
  for (x = 0; x < cols; x++) {
    var sum = 0;
    for (y = 0; y < rows; y++) sum += mask[y * cols + x];
    if (sum / rows > 0.5) { if (first < 0) first = x; last = x; live++; }
  }
  if (live >= cols * 0.3) { x0 = first; x1 = last + 1; }
  var e = Math.max(1, Math.round((x1 - x0) * EDGE));

  // Per sample: weight (vivid and bright count most), hue, brightness, linear colour.
  var weight = new Array(count), hue = new Array(count), value = new Array(count);
  for (i = 0; i < count; i++) {
    var rr = r[i] / 255, gg = g[i] / 255, bb = b[i] / 255;
    var hi = Math.max(rr, gg, bb), lo = Math.min(rr, gg, bb), d = hi - lo, h = 0;
    if (d > 0) {
      if (hi === rr) h = ((gg - bb) / d) % 6;
      else if (hi === gg) h = (bb - rr) / d + 2;
      else h = (rr - gg) / d + 4;
      h /= 6;
      if (h < 0) h += 1;
    }
    var sat = d / Math.max(hi, 1e-6);
    weight[i] = sat * sat * hi * mask[i];
    hue[i] = h;
    value[i] = hi;
  }

  var self = this;
  if (!this.peaks) this.peaks = {};
  function region(name, from, to, top, bottom) {
    var y0 = top === undefined ? 0 : top, y1 = bottom === undefined ? rows : bottom;
    // pass 1: hue histogram of the vivid pixels -> dominant hue
    var hist = [], cos = [], sin = [], bin, j, xx, yy;
    for (j = 0; j < HUE_BINS; j++) { hist.push(0); cos.push(0); sin.push(0); }
    for (yy = y0; yy < y1; yy++) {
      for (xx = from; xx < to; xx++) {
        j = yy * cols + xx;
        if (weight[j] <= 0) continue;
        bin = Math.floor(hue[j] * HUE_BINS) % HUE_BINS;
        hist[bin] += weight[j];
        cos[bin] += weight[j] * Math.cos(hue[j] * 2 * Math.PI);
        sin[bin] += weight[j] * Math.sin(hue[j] * 2 * Math.PI);
      }
    }
    function family(at) { // a bin with its neighbours: one hue family
      return hist[(at + HUE_BINS - 1) % HUE_BINS] + hist[at] + hist[(at + 1) % HUE_BINS];
    }
    var peak = 0;
    for (j = 1; j < HUE_BINS; j++) if (family(j) > family(peak)) peak = j;
    var before = self.peaks[name];
    if (before !== undefined && family(before) >= HUE_STICKY * family(peak)) peak = before;
    self.peaks[name] = peak;
    var pc = 0, ps = 0;
    for (j = -1; j <= 1; j++) {
      bin = (peak + j + HUE_BINS) % HUE_BINS;
      pc += cos[bin]; ps += sin[bin];
    }
    var peakHue = Math.atan2(ps, pc) / (2 * Math.PI), useHue = pc * pc + ps * ps > 1e-12;

    // pass 2: totals, with pixels far from the dominant hue fading out of the colour
    var t = emptySums(), sum = 0;
    for (yy = y0; yy < y1; yy++) {
      for (xx = from; xx < to; xx++) {
        j = yy * cols + xx;
        var m = mask[j], w = weight[j], near = 1;
        if (useHue && w > 0) {
          var dh = Math.abs(hue[j] - peakHue) % 1;
          if (dh > 0.5) dh = 1 - dh;
          near = Math.max(0, 1 - dh / HUE_WIDTH);
        }
        var wn = w * near * near;
        t.n += m; sum += w; t.w += wn; t.wv += wn * value[j]; t.hi += m * value[j];
        var lr = LINEAR[r[j]], lg = LINEAR[g[j]], lb = LINEAR[b[j]];
        t.wc[0] += wn * lr; t.wc[1] += wn * lg; t.wc[2] += wn * lb;
        t.c[0] += m * lr; t.c[1] += m * lg; t.c[2] += m * lb;
      }
    }
    t.all = sum; // colourfulness describes the whole region, not just the winning hue family
    return summarise(t);
  }
  var out = { left: region("left", x0, x0 + e), right: region("right", x1 - e, x1), center: region("center", 0, cols) };
  if (withZones) {
    // Picture rectangle without black bars; each zone is the edge band next to its part of the strip.
    var ya = Math.min(bars.top, rows - 1), yb = Math.max(ya + 1, rows - bars.bottom);
    var w = x1 - x0, h = yb - ya, ex = Math.max(1, Math.round(w * EDGE)), ey = Math.max(1, Math.round(h * EDGE));
    var xs = [x0, x0 + Math.round(w / 3), x0 + Math.round((2 * w) / 3), x1];
    var ys = [ya, ya + Math.round(h / 3), ya + Math.round((2 * h) / 3), yb];
    out.zones = {
      tl: region("tl", xs[0], Math.max(xs[0] + 1, xs[1]), ya, ya + ey),
      t: region("t", xs[1], Math.max(xs[1] + 1, xs[2]), ya, ya + ey),
      tr: region("tr", xs[2], Math.max(xs[2] + 1, xs[3]), ya, ya + ey),
      r: region("r", x1 - ex, x1, ys[1], Math.max(ys[1] + 1, ys[2])),
      br: region("br", xs[2], Math.max(xs[2] + 1, xs[3]), yb - ey, yb),
      b: region("b", xs[1], Math.max(xs[1] + 1, xs[2]), yb - ey, yb),
      bl: region("bl", xs[0], Math.max(xs[0] + 1, xs[1]), yb - ey, yb),
      l: region("l", x0, x0 + ex, ys[1], Math.max(ys[1] + 1, ys[2]))
    };
  }
  return out;
};

// ---- Oklab ------------------------------------------------------------------------------------------
function cbrt(v) {
  return v < 0 ? -Math.pow(-v, 1 / 3) : Math.pow(v, 1 / 3);
}

function toOklab(c) {
  var l = cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  var m = cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  var s = cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

function fromOklab(lab) {
  var l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
  var m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
  var s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2], 3);
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193263 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ];
}

// What gets smoothed: hue/strength in Oklab with chroma kept apart (a fade between two strong colours
// stays strong instead of passing through grey) and brightness on a cube-root scale.
function toTarget(region) {
  var c = region.colour, top = Math.max(c[0], c[1], c[2], 1e-6);
  var lab = toOklab([Math.max(0, c[0]) / top, Math.max(0, c[1]) / top, Math.max(0, c[2]) / top]);
  return [lab[0], lab[1], lab[2], Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]),
    Math.pow(Math.max(0, region.brightness), 1 / 3), region.colourfulness, region.overall];
}

function fromTarget(v) {
  var L = clamp01(v[0]), a = v[1], b = v[2], chroma = Math.max(0, v[3]), length = Math.sqrt(a * a + b * b);
  if (length > 1e-6) { a = (a / length) * chroma; b = (b / length) * chroma; }
  var bright = Math.max(0, v[4]);
  return { colour: fromOklab([L, a, b]), brightness: bright * bright * bright, colourfulness: v[5], overall: v[6] };
}

// Critically damped spring ("SmoothDamp"): eases in and out, never overshoots, slow for drifts and
// near-instant for a scene cut.
function Glide(value) {
  this.x = value.slice();
  this.v = value.map(function () { return 0; });
  this.cut = 0;
}

Glide.prototype.step = function (goal, dt) {
  var jump = Math.sqrt(Math.pow(goal[0] - this.x[0], 2) + Math.pow(goal[1] - this.x[1], 2) +
    Math.pow(goal[2] - this.x[2], 2)) + Math.abs(goal[4] - this.x[4]);
  this.cut = Math.max(Math.min(1, jump / CUT_SIZE), this.cut * Math.exp(-dt / (3 * CUT_SMOOTHING)));
  var seconds = SMOOTHING + (CUT_SMOOTHING - SMOOTHING) * this.cut;
  var omega = 2 / seconds, k = omega * dt, decay = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  for (var i = 0; i < goal.length; i++) {
    var change = this.x[i] - goal[i], temp = (this.v[i] + omega * change) * dt;
    var v = (this.v[i] - omega * temp) * decay, x = goal[i] + (change + temp) * decay;
    if ((goal[i] - this.x[i]) * (goal[i] - x) < 0) { x = goal[i]; v = 0; } // would swing past: stop there
    this.x[i] = x; this.v[i] = v;
  }
  return this.x;
};

// ---- what the bulb shows -----------------------------------------------------------------------------
function rgbToHsv(c) {
  var max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]), d = max - min, h = 0;
  if (d > 0) {
    if (max === c[0]) h = ((c[1] - c[2]) / d) % 6;
    else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

// Linear screen colour -> bulb hue, saturation, value (0..1): boosted saturation (less on a nearly
// grey screen), brightness from the screen with a floor.
function bulbHsv(region) {
  var hsv = rgbToHsv(region.colour);
  var amount = clamp01((region.colourfulness - GREY_BELOW) / (FULL_COLOUR_ABOVE - GREY_BELOW));
  return [hsv[0], Math.min(1, hsv[1] * VIVIDNESS * amount), Math.min(1, Math.max(MIN_BRIGHTNESS, region.brightness))];
}

// Warm white only on an almost entirely white screen; hysteresis keeps it from flipping.
function wantsWhite(region, wasWhite) {
  if (wasWhite) return !(region.colourfulness > COLOUR_ABOVE || region.overall < WHITE_SCREEN - 0.1);
  return region.overall > WHITE_SCREEN && region.colourfulness < NEUTRAL_BELOW;
}

// One screen part (left / center / right): analysed goals in, smoothed bulb state out.
function Region() {
  this.glide = null;
  this.goal = null;
  this.white = false;
}

Region.prototype.setGoal = function (summary) {
  this.goal = toTarget(summary);
  if (!this.glide) this.glide = new Glide(this.goal);
};

// Returns { mode: "colour", hsv } or { mode: "white" }, or null before the first picture.
Region.prototype.step = function (dt) {
  if (!this.goal) return null;
  var region = fromTarget(this.glide.step(this.goal, dt));
  this.white = wantsWhite(region, this.white);
  return this.white ? { mode: "white" } : { mode: "colour", hsv: bulbHsv(region) };
};

module.exports = {
  STRIP_ZONES: STRIP_ZONES,
  Analyser: Analyser,
  Region: Region,
  WHITE_BRIGHTNESS: WHITE_BRIGHTNESS,
  _internals: {
    summarise: summarise,
    toOklab: toOklab,
    fromOklab: fromOklab,
    toTarget: toTarget,
    fromTarget: fromTarget,
    Glide: Glide,
    bulbHsv: bulbHsv,
    rgbToHsv: rgbToHsv,
    wantsWhite: wantsWhite
  }
};
