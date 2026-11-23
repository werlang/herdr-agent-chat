import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "herdr") {
      return { url: "data:text/javascript,export function hc(){} export function exec(){} export function home(){return ''} export function readTextFile(){return ''} export function terminals(){return []} export function agents(){return []}", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const {
  unwrapHc,
  settingChange,
  stripHarnessXml,
  screenModel,
  groupAntigravityModels,
  terminalMachine,
  terminalLocalAddress,
  extractChangedFiles,
} = await import("../mods/agent-chat/transcript-blocks.js");
const { buildOpenCodePollQuery, messageItems } = await import("../mods/agent-chat/opencode-data.js");
const { parseConversation } = await import("../mods/agent-chat/parser.js");
const { claudeUserText, ClaudeTranscript } = await import("../mods/agent-chat/claude-transcript.js");
const { ingestCodexEntry } = await import("../mods/agent-chat/codex-transcript.js");
const { ingestAntigravityEntry } = await import("../mods/agent-chat/antigravity-transcript.js");

test("terminalMachine and terminalLocalAddress split remote addresses", () => {
  assert.equal(terminalMachine("rpi5/t16r"), "rpi5");
  assert.equal(terminalLocalAddress("rpi5/t16r"), "t16r");
  assert.equal(terminalMachine("t25k"), null);
  assert.equal(terminalLocalAddress("t25k"), "t25k");
});

test("unwrapHc clears local ppid: sender and keeps agent-to-agent sender", () => {
  assert.deepEqual(
    unwrapHc('<hc from="4c78d16e/ppid:12345">hello world</hc>'),
    { from: null, text: "hello world" }
  );
  assert.deepEqual(
    unwrapHc('<hc from="t2a" to="t2b">check tests</hc>'),
    { from: "t2a", text: "check tests" }
  );
});

test("settingChange strips (default) inside backticks and parses notices", () => {
  assert.deepEqual(
    settingChange("<local-command-stdout>Set model to `Opus 5.5 (default)`</local-command-stdout>"),
    { model: "Opus 5.5" }
  );
  assert.deepEqual(
    settingChange("<local-command-stdout>Set effort level to xhigh</local-command-stdout>"),
    { effort: "xhigh" }
  );
  assert.deepEqual(
    settingChange("<local-command-stdout>Model set to `Sonnet 5.5`</local-command-stdout>"),
    { model: "Sonnet 5.5" }
  );
});

test("stripHarnessXml removes injected harness tags and unwraps USER_REQUEST", () => {
  const raw = [
    "<ADDITIONAL_METADATA>time: 123</ADDITIONAL_METADATA>",
    "<USER_SETTINGS_CHANGE>model: gemini-4-neon-high</USER_SETTINGS_CHANGE>",
    "<USER_REQUEST>\nFix the bug\n</USER_REQUEST>",
    "<system-reminder>do not show</system-reminder>",
  ].join("\n");
  assert.equal(stripHarnessXml(raw), "Fix the bug");
});

test("screenModel reads Codex, Claude, and OpenCode footers", () => {
  assert.equal(screenModel("gpt-5.4 high · 100% left · ~/work", "codex"), "gpt-5.4 high");
  assert.equal(screenModel("Opus 5.5 · Claude Max", "claude"), "Opus 5.5");
});

test("groupAntigravityModels groups effort variants by family", () => {
  const grouped = groupAntigravityModels([
    { id: "gemini-4-neon-low", label: "Gemini 4 Neon (low)" },
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (high)" },
    { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].id, "gemini-4-neon");
  assert.equal(grouped[0].label, "Gemini 4 Neon");
  assert.deepEqual(grouped[0].efforts, ["low", "high"]);
  assert.equal(grouped[0].variants.high, "gemini-4-neon-high");
});

test("extractChangedFiles handles Antigravity Path and Codex apply_patch", () => {
  assert.deepEqual(extractChangedFiles("write_file", { Path: "/a/b.js" }), ["/a/b.js"]);
  assert.deepEqual(
    extractChangedFiles("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/app.js\n@@" }),
    ["src/app.js"]
  );
});

test("OpenCode query uses sessionId when given and filters harness XML from user messages", () => {
  const sql = buildOpenCodePollQuery({ sessionId: "ses_abc123", since: 100 });
  assert.match(sql, /where id = 'ses_abc123'/);
  const res = messageItems(1, "user", { text: "<system-reminder>x</system-reminder>\nHello" });
  assert.deepEqual(res.items, [{ type: "user", text: "Hello" }]);
  const cmd = messageItems(2, "user", { text: "/models" });
  assert.deepEqual(cmd.items, []);
});

test("claudeUserText and ClaudeTranscript filter harness messages and deduplicate queued prompts", () => {
  assert.equal(claudeUserText("Base directory for this skill: /tmp/x"), null);
  assert.equal(claudeUserText("[Image: source: /tmp/a.png]"), null);
  assert.equal(claudeUserText("This session is being continued from a previous conversation"), null);
  assert.equal(claudeUserText("hi <system-reminder>secret</system-reminder>"), "hi");

  const tr = new ClaudeTranscript("t1");
  tr.ingest({ type: "user", promptSource: "system", message: { content: "system prompt" } });
  tr.ingest({ type: "user", origin: { kind: "task-notification" }, message: { content: "task done" } });
  tr.ingest({ type: "attachment", attachment: { type: "queued_command", origin: { kind: "human" }, prompt: "run tests" } });
  tr.ingest({ type: "user", message: { content: "run tests" } });
  assert.deepEqual(tr.items, [{ type: "user", text: "run tests" }]);
});

test("ingestCodexEntry filters environment_context and parses user/assistant/tools/settings", () => {
  const state = { items: [], tools: new Map(), model: null, effort: null, sessionId: null };
  ingestCodexEntry(state, { type: "turn_context", payload: { model: "gpt-5.4", effort: "high" } });
  ingestCodexEntry(state, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }] },
    },
  });
  ingestCodexEntry(state, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "input_text", text: "list files" }] },
    },
  });
  ingestCodexEntry(state, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "CommandExecution", command: "ls -la", aggregated_output: "a.js", exit_code: 0 },
    },
  });
  ingestCodexEntry(state, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "AgentMessage", content: [{ type: "output_text", text: "Found a.js." }] },
    },
  });
  assert.equal(state.model, "gpt-5.4");
  assert.equal(state.effort, "high");
  assert.deepEqual(state.items.map((i) => i.type), ["user", "tool", "assistant"]);
});

