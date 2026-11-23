// Reads an Antigravity CLI session from its JSONL transcript under ~/.gemini/antigravity-cli/brain.
import { exec, home, readTextFile, terminals } from "herdr";
import * as fs from "fs/promises";
import {
  clip,
  toolTitle,
  classifyTool,
  itemsToBlocks,
  terminalMachine,
  stripHarnessXml,
} from "./transcript-blocks.js";

/**
 * Strips the leading `Created At:` / `Completed At:` timestamps Antigravity prepends to GENERIC tool outputs.
 * @param {string} raw
 * @returns {string}
 */
function stripGenericTimestamps(raw) {
  return String(raw || "")
    .replace(/^(?:Created At|Completed At):[^\n]*\n+/gm, "")
    .trim();
}

/**
 * Parses a tool call's arguments field (object or JSON string) safely.
 * @param {string|object} args
 * @returns {object}
 */
function parseToolArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args !== "string" || !args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_e) {
    return {};
  }
}

/**
 * Ingests a single parsed Antigravity transcript JSONL entry into `state`.
 * @param {{ items: Array<object>, tools: Map<string, object>, lastTool: object|null, model: string|null, effort: string|null }} state
 * @param {object} entry
 */
export function ingestAntigravityEntry(state, entry) {
  if (!entry || typeof entry !== "object") return;
  const type = entry.type;

  if (type === "USER_INPUT") {
    const raw = typeof entry.content === "string"
      ? entry.content
      : (typeof entry.text === "string" ? entry.text : (typeof entry.message === "string" ? entry.message : ""));
    const settingsChange = raw.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/i)?.[1];
    if (settingsChange) {
      const m = settingsChange.match(/model\s*[:=]\s*([^\s,<]+)/i);
      if (m) state.model = m[1].trim();
    }
    const text = stripHarnessXml(raw);
    if (!text || /^\/(?:model|effort)\b/i.test(text)) return;
    state.items.push({ type: "user", text });
    return;
  }

  if (type === "PLANNER_RESPONSE" || type === "EXECUTOR_RESPONSE" || type === "MODEL_RESPONSE") {
    if (typeof entry.model === "string" && entry.model.trim()) state.model = entry.model.trim();
    if (typeof entry.thinking === "string" && entry.thinking.trim()) {
      state.items.push({ type: "thought", text: entry.thinking.trim(), status: "done" });
    }
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        if (!call) continue;
        const name = call.name || call.function?.name || "tool";
        const input = parseToolArgs(call.arguments ?? call.input ?? call.function?.arguments);
        const classified = classifyTool(name, input);
        const tool = {
          type: "tool",
          name,
          input,
          action: classified.action,
          changedFiles: classified.changedFiles,
          title: toolTitle(name, input),
          detail: "",
          status: "running",
          hasFailure: false,
        };
        if (call.id) state.tools.set(call.id, tool);
        state.lastTool = tool;
        state.items.push(tool);
      }
    }
    if (typeof entry.content === "string" && entry.content.trim()) {
      state.items.push({ type: "assistant", text: entry.content.trim() });
    }
    return;
  }

  if (type === "GENERIC") {
    const detail = clip(stripGenericTimestamps(entry.content || entry.output || ""));
    const tool = (entry.tool_call_id && state.tools.get(entry.tool_call_id)) || state.lastTool;
    if (tool) {
      tool.detail = detail;
      tool.status = entry.is_error ? "error" : "done";
      tool.hasFailure = Boolean(entry.is_error);
    }
    return;
  }

  if (type === "ERROR_MESSAGE") {
    const text = String(entry.content || entry.message || "Error").trim();
    if (text) state.items.push({ type: "notice", tone: "error", text: clip(text) });
  }
}

const PY_LOCATE_AGY = [
  "import glob, os, sys",
  "hint = sys.argv[1]",
  "root = os.path.expanduser('~/.gemini/antigravity-cli/brain')",
  "if hint:",
  "    p = os.path.join(root, hint, '.system_generated', 'logs', 'transcript.jsonl')",
  "    if os.path.isfile(p): print(p); sys.exit(0)",
  "files = sorted(glob.glob(f'{root}/*/.system_generated/logs/transcript.jsonl'), key=os.path.getmtime, reverse=True)",
  "if files: print(files[0])",
].join("\n");

export class AntigravityTranscript {
  constructor(terminal) {
    this.terminal = terminal;
    this.machine = terminalMachine(terminal);
    this.path = null;
    this.lines = 0;
    this.items = [];
    this.tools = new Map();
    this.lastTool = null;
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
    this.lastTool = null;
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
    const hint =
      (Array.isArray(term?.records) ? term.records : [])
        .slice()
        .reverse()
        .map((r) => String(r || "").match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1])
        .find(Boolean) || "";

    const res = await exec("python3", ["-c", PY_LOCATE_AGY, hint], this.machine ? { on: this.machine } : undefined);
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
        ingestAntigravityEntry(this, JSON.parse(line));
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
