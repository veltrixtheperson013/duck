import assert from "node:assert/strict";
import test from "node:test";
import {
  differenceHash,
  findClosestHash,
  hammingDistance,
} from "../src/scam-images.js";

/**
 * Generates an 8x9 pixel row buffer for difference hash testing.
 * @param {number[]} values Row value pattern (9 numbers per row)
 * @returns {Buffer} An 8x9 pixel buffer (72 bytes)
 */
function createRowBuffer(values) {
  return Buffer.from(Array.from({ length: 8 }, () => values).flat());
}

test("Scam Image Hashing - Difference Hash Generation", async (t) => {
  await t.test("generates expected 64-bit hexadecimal difference hashes", () => {

    const zeroHash = differenceHash(createRowBuffer([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    assert.equal(zeroHash, "0000000000000000");

    const fullHash = differenceHash(createRowBuffer([8, 7, 6, 5, 4, 3, 2, 1, 0]));
    assert.equal(fullHash, "ffffffffffffffff");
  });

  await t.test("returns null for malformed or incomplete pixel buffers", () => {
    assert.equal(differenceHash(Buffer.alloc(71)), null);
    assert.equal(differenceHash(Buffer.alloc(0)), null);
    assert.equal(differenceHash(null), null);
  });
});

test("Scam Image Hashing - Hamming Distance & Matching", async (t) => {
  await t.test("calculates bitwise Hamming distance between valid hash strings", () => {
    assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
    assert.equal(hammingDistance("0000000000000000", "0000000000000003"), 2);
    assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
  });

  await t.test("returns Infinity for invalid hash strings or length mismatches", () => {
    assert.equal(hammingDistance("not-a-hash", "ffffffffffffffff"), Infinity);
    assert.equal(hammingDistance("0000", "ffffffffffffffff"), Infinity);
  });

  await t.test("finds the closest hash within a bounded max distance", () => {
    const knownHashes = {
      "0000000000000000": { reason: "known_scam_logo" },
      ffffffffffffffff: { reason: "unrelated_image" },
    };

    const match = findClosestHash("0000000000000003", knownHashes, 2);
    assert.deepEqual(match, {
      hash: "0000000000000000",
      distance: 2,
      metadata: { reason: "known_scam_logo" },
    });

    const noMatch = findClosestHash("000000000000000f", knownHashes, 2);
    assert.equal(noMatch, null);
  });
});