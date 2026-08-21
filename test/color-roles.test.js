import assert from "node:assert/strict";
import test from "node:test";
import { colorOptionEmoji, hexColor } from "../src/color-roles.js";

test("Color Dock formats bounded colors and readable swatches", () => {
  assert.equal(hexColor(0x20a4a8), "#20A4A8");
  assert.equal(hexColor(-50), "#000000");
  assert.equal(hexColor(0xffffff + 1), "#FFFFFF");
  assert.equal(colorOptionEmoji(0xff1010), "🟥");
  assert.equal(colorOptionEmoji(0x1010ff), "🟦");
});
