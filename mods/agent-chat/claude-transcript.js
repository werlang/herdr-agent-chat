// Reads a Claude Code session straight from its JSONL transcript, so the chat
// shows the real Markdown, tool calls and results instead of a reconstruction
// of the terminal screen.
//
// Mapping: terminal → foreground pid (`hc get`) → ~/.claude/sessions/<pid>.json
// (sessionId, cwd) → ~/.claude/projects/<cwd with non-alphanumerics as "-">/<sessionId>.jsonl.
// The first read loads the whole file; later reads take only the lines appended
// since (`tail -n +N`), so a poll costs one small process even for long sessions.
import { hc, exec, home, readTextFile, terminals } from "herdr";
import * as fs from "fs/promises";
import {
  INITIAL_TAIL_LINES,
  EARLIER_BATCH_LINES,
  readJsonlTail,
  readJsonlRange,
} from "./jsonl-tail.js";
import {
  textOf,
  clip,
  toolTitle,
  classifyTool,
  itemsToBlocks,
  settingChange,
  terminalMachine,
  terminalLocalAddress,
  stripHarnessXml,
} from "./transcript-blocks.js";

export { textOf, clip, toolTitle, classifyTool, itemsToBlocks } from "./transcript-blocks.js";

/** Wrapper tags Claude Code puts around non-conversation user entries. */
const HIDDEN_USER = /^\s*<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr)\b/;

/** Harness-injected user origins that are not typed by the human. */
const HIDDEN_ORIGINS = new Set([
  "task-notification",
  "task_notification",
  "auto-continuation",
  "auto_continuation",
  "peer",
]);

/**
 * A user string entry as the person typed it, or null when it is harness plumbing.
 * @param {string} raw
 * @returns {string|null}
 */
export function claudeUserText(raw) {
  if (typeof raw !== "string") return null;
  // Model and effort switches show as a notice from their output instead.
  if (/<command-name>\/?(model|effort)<\/command-name>/.test(raw)) return null;
  if (HIDDEN_USER.test(raw)) return null;
  if (raw.startsWith("Caveat:")) return null;
  if (raw.startsWith("[Request interrupted")) return null;
  if (raw.startsWith("Base directory for this skill:")) return null;
  if (raw.startsWith("This session is being continued from a previous conversation")) return null;
  if (/^\[Image:\s*source:[^\]]+\]\s*$/i.test(raw.trim())) return null;
  const cmd = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    const name = cmd[1].trim();
    return `${name.startsWith("/") ? name : "/" + name}${args ? " " + args : ""}`;
  }
  const cleaned = stripHarnessXml(raw);
  return cleaned || null;
}

export class ClaudeTranscript {
  constructor(terminal) {
    this.terminal = terminal;
    this.machine = terminalMachine(terminal);
    this.localTerminal = terminalLocalAddress(terminal);
    this.remoteHome = null;
    this.path = null;
    this.sessionId = null;
    this.lines = 0;
    this.items = [];
    this.tools = new Map();
    this.lastMessageId = null;
    this.queuedPrompts = new Set();
    this.miss = null;
    this.pid = null;
    this.pidAt = 0;
    this.size = 0;
    this.startLine = 1;
    this.hasEarlier = false;
    this.rawLines = [];
    this._blocks = null;
    this._working = null;
  }

  async resolveHome() {
    if (!this.machine) return home();
    if (this.remoteHome) return this.remoteHome;
    const res = await exec("sh", ["-lc", 'printf "%s" "$HOME"'], { on: this.machine });
    if (res.code === 0 && res.stdout.trim()) {
      this.remoteHome = res.stdout.trim();
      return this.remoteHome;
    }
    return null;
  }

