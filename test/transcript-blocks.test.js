import { test } from "node:test";
import assert from "node:assert/strict";
import {
  textOf,
  clip,
  toolTitle,
  itemsToBlocks,
  MAX_DETAIL,
} from "../mods/agent-chat/transcript-blocks.js";

test("textOf extracts plain text from strings and arrays", () => {
  // textOf of a string
  assert.strictEqual(textOf("plain text string"), "plain text string");
  assert.strictEqual(textOf(""), "");

  // textOf of an array
  const parts = [
    { type: "text", text: "Line 1" },
    { type: "image", data: "..." },
    { type: "text", text: "Line 2" },
  ];
  assert.strictEqual(textOf(parts), "Line 1\nLine 2");
  assert.strictEqual(textOf([]), "");
  assert.strictEqual(textOf(null), "");
  assert.strictEqual(textOf(undefined), "");
  assert.strictEqual(textOf(123), "");
});

test("clip cuts text over 4000 characters and leaves shorter text intact", () => {
  assert.strictEqual(MAX_DETAIL, 4000);
  const shortText = "x".repeat(3999);
  assert.strictEqual(clip(shortText), shortText);

  const exactText = "x".repeat(4000);
  assert.strictEqual(clip(exactText), exactText);

  // clip over 4000
  const longText = "a".repeat(4050);
  const clipped = clip(longText);
  assert.strictEqual(clipped.slice(0, 4000), "a".repeat(4000));
  assert.strictEqual(clipped, `${"a".repeat(4000)}\n… (50 more characters)`);
  assert.strictEqual(clip(""), "");
  assert.strictEqual(clip(null), "");
});

test("toolTitle prioritizes description, uses basename of file_path, and truncates over 120", () => {
  // description first
  const descTitle = toolTitle("Bash", {
    description: "Run unit test suite",
    command: "npm test -- --coverage",
    file_path: "/workspace/src/test.js",
  });
  assert.strictEqual(descTitle, "Bash · Run unit test suite");

  // basename of file_path
  const fileTitle = toolTitle("Edit", {
    file_path: "/Users/dev/workspace/herdr/mods/agent-chat/main.js",
  });
  assert.strictEqual(fileTitle, "Edit · main.js");

  const notebookTitle = toolTitle("View", {
    notebook_path: "/notebooks/analysis/report.ipynb",
  });
  assert.strictEqual(notebookTitle, "View · report.ipynb");

  // truncation over 120
  const longCommand = "curl -X POST https://example.com/api/v1/resource -H 'Authorization: Bearer test' -H 'Content-Type: application/json' --data '{\"test\":true}'";
  assert.ok(longCommand.length > 120);
  const truncated = toolTitle("Bash", { command: longCommand });
  assert.ok(truncated.startsWith("Bash · "));
  const summaryPart = truncated.slice("Bash · ".length);
  assert.strictEqual(summaryPart.length, 119); // 118 chars + "…"
  assert.ok(summaryPart.endsWith("…"));
  assert.strictEqual(summaryPart, longCommand.slice(0, 118) + "…");

  // fallback when no input
  assert.strictEqual(toolTitle("CustomTool"), "CustomTool");
});

test("itemsToBlocks handles tool grouping", () => {
  // Single tool is not grouped into tool_group
  const single = itemsToBlocks(
    [{ type: "tool", title: "Read · file.txt", detail: "content", status: "done" }],
    true
  );
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].type, "tool");
  assert.strictEqual(single[0].title, "Read · file.txt");

  // Consecutive tools form a tool_group
  const items = [
    { type: "user", text: "Do work" },
    { type: "tool", title: "Tool 1", detail: "out 1", status: "done" },
    { type: "tool", title: "Tool 2", detail: "out 2", status: "done" },
    { type: "tool", title: "Tool 3", detail: "out 3", status: "running" },
    { type: "assistant", text: "Finished" },
  ];
  const blocks = itemsToBlocks(items, true);
  assert.strictEqual(blocks.length, 3);
  assert.strictEqual(blocks[0].type, "user");
  assert.strictEqual(blocks[1].type, "tool_group");
  assert.strictEqual(blocks[1].count, 3);
  assert.strictEqual(blocks[1].status, "running");
  assert.strictEqual(blocks[1].tools.length, 3);
  assert.strictEqual(blocks[1].tools[0].title, "Tool 1");
  assert.strictEqual(blocks[1].tools[2].status, "running");
  assert.strictEqual(blocks[2].type, "assistant");
});

test("itemsToBlocks marks running tool done when !agentWorking", () => {
  // Single tool running while agent stopped (!agentWorking) -> marked done
  const singleRunning = [{ type: "tool", title: "Bash · sleep 10", detail: "", status: "running" }];
  const stoppedBlocks = itemsToBlocks(singleRunning, false);
  assert.strictEqual(stoppedBlocks.length, 1);
  assert.strictEqual(stoppedBlocks[0].status, "done");

  // Tool group with a running tool while !agentWorking -> tools and group marked done
  const groupRunning = [
    { type: "tool", title: "T1", detail: "ok", status: "done" },
    { type: "tool", title: "T2", detail: "", status: "running" },
  ];
  const stoppedGroupBlocks = itemsToBlocks(groupRunning, false);
  assert.strictEqual(stoppedGroupBlocks.length, 1);
  assert.strictEqual(stoppedGroupBlocks[0].type, "tool_group");
  assert.strictEqual(stoppedGroupBlocks[0].status, "done");
  assert.strictEqual(stoppedGroupBlocks[0].tools[1].status, "done");

  // When agentWorking is true, running status is preserved
  const stillWorkingBlocks = itemsToBlocks(singleRunning, true);
  assert.strictEqual(stillWorkingBlocks[0].status, "running");
});
