"use strict";

var assert = require("node:assert/strict");
var test = require("node:test");
var colour = require("../services/tizen/runtime/ambilight-colour.cjs");
var internals = colour._internals;

function image(width, height, pixel) {
  var data = Buffer.alloc(width * height * 3);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      var c = pixel(x, y),
        at = (y * width + x) * 3;
      data[at] = c[0];
      data[at + 1] = c[1];
      data[at + 2] = c[2];
    }
  }
  return { w: width, h: height, bpp: 3, data: data };
}

function hueOf(summary) {
  return internals.rgbToHsv(summary.colour)[0];
}

test("left and right follow the picture's outer edges, center the whole picture", function () {
  var summary = new colour.Analyser().analyse(
    image(20, 10, function (x) {
      return x < 4 ? [200, 0, 0] : x >= 16 ? [0, 0, 200] : [0, 160, 0];
    }),
    0.1
  );
  assert.ok(Math.abs(hueOf(summary.left) - 0) < 0.01);
  assert.ok(Math.abs(hueOf(summary.right) - 2 / 3) < 0.01);
  assert.ok(Math.abs(hueOf(summary.center) - 1 / 3) < 0.05); // green covers most of the picture
});

test("a vivid colour outweighs a larger grey area, like Ambilight's dominant colour", function () {
  var summary = new colour.Analyser().analyse(
    image(20, 10, function (x, y) {
      return y < 2 ? [220, 30, 30] : [120, 120, 120];
    }),
    0.1
  );
  var hsv = internals.rgbToHsv(summary.center.colour);
  assert.ok(hsv[1] > 0.9, "dominant colour stays red, not muddy: " + hsv[1]);
  assert.ok(Math.abs(hsv[0]) < 0.02);
});

test("black bars that never change stop counting after a while", function () {
  var analyser = new colour.Analyser(),
    frame = 0,
    summary;
  for (var t = 0; t < 130; t++) {
    frame++;
    summary = analyser.analyse(
      image(20, 10, function (x) {
        if (x < 3 || x >= 17) return [0, 0, 0];
        return frame % 2 ? [0, 0, 220] : [0, 0, 180];
      }),
      0.1
    );
  }
  assert.ok(
    summary.left.brightness > 0.5,
    "left edge measured inside the picture: " + summary.left.brightness
  );
});

test("grey video gives neutral light, colourful video gets extra saturation", function () {
  var grey = internals.bulbHsv({
    colour: [0.3, 0.29, 0.29],
    brightness: 0.5,
    colourfulness: 0.001,
    overall: 0.5
  });
  assert.equal(grey[1], 0);
  var vivid = internals.bulbHsv({
    colour: [0.6, 0.3, 0.3],
    brightness: 0.5,
    colourfulness: 0.2,
    overall: 0.5
  });
  assert.ok(Math.abs(vivid[1] - 0.75) < 1e-6); // 0.5 * 1.5
  var dark = internals.bulbHsv({
    colour: [0.01, 0, 0],
    brightness: 0.01,
    colourfulness: 0.2,
    overall: 0.01
  });
  assert.equal(dark[2], 0.15);
});

test("between pictures the light glides through intermediate colours instead of jumping", function () {
  var region = new colour.Region();
  region.setGoal({ colour: [1, 0, 0], brightness: 0.8, colourfulness: 0.3, overall: 0.5 });
  assert.ok(region.step(0.05).hsv[0] < 1e-6);
  region.setGoal({ colour: [1, 1, 0], brightness: 0.8, colourfulness: 0.3, overall: 0.5 });
  var hues = [];
  for (var i = 0; i < 40; i++) hues.push(region.step(0.05).hsv[0]);
  var target = 1 / 6;
  assert.ok(
    hues[0] > 0.001 && hues[0] < target - 0.01,
    "first step is between red and yellow: " + hues[0]
  );
  for (var k = 1; k < hues.length; k++)
    assert.ok(hues[k] >= hues[k - 1] - 1e-9, "never swings back");
  assert.ok(Math.abs(hues[hues.length - 1] - target) < 0.01, "arrives: " + hues[hues.length - 1]);
});

test("an almost white screen switches to warm white and stays there through small changes", function () {
  var region = new colour.Region();
  region.setGoal({ colour: [1, 1, 1], brightness: 0.95, colourfulness: 0.001, overall: 0.95 });
  assert.equal(region.step(0.05).mode, "white");
  region.setGoal({ colour: [1, 0.98, 0.98], brightness: 0.9, colourfulness: 0.015, overall: 0.9 });
  assert.equal(region.step(0.05).mode, "white");
  region.setGoal({ colour: [0, 0, 1], brightness: 0.5, colourfulness: 0.3, overall: 0.4 });
  for (var i = 0; i < 20; i++) region.step(0.05);
  assert.equal(region.step(0.05).mode, "colour");
});

test("two different vivid colours give one of them, not a blend that is not on screen", function () {
  var analyser = new colour.Analyser(),
    summary;
  for (var k = 0; k < 4; k++) {
    summary = analyser.analyse(
      image(20, 10, function (x, y) {
        return y < 6 ? [220, 40, 20] : [20, 60, 220]; // orange-red above, blue below
      }),
      0.1
    );
  }
  var hsv = internals.rgbToHsv(summary.center.colour);
  assert.ok(hsv[0] < 0.05 || hsv[0] > 0.95, "red family wins: " + hsv[0]);
  assert.ok(hsv[1] > 0.8, "and stays saturated: " + hsv[1]);
});

