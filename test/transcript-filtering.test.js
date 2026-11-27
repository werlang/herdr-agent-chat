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
  estimateBlockHeight,
  computeFeedLayout,
  parseClaudeModelsResponse,
  parseCodexModelsResponse,
  parseAntigravityModelsOutput,
  parseMarkdownBlocks,
  resolveInternalFileLink,
  prependEarlierBlocks,
  preserveScrollOnResize,
  applyPrependAnchor,
  matchesModelQuery,
  parseScreenModel,
} = await import("../mods/agent-chat/transcript-blocks.js");
const { buildOpenCodePollQuery, buildOpenCodeEarlierQuery, messageItems } = await import("../mods/agent-chat/opencode-data.js");
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

test("computeFeedLayout computes top-to-bottom offsets, maxScroll, and preserves anchor on earlier batch", () => {
  const blocks = Array.from({ length: 20 }, (_, i) => ({
    type: i % 2 === 0 ? "user" : "assistant",
    ekey: `${i % 2 === 0 ? "user" : "assistant"}#${i}`,
    text: `Message ${i}\nLine 2\nLine 3`,
  }));
  const tail = computeFeedLayout(blocks.slice(10), null, 400, true, 760);
  assert.ok(tail.maxScroll > 0);
  assert.equal(tail.rowOffsets.length, 10);

  const expanded = computeFeedLayout(blocks, null, 400, false, 760);
  assert.ok(expanded.maxScroll > tail.maxScroll);
  assert.ok(estimateBlockHeight({ type: "notice", tone: "warning", text: "Rate limit warning" }) >= 44);
});

test("OpenCode query isolates new sessions via minCreatedMs when title and sessionId are absent", () => {
  const sql = buildOpenCodePollQuery({ cwd: "/repo", minCreatedMs: 1795450000000 });
  assert.match(sql, /time_created >= 1795450000000/);
  assert.match(sql, /directory = '\/repo'/);
});

test("harness warning and error notices are ingested by Claude, Codex, and Antigravity readers", () => {
  const claude = new ClaudeTranscript("t1");
  claude.ingest({ type: "system", subtype: "api_error", level: "warning", message: "5h limit warning" });
  claude.ingest({ type: "user", message: { content: "<local-command-stderr>Unknown flag</local-command-stderr>" } });
  assert.deepEqual(
    claude.items.map((i) => ({ type: i.type, tone: i.tone, text: i.text })),
    [
      { type: "notice", tone: "warning", text: "5h limit warning" },
      { type: "notice", tone: "warning", text: "Unknown flag" },
    ]
  );

  const codexState = { items: [], tools: new Map(), model: null, effort: null, sessionId: null };
  ingestCodexEntry(codexState, { type: "event_msg", payload: { type: "warning", message: "Approaching quota" } });
  ingestCodexEntry(codexState, { type: "event_msg", payload: { type: "error", message: "Request failed" } });
  assert.deepEqual(
    codexState.items.map((i) => ({ type: i.type, tone: i.tone, text: i.text })),
    [
      { type: "notice", tone: "warning", text: "Approaching quota" },
      { type: "notice", tone: "error", text: "Request failed" },
    ]
  );

  const agyState = { items: [], tools: new Map(), lastTool: null, model: null, effort: null };
  ingestAntigravityEntry(agyState, { type: "WARNING_MESSAGE", content: "Tool timeout" });
  ingestAntigravityEntry(agyState, { type: "ERROR_MESSAGE", error: "Upstream 503" });
  assert.deepEqual(
    agyState.items.map((i) => ({ type: i.type, tone: i.tone, text: i.text })),
    [
      { type: "notice", tone: "warning", text: "Tool timeout" },
      { type: "notice", tone: "error", text: "Upstream 503" },
    ]
  );
});

