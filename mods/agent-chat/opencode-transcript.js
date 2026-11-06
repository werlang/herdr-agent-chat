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
import { itemsToBlocks } from "./transcript-blocks.js";
import { buildOpenCodePollQuery, OpenCodeItemCache } from "./opencode-data.js";

export { textOf, clip, toolTitle, classifyTool, itemsToBlocks } from "./transcript-blocks.js";

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
    this.messages = new Map(); // seq → { type, data, raw }
    this.since = 0;
    this.model = null;
    this.provider = null;
    this.effort = null;
    this.sessionModel = false; // true once session_v2 has supplied a model
    this._blocks = null;
    this._working = null;
    this.itemsCache = new OpenCodeItemCache();
    this.itemRebuilds = 0;
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

  /**
   * Applies the model stored on the resolved `session_v2` row.
   * @param {any} row
   */
  applySession(row) {
    try {
      const model = JSON.parse(row.model || "null");
      if (!model?.id) return;
      // The session row is the source of truth: a model picked in the TUI or
      // through the API lands here before any new assistant message exists.
      this.sessionModel = true;
      this.model = model.id;
      this.provider = model.providerID || null;
      this.effort = model.variant && model.variant !== "default" ? model.variant : null;
    } catch (_e) {}
  }

  /** Model name for the picker. */
  get modelLabel() {
    return prettyModel(this.model);
  }

  async refresh(agentWorking) {
    const before = this.sessionId;
    const agent = agents().find((a) => a.address === this.terminal);
    const term = terminals().find((t) => t.address === this.terminal);
    const title = (agent?.title || "").replace(/^OC\s*\|\s*/, "").trim();
    const cwd = term?.cwd || null;
    this.itemsCache.rebuilds = 0;

    // One sqlite3 process resolves the session and returns its changed rows.
    const rows = await this.sql(
      buildOpenCodePollQuery({ title, cwd, since: this.since, knownSessionId: before })
    );
    if (!rows) return null;
    const sessionRow = rows.find((row) => row.kind === "session");
    if (!sessionRow) return null;

    const changedSession = sessionRow.id !== this.sessionId;
    if (changedSession) {
      this.sessionId = sessionRow.id;
      this.sessionModel = false;
      this.messages = new Map();
      this.since = 0;
      this._blocks = null;
      this.itemsCache.clear();
    }
    this.applySession(sessionRow);

    let changed = changedSession;
    for (const row of rows) {
      if (row.kind !== "message") continue;
      this.since = Math.max(this.since, row.time_updated);
      const prev = this.messages.get(row.seq);
      // The newest row is re-read every poll (`>=`); only a different raw row
      // is new work, so an idle transcript rebuilds nothing.
      if (prev && prev.type === row.type && prev.raw === row.data) continue;
      try {
        const data = JSON.parse(row.data);
        this.messages.set(row.seq, { type: row.type, data, raw: row.data });
        this.itemsCache.set(row.seq, row.type, data);
        changed = true;
      } catch (_e) {}
    }
    if (agentWorking !== this._working) changed = true;
    this._working = agentWorking;
    if (changed || !this._blocks) this._blocks = itemsToBlocks(this.items(), agentWorking);
    this.itemRebuilds = this.itemsCache.rebuilds;
    return { blocks: this._blocks, changed };
  }

  /** Messages in order as chat items (user, thought, assistant, tool). */
  items() {
    const { items, model, effort, hasModel } = this.itemsCache.collect(this.messages);
    // Older assistant rows must not overwrite a session-level model that is
    // already known, or a switch would revert on the next poll.
    if (hasModel && !this.sessionModel) {
      this.model = model;
      this.effort = effort;
    }
    return items;
  }
}
