// Reads a Claude Code session straight from its JSONL transcript, so the chat
// shows the real Markdown, tool calls and results instead of a reconstruction
// of the terminal screen.
//
// Mapping: terminal → foreground pid (`hc get`) → ~/.claude/sessions/<pid>.json
// (sessionId, cwd) → ~/.claude/projects/<cwd with non-alphanumerics as "-">/<sessionId>.jsonl.
// The first read loads the whole file; later reads take only the lines appended
// since (`tail -n +N`), so a poll costs one small process even for long sessions.
import { hc, exec, home } from "herdr";
import * as fs from "fs/promises";
import { textOf, clip, toolTitle, classifyTool, itemsToBlocks, settingChange } from "./transcript-blocks.js";

export { textOf, clip, toolTitle, classifyTool, itemsToBlocks } from "./transcript-blocks.js";

/** Wrapper tags Claude Code puts around non-conversation user entries. */
const HIDDEN_USER = /^\s*<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr)\b/;

/**
 * A user string entry as the person typed it, or null when it is plumbing.
 * @param {string} raw
 * @returns {string|null}
 */
function userText(raw) {
  if (typeof raw !== "string") return null;
  // Model and effort switches show as a notice from their output instead.
  if (/<command-name>\/?(model|effort)<\/command-name>/.test(raw)) return null;
  if (HIDDEN_USER.test(raw)) return null;
  if (raw.startsWith("Caveat:")) return null;
  if (raw.startsWith("[Request interrupted")) return null;
  const cmd = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    const name = cmd[1].trim();
    return `${name.startsWith("/") ? name : "/" + name}${args ? " " + args : ""}`;
  }
  return raw.trim() || null;
}

export class ClaudeTranscript {
  constructor(terminal) {
    this.terminal = terminal;
    this.path = null;
    this.sessionId = null;
    this.lines = 0;
    this.items = [];
    this.tools = new Map();
    this.lastMessageId = null;
    this.miss = null;
    this.pid = null;
    this.pidAt = 0;
    this.size = 0;
    this._blocks = null;
    this._working = null;
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
    const h = home();
    let session;
    try {
      session = JSON.parse(await fs.readFile(`${h}/.claude/sessions/${pid}.json`, "utf8"));
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
    this.miss = null;
    this.size = 0;
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
      if (!this.fresh) return null;
      const changed = this._blocks === null || this._blocks.length > 0 || sessionBefore !== this.sessionId;
      this._blocks = [];
      return { blocks: this._blocks, changed };
    }
    let stat = null;
    try {
      stat = await fs.stat(path);
    } catch (_e) {}
    let chunk;
    if (this.lines === 0) {
      chunk = await fs.readFile(path, "utf8");
    } else if (stat && stat.size === this.size) {
      // Nothing was appended; skip the `tail` process entirely.
      chunk = "";
    } else {
      const res = await exec("tail", ["-n", `+${this.lines + 1}`, path]);
      if (res.code !== 0) return null;
      chunk = res.stdout;
    }
    if (stat) this.size = stat.size;
    // Only whole lines: a line still being written is read on the next poll.
    const end = chunk.lastIndexOf("\n");
    const complete = end >= 0 ? chunk.slice(0, end) : "";
    const lines = complete ? complete.split("\n") : [];
    for (const line of lines) {
      this.lines++;
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

  ingest(entry) {
    if (!entry || entry.isSidechain) return;

    // Messages typed while the agent was busy are stored as queued commands.
    const att = entry.type === "attachment" ? entry.attachment : null;
    if (att?.type === "queued_command" && att.origin?.kind === "human") {
      const images = Array.isArray(att.prompt) ? att.prompt.filter((p) => p?.type === "image").length : 0;
      let text = userText(typeof att.prompt === "string" ? att.prompt : textOf(att.prompt)) || "";
      if (images) text = `${text}${text ? "\n\n" : ""}${images === 1 ? "🖼 1 image" : `🖼 ${images} images`}`;
      if (text) this.items.push({ type: "user", text });
      return;
    }

    const content = entry.message?.content;

    if (entry.type === "user") {
      if (entry.isMeta || entry.isCompactSummary) return;
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
        return;
      }
      if (typeof content === "string") {
        const text = userText(content);
        if (text) this.items.push({ type: "user", text });
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
          const t = userText(part.text);
          if (t) text += (text ? "\n" : "") + t;
        } else if (part?.type === "image") {
          images++;
        }
      }
      if (images) text = `${text}${text ? "\n\n" : ""}${images === 1 ? "🖼 1 image" : `🖼 ${images} images`}`;
      if (text) this.items.push({ type: "user", text });
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