  /**
   * Finds this terminal's transcript; null when it is not a Claude Code session.
   * Remembers scan misses for 10 s to avoid repeating filesystem scans every second.
   * @returns {Promise<string|null>}
   */
  async locate() {
    const now = Date.now();
    // The foreground pid rarely changes; `hc get` is a process, so check it
    // on a slow cadence and read the small session file every poll.
    if (!this.pid || now - this.pidAt > 3000) {
      const res = await hc(["get", this.terminal, "--json"]);
      if (res.code !== 0) return null;
      this.pid = JSON.parse(res.stdout)?.foreground?.pid || null;
      this.pidAt = now;
    }
    const pid = this.pid;
    if (!pid) return null;
    const h = await this.resolveHome();
    if (!h) return null;
    let session;
    try {
      const rawSession = this.machine
        ? await readTextFile(`${h}/.claude/sessions/${pid}.json`, { on: this.machine })
        : await fs.readFile(`${h}/.claude/sessions/${pid}.json`, "utf8");
      session = JSON.parse(rawSession);
    } catch (_e) {
      // The pid may have been replaced since the last `hc get`: retry it next poll.
      this.pidAt = 0;
      return null;
    }
    if (!session?.sessionId) return null;

    // A new session id (/clear, /resume) starts the transcript over and clears the miss.
    if (session.sessionId !== this.sessionId) {
      this.sessionId = session.sessionId;
      this.reset();
    }
    if (this.path) return this.path;

    const file = `${session.sessionId}.jsonl`;
    const guess = `${h}/.claude/projects/${String(session.cwd || "").replace(/[^A-Za-z0-9]/g, "-")}/${file}`;
    if (this.machine) {
      const check = await exec("sh", ["-lc", `if [ -f "$1" ]; then printf "%s" "$1"; else ls -1 "$2"/*/"$3" 2>/dev/null | head -n1; fi`, "_", guess, `${h}/.claude/projects`, file], { on: this.machine });
      const found = check.code === 0 ? check.stdout.trim() : "";
      if (found) {
        this.miss = null;
        return (this.path = found);
      }
      this.miss = { sessionId: session.sessionId, at: Date.now() };
      return null;
    }

    if (await fs.exists(guess)) {
      this.miss = null;
      return (this.path = guess);
    }

    if (this.miss && this.miss.sessionId === session.sessionId && Date.now() - this.miss.at < 10_000) {
      return null;
    }

    for (const dir of await fs.readdir(`${h}/.claude/projects`)) {
      const candidate = `${h}/.claude/projects/${dir}/${file}`;
      if (await fs.exists(candidate)) {
        this.miss = null;
        return (this.path = candidate);
      }
    }
    this.miss = { sessionId: session.sessionId, at: Date.now() };
    return null;
  }

  /**
   * True when the terminal runs Claude Code but its transcript file does not
   * exist yet: a fresh session writes it with the first message, and until
   * then the screen is only the welcome banner and the input placeholder.
   */
  get fresh() {
    return Boolean(this.sessionId && !this.path);
  }

  /** Resets cached state for a new session or after session changes. */
  reset() {
    this.path = null;
    this.lines = 0;
    this.items = [];
    this.tools = new Map();
    this.lastMessageId = null;
    this.queuedPrompts = new Set();
    this.miss = null;
    this.size = 0;
    this.startLine = 1;
    this.hasEarlier = false;
    this.rawLines = [];
    this._blocks = null;
    this._working = null;
    this.model = null;
    this.effort = null;
  }

