import { test } from "node:test";
import assert from "node:assert/strict";
import { spliceHistory } from "../mods/agent-chat/parser.js";

test("spliceHistory handles empty and missing cached history", () => {
  const parsed = [{ type: "user", text: "hello" }, { type: "assistant", text: "hi" }];
  assert.deepStrictEqual(spliceHistory([], parsed), parsed);
  assert.deepStrictEqual(spliceHistory(null, parsed), parsed);
  assert.deepStrictEqual(spliceHistory(undefined, parsed), parsed);
});

test("spliceHistory appends if parsed has no user turn", () => {
  const cached = [{ type: "user", text: "start" }, { type: "assistant", text: "working..." }];
  const parsed = [{ type: "assistant", text: "still working..." }];
  const result = spliceHistory(cached, parsed);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].text, "start");
  assert.strictEqual(result[1].text, "working...");
  assert.strictEqual(result[2].text, "still working...");
});

test("spliceHistory with a repeated prompt keeps everything up to the second match", () => {
  // "continue" twice in cached; screen starts at the second one -> keeps everything up to the second
  const cached = [
    { type: "user", text: "continue" },
    { type: "thought", text: "thought 1" },
    { type: "assistant", text: "reply 1" },
    { type: "user", text: "continue" },
    { type: "thought", text: "thought 2" },
    { type: "assistant", text: "reply 2" },
  ];

  const parsed = [
    { type: "user", text: "continue" },
    { type: "thought", text: "thought 2 updated" },
    { type: "assistant", text: "reply 2 updated" },
  ];

  const result = spliceHistory(cached, parsed);

  // Cached had two "continue" prompts:
  // Items before the second "continue" (index 0, 1, 2) must be preserved.
  // The splice should occur at the LAST matching user turn (index 3).
  assert.strictEqual(result.length, 6);
  assert.strictEqual(result[0].type, "user");
  assert.strictEqual(result[0].text, "continue");
  assert.strictEqual(result[1].type, "thought");
  assert.strictEqual(result[1].text, "thought 1");
  assert.strictEqual(result[2].type, "assistant");
  assert.strictEqual(result[2].text, "reply 1");

  // Replaced from the second "continue" onward with parsed blocks
  assert.strictEqual(result[3].type, "user");
  assert.strictEqual(result[3].text, "continue");
  assert.strictEqual(result[4].type, "thought");
  assert.strictEqual(result[4].text, "thought 2 updated");
  assert.strictEqual(result[5].type, "assistant");
  assert.strictEqual(result[5].text, "reply 2 updated");
});

test("spliceHistory matches by 30-character prefix", () => {
  const cached = [
    { type: "user", text: "Please refactor the authentication module to use tokens" },
    { type: "assistant", text: "Working on auth..." },
  ];
  // Screen output with slight trailing differences but sharing the first 30 chars
  const parsed = [
    { type: "user", text: "Please refactor the authentication module to use tokens and cookies" },
    { type: "assistant", text: "Working on auth and cookies..." },
  ];

  const result = spliceHistory(cached, parsed);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].text, "Please refactor the authentication module to use tokens and cookies");
  assert.strictEqual(result[1].text, "Working on auth and cookies...");
});