test("harness discovery parsers extract models and capabilities from CLI outputs", () => {
  const claudeOut = [
    '{"type":"system","subtype":"hook_started"}',
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        response: {
          models: [
            {
              value: "fable",
              resolvedModel: "claude-fable-5-2",
              displayName: "Fable",
              description: "Fable 5.2",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            },
          ],
        },
      },
    }),
  ].join("\n");
  const claudeModels = parseClaudeModelsResponse(claudeOut);
  assert.equal(claudeModels.length, 1);
  assert.equal(claudeModels[0].id, "fable");
  assert.equal(claudeModels[0].resolvedModel, "claude-fable-5-2");
  assert.deepEqual(claudeModels[0].efforts, ["low", "medium", "high", "xhigh", "max"]);

  const codexOut = [
    '{"id":1,"result":{"userAgent":"herdr"}}',
    JSON.stringify({
      id: 2,
      result: {
        data: [
          {
            id: "gpt-6.2-sol",
            displayName: "GPT-6.2-Sol",
            description: "Go-to model",
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          },
          { id: "hidden-model", hidden: true },
        ],
      },
    }),
  ].join("\n");
  const codexModels = parseCodexModelsResponse(codexOut);
  assert.equal(codexModels.length, 1);
  assert.equal(codexModels[0].slug, "gpt-6.2-sol");
  assert.deepEqual(
    codexModels[0].supported_reasoning_levels.map((e) => e.effort),
    ["low", "high"]
  );

  const agyOut = "\r⠋ Fetching...\r\ngemini-4-neon-high   Gemini 4 Neon (High)\r\ngemini-4-argon-low  Gemini 4 Argon (Low)\r\n";
  const agyModels = parseAntigravityModelsOutput(agyOut);
  assert.deepEqual(agyModels, [
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  ]);
});

test("parseMarkdownBlocks parses headings, nested bullet lists, ordered lists, and code blocks", () => {
  const md = [
    "### 1. Section",
    "- **Top item**: description",
    "  - Nested item A",
    "  - Nested item B",
    "1. Ordered first",
    "2. Ordered second",
    "```js",
    "const x = 1;",
    "```",
  ].join("\n");
  const blocks = parseMarkdownBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "list", "list", "code"]);
  assert.equal(blocks[0].level, 3);
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[1].items[0].blocks.length, 2);
  assert.equal(blocks[1].items[0].blocks[1].type, "list");
  assert.equal(blocks[1].items[0].blocks[1].items.length, 2);
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[3].lang, "js");
});

test("AntigravityTranscript locates transcript_full.jsonl before transcript.jsonl", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../mods/agent-chat/antigravity-transcript.js", import.meta.url), "utf8");
  assert.match(src, /transcript_full\.jsonl/);
  assert.ok(src.indexOf("transcript_full.jsonl") < src.indexOf("'transcript.jsonl'"));
});

test("resolveInternalFileLink resolves file:// URLs, absolute paths, and relative paths for file-editor", () => {
  assert.equal(resolveInternalFileLink("https://github.com/pingdotgg/t3code"), null);
  assert.equal(resolveInternalFileLink("#section"), null);

  assert.deepEqual(
    resolveInternalFileLink("file:///Users/pablowerlang/ws/herdr-agent-chat/mods/agent-chat/main.js#L12-L20", "/Users/pablowerlang/ws/herdr-agent-chat"),
    {
      fullPath: "/Users/pablowerlang/ws/herdr-agent-chat/mods/agent-chat/main.js",
      folder: "/Users/pablowerlang/ws/herdr-agent-chat",
      file: "mods/agent-chat/main.js",
      name: "main.js",
      line: 12,
    }
  );

  assert.deepEqual(
    resolveInternalFileLink("./src/../mods/file%20name.js:42", "/repo"),
    {
      fullPath: "/repo/mods/file%20name.js",
      folder: "/repo",
      file: "mods/file%20name.js",
      name: "file%20name.js",
      line: 42,
    }
  );

  assert.deepEqual(
    resolveInternalFileLink("file:///tmp/my%20file.md", "/repo"),
    {
      fullPath: "/tmp/my file.md",
      folder: "/tmp",
      file: "my file.md",
      name: "my file.md",
      line: null,
    }
  );
});

