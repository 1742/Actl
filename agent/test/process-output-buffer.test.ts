import assert from "node:assert/strict";
import test from "node:test";
import { ProcessOutputBuffer } from "../src/runtime/process/process-output-buffer.js";

test("line reads span output chunks and preserve stream order", () => {
  const buffer = new ProcessOutputBuffer(1024);
  buffer.append("stdout", "first\nsec");
  buffer.append("stderr", "ond\nthird");

  const fromSecond = buffer.readFromLine(2);
  assert.deepEqual(fromSecond.chunks.map(({ stream, text }) => ({ stream, text })), [
    { stream: "stdout", text: "sec" },
    { stream: "stderr", text: "ond\nthird" },
  ]);
  assert.equal(fromSecond.nextLine, 3);
  assert.equal(fromSecond.truncated, false);
  assert.deepEqual(buffer.readFromLine(4).chunks, []);
});

test("line reads report when the requested line has been truncated", () => {
  const buffer = new ProcessOutputBuffer(9);
  buffer.append("stdout", "first\nsec");
  buffer.append("stdout", "ond\nthird");

  const second = buffer.readFromLine(2);
  assert.equal(second.truncated, true);
  assert.equal(second.chunks.map((chunk) => chunk.text).join(""), "ond\nthird");
  const third = buffer.readFromLine(3);
  assert.equal(third.truncated, false);
  assert.equal(third.chunks.map((chunk) => chunk.text).join(""), "third");
});

test("an oversized chunk retains complete lines when its tail starts at a line boundary", () => {
  const buffer = new ProcessOutputBuffer(6);
  buffer.append("stdout", "old\nnew\n");
  const result = buffer.readFromLine(2);
  assert.equal(result.truncated, false);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(""), "new\n");
  assert.equal(buffer.readFromLine(1).truncated, true);
});
