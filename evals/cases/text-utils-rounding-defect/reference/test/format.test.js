import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes } from "../src/format.js";

test("formats bytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1048576), "1 MB");
});

test("rejects invalid input", () => {
  assert.throws(() => formatBytes(-1), TypeError);
  assert.throws(() => formatBytes(Number.NaN), TypeError);
});

test("values that round to 1024 move to the next unit", () => {
  assert.equal(formatBytes(1048575), "1 MB");
  assert.equal(formatBytes(1073741823), "1 GB");
  assert.equal(formatBytes(1047552), "1023 KB");
});
