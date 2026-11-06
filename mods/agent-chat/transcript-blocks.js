// Pure helper functions for formatting and structuring transcript data into chat blocks.

/** Longest tool output kept per call; the rest is cut with a note. */
export const MAX_DETAIL = 4000;

/**
 * Extracts plain text from a message content string or array of parts.
 * @param {string|Array<object>} content
 * @returns {string}
 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Clips long text to MAX_DETAIL characters, appending a note with omitted count.
 * @param {string} text
 * @returns {string}
 */
export function clip(text) {
  if (!text) return "";
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n… (${text.length - MAX_DETAIL} more characters)` : text;
}

/**
 * Returns the final path segment.
 * @param {string} path
 * @returns {string}
 */
function basename(path) {
  return typeof path === "string" ? path.split("/").pop() : "";
}

/** Tool names categorized as read operations. */
const READ_NAMES = new Set([
  "read", "read_file", "view", "cat", "ls", "glob", "list_dir"
]);

/** Tool names categorized as file edit/write operations. */
const EDIT_NAMES = new Set([
  "edit", "write", "multiedit", "notebookedit", "write_file", "edit_file",
  "replace_file_content", "multi_replace_file_content", "apply_patch", "patch"
]);

/** Tool names categorized as command execution operations. */
const COMMAND_NAMES = new Set([
  "bash", "run", "exec", "run_command", "terminal", "shell"
]);

/** Tool names categorized as local code search operations. */
const CODE_SEARCH_NAMES = new Set([
  "grep", "search", "grep_search", "find_by_name", "codebase_search"
]);

/** Tool names categorized as web search or fetching operations. */
const SEARCH_NAMES = new Set([
  "webfetch", "websearch", "search_web", "fetch"
]);

/**
 * Extracts changed file paths from a tool call input or title.
 * @param {string} _name
 * @param {object} [input]
 * @param {string} [title]
 * @returns {string[]}
 */
export function extractChangedFiles(_name, input = {}, title = "") {
  const files = [];
  if (input && typeof input === "object") {
    if (input.file_path) files.push(String(input.file_path));
    if (input.filePath) files.push(String(input.filePath));
    if (input.path) files.push(String(input.path));
    if (input.notebook_path) files.push(String(input.notebook_path));
    if (input.target_file) files.push(String(input.target_file));
    if (Array.isArray(input.files)) files.push(...input.files.map(String));
    if (Array.isArray(input.paths)) files.push(...input.paths.map(String));
  }
  if (files.length === 0 && title) {
    const paren = String(title).match(/^(?:Edit|Edited|Updated|Created|Write)\s+\d+\s+files?\s*\(([^)]+)\)/i);
    if (paren && paren[1]) {
      for (const part of paren[1].split(/[·,]/)) {
        const cleaned = part.trim().replace(/^\+\d+$/, "");
        if (cleaned && !/^\d+$/.test(cleaned) && !cleaned.includes(" ")) {
          files.push(cleaned);
        }
      }
    } else {
      const m = String(title).match(/^(?:Edit|Edited|Write|MultiEdit|Patch|NotebookEdit)\s*(?:·\s*|\s+)([\w\-./\\]+)/i);
      if (m && m[1] && !/^\d+$/.test(m[1]) && !m[1].includes(" ")) {
        files.push(m[1]);
      }
    }
  }
  return [...new Set(files.filter(Boolean))];
}

/**
 * Classifies a tool call into a semantic action category and extracts changed files.
 * @param {string} name
 * @param {object} [input]
 * @param {string} [title]
 * @returns {{ action: "read"|"edit"|"command"|"code-search"|"search"|"other", changedFiles: string[] }}
 */
export function classifyTool(name = "", input = {}, title = "") {
  const normName = String(name || "").toLowerCase().trim();
  let action = "other";
  if (EDIT_NAMES.has(normName)) {
    action = "edit";
  } else if (COMMAND_NAMES.has(normName)) {
    action = "command";
  } else if (READ_NAMES.has(normName)) {
    action = "read";
  } else if (CODE_SEARCH_NAMES.has(normName)) {
    action = "code-search";
  } else if (SEARCH_NAMES.has(normName)) {
    action = "search";
  } else if (title) {
    const t = String(title).trim();
    if (/^(?:Edit|Edited|Write|MultiEdit|Patch|NotebookEdit)\b/i.test(t)) {
      action = "edit";
    } else if (/^(?:Ran|Running|Bash|Exec|Run|Terminal|Shell)\b/i.test(t)) {
      action = "command";
    } else if (/^(?:Read|View|Cat|LS|Glob|List|Explored)\b/i.test(t)) {
      action = "read";
    } else if (/^(?:Grep|Search|Searched code|Find)\b/i.test(t)) {
      action = "code-search";
    } else if (/^(?:WebFetch|WebSearch|Fetch|Searched the web)\b/i.test(t)) {
      action = "search";
    }
  }

  const changedFiles = action === "edit" ? extractChangedFiles(name, input, title) : [];
  return { action, changedFiles };
}

/**
 * Counts effective actions for a group; edits count distinct files modified.
 * @param {string} action
 * @param {Array<object>} entries
 * @returns {number}
 */
function toolGroupActionCount(action, entries) {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    const files = entry.changedFiles || [];
    if (files.length === 0) {
      editsWithoutFileDetails += 1;
    } else {
      for (const file of files) changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

/**
 * Produces a human-readable action label for a count of operations.
 * @param {string} action
 * @param {number} count
 * @returns {string}
 */
function toolGroupActionLabel(action, count) {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
    default:
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
  }
}

/**
 * Priority order for summary generation: commands and edits outrank reads and searches.
 * @param {string} action
 * @returns {number}
 */
function summaryActionPriority(action) {
  switch (action) {
    case "command":
    case "edit":
      return 0;
    case "read":
    case "code-search":
    case "search":
      return 1;
    default:
      return 2;
  }
}

/**
 * Computes the summary kind for a collection of tools.
 * @param {Array<object>} tools
 * @returns {string}
 */
export function toolGroupSummaryKind(tools = []) {
  if (tools.length === 0) return "other";
  const actions = new Set(tools.map((t) => t.action || "other"));
  if (actions.size === 1) return actions.values().next().value;
  return "mixed";
}

/**
 * Summarizes a tool group into natural language (e.g. "Changed 2 files and ran 1 command").
 * @param {Array<object>} tools
 * @returns {{ summary: string, summaryKind: string, hasFailure: boolean, changedFiles: string[] }}
 */
export function summarizeToolGroup(tools = []) {
  if (tools.length === 0) {
    return {
      summary: "Used 0 tools",
      summaryKind: "other",
      hasFailure: false,
      changedFiles: [],
    };
  }

  const groups = new Map();
  const allChangedFiles = new Set();

  for (const tool of tools) {
    const action = tool.action || classifyTool(tool.name, tool.input, tool.title).action;
    tool.action = action;
    const changed = tool.changedFiles || extractChangedFiles(tool.name, tool.input, tool.title);
    tool.changedFiles = changed;
    for (const f of changed) allChangedFiles.add(f);

    const group = groups.get(action);
    if (group) group.push(tool);
    else groups.set(action, [tool]);
  }

  const summaries = [...groups.entries()].map(([action, entries], index) => {
    const count = toolGroupActionCount(action, entries);
    const failedCount = entries.filter((t) => t.status === "error" || t.status === "failed" || t.hasFailure).length;
    return {
      action,
      index,
      count: entries.length,
      priority: summaryActionPriority(action),
      label: toolGroupActionLabel(action, count),
      failedCount,
    };
  });

  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);

  const labels = selected.map(({ label }) => label);
  const remainingCount = tools.length - selected.reduce((sum, g) => sum + g.count, 0);
  if (remainingCount > 0) {
    labels.push(`performed ${remainingCount} other ${remainingCount === 1 ? "action" : "actions"}`);
  }

  const sentenceLabels = labels.map((label, idx) =>
    idx === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  );

  const summary =
    sentenceLabels.length < 3
      ? sentenceLabels.join(" and ")
      : `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;

  const summaryKind = toolGroupSummaryKind(tools);
  const hasFailure = summaries.some((g) => g.failedCount > 0);

  return {
    summary,
    summaryKind,
    hasFailure,
    changedFiles: [...allChangedFiles],
  };
}

