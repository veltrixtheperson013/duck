import assert from "node:assert/strict";
import test from "node:test";
import { differenceHash, findClosestHash, hammingDistance } from "../src/scam-images.js";

function rows(values) {
  return Buffer.from(Array.from({ length: 8 }, () => values).flat());
}

test("scam image hashing produces stable 64-bit difference hashes", () => {
  assert.equal(differenceHash(rows([0, 1, 2, 3, 4, 5, 6, 7, 8])), "0000000000000000");
  assert.equal(differenceHash(rows([8, 7, 6, 5, 4, 3, 2, 1, 0])), "ffffffffffffffff");
  assert.equal(differenceHash(Buffer.alloc(71)), null);
});

test("scam image matching uses a bounded Hamming distance", () => {
  assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hammingDistance("not-a-hash", "ffffffffffffffff"), Infinity);
  const entries = {
    "0000000000000000": { reason: "known" },
    ffffffffffffffff: { reason: "far" }
  };
  assert.deepEqual(findClosestHash("0000000000000003", entries, 2), {
    hash: "0000000000000000",
    distance: 2,
    metadata: { reason: "known" }
  });
  assert.equal(findClosestHash("000000000000000f", entries, 2), null);
});
