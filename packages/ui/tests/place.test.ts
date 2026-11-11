/** `place` (src/components/place.ts): side, position and height limit of a
 * floating piece, from the boxes the host reports. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { place } from "../src/components/place";

// A 600 px tall clip (a scroller at y 100), a 260 x 34 trigger.
const clip = { x: 40, y: 100, width: 800, height: 600 };
const trigger = (y: number, x = 100) => ({ x, y, width: 260, height: 34 });
const size = { width: 260, height: 300 };

test("opens on the preferred side when it fits", () => {
  const below = place({ anchor: trigger(150), clip, size, offset: 6 });
  assert.deepEqual(below, { side: "bottom", x: 100, y: 190, height: 300, maxHeight: 692 - 190 });
  const above = place({ anchor: trigger(500), clip, size, side: "top", offset: 6 });
  assert.equal(above.side, "top");
  assert.equal(above.y + above.height, 494, "6 px above the trigger");
});

test("flips when the preferred side lacks room and the other has more", () => {
  // Near the bottom: 692 - (640 + 34 + 6) = 12 px below, 640 - 6 - 108 = 526 above.
  const flipped = place({ anchor: trigger(640), clip, size, offset: 6 });
  assert.equal(flipped.side, "top");
  assert.equal(flipped.height, 300);
  assert.equal(flipped.y, 640 - 6 - 300);
  // `auto` is bottom with the same rule.
  assert.equal(place({ anchor: trigger(640), clip, size, side: "auto", offset: 6 }).side, "top");
  assert.equal(place({ anchor: trigger(150), clip, size, side: "auto", offset: 6 }).side, "bottom");
  // Near the top, preferring top: flips down.
  assert.equal(place({ anchor: trigger(120), clip, size, side: "top", offset: 6 }).side, "bottom");
});

test("stays on the preferred side when the other has no more room", () => {
  // A short clip: 100 px either side; neither fits 300.
  const short = { x: 40, y: 100, width: 800, height: 240 };
  const at = place({ anchor: trigger(203), clip: short, size, offset: 6, margin: 8 });
  assert.equal(at.side, "bottom");
  // Above has more room (203 - 6 - 108 = 89 vs 340 - 8 - 243 = 89): equal, so it stays.
  assert.equal(at.maxHeight, 89);
});

test("limits the height to the room on the chosen side", () => {
  const short = { x: 40, y: 100, width: 800, height: 260 };
  const at = place({ anchor: trigger(250), clip: short, size, offset: 6, margin: 8 });
  // Above: 250 - 6 - 108 = 136; below: 352 - 290 = 62. Above has more.
  assert.equal(at.side, "top");
  assert.equal(at.maxHeight, 136);
  assert.equal(at.height, 136);
  assert.equal(at.y, 108, "starts at the clip's top margin");
});

test("shifts horizontally to stay inside the clip", () => {
  const wide = { width: 320, height: 100 };
  // Aligned at the start, it would end at 760 + 320 = 1080 > 832.
  assert.equal(place({ anchor: trigger(150, 760), clip, size: wide }).x, 840 - 8 - 320);
  // Aligned at the end of a trigger near the left edge, it would start at 40 + 260 - 320 = -20.
  assert.equal(place({ anchor: trigger(150, 40), clip, size: wide, align: "end" }).x, 48);
  // Centred.
  assert.equal(place({ anchor: trigger(150, 300), clip, size: wide, align: "center" }).x, 270);
  // Wider than the clip: its left edge stays in.
  assert.equal(place({ anchor: trigger(150), clip, size: { width: 900, height: 10 } }).x, 48);
});