/**
 * Extracts the leading bold title or first clean sentence of a thought block.
 * @param {string} markdown
 * @returns {string}
 */
export function liveThoughtLine(markdown = "") {
  if (!markdown) return "";
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

/** djb2 string hash, base-36. Cheap and stable across runs. */
export function contentHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** A chunk closes once it holds at least this many characters. */
const MIN_CHUNK_CHARS = 1200;

/** Document-wide syntax a split could break: reference definitions, HTML blocks, containers, math. */
const DOCUMENT_WIDE = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|:::|\$\$)/m;

/** A code fence line: up to 3 spaces of indent, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A line that continues the block above it: indented, or a list item marker. */
const CONTINUATION = /^(?:\s|(?:[-*+]|\d+[.)])(?:\s|$))/;

/**
 * Greedy grouping, stable under appends: pieces join the current chunk in
 * order, and the chunk closes as soon as it holds MIN_CHUNK_CHARS. Only a
 * piece followed by a cut may close a chunk (the final piece never does), so a
 * closed chunk's text never changes and appending to the reply only changes the
 * last chunk.
 * @param {string[]} pieces cut pieces in order; the final, uncut one last
 * @returns {string[]} chunks whose concatenation is the pieces' concatenation
 */
function groupPieces(pieces) {
  const chunks = [];
  let current = "";
  for (let i = 0; i < pieces.length; i++) {
    current += pieces[i];
    const isFinal = i === pieces.length - 1;
    if (!isFinal && current.length >= MIN_CHUNK_CHARS) {
      chunks.push(current);
      current = "";
    }
  }
  chunks.push(current);
  return chunks;
}

