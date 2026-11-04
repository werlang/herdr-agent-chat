// Reads an OpenCode session from its own SQLite store, so the chat shows the
// real Markdown and tool calls instead of the TUI's borders and status bar.
//
// OpenCode 2.x keeps sessions in ~/.local/share/opencode/opencode.db:
// `session_v2` (title, directory, model) and `session_message` (one JSON row
// per user / assistant / system message, ordered by `seq`). The TUI is matched
// to its session by title (Herdr shows OpenCode's terminal title as
// "OC | <session title>"), else by the newest session in the terminal's folder.
//
// Rows go through a file rather than stdout: a long session is several MB and
// `exec` caps output at 8 MiB. After the first read only rows whose
// `time_updated` moved are fetched.
import { exec, agents, terminals, home } from "herdr";
import * as fs from "fs/promises";
import { textOf, clip, toolTitle, itemsToBlocks } from "./transcript-blocks.js";

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Formats a model id into a human-readable name.
 * @param {string|null} id
 * @returns {string|null}
 */
function prettyModel(id) {
  if (!id) return null;
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => (/^v?\d/.test(w) ? w.toUpperCase().replace(/^V/, "V") : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

export class OpenCodeTranscript {
  constructor(terminal) {
    this.terminal = terminal;
    this.sessionId = null;
    this.messages = new Map(); // seq → parsed row
    this.since = 0;
    this.model = null;
    this.provider = null;
    this.effort = null;
  }

  get db() {
    return `${home()}/.local/share/opencode/opencode.db`;
  }

  get scratch() {
    return `${home()}/.config/herdr-app/data/agent-chat`;
  }

  /**
   * Executes a read-only SQLite query and returns JSON rows.
   * Uses a sanitized terminal scratch path to prevent invalid paths from remote terminals.
   * @param {string} query
   * @returns {Promise<any[]|null>}
   */
  async sql(query) {
    await fs.mkdir(this.scratch, { recursive: true });
    const safeTerm = String(this.terminal || "").replace(/[^A-Za-z0-9_-]/g, "_");
    const out = `${this.scratch}/opencode-${safeTerm}.json`;
    const res = await exec("sqlite3", ["-readonly", "-json", this.db, `.output ${out}`, query]);
    if (res.code !== 0) return null;
    const text = await fs.readFile(out, "utf8");
    return text.trim() ? JSON.parse(text) : [];
  }

  /** The session this terminal's TUI shows, or null. */
  async locate() {
    const agent = agents().find((a) => a.address === this.terminal);
    const term = terminals().find((t) => t.address === this.terminal);
    const title = (agent?.title || "").replace(/^OC\s*\|\s*/, "").trim();
    const cwd = term?.cwd || null;
    const where = [
      "parent_id is null",
      title ? `title = ${q(title)}` : null,
      !title && cwd ? `directory = ${q(cwd)}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const orderBy =
      title && cwd
        ? `(directory = ${q(cwd)}) desc, time_updated desc`
        : "time_updated desc";
    const rows = await this.sql(
      `select id, model from session_v2 where ${where} order by ${orderBy} limit 1`
    );
    const row = rows?.[0];
    if (!row) return null;
    if (row.id !== this.sessionId) {
      this.sessionId = row.id;
      this.messages = new Map();
      this.since = 0;
    }
    try {
      const model = JSON.parse(row.model || "null");
      this.model = model?.id || this.model;
      this.provider = model?.providerID || this.provider || null;
      this.effort = model?.variant && model.variant !== "default" ? model.variant : null;
    } catch (_e) {}
    return row.id;
  }

  /** Model name for the picker. */
  get modelLabel() {
    return prettyModel(this.model);
  }

  async refresh(agentWorking) {
    const before = this.sessionId;
    if (!(await this.locate())) return null;
    const rows = await this.sql(
      `select seq, type, time_updated, data from session_message where session_id = ${q(this.sessionId)} and time_updated >= ${this.since} order by seq`
    );
    if (!rows) return null;
    for (const row of rows) {
      this.since = Math.max(this.since, row.time_updated);
      try {
        this.messages.set(row.seq, { type: row.type, data: JSON.parse(row.data) });
      } catch (_e) {}
    }
    const changed = rows.length > 0 || before !== this.sessionId || agentWorking !== this._working;
    this._working = agentWorking;
    return { blocks: itemsToBlocks(this.items(), agentWorking), changed };
  }

  /** Messages in order as chat items (user, thought, assistant, tool). */
  items() {
    const out = [];
    const seqs = [...this.messages.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const { type, data } = this.messages.get(seq);
      if (type === "user") {
        const files = Array.isArray(data.files) ? data.files.length : 0;
        let text = (data.text || "").trim();
        if (files) text = `${text}${text ? "\n\n" : ""}${files === 1 ? "🖼 1 file" : `🖼 ${files} files`}`;
        if (text) out.push({ type: "user", text });
        continue;
      }
      if (type !== "assistant" || !Array.isArray(data.content)) continue;
      if (data.model?.id) {
        this.model = data.model.id;
        this.effort = data.model.variant && data.model.variant !== "default" ? data.model.variant : null;
      }
      for (const part of data.content) {
        if (part?.type === "reasoning" && part.text?.trim()) {
          out.push({ type: "thought", text: part.text, status: "done" });
        } else if (part?.type === "text" && part.text?.trim()) {
          const last = out[out.length - 1];
          if (last?.type === "assistant" && last.seq === seq) last.text += `\n\n${part.text}`;
          else out.push({ type: "assistant", text: part.text, seq });
        } else if (part?.type === "tool") {
          const state = part.state || {};
          const status = state.status === "completed" ? "done" : state.status === "error" ? "error" : "running";
          const detail = clip(textOf(state.content) || state.output || state.error || "");
          out.push({ type: "tool", title: toolTitle(part.name, state.input), detail, status });
        }
      }
    }
    return out;
  }
}