test("prependEarlierBlocks deduplicates overlap and prepends only earlier CLI blocks", () => {
  const older = [
    { type: "user", text: "turn 1" },
    { type: "assistant", text: "reply 1" },
    { type: "user", text: "turn 2" },
  ];
  const current = [
    { type: "user", text: "turn 2" },
    { type: "assistant", text: "reply 2" },
  ];
  const res = prependEarlierBlocks(older, current);
  assert.equal(res.addedCount, 2);
  assert.deepEqual(res.merged.map((b) => b.text), ["turn 1", "reply 1", "turn 2", "reply 2"]);

  const noNew = prependEarlierBlocks(current, current);
  assert.equal(noNew.addedCount, 0);
});

test("buildOpenCodePollQuery supports tail limit and buildOpenCodeEarlierQuery pages older seq", () => {
  const limited = buildOpenCodePollQuery({ sessionId: "ses_1", since: 0, limit: 20 });
  assert.match(limited, /order by seq desc limit 20\)/);
  assert.equal((limited.match(/session_v2/g) || []).length, 1);
  assert.equal((limited.match(/session_message/g) || []).length, 1);

  const unlimited = buildOpenCodePollQuery({ sessionId: "ses_1", since: 100 });
  assert.doesNotMatch(unlimited, /order by seq desc limit/);

  const earlier = buildOpenCodeEarlierQuery({ sessionId: "ses_1", beforeSeq: 45, limit: 20 });
  assert.match(earlier, /session_id = 'ses_1' and seq < 45/);
  assert.match(earlier, /order by seq desc limit 20$/);
});

test("preserveScrollOnResize keeps scrollY constant when viewport height changes", () => {
  const scrollFromBottom = 240;
  const prevMax = 1000;
  const nextMax = 1044; // working bar appeared, shrinking viewport by 44px
  const nextFromBottom = preserveScrollOnResize(scrollFromBottom, prevMax, nextMax);
  const prevScrollY = prevMax - scrollFromBottom;
  const nextScrollY = nextMax - nextFromBottom;
  assert.equal(nextScrollY, prevScrollY);
  assert.equal(nextFromBottom, 284);
});

test("applyPrependAnchor shifts scrollY by exact real height delta so visible rows stay pixel-locked", () => {
  const prevScrollY = 40;
  const prevHeight = 2100;
  const newHeight = 3450; // +1350px prepended above viewport
  const nextScrollY = applyPrependAnchor(prevScrollY, prevHeight, newHeight);
  assert.equal(nextScrollY, 1390);
  // Item originally at y = 440px (screen y = 440 - 40 = 400px) is now at y = 1790px:
  assert.equal(440 + (newHeight - prevHeight) - nextScrollY, 400);
});

