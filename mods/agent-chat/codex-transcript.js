// Reads a Codex CLI session from its JSONL rollout transcript under ~/.codex/sessions.
import { exec, home, readTextFile, terminals } from "herdr";
import * as fs from "fs/promises";
import {
  textOf,
  clip,
  toolTitle,
  classifyTool,
  itemsToBlocks,
  terminalMachine,
  stripHarnessXml,
} from "./transcript-blocks.js";

const CODEX_HARNESS_BLOCK = /^\s*<(environment_context|permissions instructions|INSTRUCTIONS|app-context|user_instructions)\b/i;

/**
 * Extracts text from a Codex UserMessage or AgentMessage content payload.
 * @param {string|Array<object>} content
 * @returns {string}
 */
function codexMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => (p?.type === "Text" || p?.type === "text" || p?.type === "input_text" || p?.type === "output_text") && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Ingests a single parsed Codex rollout JSONL entry into `state`.
 * @param {{ items: Array<object>, tools: Map<string, object>, model: string|null, effort: string|null, sessionId: string|null }} state
 * @param {object} entry
 */
export function ingestCodexEntry(state, entry) {
  if (!entry || typeof entry !== "object") return;
  const payload = entry.payload || {};

  if (entry.type === "session_meta") {
    if (payload.id) state.sessionId = payload.id;
    return;
  }

  if (entry.type === "turn_context") {
    if (payload.model) state.model = payload.model;
    const eff = payload.effort || payload.reasoning_effort;
    if (eff) state.effort = String(eff).toLowerCase();
    return;
  }

  if (entry.type !== "event_msg") return;

  if (payload.type === "thread_settings_applied") {
    if (payload.model) {
      state.model = payload.model;
      state.items.push({ type: "notice", tone: "info", text: `Model set to ${payload.model}` });
    }
    const eff = payload.effort || payload.reasoning_effort;
    if (eff) {
      state.effort = String(eff).toLowerCase();
      state.items.push({ type: "notice", tone: "info", text: `Effort set to ${state.effort}` });
    }
    return;
  }

  if (payload.type === "turn_aborted") {
    state.items.push({ type: "notice", tone: "warning", text: "Turn interrupted" });
    return;
  }

  if (payload.type === "context_compacted") {
    state.items.push({ type: "notice", tone: "info", text: "Conversation compacted" });
    return;
  }

  if (payload.type !== "item_completed" || !payload.item) return;
  const item = payload.item;

  if (item.type === "UserMessage") {
    const raw = codexMessageText(item.content ?? item.text ?? "");
    if (!raw || CODEX_HARNESS_BLOCK.test(raw)) return;
    const text = stripHarnessXml(raw);
    if (!text || /^\/model\b/i.test(text)) return;
    state.items.push({ type: "user", text });
    return;
  }

  if (item.type === "AgentMessage") {
    const text = codexMessageText(item.content ?? item.text ?? "").trim();
    if (text) state.items.push({ type: "assistant", text });
    return;
  }

  if (item.type === "Reasoning") {
    const raw = Array.isArray(item.summary_text)
      ? item.summary_text.join("\n")
      : (item.summary_text || codexMessageText(item.content ?? item.text ?? ""));
    const text = String(raw || "").trim();
    if (text) state.items.push({ type: "thought", text, status: "done" });
    return;
  }

  if (item.type === "CommandExecution") {
    const input = { cmd: item.command || "" };
    const classified = classifyTool("exec_command", input);
    const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
    state.items.push({
      type: "tool",
      name: "exec_command",
      input,
      action: classified.action,
      changedFiles: classified.changedFiles,
      title: toolTitle("exec_command", input),
      detail: clip(item.aggregated_output || item.output || ""),
      status: failed ? "error" : "done",
      hasFailure: failed,
    });
    return;
  }

  if (item.type === "FileChange") {
    const paths = Array.isArray(item.changes) ? item.changes.map((c) => c?.path).filter(Boolean) : [];
    const input = { paths };
    const classified = classifyTool("apply_patch", input);
    state.items.push({
      type: "tool",
      name: "apply_patch",
      input,
      action: classified.action,
      changedFiles: classified.changedFiles,
      title: paths.length ? `apply_patch · ${paths[0].split("/").pop()}` : "apply_patch",
      detail: clip(item.diff || item.output || ""),
      status: "done",
      hasFailure: false,
    });
    return;
  }

  if (item.type === "McpToolCall") {
    const name = item.tool || item.name || "mcp";
    const input = item.arguments && typeof item.arguments === "object" ? item.arguments : {};
    const classified = classifyTool(name, input);
    const failed = Boolean(item.error);
    state.items.push({
      type: "tool",
      name,
      input,
      action: classified.action,
      changedFiles: classified.changedFiles,
      title: toolTitle(name, input),
      detail: clip(failed ? String(item.error) : textOf(item.result?.content || item.result || "")),
      status: failed ? "error" : "done",
      hasFailure: failed,
    });
    return;
  }

  if (item.type === "ImageView") {
    const input = { path: item.path || "" };
    const classified = classifyTool("view", input);
    state.items.push({
      type: "tool",
      name: "view",
      input,
      action: classified.action,
      changedFiles: classified.changedFiles,
      title: toolTitle("view", input),
      detail: "",
      status: "done",
      hasFailure: false,
    });
    return;
  }

  if (item.type === "CollabAgentToolCall" || item.type === "SubAgentActivity") {
    const name = item.tool || "agent";
    const input = { description: item.prompt || item.target || "" };
    state.items.push({
      type: "tool",
      name,
      input,
      action: "other",
      changedFiles: [],
      title: toolTitle(name, input),
      detail: "",
      status: "done",
      hasFailure: false,
    });
  }
}