/**
 * Splits Markdown into chunks that each render on their own: cuts only at a
 * blank line that closes every open block (not inside a code fence, and not
 * before a line that continues the block above). Pieces are then grouped
 * greedily: a chunk closes once it holds at least 1200 characters, and the
 * last chunk holds the rest. Short replies stay one chunk. Concatenating the
 * chunks gives back `text` exactly. Text with CRLF or document-wide syntax
 * comes back whole. Empty text gives `[""]`.
 * @param {string} text
 * @returns {string[]}
 */
export function splitMarkdownChunks(text) {
  const source = typeof text === "string" ? text : "";
  if (source === "" || source.includes("\r") || source.includes("[^") || DOCUMENT_WIDE.test(source)) {
    return [source];
  }
  const lines = source.split("\n");
  const pieces = [];
  let start = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (fence) {
      // Inside a fence only its closing fence (same char, at least as long) ends it.
      if (m && m[1][0] === fence.char && m[1].length >= fence.length && m[2].trim() === "") fence = null;
      continue;
    }
    if (m && (m[1][0] === "~" || !m[2].includes("`"))) {
      fence = { char: m[1][0], length: m[1].length };
      continue;
    }
    if (lines[i].trim() !== "") continue;
    // Cut after the last blank line of a run, and only before a new block.
    const next = lines[i + 1];
    if (next === undefined || next.trim() === "" || CONTINUATION.test(next)) continue;
    pieces.push(`${lines.slice(start, i + 1).join("\n")}\n`);
    start = i + 1;
  }
  pieces.push(lines.slice(start).join("\n"));
  return groupPieces(pieces);
}

/** A line that holds only a Markdown image: `![alt](src "title")`. */
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)\s*$/;