test("ingestAntigravityEntry strips harness metadata, links GENERIC tool results, and ignores checkpoints", () => {
  const state = { items: [], tools: new Map(), lastTool: null, model: null, effort: null };
  ingestAntigravityEntry(state, {
    type: "USER_INPUT",
    content: "<ADDITIONAL_METADATA>cwd: /app</ADDITIONAL_METADATA>\n<USER_REQUEST>\ncheck status\n</USER_REQUEST>",
  });
  ingestAntigravityEntry(state, {
    type: "PLANNER_RESPONSE",
    model: "gemini-4-neon-high",
    thinking: "Checking files",
    tool_calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ Path: "/app/main.js" }) }],
    content: "All good.",
  });
  ingestAntigravityEntry(state, {
    type: "GENERIC",
    tool_call_id: "c1",
    content: "Created At: 2026-01-01\nCompleted At: 2026-01-01\n\nfile contents",
  });
  ingestAntigravityEntry(state, { type: "CHECKPOINT", content: "snap" });
  assert.equal(state.model, "gemini-4-neon-high");
  assert.deepEqual(state.items.map((i) => i.type), ["user", "thought", "tool", "assistant"]);
  assert.equal(state.items[2].detail, "file contents");
  assert.equal(state.items[2].status, "done");
});

test("parseConversation keeps Claude ● prose as assistant and Codex › as user", () => {
  const screen = [
    "› hello codex",
    "● Here is the explanation in prose.",
    "● Read(main.js)",
    "How is Claude doing this session? (optional)",
    "1: Bad  2: Fine  3: Good  0: Dismiss",
  ].join("\n");
  const blocks = parseConversation(screen);
  assert.deepEqual(blocks.map((b) => b.type), ["user", "assistant", "tool"]);
  assert.equal(blocks[0].text, "hello codex");
  assert.equal(blocks[1].text, "Here is the explanation in prose.");
  assert.equal(blocks[2].title, "Read(main.js)");
});
