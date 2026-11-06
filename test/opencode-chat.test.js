import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildOpenCodePollQuery,
  messageItems,
  OpenCodeItemCache,
} from "../mods/agent-chat/opencode-data.js";
import { itemsToBlocks } from "../mods/agent-chat/transcript-blocks.js";

/** A tool part with the same shape OpenCode stores. */
function toolPart(name, input, status = "completed", at = 1000) {
  return {
    type: "tool",
    name,
    state: {
      status,
      input,
      content: [{ type: "text", text: `${name} output` }],
    },
    time: { created: at, ran: at + 50, completed: at + 120 },
  };
}

/** An assistant row with reasoning, tools and a final text part. */
function assistantRow(seq, text = "Done.") {
  return {
    time: { created: 1000, completed: 4000 },
    model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
    content: [
      { type: "reasoning", text: "First thought", time: { created: 1000, completed: 1100 } },
      toolPart("read", { path: "a.js" }, "completed", 1200),
      { type: "reasoning", text: "Second thought", time: { created: 1400, completed: 1500 } },
      toolPart("grep", { pattern: "needle" }, "completed", 1600),
      { type: "text", text },
    ],
  };
}

test("OpenCode item cache recomputes only changed rows and output stays identical", () => {
  const messages = new Map([
    [1, { type: "user", data: { text: "hello", files: [] } }],
    [10, { type: "assistant", data: assistantRow(10) }],
    [12, { type: "assistant", data: assistantRow(12, "Later.") }],
  ]);

  const cache = new OpenCodeItemCache();
  for (const [seq, { type, data }] of messages) cache.set(seq, type, data);
  assert.equal(cache.rebuilds, 3, "initial load computes every row");
  const first = cache.collect(messages);
  const cachedTen = cache.bySeq.get(10).items;

  // A poll with one changed row only recomputes that row.
  cache.rebuilds = 0;
  messages.set(12, { type: "assistant", data: assistantRow(12, "Even later.") });
  const changed = messages.get(12);
  cache.set(12, changed.type, changed.data);
  cache.collect(messages);
  assert.equal(cache.rebuilds, 1, "only the changed seq is recomputed");
  assert.strictEqual(cache.bySeq.get(10).items, cachedTen, "unchanged row keeps its items");

  // The cached output equals a from-scratch computation for the same data.
  const fresh = new OpenCodeItemCache();
  for (const [seq, { type, data }] of messages) fresh.set(seq, type, data);
  const expected = fresh.collect(messages);
  const actual = cache.collect(messages);
  assert.deepEqual(actual, expected);

  assert.deepEqual(
    actual.items.map((item) => item.type),
    ["user", "thought", "tool", "thought", "tool", "assistant", "thought", "tool", "thought", "tool", "assistant"]
  );
});

test("OpenCode items carry the assistant turn and its worked duration", () => {
  const { items, model, effort, hasModel } = messageItems(10, "assistant", assistantRow(10));
  assert.equal(model, "deepseek-v4.1-flash");
  assert.equal(effort, "max");
  assert.equal(hasModel, true);
  for (const item of items) {
    if (item.type === "assistant" || item.type === "tool") assert.equal(item.turn, 10);
  }
  assert.equal(items.find((item) => item.type === "tool").workedMs, 3000);
});

test("tool calls from one conversation turn become one Worked for Xs group", () => {
  const { items } = messageItems(10, "assistant", assistantRow(10));
  const blocks = itemsToBlocks(items, false);

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["tool_group", "assistant"]
  );
  const group = blocks[0];
  assert.equal(group.count, 2);
  assert.equal(group.tools.length, 2);
  assert.deepEqual(group.thoughts.map((thought) => thought.text), ["First thought", "Second thought"]);
  assert.deepEqual(
    group.tools.map((tool) => tool.title),
    ["read · a.js", "grep · needle"]
  );
  assert.equal(group.summary, "Worked for 3s");
  assert.equal(group.turn, 10);
  assert.equal(blocks[1].text, "Done.");
});