/**
 * Pulls standalone image lines out of one Markdown chunk. The native Markdown
 * view draws no images (they would vanish without a trace), so each one
 * becomes its own entry the feed shows as an attachment row. A chunk with no
 * image comes back as the single entry `{ id, text }`, unchanged.
 * @param {string} text
 * @param {string} id stable id of the chunk
 * @returns {Array<{id: string, text?: string, image?: {alt: string, src: string}}>}
 */
export function splitImageLines(text, id) {
  if (typeof text !== "string" || !text.includes("![")) return [{ id, text }];
  const out = [];
  let buffer = [];
  let fence = null;
  let n = 0;
  const flush = () => {
    if (buffer.length > 0 && buffer.some((line) => line.trim() !== "")) {
      out.push({ id: `${id}-${n++}`, text: buffer.join("\n") });
    }
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.length && f[2].trim() === "") fence = null;
      buffer.push(line);
      continue;
    }
    if (f && (f[1][0] === "~" || !f[2].includes("`"))) {
      fence = { char: f[1][0], length: f[1].length };
      buffer.push(line);
      continue;
    }
    const m = IMAGE_LINE.exec(line);
    if (m) {
      flush();
      out.push({ id: `${id}-${n++}`, image: { alt: m[1].trim(), src: m[2] } });
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out.some((entry) => entry.image) ? out : [{ id, text }];
}

/**
 * Messages one agent sends another through `hc send` arrive wrapped in
 * `<hc from="t143">…</hc>`. The chat shows the text and says who sent it.
 * @param {string} text
 * @returns {{from: string, text: string}|null} null when the text is not wrapped
 */
export function unwrapHc(text) {
  const m = /^\s*<hc from="([^"]*)">([\s\S]*?)<\/hc>\s*$/.exec(typeof text === "string" ? text : "");
  return m ? { from: m[1], text: m[2].trim() } : null;
}

/**
 * Precomputes what a feed row reads on every frame, so drawing a row never
 * scans or re-parses text. Mutates the blocks in place:
 * - thought: `liveLine`, the one-line summary of its text;
 * - user: `lineCount`, `isLong` and, when long, `preview` (the first 8 lines);
 * - assistant: `mdChunks`, its Markdown in chunks, each with a stable `id`
 *   that changes only when that chunk's text does;
 * and returns `activeDetail` for the working line: the live summary of the
 * last running thought, else the title of the last running tool, else "".
 * @param {Array<object>} blocks
 * @returns {{ activeDetail: string }}
 */
/**
 * Adds per-render facts (live thought line, user preview, markdown chunks).
 * A block whose text is unchanged reuses the chunks from the previous render,
 * so a streaming reply only re-splits its own last block.
 * @param {Array<object>} blocks
 * @param {Array<object>} [previous] the blocks currently on screen
 * @returns {{ activeDetail: string }}
 */
export function annotateRows(blocks, previous = null) {
  const previousByEkey = new Map();
  if (previous) {
    for (const b of previous) if (b.ekey) previousByEkey.set(b.ekey, b);
  }
  let activeThought = null;
  let activeTool = null;
  for (const b of blocks) {
    const old = b.ekey ? previousByEkey.get(b.ekey) : null;
    if (b.type === "thought") {
      b.liveLine = liveThoughtLine(b.text);
      if (b.status === "running") activeThought = b;
    } else if (b.type === "user") {
      const wrapped = unwrapHc(b.text);
      if (wrapped) {
        b.from = wrapped.from;
        b.text = wrapped.text;
      }
      if (old && old.text === b.text) {
        b.lineCount = old.lineCount;
        b.isLong = old.isLong;
        if (old.preview !== undefined) b.preview = old.preview;
      } else {
        const lines = (b.text || "").split("\n");
        b.lineCount = lines.length;
        b.isLong = lines.length > 10 || (b.text || "").length > 600;
        if (b.isLong) b.preview = lines.slice(0, 8).join("\n") + "\n…";
      }
    } else if (b.type === "assistant") {
      if (old?.mdChunks && old.text === b.text) {
        b.mdChunks = old.mdChunks;
      } else {
        const owner = b.ekey || b.key || "a";
        b.mdChunks = splitMarkdownChunks(b.text || "").flatMap((text, i) =>
          splitImageLines(text, `md-${owner}-${i}-${contentHash(text)}`)
        );
      }
    } else if (b.type === "tool" && b.status === "running") {
      activeTool = b;
    } else if (b.type === "tool_group") {
      for (const thought of b.thoughts || []) {
        if (thought.status === "running") activeThought = { liveLine: liveThoughtLine(thought.text) };
      }
      for (const tool of b.tools || []) {
        if (tool.status === "running") activeTool = tool;
      }
    }
  }
  let activeDetail = "";
  if (activeThought) activeDetail = activeThought.liveLine;
  else if (activeTool?.title) activeDetail = activeTool.title;
  return { activeDetail };
}

