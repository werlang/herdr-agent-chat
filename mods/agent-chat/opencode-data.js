// Pure helpers for the OpenCode store: one SQLite poll, per-message chat items,
// and a per-seq item cache. Kept free of the `herdr` module so tests can run
// under plain Node.
import { clip, textOf, toolTitle, classifyTool } from "./transcript-blocks.js";

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Duration of an assistant turn from its own timestamps. A running turn uses
 * its latest part time so the value is stable for the same row data.
 * @param {object} data
 * @returns {number} milliseconds, or 0 when the row carries no usable times
 */
export function messageWorkedMs(data) {
  const start = data?.time?.created;
  if (!Number.isFinite(start)) return 0;
  let end = data.time?.completed;
  if (!Number.isFinite(end)) {
    end = 0;
    for (const part of data.content || []) {
      const t = part?.time;
      const candidate = t?.completed ?? t?.ran ?? t?.created;
      if (Number.isFinite(candidate)) end = Math.max(end, candidate);
    }
  }
  return end > start ? end - start : 0;
}

/**
 * Chat items produced by one `session_message` row. The cache keys on `seq`,
 * so this must depend only on the row data (never on the current time).
 * @param {number} seq
 * @param {string} type
 * @param {object} data
 * @returns {{items: Array<object>, model: string|null, effort: string|null, hasModel: boolean}}
 */
export function messageItems(seq, type, data) {
  const items = [];
  if (type === "user") {
    const files = Array.isArray(data?.files) ? data.files.length : 0;
    let text = (data?.text || "").trim();
    if (files) text = `${text}${text ? "\n\n" : ""}${files === 1 ? "🖼 1 file" : `🖼 ${files} files`}`;
    if (text) items.push({ type: "user", text });
    return { items, model: null, effort: null, hasModel: false };
  }

  if (type !== "assistant") {
    const notice = noticeItem(seq, type, data);
    if (notice) items.push(notice);
    return { items, model: null, effort: null, hasModel: false };
  }

  const hasModel = Boolean(data?.model?.id) && Array.isArray(data?.content);
  const model = hasModel ? data.model.id : null;
  const effort = hasModel && data.model.variant && data.model.variant !== "default" ? data.model.variant : null;
  if (!Array.isArray(data?.content)) {
    const notice = noticeItem(seq, type, data);
    if (notice) items.push(notice);
    return { items, model: null, effort: null, hasModel: false };
  }

  const workedMs = messageWorkedMs(data);
  let lastText = null;
  for (const part of data.content) {
    if (part?.type === "reasoning" && part.text?.trim()) {
      lastText = null;
      items.push({ type: "thought", text: part.text, status: "done", turn: seq, workedMs });
    } else if (part?.type === "text" && part.text?.trim()) {
      if (lastText) lastText.text += `\n\n${part.text}`;
      else {
        lastText = { type: "assistant", text: part.text, seq, turn: seq };
        items.push(lastText);
      }
    } else if (part?.type === "tool") {
      const state = part.state || {};
      const status = state.status === "completed" ? "done" : state.status === "error" ? "error" : "running";
      const detail = clip(textOf(state.content) || state.output || state.error || "");
      const classified = classifyTool(part.name, state.input);
      lastText = null;
      items.push({
        type: "tool",
        name: part.name,
        input: state.input,
        action: classified.action,
        changedFiles: classified.changedFiles,
        title: toolTitle(part.name, state.input),
        detail,
        status,
        hasFailure: status === "error",
        turn: seq,
        workedMs,
      });
    }
  }
  const failure = noticeItem(seq, type, data);
  if (failure) items.push(failure);
  return { items, model, effort, hasModel };
}

/**
 * The one-line notice a non-chat row stands for, or null. Without these a
 * failed or interrupted turn just stops with nothing on screen.
 * - any row with `error.message` (provider timeouts, rate limits): an error;
 * - `idle` with outcome `interrupted`: the turn was stopped;
 * - `model-switched`: the session's model changed (picker, TUI or API);
 * - `compaction`: older context was summarised.
 * @param {number} seq
 * @param {string} type
 * @param {object} data
 * @returns {{type: "notice", tone: "error"|"info", text: string, seq: number, turn: number}|null}
 */
