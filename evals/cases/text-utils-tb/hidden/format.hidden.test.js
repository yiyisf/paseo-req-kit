import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes } from "../src/format.js";

const TB = 1024 ** 4;

test("FR-1 TB", () => {
  assert.equal(formatBytes(TB), "1 TB");
  assert.equal(formatBytes(1.5 * TB), "1.5 TB");
  assert.equal(formatBytes(2048 * TB), "2048 TB");
});

test("FR-2 negative numbers", () => {
  assert.equal(formatBytes(-1536), "-1.5 KB");
  assert.equal(formatBytes(-1), "-1 B");
  for (const bad of [Number.NaN, Infinity, -Infinity, "12"]) assert.throws(() => formatBytes(bad), TypeError);
});

test("FR-3 decimals", () => {
  assert.equal(formatBytes(1536, { decimals: 2 }), "1.50 KB");
  assert.equal(formatBytes(1536, { decimals: 0 }), "2 KB");
  assert.equal(formatBytes(1048576), "1 MB");
  assert.equal(formatBytes(1048576, { decimals: 1 }), "1.0 MB");
  assert.equal(formatBytes(512, { decimals: 2 }), "512 B");
  for (const bad of [-1, 4, 1.5]) assert.throws(() => formatBytes(1, { decimals: bad }), RangeError);
});

test("FR-4 existing behaviour", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
});