const CODE_LINE_SKIP = /^(?:const|let|var|return|if|for|while|switch|try|catch|function|async)\b/;
const ONLY_PUNCTUATION = /^[\s{}()[\];,]+$/;
const STRING_LINE = /^["'`].*["'`],?$/;

/**
 * The first meaningful line of an `execute` code-mode tool, not its raw JS.
 * Tool calls become `namespace.function`; assignments and control-flow lines
 * are unwrapped or skipped.
 * @param {string} code
 * @returns {string}
 */
function firstMeaningfulCodeLine(code) {
  for (const raw of String(code || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || ONLY_PUNCTUATION.test(line)) continue;
    if (/^[})\]]/.test(line) || /^(?:else|case|default)\b/.test(line)) continue;

    if (line.startsWith("//")) {
      line = line.replace(/^\/\/+\s*/, "").trim();
      if (line && !ONLY_PUNCTUATION.test(line)) return line;
      continue;
    }
    if (line.startsWith("/*")) {
      line = line.replace(/^\/\*+\s*/, "").replace(/\*\/\s*$/, "").trim();
      if (line && !ONLY_PUNCTUATION.test(line)) return line;
      continue;
    }

    const toolCall = /tools(?:\[["']([^"']+)["']\]|\.([A-Za-z0-9_$]+))\.([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (toolCall) return `${toolCall[1] || toolCall[2]}.${toolCall[3]}`;

    if (STRING_LINE.test(line)) continue;
    if (CODE_LINE_SKIP.test(line)) {
      line = line
        .replace(/^(?:const|let|var)\s+[A-Za-z0-9_$]+\s*=\s*/, "")
        .replace(/^(?:return|await)\s+/, "")
        .trim();
      if (!line || ONLY_PUNCTUATION.test(line) || STRING_LINE.test(line) || CODE_LINE_SKIP.test(line)) {
        continue;
      }
    }
    if (line.startsWith("await ")) line = line.slice(6).trim();
    if (!line || ONLY_PUNCTUATION.test(line) || STRING_LINE.test(line)) continue;
    return line;
  }
  return "";
}

/**
 * "Bash · run the tests", "Edit · main.js": what a tool call did, in one line.
 * Titles are the first line only, at most 60 characters; OpenCode's `execute`
 * code-mode tool is labelled from its first meaningful code line.
 * @param {string} name
 * @param {object} [input]
 * @returns {string}
 */
export function toolTitle(name, input = {}) {
  input = input || {};
  const pick =
    typeof input?.code === "string" && name === "execute"
      ? firstMeaningfulCodeLine(input.code)
      : input.description ||
        (input.file_path && basename(input.file_path)) ||
        (input.notebook_path && basename(input.notebook_path)) ||
        input.command ||
        input.pattern ||
        input.query ||
        input.url ||
        input.prompt ||
        input.skill ||
        Object.values(input).find((v) => typeof v === "string") ||
        "";
  const short = String(pick).split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (!short) return name;
  const full = `${name} · ${short}`;
  return full.length > 60 ? `${full.slice(0, 59).trimEnd()}…` : full;
}

/**
 * "2.5s", "12s": a compact worked-for duration.
 * @param {number} ms
 * @returns {string}
 */
