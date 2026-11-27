// Reads a Codex CLI session from its JSONL rollout transcript under ~/.codex/sessions.
import { hc, exec, home, readTextFile, terminals } from "herdr";
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
import {
  INITIAL_TAIL_LINES,
  EARLIER_BATCH_LINES,
  readJsonlTail,
  readJsonlRange,
} from "./jsonl-tail.js";

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

  // Codex writes `thread_settings_applied` before every turn, with the values
  // under `thread_settings`. Only a value that differs from the one already
  // known is a switch; the first one seen (no prior value) is just the baseline.
  if (payload.type === "thread_settings_applied") {
    const settings = payload.thread_settings || payload;
    const model = settings.model;
    if (model) {
      if (state.model && state.model !== model) {
        state.items.push({ type: "notice", tone: "info", text: `Model set to ${model}` });
      }
      state.model = model;
    }
    const eff = settings.reasoning_effort || settings.effort;
    if (eff) {
      const effort = String(eff).toLowerCase();
      if (state.effort && state.effort !== effort) {
        state.items.push({ type: "notice", tone: "info", text: `Effort set to ${effort}` });
      }
      state.effort = effort;
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

  if (payload.type === "warning") {
    const msg = String(payload.message || payload.text || "Warning").trim();
    if (msg) state.items.push({ type: "notice", tone: "warning", text: clip(msg) });
    return;
  }

  if (payload.type === "error" || payload.type === "stream_error") {
    const msg = String(payload.message || payload.error?.message || payload.text || "Error").trim();
    if (msg) state.items.push({ type: "notice", tone: "error", text: clip(msg) });
    return;
  }

  if (payload.type !== "item_completed" || !payload.item) return;
  const item = payload.item;

  if (item.type === "UserMessage") {
    const content = item.content ?? item.text ?? "";
    const raw = codexMessageText(content);
    const images = Array.isArray(content)
      ? content.filter((p) => p && /^(?:image|local_?image|input_image)$/i.test(String(p.type || ""))).length
      : 0;
    if (!images && (!raw || CODEX_HARNESS_BLOCK.test(raw))) return;
    let text = raw && !CODEX_HARNESS_BLOCK.test(raw) ? stripHarnessXml(raw) : "";
    if (/^\/model\b/i.test(text) && !images) return;
    // Codex prepends `[Image #N]` to the prompt on Ctrl+V; when the composer
    // also placed `[Image #N]` inline in the message, strip the leading duplicate.
    const leading = text.match(/^((?:\[Image #\d+\]\s*)+)([\s\S]+)$/);
    if (leading && /\[Image #\d+\]/.test(leading[2])) {
      text = leading[2].trim();
    }
    if (images && !/\[Image #\d+\]/.test(text)) {
      text = `${text}${text ? "\n\n" : ""}${images === 1 ? "🖼 1 image" : `🖼 ${images} images`}`;
    }
    if (!text) return;
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
  "import datetime, json, glob, os, sqlite3, sys",
  "cwd = sys.argv[1]",
  "pid = sys.argv[2] if len(sys.argv) > 2 else ''",
  "created_ms = int(float(sys.argv[3])) if len(sys.argv) > 3 and sys.argv[3] else 0",
  "root = os.path.expanduser('~/.codex')",
  "if pid:",
  "    try:",
  "        logs_db = os.path.join(root, 'logs_2.sqlite')",
  "        state_db = os.path.join(root, 'state_5.sqlite')",
  "        if os.path.isfile(logs_db) and os.path.isfile(state_db):",
  "            con = sqlite3.connect(f'file:{logs_db}?mode=ro', uri=True)",
  "            rows = con.execute('SELECT DISTINCT thread_id FROM logs WHERE process_uuid LIKE ? AND thread_id IS NOT NULL ORDER BY ts DESC LIMIT 10', (f'pid:{pid}:%',)).fetchall()",
  "            con.close()",
  "            if rows:",
  "                con2 = sqlite3.connect(f'file:{state_db}?mode=ro', uri=True)",
  "                for (tid,) in rows:",
  "                    r2 = con2.execute(\"SELECT rollout_path FROM threads WHERE id = ? AND attached_thread_parent_id IS NULL AND source = 'cli'\", (tid,)).fetchone()",
  "                    if r2 and r2[0] and os.path.isfile(r2[0]):",
  "                        con2.close()",
  "                        print(r2[0]); sys.exit(0)",
  "                con2.close()",
  "    except Exception: pass",
  "def session_created_ms(path, doc):",
  "    ts = doc.get('timestamp') or doc.get('payload', {}).get('timestamp')",
  "    if isinstance(ts, str) and ts:",
  "        try: return datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000",
  "        except Exception: pass",
  "    try:",
  "        bt = getattr(os.stat(path), 'st_birthtime', None)",
  "        if bt: return bt * 1000",
  "    except Exception: pass",
  "    return 0",
  "sessions_dir = os.path.join(root, 'sessions')",
  "files = sorted(glob.glob(f'{sessions_dir}/**/rollout-*.jsonl', recursive=True), key=os.path.getmtime, reverse=True)",
  "for f in files[:25]:",
  "    try:",
  "        if created_ms > 0 and os.path.getmtime(f) * 1000 < created_ms - 5000:",
  "            continue",
  "        with open(f, 'r', encoding='utf-8') as fh:",
  "            line = fh.readline()",
  "        doc = json.loads(line)",
  "        if created_ms > 0 and session_created_ms(f, doc) < created_ms - 5000:",
  "            continue",
  "        meta = doc.get('payload', {})",
  "        if meta.get('parent_thread_id') is not None or isinstance(meta.get('source'), dict):",
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
    const recPath = (Array.isArray(term?.records) ? term.records : [])
      .find((r) => typeof r === "string" && /rollout-.*\.jsonl$/.test(r));
    if (recPath) {
      this.path = recPath;
      return this.path;
    }

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
      ["-c", PY_LOCATE_CODEX, cwd, String(this.pid || ""), String(createdMs || 0)],
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
        ingestCodexEntry(this, JSON.parse(line));
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
    // Replayed from the start: switch notices compare against earlier values.
    this.model = null;
    this.effort = null;
    for (const line of this.rawLines) {
      if (!line) continue;
      try {
        ingestCodexEntry(this, JSON.parse(line));
      } catch (_e) {}
    }
    this._blocks = this.blocks(this._working);
    return { blocks: this._blocks, changed: true, hasEarlier: this.hasEarlier };
  }

  blocks(agentWorking) {
    return itemsToBlocks(this.items, agentWorking);
  }
}