test("a single tool in a turn is still one Worked group", () => {
  const data = {
    time: { created: 1000, completed: 2500 },
    content: [toolPart("read", { path: "only.js" })],
  };
  const { items } = messageItems(20, "assistant", data);
  const blocks = itemsToBlocks(items, false);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "tool_group");
  assert.equal(blocks[0].count, 1);
  assert.equal(blocks[0].summary, "Worked for 1.5s");
});

test("text between tools does not split a turn's Worked section", () => {
  const items = [
    { type: "user", text: "do it" },
    { type: "thought", text: "thinking", turn: 5 },
    { type: "tool", title: "read · a.js", action: "read", status: "done", changedFiles: [], workedMs: 3000, turn: 5 },
    { type: "assistant", text: "Partial answer.", turn: 5 },
    { type: "tool", title: "read · b.js", action: "read", status: "done", changedFiles: [], workedMs: 3000, turn: 5 },
    { type: "assistant", text: "Final answer.", turn: 5 },
  ];
  const blocks = itemsToBlocks(items, false);
  const groups = blocks.filter((block) => block.type === "tool_group");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].thoughts.map((thought) => thought.text), ["thinking"]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["user", "tool_group", "assistant", "assistant"]
  );
  assert.equal(blocks.at(-1).text, "Final answer.");
});

test("each user turn gets its own Worked group", () => {
  const first = messageItems(10, "assistant", assistantRow(10, "First done.")).items;
  const second = messageItems(12, "assistant", assistantRow(12, "Second done.")).items;
  const blocks = itemsToBlocks(
    [
      { type: "user", text: "first" },
      ...first,
      { type: "user", text: "second" },
      ...second,
    ],
    false
  );
  const groups = blocks.filter((block) => block.type === "tool_group");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.turn), [10, 12]);
  assert.deepEqual(groups.map((group) => group.count), [2, 2]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["user", "tool_group", "assistant", "user", "tool_group", "assistant"]
  );
});

test("a 77-message session rebuilds all rows once, then one per changed poll", () => {
  const messages = new Map();
  for (let seq = 1; seq <= 77; seq++) {
    const data = seq % 2 ? { text: `message ${seq}` } : assistantRow(seq, `done ${seq}`);
    messages.set(seq, { type: seq % 2 ? "user" : "assistant", data });
  }
  const cache = new OpenCodeItemCache();
  for (const [seq, { type, data }] of messages) cache.set(seq, type, data);
  assert.equal(cache.rebuilds, 77);

  cache.rebuilds = 0;
  const lastSeq = 77;
  const changed = messages.get(lastSeq);
  cache.set(lastSeq, changed.type, changed.data);
  cache.collect(messages);
  assert.equal(cache.rebuilds, 1);
});

test("execute tool title comes from its first meaningful code line", () => {
  const data = {
    time: { created: 1000, completed: 2000 },
    content: [
      toolPart("execute", {
        code: 'const r = await tools["ai-memory"].memory_query({ query: "x" });\nreturn r;',
      }),
    ],
  };
  const { items } = messageItems(30, "assistant", data);
  const title = items[0].title;
  assert.ok(title.startsWith("execute · "));
  assert.ok(title.includes("ai-memory.memory_query"));
  assert.ok(!title.includes("const"));
});

test("one poll query resolves the session and fetches messages", () => {
  const sql = buildOpenCodePollQuery({
    title: "demo",
    cwd: "/repo",
    since: 123,
    knownSessionId: "sess_a",
  });
  assert.ok(sql.includes("with s as"));
  assert.ok(sql.includes("union all"));
  assert.ok(sql.includes("'session' as kind"));
  assert.ok(sql.includes("'message' as kind"));
  assert.ok(sql.includes("time_updated >= 123"));
  assert.ok(sql.includes("sess_a"));
  assert.ok(sql.includes("order by ord, seq"));
  assert.equal((sql.match(/session_v2/g) || []).length, 1);
  assert.equal((sql.match(/session_message/g) || []).length, 1);
});

