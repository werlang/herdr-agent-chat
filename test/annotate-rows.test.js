import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateRows, liveThoughtLine } from "../mods/agent-chat/transcript-blocks.js";

test("annotateRows sets liveLine on thought blocks from their text", () => {
  const headed = { type: "thought", text: "**Analyzing code**\nDetails follow here.", status: "done" };
  const plain = { type: "thought", text: "Streaming live thought. Second sentence.", status: "done" };
  annotateRows([headed, plain]);
  assert.equal(headed.liveLine, liveThoughtLine(headed.text));
  assert.equal(headed.liveLine, "Analyzing code");
  assert.equal(plain.liveLine, "Streaming live thought.");
});

test("annotateRows sets lineCount, isLong and preview on user blocks", () => {
  const short = { type: "user", text: "one\ntwo\nthree" };
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const long = { type: "user", text: lines.join("\n") };
  const empty = { type: "user" };
  annotateRows([short, long, empty]);

  assert.equal(short.lineCount, 3);
  assert.equal(short.isLong, false);
  assert.equal(short.preview, undefined);

  assert.equal(long.lineCount, 12);
  assert.equal(long.isLong, true);
  assert.equal(long.preview, `${lines.slice(0, 8).join("\n")}\n…`);

  assert.equal(empty.lineCount, 1);
  assert.equal(empty.isLong, false);
});

test("annotateRows marks a user block long when its text exceeds 600 characters", () => {
  const block = { type: "user", text: "x".repeat(601) };
  annotateRows([block]);
  assert.equal(block.lineCount, 1);
  assert.equal(block.isLong, true);
  assert.equal(block.preview, `${"x".repeat(601)}\n…`);
});

test("annotateRows takes activeDetail from the last running thought", () => {
  const blocks = [
    { type: "thought", text: "**First thought**\nbody", status: "running" },
    { type: "tool", title: "Bash · npm test", status: "running" },
    { type: "thought", text: "**Reading files**\nbody", status: "running" },
    { type: "thought", text: "**Done thought**\nbody", status: "done" },
  ];
  const { activeDetail } = annotateRows(blocks);
  assert.equal(activeDetail, "Reading files");
});

test("annotateRows falls back to the last running tool title when no thought runs", () => {
  const blocks = [
    { type: "thought", text: "**Finished**\nbody", status: "done" },
    { type: "tool", title: "Edit · main.js", status: "running" },
    { type: "tool", title: "Bash · npm test", status: "running" },
    { type: "tool", title: "Read · notes.md", status: "done" },
  ];
  const { activeDetail } = annotateRows(blocks);
  assert.equal(activeDetail, "Bash · npm test");
});

test("annotateRows uses running work inside a worked group for the working line", () => {
  const blocks = [
    {
      type: "tool_group",
      thoughts: [{ text: "**Reading files**\nbody", status: "running" }],
      tools: [{ title: "Bash · inner", status: "running" }],
      status: "running",
    },
  ];
  assert.equal(annotateRows(blocks).activeDetail, "Reading files");

  const toolOnly = [
    {
      type: "tool_group",
      thoughts: [],
      tools: [{ title: "Bash · inner", status: "running" }],
      status: "running",
    },
  ];
  assert.equal(annotateRows(toolOnly).activeDetail, "Bash · inner");
});

test("annotateRows returns an empty activeDetail when nothing runs", () => {
  const blocks = [
    { type: "user", text: "hi" },
    { type: "thought", text: "**Old**\nbody", status: "done" },
    { type: "tool", title: "Read · a.js", status: "done" },
  ];
  assert.equal(annotateRows(blocks).activeDetail, "");
  assert.equal(annotateRows([]).activeDetail, "");
});

test("annotateRows unwraps an hc envelope into a sender and plain text", async () => {
  const { annotateRows, unwrapHc } = await import("../mods/agent-chat/transcript-blocks.js");
  assert.deepEqual(unwrapHc('<hc from="t143">Do the thing.</hc>'), { from: "t143", text: "Do the thing." });
  assert.equal(unwrapHc("plain text"), null);
  const blocks = [{ type: "user", text: '<hc from="t9">\nhello there\n</hc>' }];
  annotateRows(blocks);
  assert.equal(blocks[0].from, "t9");
  assert.equal(blocks[0].text, "hello there");
  // Running again on the already unwrapped block changes nothing.
  annotateRows(blocks);
  assert.equal(blocks[0].from, "t9");
  assert.equal(blocks[0].text, "hello there");
});
