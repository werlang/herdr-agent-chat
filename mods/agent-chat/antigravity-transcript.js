// Reads an Antigravity CLI session from its JSONL transcript under ~/.gemini/antigravity-cli/brain.
import { hc, exec, home, readTextFile, terminals } from "herdr";
import * as fs from "fs/promises";
import {
  clip,
  toolTitle,
  classifyTool,
  itemsToBlocks,
  terminalMachine,
  stripHarnessXml,
} from "./transcript-blocks.js";
import {
  INITIAL_TAIL_LINES,
  EARLIER_BATCH_LINES,
  readJsonlTail,
  readJsonlRange,
} from "./jsonl-tail.js";

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
      const cleaned = entry.content.replace(/\n?<truncated \d+ bytes>\n?/g, "\n…\n").trim();
      if (cleaned) state.items.push({ type: "assistant", text: cleaned });
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
  "import glob, os, re, sqlite3, subprocess, sys",
  "hint = sys.argv[1] if len(sys.argv) > 1 else ''",
  "pid = sys.argv[2] if len(sys.argv) > 2 else ''",
  "cwd = sys.argv[3] if len(sys.argv) > 3 else ''",
  "created_ms = int(float(sys.argv[4])) if len(sys.argv) > 4 and sys.argv[4] else 0",
  "base = os.path.expanduser('~/.gemini/antigravity-cli')",
  "brain = os.path.join(base, 'brain')",
  "def resolve_log(cid):",
  "    logs = os.path.join(brain, cid, '.system_generated', 'logs')",
  "    full = os.path.join(logs, 'transcript_full.jsonl')",
  "    if os.path.isfile(full): return full",
  "    comp = os.path.join(logs, 'transcript.jsonl')",
  "    if os.path.isfile(comp): return comp",
  "    return None",
  "if hint:",
  "    p = resolve_log(hint)",
  "    if p: print(p); sys.exit(0)",
  "if pid:",
  "    lock_id = None",
  "    fd_dir = f'/proc/{pid}/fd'",
  "    if os.path.isdir(fd_dir):",
  "        for entry in os.listdir(fd_dir):",
  "            try:",
  "                target = os.readlink(os.path.join(fd_dir, entry))",
  "                m = re.search(r'/presence/([0-9a-f-]+)\\.lock$', target, re.I)",
  "                if m: lock_id = m.group(1); break",
  "            except Exception: pass",
  "    else:",
  "        try:",
  "            out = subprocess.check_output(['lsof', '-a', '-p', pid, '-Fn'], stderr=subprocess.DEVNULL, text=True)",
  "            for line in out.splitlines():",
  "                m = re.search(r'/presence/([0-9a-f-]+)\\.lock$', line, re.I)",
  "                if m: lock_id = m.group(1); break",
  "        except Exception: pass",
  "    if lock_id:",
  "        p = resolve_log(lock_id)",
  "        if p: print(p)",
  "        sys.exit(0)",
  "db_path = os.path.join(base, 'conversation_summaries.db')",
  "if os.path.isfile(db_path) and cwd:",
  "    try:",
  "        con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)",
  "        rows = con.execute(\"SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id = '' AND workspace_uris LIKE ? ORDER BY last_modified_time DESC LIMIT 5\", (f'%{cwd}%',)).fetchall()",
  "        con.close()",
  "        for (cid,) in rows:",
  "            p = resolve_log(cid)",
  "            if p and (created_ms <= 0 or os.path.getmtime(p) * 1000 >= created_ms - 5000):",
  "                print(p); sys.exit(0)",
  "    except Exception: pass",
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
    this.pid = null;
    this.pidAt = 0;
    this.size = 0;
    this.startLine = 1;
    this.hasEarlier = false;
    this.rawLines = [];
    this._blocks = null;
    this._working = null;
  }

  reset() {
    this.path = null;
    this.lines = 0;
    this.startLine = 1;
    this.hasEarlier = false;
    this.rawLines = [];
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
    if (now - this.miss < 3000) return null;

    const term = terminals().find((t) => t.address === this.terminal);
    const cwd = term?.cwd || "";
    const createdMs = term?.created_ms || 0;
    const hint =
      (Array.isArray(term?.records) ? term.records : [])
        .slice()
        .reverse()
        .map((r) => String(r || "").match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1])
        .find(Boolean) || "";

    if (!this.pid || now - this.pidAt > 3000) {
      try {
        const g = await hc(["get", this.terminal, "--json"]);
        if (g.code === 0 && g.stdout) {
          this.pid = JSON.parse(g.stdout)?.foreground?.pid || null;
          this.pidAt = now;
        }
      } catch (_e) {}
    }

    const res = await exec(
      "python3",
      ["-c", PY_LOCATE_AGY, hint, String(this.pid || ""), cwd, String(createdMs || 0)],
      this.machine ? { on: this.machine } : undefined
    );
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
    if (this.path && this.path.endsWith("/transcript.jsonl")) {
      const fullPath = `${this.path.slice(0, -"/transcript.jsonl".length)}/transcript_full.jsonl`;
      let hasFull = false;
      if (!this.machine) {
        try {
          await fs.access(fullPath);
          hasFull = true;
        } catch (_e) {}
      } else {
        const chk = await exec("test", ["-f", fullPath], { on: this.machine });
        hasFull = chk.code === 0;
      }
      if (hasFull) {
        this.reset();
        this.path = fullPath;
      }
    }
    const path = await this.locate();
    if (!path) {
      const changed = this._blocks === null || this._blocks.length > 0;
      this._blocks = [];
      return { blocks: this._blocks, changed };
    }
    let stat = null;
    if (!this.machine) {
      try {
        stat = await fs.stat(path);
      } catch (_e) {}
    }
    let lines;
    if (this.lines === 0) {
      const tail = await readJsonlTail(path, INITIAL_TAIL_LINES, this.machine);
      if (!tail) return null;
      this.lines = tail.totalLines;
      this.startLine = tail.startLine;
      this.hasEarlier = tail.hasEarlier;
      lines = tail.lines;
    } else if (stat && stat.size === this.size) {
      lines = [];
    } else {
      const res = await exec("tail", ["-n", `+${this.lines + 1}`, path], this.machine ? { on: this.machine } : undefined);
      if (res.code !== 0) return null;
      const end = res.stdout.lastIndexOf("\n");
      const complete = end >= 0 ? res.stdout.slice(0, end) : "";
      lines = complete ? complete.split("\n") : [];
      this.lines += lines.length;
    }
    if (stat) this.size = stat.size;
    for (const line of lines) {
      this.rawLines.push(line);
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

  async loadEarlier(batchLines = EARLIER_BATCH_LINES) {
    if (!this.path || !this.hasEarlier || this.startLine <= 1) {
      return { blocks: this._blocks || [], changed: false, hasEarlier: false };
    }
    const from = Math.max(1, this.startLine - batchLines);
    const to = this.startLine - 1;
    const older = await readJsonlRange(this.path, from, to, this.machine);
    this.startLine = from;
    this.hasEarlier = from > 1;
    if (!older.length) {
      return { blocks: this._blocks || [], changed: false, hasEarlier: this.hasEarlier };
    }
    this.rawLines = [...older, ...this.rawLines];
    this.items = [];
    this.tools = new Map();
    this.lastTool = null;
    for (const line of this.rawLines) {
      if (!line) continue;
      try {
        ingestAntigravityEntry(this, JSON.parse(line));
      } catch (_e) {}
    }
    this._blocks = this.blocks(this._working);
    return { blocks: this._blocks, changed: true, hasEarlier: this.hasEarlier };
  }

  blocks(agentWorking) {
    return itemsToBlocks(this.items, agentWorking);
  }
}