test("OpenCode refresh runs exactly one sqlite query and no separate locate", async () => {
  const source = await readFile(
    new URL("../mods/agent-chat/opencode-transcript.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async refresh(");
  const end = source.indexOf("\n  /**", start);
  const body = source.slice(start, end);
  assert.equal((body.match(/this\.sql\(/g) || []).length, 1);
  assert.ok(body.includes("buildOpenCodePollQuery"));
  assert.ok(!body.includes("locate("));
});

test("noticeItem surfaces errors, interruptions, model switches and compactions", async () => {
  const { noticeItem } = await import("../mods/agent-chat/opencode-data.js");
  assert.deepEqual(noticeItem(5, "assistant", { error: { type: "provider.transport", message: "Timed out" } }), {
    type: "notice", tone: "error", text: "Timed out", seq: 5, turn: 5,
  });
  assert.equal(noticeItem(6, "idle", { outcome: "interrupted" }).text, "Interrupted");
  assert.equal(noticeItem(6, "idle", { outcome: "failed" }).tone, "error");
  assert.equal(noticeItem(6, "idle", { outcome: "succeeded" }), null);
  assert.equal(
    noticeItem(7, "model-switched", { model: { id: "big-pickle", providerID: "opencode", variant: "max" } }).text,
    "Model switched to big-pickle · max"
  );
  assert.equal(noticeItem(8, "compaction", { status: "completed" }).text, "Earlier conversation compacted");
  assert.equal(noticeItem(8, "compaction", { status: "running" }), null);
  assert.equal(noticeItem(9, "shell", { command: "ls" }), null);
});

test("messageItems turns an idle row into a notice and keeps model out of it", () => {
  const r = messageItems(12, "idle", { outcome: "interrupted" });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, "notice");
  assert.equal(r.hasModel, false);
});

test("a failed assistant row keeps its content and adds the error notice after it", () => {
  const r = messageItems(20, "assistant", {
    model: { id: "m", providerID: "p" },
    content: [{ type: "text", text: "partial" }],
    error: { message: "Rate limited" },
  });
  assert.deepEqual(r.items.map((i) => i.type), ["assistant", "notice"]);
  assert.equal(r.hasModel, true);
});

test("itemsToBlocks keeps a notice after the worked group and gives the group an activity line", () => {
  const blocks = itemsToBlocks(
    [
      { type: "user", text: "go" },
      { type: "tool", name: "bash", input: { command: "ls" }, title: "bash · ls", detail: "x", status: "done", turn: 2, workedMs: 3000 },
      { type: "assistant", text: "done", seq: 2, turn: 2 },
      { type: "notice", tone: "error", text: "Timed out", seq: 3, turn: 3 },
    ],
    false
  );
  assert.deepEqual(blocks.map((b) => b.type), ["user", "tool_group", "assistant", "notice"]);
  assert.match(blocks[1].activity, /Ran 1 command/);
  assert.match(blocks[1].summary, /^Worked for/);
});

test("claude-style items fold a run of thoughts and tools into one section, in order", () => {
  const tool = (name, status = "done") => ({ type: "tool", name, input: { command: name }, title: `bash · ${name}`, detail: "out", status });
  const blocks = itemsToBlocks(
    [
      { type: "user", text: "go" },
      { type: "thought", text: "first thought", status: "done" },
      tool("ls"),
      { type: "thought", text: "second thought", status: "done" },
      tool("pwd"),
      { type: "assistant", text: "narration between runs" },
      { type: "thought", text: "alone", status: "done" },
      { type: "assistant", text: "done" },
    ],
    false
  );
  assert.deepEqual(blocks.map((b) => b.type), ["user", "tool_group", "assistant", "thought", "assistant"]);
  assert.equal(blocks[1].count, 2);
  assert.deepEqual(blocks[1].thoughts.map((x) => x.text), ["first thought", "second thought"]);
});
