import assert from "node:assert";
import { parseConversation, stripAnsi } from "../mods/agent-chat/parser.js";

// Test 1: stripAnsi
const ansiText = "\x1b[32mHello\x1b[0m \x1b[1mWorld\x1b[0m\r\n";
assert.strictEqual(stripAnsi(ansiText), "Hello World\n");

// Test 2: Startup banner & bottom chrome stripping
const sampleBannerAndChrome = `
      ▄▀▀▄        Antigravity CLI 1.4.12
     ▀▀▀▀▀▀       user@example.com (Google AI Pro)
    ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (High)
   ▄▀▀    ▀▀▄     ~/Documents/Workspaces/herdr/herdr-agent-chat
  ▄▀▀      ▀▀▄

────────────────────────────────────────────────────────────
> what is the status?
  Can you check it?

○ Thought for 3.2s (Checking repository health...)
● Explored 1 file (README.md)
● Ran 2 commands (git status · npm test)
⎿ exit 0
… 5 more actions …

Here is the current status:
- All tests passing
- Working directory clean

\`\`\`sh
git status
# clean
\`\`\`

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
esc to cancel                                                                          Gemini 3.8 Flash · high
`;

const blocks = parseConversation(sampleBannerAndChrome);
console.log("Parsed blocks count:", blocks.length);
blocks.forEach((b, i) => console.log(`  [${i}] ${b.type}:`, b.title || b.header || b.text?.slice(0, 40)));

assert.strictEqual(blocks[0].type, "user");
assert.ok(blocks[0].text.includes("what is the status?"));
assert.ok(blocks[0].text.includes("Can you check it?"));

assert.strictEqual(blocks[1].type, "thought");
assert.strictEqual(blocks[1].duration, "3.2s");
assert.strictEqual(blocks[1].summary, "Checking repository health...");

assert.strictEqual(blocks[2].type, "tool_group");
assert.strictEqual(blocks[2].count, 3);
assert.strictEqual(blocks[2].tools[0].title, "Explored 1 file (README.md)");
assert.strictEqual(blocks[2].tools[1].title, "Ran 2 commands (git status · npm test)");
assert.ok(blocks[2].tools[1].detail.includes("⎿ exit 0"));

assert.strictEqual(blocks[3].type, "assistant");
assert.ok(blocks[3].text.includes("Here is the current status:"));
assert.ok(blocks[3].text.includes("```sh"));
assert.ok(!blocks[3].text.includes("esc to cancel"));
assert.ok(!blocks[3].text.includes("Gemini 3.8 Flash"));

// Test 3: Multi-turn conversation
const multiTurn = `
> turn 1 question

○ Thought for 1s
● Ran 1 command
Answer 1

────────────────────────────────────────────────────────────
> turn 2 question

○ Thought for 2s
Answer 2
`;

const multiBlocks = parseConversation(multiTurn);
assert.strictEqual(multiBlocks.length, 7);
assert.strictEqual(multiBlocks[0].type, "user");
assert.strictEqual(multiBlocks[0].text, "turn 1 question");
assert.strictEqual(multiBlocks[1].type, "thought");
assert.strictEqual(multiBlocks[2].type, "tool");
assert.strictEqual(multiBlocks[3].type, "assistant");
assert.strictEqual(multiBlocks[3].text, "Answer 1");
assert.strictEqual(multiBlocks[4].type, "user");
assert.strictEqual(multiBlocks[4].text, "turn 2 question");
assert.strictEqual(multiBlocks[5].type, "thought");
assert.strictEqual(multiBlocks[6].type, "assistant");
assert.strictEqual(multiBlocks[6].text, "Answer 2");

// Test 4: Thought with nested parentheses in summary
const thoughtWithParens = `
> test question
○ Thought for 2m 24s (Checking for required files (e.g. foo(bar))...)
Answer
`;
const thoughtBlocks = parseConversation(thoughtWithParens);
assert.strictEqual(thoughtBlocks[1].type, "thought");
assert.strictEqual(thoughtBlocks[1].duration, "2m 24s");
assert.strictEqual(thoughtBlocks[1].summary, "Checking for required files (e.g. foo(bar))...");
assert.strictEqual(thoughtBlocks[1].text, "Checking for required files (e.g. foo(bar))...");

console.log("All parser unit tests passed successfully!");