const PY_LOCATE_CODEX = [
  "import json, glob, os, sys",
  "cwd = sys.argv[1]",
  "root = os.path.expanduser('~/.codex/sessions')",
  "files = sorted(glob.glob(f'{root}/**/rollout-*.jsonl', recursive=True), key=os.path.getmtime, reverse=True)",
  "for f in files[:25]:",
  "    try:",
  "        with open(f, 'r', encoding='utf-8') as fh:",
  "            line = fh.readline()",
  "        meta = json.loads(line).get('payload', {})",
  "        if meta.get('parent_thread_id') is not None:",
  "            continue",
  "        if not cwd or meta.get('cwd') == cwd:",
  "            print(f); break",
  "    except Exception: pass",
].join("\n");

export class CodexTranscript {
  constructor(terminal) {
    this.terminal = terminal;
    this.machine = terminalMachine(terminal);
    this.path = null;
    this.sessionId = null;
    this.lines = 0;
    this.items = [];
    this.tools = new Map();
    this.model = null;
    this.effort = null;
    this.miss = 0;
    this.size = 0;
    this._blocks = null;
    this._working = null;
  }

  reset() {
    this.path = null;
    this.lines = 0;
    this.items = [];
    this.tools = new Map();
    this.model = null;
    this.effort = null;
    this.size = 0;
    this._blocks = null;
    this._working = null;
  }

  async locate() {
    if (this.path) return this.path;
    const now = Date.now();
    if (now - this.miss < 5000) return null;

    const term = terminals().find((t) => t.address === this.terminal);
    const cwd = term?.cwd || "";
    const recPath = (Array.isArray(term?.records) ? term.records : [])
      .find((r) => typeof r === "string" && /rollout-.*\.jsonl$/.test(r));
    if (recPath) {
      this.path = recPath;
      return this.path;
    }

    const res = await exec("python3", ["-c", PY_LOCATE_CODEX, cwd], this.machine ? { on: this.machine } : undefined);
    const found = res.code === 0 ? res.stdout.trim() : "";
    if (found) {
      this.miss = 0;
      this.path = found;
      return found;
    }
    this.miss = now;
    return null;
  }

  async refresh(agentWorking) {
    const path = await this.locate();
    if (!path) return null;
    let stat = null;
    if (!this.machine) {
      try {
        stat = await fs.stat(path);
      } catch (_e) {}
    }
    let chunk;
    if (this.lines === 0) {
      chunk = this.machine
        ? await readTextFile(path, { on: this.machine })
        : await fs.readFile(path, "utf8");
    } else if (stat && stat.size === this.size) {
      chunk = "";
    } else {
      const res = await exec("tail", ["-n", `+${this.lines + 1}`, path], this.machine ? { on: this.machine } : undefined);
      if (res.code !== 0) return null;
      chunk = res.stdout;
    }
    if (stat) this.size = stat.size;
    const end = chunk.lastIndexOf("\n");
    const complete = end >= 0 ? chunk.slice(0, end) : "";
    const lines = complete ? complete.split("\n") : [];
    for (const line of lines) {
      this.lines++;
      if (!line) continue;
      try {
        ingestCodexEntry(this, JSON.parse(line));
      } catch (_e) {}
    }
    const changed = lines.length > 0 || agentWorking !== this._working;
    this._working = agentWorking;
    if (changed || !this._blocks) this._blocks = this.blocks(agentWorking);
    return { blocks: this._blocks, changed };
  }

  blocks(agentWorking) {
    return itemsToBlocks(this.items, agentWorking);
  }
}