export function formatWorkedFor(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = ms / 1000;
  return seconds < 10 ? `${Math.round(seconds * 10) / 10}s` : `${Math.round(seconds)}s`;
}

/**
 * Builds one `tool_group` block. Worked groups always become a group (even for
 * one tool) and carry the "Worked for Xs" label; consecutive-run groups keep
 * the old action summary.
 * @param {Array<object>} tools
 * @param {{workedLabel?: boolean, thoughts?: Array<object>, workedMs?: number|null}} [options]
 * @returns {object}
 */
function buildToolGroup(tools, { workedLabel = false, thoughts = [], workedMs: workedOverride = null } = {}) {
  for (const t of tools) {
    const classified = classifyTool(t.name, t.input, t.title);
    t.action = t.action || classified.action;
    t.changedFiles = t.changedFiles?.length ? t.changedFiles : classified.changedFiles;
    t.hasFailure = t.status === "error" || t.status === "failed";
  }
  const groupSummary = summarizeToolGroup(tools);
  const workedMs =
    workedOverride == null ? tools.reduce((max, t) => Math.max(max, t.workedMs || 0), 0) : workedOverride;
  const thoughtBlocks = thoughts.map((x) => ({
    text: x.text || "",
    status: x.status || "done",
    turn: x.turn ?? undefined,
  }));
  return {
    type: "tool_group",
    count: tools.length,
    tools: tools.map((x) => ({
      title: x.title,
      detail: x.detail,
      status: x.status,
      action: x.action,
      changedFiles: x.changedFiles,
      hasFailure: x.hasFailure,
    })),
    thoughts: thoughtBlocks,
    summary: workedLabel
      ? workedMs > 0
        ? `Worked for ${formatWorkedFor(workedMs)}`
        : "Worked"
      : groupSummary.summary,
    // "Ran 3 commands and read 2 files": what a worked section did, shown
    // beside its duration so the section reads without being opened.
    activity: workedLabel && tools.length > 0 ? groupSummary.summary : "",
    summaryKind: tools.length > 0 ? groupSummary.summaryKind : "thought",
    hasFailure: groupSummary.hasFailure,
    changedFiles: groupSummary.changedFiles,
    status:
      tools.some((x) => x.status === "running") || thoughtBlocks.some((x) => x.status === "running")
        ? "running"
        : "done",
    turn: tools[0]?.turn ?? thoughtBlocks[0]?.turn ?? undefined,
    durationMs: workedMs || undefined,
  };
}

/**
 * OpenCode turns start at a user message and run through every following
 * assistant row until the next user message. All thoughts and tool calls of
 * such a turn fold into one "Worked for Xs" section; the turn's assistant text
 * stays outside the section, after it.
 * @param {Array<object>} items
 * @param {boolean} agentWorking
 * @returns {Array<object>}
 */
function itemsToBlocksByTurn(items, agentWorking) {
  const out = [];
  let thoughts = [];
  let tools = [];
  let texts = [];
  /** Assistant row seq → its own worked duration, so a turn sums rows once. */
  let workedBySeq = new Map();

  const take = (item) =>
    item.type === "tool" && item.status === "running" && !agentWorking
      ? { ...item, status: "done" }
      : item;

  const trackWorked = (item) => {
    if (item.turn == null) return;
    const ms = item.workedMs || 0;
    if (ms > (workedBySeq.get(item.turn) || 0)) workedBySeq.set(item.turn, ms);
  };

  const finishTurn = () => {
    const workedMs = [...workedBySeq.values()].reduce((sum, ms) => sum + ms, 0);
    if (thoughts.length > 0 || tools.length > 0) {
      const group = buildToolGroup(tools, { workedLabel: true, thoughts, workedMs });
      out.push(group);
      const firstReply = texts.findIndex((x) => x.type === "assistant");
      if (group.changedFiles?.length > 0 && firstReply >= 0) {
        texts[firstReply] = { ...texts[firstReply], changedFiles: [...new Set(group.changedFiles)] };
      }
    }
    for (const text of texts) out.push({ ...text });
    thoughts = [];
    tools = [];
    texts = [];
    workedBySeq = new Map();
  };

  for (const item of items) {
    const it = take(item);
    if (it.type === "user") {
      finishTurn();
      out.push({ ...it });
      continue;
    }
    if (it.type === "assistant") {
      texts.push(it);
      trackWorked(it);
      continue;
    }
    // Errors, interruptions and model switches stay in their turn, after the
    // worked section, instead of splitting it in two.
    if (it.type === "notice") {
      texts.push(it);
      continue;
    }
    if (it.type === "thought") {
      thoughts.push(it);
      trackWorked(it);
      continue;
    }
    if (it.type === "tool") {
      tools.push(it);
      trackWorked(it);
      continue;
    }
    finishTurn();
    out.push({ ...it });
  }
  finishTurn();
  return out;
}