test("a near-tie keeps the previous colour instead of flipping", function () {
  var analyser = new colour.Analyser(),
    summary,
    redRows = 6;
  function frame() {
    return analyser.analyse(
      image(20, 10, function (x, y) {
        return y < redRows ? [220, 30, 30] : [30, 30, 220];
      }),
      0.1
    );
  }
  frame();
  redRows = 5; // now an even split: red stays
  summary = frame();
  var h = internals.rgbToHsv(summary.center.colour)[0];
  assert.ok(h < 0.05 || h > 0.95, "still red: " + h);
});

test("letterbox bars stop counting within a few pictures", function () {
  var analyser = new colour.Analyser(),
    summary;
  for (var k = 0; k < 3; k++) {
    summary = analyser.analyse(
      image(20, 10, function (x, y) {
        return y < 2 || y >= 8 ? [0, 0, 0] : [200, 200, 200];
      }),
      0.1
    );
  }
  assert.ok(
    summary.center.overall > 0.75,
    "bars no longer darken the picture: " + summary.center.overall
  );
});

// ---- strip zones: area statistic that ignores small bright details --------------------------------
// 80x45 picture (the sample grid of a 320x180 capture): dark blue scene, optionally with a line of
// bright subtitle text in the bottom edge band.
function darkScene(withText, textColour) {
  return image(80, 45, function (x, y) {
    // text: thin strokes, every other column, in two rows of the bottom band (~6% of zone "b")
    var inText = withText && (y === 40 || y === 42) && x >= 30 && x < 50 && x % 2 === 0;
    if (inText) return textColour;
    return [12 + (x % 3), 18, 60 + (y % 2)]; // dark blue with a little texture
  });
}

function zonesOf(picture) {
  var analyser = new colour.Analyser(),
    out;
  for (var k = 0; k < 3; k++) out = analyser.analyse(picture, 0.1, true).zones;
  return out;
}

test("a few bright subtitle pixels in a dark zone do not swing its colour or brightness", function () {
  var plain = zonesOf(darkScene(false)),
    white = zonesOf(darkScene(true, [255, 255, 255]));
  var yellow = zonesOf(darkScene(true, [255, 235, 0]));
  ["b", "bl", "br"].forEach(function (name) {
    [white, yellow].forEach(function (zones, i) {
      var label = name + (i ? " yellow" : " white");
      assert.ok(
        Math.abs(hueOf(zones[name]) - hueOf(plain[name])) < 0.02,
        label + " hue " + hueOf(zones[name])
      );
      assert.ok(
        Math.abs(zones[name].brightness - plain[name].brightness) < 0.02,
        label + " brightness " + zones[name].brightness + " vs " + plain[name].brightness
      );
    });
  });
  // the zone really is blue, not yellow
  var hue = hueOf(yellow.b);
  assert.ok(hue > 0.55 && hue < 0.75, "bottom zone stays blue: " + hue);
});

test("a bright area that fills a good part of the zone still counts", function () {
  var zones = zonesOf(
    image(80, 45, function (x, y) {
      return y >= 39 && x >= 27 && x < 53 ? [240, 30, 20] : [12, 18, 60]; // red block over ~2/3 of zone "b"
    })
  );
  var hsv = internals.rgbToHsv(zones.b.colour);
  assert.ok(hsv[0] < 0.05 || hsv[0] > 0.95, "red wins: " + hsv[0]);
  assert.ok(zones.b.brightness > 0.5, "and lights the zone: " + zones.b.brightness);
});

test("the bulbs' left/center/right keep their untrimmed statistic", function () {
  var plain = new colour.Analyser().analyse(darkScene(false), 0.1);
  var text = new colour.Analyser().analyse(darkScene(true, [255, 255, 255]), 0.1);
  assert.ok(
    text.center.overall > plain.center.overall,
    "the white text still counts for the bulbs"
  );
});

test("zones from a native source map to the same summaries as a uniform picture", function () {
  var zones = [];
  for (var i = 0; i < 8; i++) zones.push(i < 4 ? [200, 20, 20] : [20, 20, 200]);
  var summaries = colour.summariesFromZones(zones);
  assert.deepEqual(Object.keys(summaries.zones), colour.STRIP_ZONES);
  assert.ok(Math.abs(hueOf(summaries.zones.tl)) < 0.01);
  assert.ok(Math.abs(hueOf(summaries.zones.l) - 2 / 3) < 0.01);
  var uniform = new colour.Analyser().analyse(
    image(20, 10, function () {
      return [200, 20, 20];
    }),
    0.1
  ).center;
  var fromRgb = colour.summaryFromRgb([200, 20, 20]);
  assert.ok(Math.abs(uniform.brightness - fromRgb.brightness) < 1e-6);
  assert.ok(Math.abs(uniform.colourfulness - fromRgb.colourfulness) < 1e-6);
  for (var k = 0; k < 3; k++) assert.ok(Math.abs(uniform.colour[k] - fromRgb.colour[k]) < 1e-6);
  assert.ok(summaries.left && summaries.right && summaries.center);
});