test("parseAntigravityModelsOutput parses TSV and padded agy models output", () => {
  const sample = [
    "\x1b[?25l⠋ Fetching available models...\r",
    "ID\tLABEL",
    "gemini-4-neon-high\tGemini 4 Neon (High)",
    "gemini-4-neon-low\tGemini 4 Neon (Low)",
    "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
  ].join("\n");
  assert.deepEqual(parseAntigravityModelsOutput(sample), [
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
    { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
  ]);
});

test("groupAntigravityModels sorts efforts canonically and handles effort-less models", () => {
  const grouped = groupAntigravityModels([
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
    { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (XHigh)" },
    { id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)" },
    { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
    { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
  ]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(grouped[0].label, "Gemini 4 Neon");
  assert.deepEqual(grouped[1].efforts, []);
  assert.equal(grouped[1].variants.default, "gemini-pro-orchestrator-neon");
});

test("matchesModelQuery filters case-insensitively across multiple tokens and fields", () => {
  const fields = ["Claude Opus 5.5", "claude-opus-5-5", "Anthropic", "anthropic"];
  assert.equal(matchesModelQuery("", fields), true);
  assert.equal(matchesModelQuery("   ", fields), true);
  assert.equal(matchesModelQuery("opus", fields), true);
  assert.equal(matchesModelQuery("anthropic opus", fields), true);
  assert.equal(matchesModelQuery("OPUS 5.5", fields), true);
  assert.equal(matchesModelQuery("gemini opus", fields), false);
});

test("parseScreenModel reads real Antigravity, Codex, Claude, and OpenCode footers", () => {
  assert.deepEqual(
    parseScreenModel("esc to cancel                                              auto · Gemini 4 Neon · low", "antigravity"),
    { model: "Gemini 4 Neon", effort: "low" }
  );
  assert.deepEqual(
    parseScreenModel("? for shortcuts                                    accept-edits · Gemini 4 Neon · low", "agy"),
    { model: "Gemini 4 Neon", effort: "low" }
  );
  assert.deepEqual(
    parseScreenModel("auto · Gemini 4 Neon · high", "antigravity"),
    { model: "Gemini 4 Neon", effort: "high" }
  );
  assert.deepEqual(
    parseScreenModel("esc to cancel                                              auto · Orchestrator (Neon)", "antigravity"),
    { model: "Orchestrator (Neon)", effort: null }
  );
  assert.deepEqual(
    parseScreenModel("? for shortcuts                                    Gemini 3.8 Flash · medium", "antigravity"),
    { model: "Gemini 3.8 Flash", effort: "medium" }
  );

  assert.deepEqual(
    parseScreenModel("  GPT-6.2-Sol medium · ~/workspaces/node-aec · Analise o progresso da etapa", "codex"),
    { model: "GPT-6.2-Sol", effort: "medium" }
  );
  assert.deepEqual(
    parseScreenModel("  GPT-6.2-Sol medium · /home/workspaces/gladcode2 · Revisar WP1", "codex"),
    { model: "GPT-6.2-Sol", effort: "medium" }
  );
  assert.deepEqual(
    parseScreenModel("  GPT-6.1 Terra extra high · ~/project", "codex"),
    { model: "GPT-6.1 Terra", effort: "xhigh" }
  );
  assert.deepEqual(
    parseScreenModel("gpt-5.4 high · 100% left · ~/work", "codex"),
    { model: "gpt-5.4", effort: "high" }
  );

  assert.deepEqual(
    parseScreenModel("▐▛███▜▌  Opus 5.5 with medium effort · Claude Pro\n◉ xhigh · /effort", "claude-code"),
    { model: "Opus 5.5", effort: "xhigh" }
  );
  assert.deepEqual(
    parseScreenModel("Opus 5.5 · Claude Max", "claude-code"),
    { model: "Opus 5.5", effort: null }
  );
  assert.deepEqual(
    parseScreenModel("Sonnet 4.6 (1M context)", "claude-code"),
    { model: "Sonnet 4.6", effort: null }
  );

  assert.deepEqual(
    parseScreenModel("  ┃  Build auto · DeepSeek V4.1 Flash 1017 OpenCode Go · max", "opencode"),
    { model: "DeepSeek V4.1 Flash 1017 OpenCode Go", effort: "max" }
  );
  assert.deepEqual(
    parseScreenModel("  ┃  Build · DeepSeek V4.1 Flash 1017 OpenCode Go · max", "opencode"),
    { model: "DeepSeek V4.1 Flash 1017 OpenCode Go", effort: "max" }
  );
  // A fresh TUI renders few lines and pads the rest of the screen with blanks;
  // the footer must still be found outside the last 20 physical lines.
  const freshScreen =
    "  ┃  Ask anything…\n" +
    "  ┃  Build auto · DeepSeek V4.1 Flash 1017 OpenCode Go · max\n" +
    "\n".repeat(40);
  assert.deepEqual(parseScreenModel(freshScreen, "opencode"), {
    model: "DeepSeek V4.1 Flash 1017 OpenCode Go",
    effort: "max",
  });
});

test("ingestAntigravityEntry parses Model Selection changes from USER_SETTINGS_CHANGE", () => {
  const state = { items: [], tools: new Map(), lastTool: null, model: null, effort: null };
  ingestAntigravityEntry(state, {
    type: "USER_INPUT",
    content: "<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 4 Neon (Medium). No need to comment.</USER_SETTINGS_CHANGE><USER_REQUEST>hi</USER_REQUEST>",
  });
  assert.equal(state.model, "Gemini 4 Neon");
  assert.equal(state.effort, "medium");
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, "hi");
});

test("parseScreenModel reads the OpenCode 2.4 footer without a Build/Plan prefix", () => {
  const screen = [
    "            /update to install",
    "            v2.4.2",
    "",
    " ┃",
    " ┃ Ask anything… \"What is the tech stack",
    " ┃",
    " ┃ DeepSeek V4.1 Flash 1017 · max",
    " ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    " ~/workspaces/node-aec:dev",
    "",
  ].join("\n");
  assert.deepEqual(parseScreenModel(screen, "opencode"), { model: "DeepSeek V4.1 Flash 1017", effort: "max" });
  const noVariant = screen.replace(" · max", "");
  assert.deepEqual(parseScreenModel(noVariant, "opencode"), { model: "DeepSeek V4.1 Flash 1017", effort: null });
  const emptyBox = " ┃\n ┃ Ask anything…\n ┃\n ╹▀▀▀▀▀▀▀▀▀▀\n";
  assert.equal(parseScreenModel(emptyBox, "opencode"), null);
});

test("ingestAntigravityEntry emits notices only for real model/effort switches", () => {
  const state = { items: [], tools: new Map(), lastTool: null, model: null, effort: null };
  const change = (from, to) => ingestAntigravityEntry(state, {
    type: "USER_INPUT",
    content: `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from ${from} to ${to}. No need to comment.</USER_SETTINGS_CHANGE>`,
  });
  change("None", "Gemini 3.8 Flash (Medium)");
  assert.equal(state.model, "Gemini 3.8 Flash");
  assert.deepEqual(state.items, []);
  change("Gemini 3.8 Flash (Medium)", "Gemini 3.8 Flash (High)");
  assert.equal(state.effort, "high");
  change("Gemini 3.8 Flash (High)", "Orchestrator (Neon)");
  assert.equal(state.model, "Orchestrator (Neon)");
  assert.deepEqual(state.items.map((i) => i.text), ["Effort set to high", "Model set to Orchestrator (Neon)"]);
});

test("ingestCodexEntry emits notices only when thread settings change", async () => {
  const { ingestCodexEntry } = await import("../mods/agent-chat/codex-transcript.js");
  const state = { items: [], tools: new Map(), model: null, effort: null, sessionId: null };
  const applied = (model, reasoning_effort) => ingestCodexEntry(state, {
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings: { model, reasoning_effort } },
  });
  applied("gpt-6.2-sol", "medium");
  applied("gpt-6.2-sol", "medium");
  assert.deepEqual(state.items, []);
  applied("gpt-6.2-sol", "high");
  applied("gpt-6.1-terra", "high");
  assert.deepEqual(state.items.map((i) => i.text), ["Effort set to high", "Model set to gpt-6.1-terra"]);
  assert.equal(state.model, "gpt-6.1-terra");
});

test("screen parsers stay fast on a soft-wrapped single-line screen", async () => {
  const { parseScreenChoice, screenAwaitsChoice } = await import("../mods/agent-chat/parser.js");
  // A narrow full-screen TUI wraps every row, so the whole screen is one line.
  const line = `${" ".repeat(3800)}Build auto · GLM-5.3 OpenCode Go · max${" ".repeat(300)}⊙ 2 MCP`;
  const started = performance.now();
  parseScreenModel(line, "opencode");
  parseScreenModel(line, "");
  parseScreenChoice(line);
  screenAwaitsChoice(line);
  assert.ok(performance.now() - started < 50);
  // Normal footers still parse after collapsing space runs.
  assert.deepEqual(
    parseScreenModel(" ┃  Build auto · GLM-5.3 OpenCode Go · high\n ╹▀▀▀▀", "opencode"),
    { model: "GLM-5.3 OpenCode Go", effort: "high" }
  );
});