  /**
   * Reads what was appended since the last call.
   * @param {boolean} agentWorking
   * @returns {Promise<{blocks: object[], changed: boolean} | null>} null when no transcript exists.
   */
  async refresh(agentWorking) {
    const sessionBefore = this.sessionId;
    const path = await this.locate();
    if (!path) {
      const term = terminals().find((t) => t.address === this.terminal);
      if (!this.fresh && (term?.turn ?? 0) !== 0) return null;
      const changed = this._blocks === null || this._blocks.length > 0 || sessionBefore !== this.sessionId;
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
      // Nothing was appended; skip the `tail` process entirely.
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
        this.ingest(JSON.parse(line));
      } catch (_e) {
        // A malformed line is skipped; the rest of the transcript still reads.
      }
    }
    const changed = lines.length > 0 || sessionBefore !== this.sessionId || agentWorking !== this._working;
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
    this.lastMessageId = null;
    this.queuedPrompts = new Set();
    for (const line of this.rawLines) {
      if (!line) continue;
      try {
        this.ingest(JSON.parse(line));
      } catch (_e) {}
    }
    this._blocks = this.blocks(this._working);
    return { blocks: this._blocks, changed: true, hasEarlier: this.hasEarlier };
  }

  ingest(entry) {
    if (!entry || entry.isSidechain) return;

    // Messages typed while the agent was busy are stored as queued commands.
    const att = entry.type === "attachment" ? entry.attachment : null;
    if (att?.type === "model" && typeof att.model === "string") {
      this.model = att.model;
      return;
    }
    if (att?.type === "queued_command" && att.origin?.kind === "human") {
      const images = Array.isArray(att.prompt) ? att.prompt.filter((p) => p?.type === "image").length : 0;
      let text = claudeUserText(typeof att.prompt === "string" ? att.prompt : textOf(att.prompt)) || "";
      if (images) text = `${text}${text ? "\n\n" : ""}${images === 1 ? "🖼 1 image" : `🖼 ${images} images`}`;
      if (text) {
        this.queuedPrompts.add(text);
        this.items.push({ type: "user", text });
      }
      return;
    }

    const content = entry.message?.content;
    const originKind = entry.origin?.kind || entry.turnOrigin?.kind || "";

    if (entry.type === "user") {
      if (entry.isCompactSummary) {
        this.items.push({ type: "notice", tone: "info", text: "Conversation compacted" });
        return;
      }
      if (entry.isMeta || entry.promptSource === "system" || HIDDEN_ORIGINS.has(originKind)) {
        // Still allow tool_result blocks if a meta entry carries them.
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part?.type === "tool_result") {
              const tool = this.tools.get(part.tool_use_id);
              if (tool) {
                tool.detail = clip(textOf(part.content));
                tool.status = part.is_error ? "error" : "done";
                tool.hasFailure = Boolean(part.is_error);
              }
            }
          }
        }
        return;
      }
      const change = settingChange(typeof content === "string" ? content : textOf(content));
      if (change) {
        if (change.model) {
          this.model = change.model;
          this.items.push({ type: "notice", tone: "info", text: `Model set to ${change.model}` });
        }
        if (change.effort) {
          this.effort = change.effort;
          this.items.push({ type: "notice", tone: "info", text: `Effort set to ${change.effort}` });
        }
        if (change.notice) {
          this.items.push({ type: "notice", tone: "info", text: change.notice });
        }
        return;
      }
      if (typeof content === "string") {
        const text = claudeUserText(content);
        if (text && !this.queuedPrompts.delete(text)) this.items.push({ type: "user", text });
        return;
      }
      if (!Array.isArray(content)) return;
      let text = "";
      let images = 0;
      for (const part of content) {
        if (part?.type === "tool_result") {
          const tool = this.tools.get(part.tool_use_id);
          if (tool) {
            tool.detail = clip(textOf(part.content));
            tool.status = part.is_error ? "error" : "done";
            tool.hasFailure = Boolean(part.is_error);
          }
        } else if (part?.type === "text") {
          const t = claudeUserText(part.text);
          if (t) text += (text ? "\n" : "") + t;
        } else if (part?.type === "image") {
          images++;
        }
      }
      if (images) text = `${text}${text ? "\n\n" : ""}${images === 1 ? "🖼 1 image" : `🖼 ${images} images`}`;
      if (text && !this.queuedPrompts.delete(text)) this.items.push({ type: "user", text });
      return;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      const messageId = entry.message?.id;
      // The model that wrote the latest reply is the one the session is on.
      const model = entry.message?.model;
      if (model && !model.startsWith("<")) this.model = model;
      if (typeof entry.effort === "string") this.effort = entry.effort;
      for (const part of content) {
        if (part?.type === "text" && part.text?.trim()) {
          const last = this.items[this.items.length - 1];
          if (last?.type === "assistant" && last.messageId === messageId) last.text += `\n\n${part.text}`;
          else this.items.push({ type: "assistant", text: part.text, messageId });
        } else if (part?.type === "thinking" && part.thinking?.trim()) {
          // Redacted thinking arrives empty; only readable thinking gets a row.
          this.items.push({ type: "thought", text: part.thinking, status: "done" });
        } else if (part?.type === "tool_use") {
          const classified = classifyTool(part.name, part.input);
          const tool = {
            type: "tool",
            name: part.name,
            input: part.input,
            action: classified.action,
            changedFiles: classified.changedFiles,
            title: toolTitle(part.name, part.input),
            detail: "",
            status: "running",
            hasFailure: false,
          };
          this.tools.set(part.id, tool);
          this.items.push(tool);
        }
      }
    }
  }

  blocks(agentWorking) {
    return itemsToBlocks(this.items, agentWorking);
  }
}
