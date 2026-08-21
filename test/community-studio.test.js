import assert from "node:assert/strict";
import test from "node:test";
import { levelForXp } from "../src/community-studio.js";

test("Pond Levels use predictable quadratic XP thresholds", () => {
  assert.equal(levelForXp(0), 0);
  assert.equal(levelForXp(99), 0);
  assert.equal(levelForXp(100), 1);
  assert.equal(levelForXp(899), 2);
  assert.equal(levelForXp(900), 3);
  assert.equal(levelForXp(-50), 0);
});