/**
 * Items as feed blocks: runs of tool calls fold into one group, and OpenCode
 * items are grouped by conversation turn: one user message, all following
 * thoughts and tools in one "Worked for Xs" section, assistant text outside.
 * @param {Array<object>} items
 * @param {boolean} agentWorking
 * @returns {Array<object>}
 */
export function itemsToBlocks(items, agentWorking) {
  if (items.some((item) => item.turn != null)) return itemsToBlocksByTurn(items, agentWorking);

  const out = [];
  // A run of consecutive thoughts and tool calls: one section, so the feed
  // does not alternate "Thought", "Read", "Thought", "Bash"... line by line.
  let run = [];
  let lastChangedFiles = [];

  const flush = () => {
    const tools = run.filter((x) => x.type === "tool");
    const thoughts = run.filter((x) => x.type === "thought");
    if (tools.length === 0) {
      // Thinking on its own keeps its own row.
      for (const thought of thoughts) out.push({ ...thought });
    } else if (tools.length === 1 && thoughts.length === 0) {
      const single = { ...tools[0] };
      const classified = classifyTool(single.name, single.input, single.title);
      single.action = single.action || classified.action;
      single.changedFiles = single.changedFiles?.length ? single.changedFiles : classified.changedFiles;
      single.hasFailure = single.status === "error" || single.status === "failed";
      if (single.changedFiles?.length > 0) {
        lastChangedFiles.push(...single.changedFiles);
      }
      out.push(single);
    } else {
      const group = buildToolGroup(tools, { thoughts });
      if (group.changedFiles?.length > 0) {
        lastChangedFiles.push(...group.changedFiles);
      }
      out.push(group);
    }
    run = [];
  };

  for (const item of items) {
    const it = item.type === "tool" && item.status === "running" && !agentWorking ? { ...item, status: "done" } : item;
    if (it.type === "tool" || it.type === "thought") {
      run.push(it);
    } else {
      flush();
      const block = { ...it };
      if (block.type === "assistant" && lastChangedFiles.length > 0) {
        block.changedFiles = [...new Set(lastChangedFiles)];
        lastChangedFiles = [];
      } else if (block.type === "user") {
        lastChangedFiles = [];
      }
      out.push(block);
    }
  }
  flush();
  return out;
}

/**
 * What a `/model` or `/effort` run reported, from its `<local-command-stdout>`:
 * "Set model to `Sonnet 5.5` and saved…" or "Set effort level to xhigh (saved…".
 * @param {string} raw
 * @returns {{model?: string, effort?: string}|null}
 */
export function settingChange(raw) {
  if (typeof raw !== "string") return null;
  const out = raw.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1];
  if (!out) return null;
  const model = out.match(/^Set model to\s+`?([^`]+?)`?(?:\s+\(default\))?(?:\s+and\b|\s*$)/);
  if (model) return { model: model[1].trim() };
  const effort = out.match(/^Set effort level to\s+(\w+)/);
  if (effort) return { effort: effort[1].toLowerCase() };
  return null;
}