export function noticeItem(seq, type, data) {
  const make = (tone, text) => ({ type: "notice", tone, text, seq, turn: seq });
  const error = data?.error;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (message) return make("error", message);
  if (type === "idle") {
    if (data?.outcome === "interrupted") return make("info", "Interrupted");
    if (data?.outcome === "failed") return make("error", "Turn failed");
    return null;
  }
  if (type === "model-switched" && data?.model?.id) {
    const variant = data.model.variant && data.model.variant !== "default" ? ` · ${data.model.variant}` : "";
    return make("info", `Model switched to ${data.model.id}${variant}`);
  }
  if (type === "compaction" && data?.status === "completed") {
    return make("info", "Earlier conversation compacted");
  }
  return null;
}

/**
 * Cache of `messageItems` results keyed by message `seq`. A poll recomputes
 * only rows whose raw JSON changed; collecting concatenates cached arrays.
 */
export class OpenCodeItemCache {
  constructor() {
    /** @type {Map<number, ReturnType<typeof messageItems>>} */
    this.bySeq = new Map();
    /** Number of rows recomputed since the last reset (per-poll metric). */
    this.rebuilds = 0;
  }

  clear() {
    this.bySeq.clear();
    this.rebuilds = 0;
  }

  /**
   * Recomputes and stores one row. Call only for a new or changed row.
   * @param {number} seq
   * @param {string} type
   * @param {object} data
   */
  set(seq, type, data) {
    const entry = messageItems(seq, type, data);
    this.bySeq.set(seq, entry);
    this.rebuilds += 1;
    return entry;
  }

  /**
   * Returns a cached row, computing it only when the cache has no entry.
   * @param {number} seq
   * @param {string} type
   * @param {object} data
   */
  get(seq, type, data) {
    return this.bySeq.get(seq) || this.set(seq, type, data);
  }

  /**
   * Flattens cached rows in `seq` order. Also reports the latest assistant
   * model, matching the old full `items()` scan.
   * @param {Map<number, {type: string, data: object}>} messages
   */
  collect(messages) {
    const items = [];
    let model = null;
    let effort = null;
    let hasModel = false;
    const seqs = [...messages.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const { type, data } = messages.get(seq);
      const entry = this.get(seq, type, data);
      if (entry.hasModel) {
        model = entry.model;
        effort = entry.effort;
        hasModel = true;
      }
      for (const item of entry.items) items.push(item);
    }
    return { items, model, effort, hasModel };
  }
}

/**
 * One SQLite statement that resolves the session and returns its changed
 * messages in the same invocation. `kind` separates the session row from
 * message rows. When the resolved session differs from `knownSessionId`, all
 * of its rows are returned so a `/new` or `/resume` can start over.
 * @param {{title?: string|null, cwd?: string|null, since?: number, knownSessionId?: string|null}} input
 * @returns {string}
 */
export function buildOpenCodePollQuery({
  title = "",
  cwd = null,
  since = 0,
  knownSessionId = null,
} = {}) {
  const where = [
    "parent_id is null",
    title ? `title = ${q(title)}` : null,
    !title && cwd ? `directory = ${q(cwd)}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const orderBy =
    title && cwd ? `(directory = ${q(cwd)}) desc, time_updated desc` : "time_updated desc";
  const sinceMs = Number.isFinite(Number(since)) ? Math.max(0, Math.floor(Number(since))) : 0;
  const messagesWhere = knownSessionId
    ? `session_id = (select id from s) and (time_updated >= ${sinceMs} or (select id from s) <> ${q(knownSessionId)})`
    : `session_id = (select id from s) and time_updated >= ${sinceMs}`;

  return (
    `with s as (select id, model from session_v2 where ${where} order by ${orderBy} limit 1), ` +
    `m as (select seq, type, time_updated, data from session_message where ${messagesWhere}) ` +
    `select 0 as ord, 'session' as kind, s.id as id, s.model as model, null as seq, null as type, null as time_updated, null as data from s ` +
    `union all ` +
    `select 1 as ord, 'message' as kind, null as id, null as model, m.seq as seq, m.type as type, m.time_updated as time_updated, m.data as data from m ` +
    `order by ord, seq`
  );
}
