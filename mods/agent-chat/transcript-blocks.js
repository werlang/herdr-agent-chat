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
  "read", "read_file", "view", "cat", "ls", "glob", "list_dir", "list_resources", "read_resource"
]);

/** Tool names categorized as file edit/write operations. */
const EDIT_NAMES = new Set([
  "edit", "write", "create", "update", "multiedit", "notebookedit", "write_file", "edit_file",
  "replace_file_content", "multi_replace_file_content", "apply_patch", "patch"
]);

/** Tool names categorized as command execution operations. */
const COMMAND_NAMES = new Set([
  "bash", "run", "exec", "exec_command", "write_stdin", "run_command", "terminal", "shell", "managetask", "manage_task"
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
    if (input.Path) files.push(String(input.Path));
    if (input.notebook_path) files.push(String(input.notebook_path));
    if (input.target_file) files.push(String(input.target_file));
    if (input.TargetFile) files.push(String(input.TargetFile));
    if (Array.isArray(input.files)) files.push(...input.files.map(String));
    if (Array.isArray(input.paths)) files.push(...input.paths.map(String));
    if (typeof input.patch === "string") {
      for (const m of input.patch.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm)) {
        files.push(m[1].trim());
      }
    }
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
/**
 * Unwraps `<hc from="tX">body</hc>` cross-agent messages.
 * Suppresses `from` when the sender is a local `ppid:` process tag.
 * @param {string} text
 * @returns {{ from: string|null, text: string } | null}
 */
export function unwrapHc(text) {
  const m = /^\s*<hc\b[^>]*\bfrom="([^"]*)"[^>]*>([\s\S]*?)<\/hc>\s*$/.exec(typeof text === "string" ? text : "");
  if (!m) return null;
  const sender = m[1].trim();
  const from = !sender || /(?:^|\/)ppid:\d+$/.test(sender) ? null : sender;
  return { from, text: m[2].trim() };
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
        if (wrapped.from) b.from = wrapped.from;
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
      if (old?.mdChunks && old?.mdBlocks && old.text === b.text) {
        b.mdChunks = old.mdChunks;
        b.mdBlocks = old.mdBlocks;
      } else {
        const owner = b.ekey || b.key || "a";
        b.mdChunks = splitMarkdownChunks(b.text || "").flatMap((text, i) =>
          splitImageLines(text, `md-${owner}-${i}-${contentHash(text)}`)
        );
        b.mdBlocks = parseMarkdownBlocks(b.text || "");
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
  const filePath = input.file_path || input.filePath || input.Path || input.TargetFile || input.target_file || input.path;
  const pick =
    typeof input?.code === "string" && name === "execute"
      ? firstMeaningfulCodeLine(input.code)
      : input.toolSummary ||
        input.description ||
        (filePath && basename(String(filePath))) ||
        (input.notebook_path && basename(input.notebook_path)) ||
        input.command ||
        input.CommandLine ||
        input.cmd ||
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
/**
 * Parses model/effort/compaction notices from Claude `<local-command-stdout>` blocks.
 * @param {string} raw
 * @returns {{ model?: string, effort?: string, notice?: string } | null}
 */
export function settingChange(raw) {
  if (typeof raw !== "string") return null;
  const out = raw.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim();
  if (!out) return null;
  const model = out.match(/^(?:Set model to|Model set to)\s+`?([^`\n]+?)`?(?:\s+and\b|\s*$)/i);
  if (model) {
    const clean = model[1].replace(/\s*\(default\)\s*$/i, "").trim();
    return clean ? { model: clean } : null;
  }
  const effort = out.match(/^(?:Set effort level to|Effort set to)\s+(\w+)/i);
  if (effort) return { effort: effort[1].toLowerCase() };
  return null;
}

/**
 * Extracts the remote machine prefix from a terminal address like `rpi5/t16r`, or null if local.
 * @param {string} address
 * @returns {string|null}
 */
export function terminalMachine(address) {
  if (typeof address !== "string") return null;
  const i = address.indexOf("/");
  return i > 0 ? address.slice(0, i) : null;
}

/**
 * Extracts the local terminal ID from an address (`rpi5/t16r` -> `t16r`, `t16r` -> `t16r`).
 * @param {string} address
 * @returns {string}
 */
export function terminalLocalAddress(address) {
  if (typeof address !== "string") return "";
  const i = address.indexOf("/");
  return i > 0 ? address.slice(i + 1) : address;
}

const HARNESS_TAG_NAMES = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "task-notification",
  "ADDITIONAL_METADATA",
  "USER_SETTINGS_CHANGE",
  "EXTREMELY_IMPORTANT",
  "user_info",
  "context",
];

const HARNESS_TAG_RE = new RegExp(
  `<(${HARNESS_TAG_NAMES.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  "gi"
);

/**
 * Removes injected harness XML blocks from user text while preserving actual user content.
 * @param {string} raw
 * @returns {string}
 */
export function stripHarnessXml(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(HARNESS_TAG_RE, "");
  const userReq = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (userReq) text = userReq[1];
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Reads the model name from Claude Code's startup banner or status line.
 * @param {string} rawText
 * @returns {string}
 */
export function claudeScreenModel(rawText) {
  if (!rawText) return "";
  const lines = String(rawText).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  for (const line of lines) {
    // Banner: "Opus 5.5 · Claude Max" or "Sonnet 4.6 · ..."
    const banner = line.match(/^\s*([A-Z][A-Za-z0-9 ._-]{1,36}?)\s+·\s+Claude\b/);
    if (banner) return banner[1].trim();
    // Status bar: "Opus 5.5 (1M context)" or "Claude Opus 5.5"
    const ctx = line.match(/^\s*(?:Claude\s+)?((?:Opus|Sonnet|Haiku|Fable)\s+[0-9.]+)\s*(?:\(|·|$)/);
    if (ctx) return ctx[1].trim();
  }
  return "";
}

/**
 * Reads the active model (and optional effort) from a terminal screen capture when no transcript exists yet.
 * @param {string} rawText
 * @param {string} [app]
 * @returns {string}
 */
export function screenModel(rawText, app = "") {
  if (!rawText) return "";
  const clean = String(rawText).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  if (app === "claude") return claudeScreenModel(clean);
  const lines = clean.split("\n");
  if (app === "codex") {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\s*([a-z0-9][a-z0-9._-]+(?:\s+(?:low|medium|high|xhigh|extra high|max|ultra))?)\s+·\s+(?:\d+%\s+left|\/)/i);
      if (m) return m[1].trim();
    }
    return "";
  }
  if (app === "antigravity") {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\b((?:gemini|claude|gpt|orchestrator)[a-z0-9._ -]{2,40})\s*(?:\||·|$)/i);
      if (m) return m[1].trim();
    }
    return "";
  }
  // OpenCode TUI footer: "┃  Claude Sonnet 4.5  Anthropic  ·  high" or "Build  Claude ...  Anthropic"
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const oc = line.match(/(?:Build|Plan|Chat)\s+([A-Z][A-Za-z0-9 ._-]{2,40}?)\s{2,}([A-Z][A-Za-z0-9 ._-]+)/);
    if (oc) return oc[1].trim();
  }
  return claudeScreenModel(clean);
}

const AGY_EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh)$/i;

/**
 * Splits an Antigravity model ID into its base family ID and effort level (if encoded as a suffix).
 * @param {string} id
 * @returns {{ familyId: string, effort: string }}
 */
export function parseAntigravityModel(id) {
  const raw = String(id || "").trim();
  const m = raw.match(AGY_EFFORT_SUFFIX_RE);
  if (!m) return { familyId: raw, effort: "" };
  return { familyId: raw.slice(0, -m[0].length), effort: m[1].toLowerCase() };
}

/**
 * Groups flat Antigravity model entries (e.g. `gemini-4-neon-low`, `gemini-4-neon-high`)
 * into selectable model families with their supported effort levels.
 * @param {Array<{ id: string, label?: string, name?: string }>} models
 * @returns {Array<{ id: string, label: string, efforts: string[], variants: Record<string, string> }>}
 */
export function groupAntigravityModels(models) {
  const byFamily = new Map();
  for (const item of models || []) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    const { familyId, effort } = parseAntigravityModel(id);
    const rawLabel = String(item?.label || item?.name || id).trim();
    const baseLabel = effort
      ? rawLabel.replace(new RegExp(`\\s*\\(?${effort}\\)?\\s*$`, "i"), "").trim()
      : rawLabel;
    let entry = byFamily.get(familyId);
    if (!entry) {
      entry = { id: familyId, label: baseLabel || familyId, efforts: [], variants: {} };
      byFamily.set(familyId, entry);
    }
    if (effort) {
      if (!entry.efforts.includes(effort)) entry.efforts.push(effort);
      entry.variants[effort] = id;
    } else {
      entry.variants.default = id;
    }
  }
  return [...byFamily.values()];
}

/**
 * Estimates rendered height in pixels for a single feed block.
 * @param {object} block
 * @param {Set<string>} [expandedSet]
 * @param {number} [columnWidth]
 * @returns {number}
 */
export function estimateBlockHeight(block, expandedSet, columnWidth = 760) {
  if (!block) return 0;
  if (block.type === "spacer") return Number(block.size) || 12;

  const ekey = block.ekey || "";
  const open = Boolean(expandedSet && ekey && expandedSet.has(ekey));

  if (block.type === "user") {
    const raw = block.isLong && !open ? (block.preview ?? block.text ?? "") : (block.text ?? "");
    const lines = String(raw).split("\n");
    const wrapped = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 62)), 0);
    return 24 + 20 + (block.from ? 18 : 0) + (block.isLong ? 24 : 0) + wrapped * 22;
  }

  if (block.type === "assistant") {
    const contentWidth = Math.max(240, Math.min(columnWidth, 760) - 48);
    const mdBlocks = block.mdBlocks || parseMarkdownBlocks(block.text || "");
    let h = 16;
    if (mdBlocks.length > 0) {
      for (let i = 0; i < mdBlocks.length; i++) {
        if (i > 0) h += 10;
        h += estimateMdBlockHeight(mdBlocks[i], contentWidth);
      }
    }
    const meta = (block.changedFiles?.length || 0) > 0 ? 28 : 0;
    return h + meta;
  }

  if (block.type === "thought") {
    if (!open) return 28;
    const lines = String(block.text || block.summary || "").split("\n").length;
    return 28 + Math.min(280, Math.max(48, lines * 21 + 30));
  }

  if (block.type === "tool") {
    if (!open || !block.detail) return 26;
    const lines = String(block.detail).split("\n").length;
    return 26 + Math.min(240, Math.max(44, lines * 18 + 30));
  }

  if (block.type === "tool_group") {
    if (!open) return 28;
    let h = 34;
    const thoughts = block.thoughts || [];
    for (let i = 0; i < thoughts.length; i++) {
      if (!thoughts[i]?.text) continue;
      h += 24;
      if (expandedSet?.has(`${ekey}:thought${i}`)) {
        const lines = String(thoughts[i].text).split("\n").length;
        h += Math.min(280, Math.max(48, lines * 21 + 30));
      }
    }
    const tools = block.tools || [];
    for (let i = 0; i < tools.length; i++) {
      h += 24;
      if (tools[i]?.detail && expandedSet?.has(`${ekey}:tool${i}`)) {
        const lines = String(tools[i].detail).split("\n").length;
        h += Math.min(240, Math.max(44, lines * 18 + 30));
      }
    }
    return h;
  }

  if (block.type === "notice") {
    if (block.tone === "warning" || block.tone === "error") {
      const lines = String(block.text || "").split("\n");
      const wrapped = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil(l.length / 76)), 0);
      return 12 + Math.max(32, wrapped * 18 + 14);
    }
    return 34;
  }

  return 32;
}

/**
 * Computes feed row offsets and scroll bounds for a top-to-bottom viewport.
 * @param {Array<object>} blocks
 * @param {Set<string>} [expandedSet]
 * @param {number} [viewportHeight]
 * @param {boolean} [hasEarlier]
 * @param {number} [columnWidth]
 * @returns {{ totalHeight: number, maxScroll: number, rowOffsets: number[] }}
 */
export function computeFeedLayout(
  blocks = [],
  expandedSet = null,
  viewportHeight = 600,
  hasEarlier = false,
  columnWidth = 760
) {
  const vh = Math.max(100, Number(viewportHeight) || 600);
  let y = (hasEarlier ? 44 : 0) + 12;
  const rowOffsets = [];
  for (const b of blocks) {
    rowOffsets.push(y);
    y += estimateBlockHeight(b, expandedSet, columnWidth);
  }
  y += 24;
  const totalHeight = Math.max(vh, y);
  const maxScroll = Math.max(0, totalHeight - vh);
  return { totalHeight, maxScroll, rowOffsets };
}




const MD_LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/;
const MD_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const MD_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const MD_RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const MD_QUOTE = /^ {0,3}>/;
const MD_TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function mdIndentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function mdSplitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function mdStartsBlock(line) {
  return (
    MD_FENCE_OPEN.test(line) ||
    MD_HEADING.test(line) ||
    MD_RULE.test(line) ||
    MD_QUOTE.test(line) ||
    IMAGE_LINE.test(line) ||
    (MD_LIST_ITEM.test(line) && line.trim() !== "")
  );
}

function parseMdLines(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = MD_FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1];
      const closer = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !closer.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    const img = IMAGE_LINE.exec(line);
    if (img) {
      blocks.push({ type: "image", alt: img[1].trim(), src: img[2] });
      i++;
      continue;
    }

    const heading = MD_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] || "" });
      i++;
      continue;
    }

    if (MD_RULE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (MD_QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      blocks.push({ type: "quote", blocks: parseMdLines(inner) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && MD_TABLE_DELIMITER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const align = mdSplitRow(lines[i + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left"
      );
      const header = mdSplitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(mdSplitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", align, header, rows });
      continue;
    }

    const item = MD_LIST_ITEM.exec(line);
    if (item && mdIndentOf(line) < 4) {
      const indent = mdIndentOf(line);
      const ordered = /\d/.test(item[2][0]);
      const list = { type: "list", ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: [] };
      while (i < lines.length) {
        const m = MD_LIST_ITEM.exec(lines[i]);
        if (!m || mdIndentOf(lines[i]) !== indent || /\d/.test(m[2][0]) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + m[3].length;
        const body = [m[4]];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (next.trim() === "") {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === "") j++;
            if (j < lines.length && mdIndentOf(lines[j]) > indent) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (mdIndentOf(next) <= indent) break;
          body.push(next.slice(Math.min(mdIndentOf(next), contentIndent)));
          i++;
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body[0]);
        if (task) body[0] = task[2];
        list.items.push({ checked: task ? task[1].toLowerCase() === "x" : null, blocks: parseMdLines(body) });
      }
      blocks.push(list);
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !mdStartsBlock(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

/**
 * Parses Markdown into structured blocks (headings, paragraphs, lists, code, quotes, tables, rules, images).
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseMarkdownBlocks(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) return [];
  return parseMdLines(source.replace(/\r\n?/g, "\n").split("\n"));
}

function estimateMdBlockHeight(block, width) {
  if (!block) return 0;
  switch (block.type) {
    case "heading": {
      const sizes = { 1: 22, 2: 18, 3: 16, 4: 14.5, 5: 14, 6: 13.5 };
      const sz = sizes[block.level] || 14;
      const charsPerLine = Math.max(12, Math.floor(width / (sz * 0.55)));
      const lines = Math.max(1, Math.ceil((block.text || "").length / charsPerLine));
      return lines * Math.round(sz * 1.35) + (block.level <= 2 ? 8 : 2);
    }
    case "paragraph": {
      const charsPerLine = Math.max(16, Math.floor(width / 7.5));
      const lines = Math.max(1, Math.ceil((block.text || "").length / charsPerLine));
      return lines * 22;
    }
    case "code": {
      const lines = (block.text || "").split("\n").length;
      return lines * 19 + 26;
    }
    case "image":
      return 38;
    case "hr":
      return 12;
    case "quote": {
      const innerWidth = Math.max(100, width - 20);
      let h = 0;
      const sub = block.blocks || [];
      for (let i = 0; i < sub.length; i++) {
        if (i > 0) h += 8;
        h += estimateMdBlockHeight(sub[i], innerWidth);
      }
      return h + 4;
    }
    case "list": {
      const innerWidth = Math.max(100, width - 32);
      let h = 0;
      const items = block.items || [];
      for (let i = 0; i < items.length; i++) {
        if (i > 0) h += 4;
        let itemH = 0;
        const sub = items[i].blocks || [];
        for (let j = 0; j < sub.length; j++) {
          if (j > 0) itemH += 6;
          itemH += estimateMdBlockHeight(sub[j], innerWidth);
        }
        h += Math.max(22, itemH);
      }
      return h;
    }
    case "table": {
      const rows = (block.rows || []).length + 1;
      return rows * 30 + 6;
    }
    default:
      return 22;
  }
}

/**
 * Resolves an internal link or file path (`file:///...`, `/abs/path`, `rel/path#L10`)
 * into `{ fullPath, folder, file, name, line }` for opening in `file-editor`.
 * Returns `null` for external URLs (`http:`, `https:`, `mailto:`, etc.) or `#anchors`.
 *
 * @param {string} rawUrl
 * @param {string} [cwd=""]
 * @returns {{ fullPath: string, folder: string, file: string, name: string, line: number | null } | null}
 */
export function resolveInternalFileLink(rawUrl, cwd = "") {
  if (typeof rawUrl !== "string") return null;
  let target = rawUrl.trim();
  if (!target || target.startsWith("#")) return null;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "file") return null;
    target = target.slice("file:".length);
    if (target.startsWith("//localhost/")) target = target.slice("//localhost".length);
    else if (target.startsWith("///")) target = target.slice(2);
    else if (target.startsWith("//")) target = target.slice(1);
    try {
      target = decodeURIComponent(target);
    } catch (_e) {}
  }

  let line = null;
  const hashIdx = target.indexOf("#");
  if (hashIdx >= 0) {
    const frag = target.slice(hashIdx + 1);
    const lineMatch = /^L?(\d+)(?:[-–—:]L?\d+)?$/i.exec(frag);
    if (lineMatch) line = Number.parseInt(lineMatch[1], 10);
    target = target.slice(0, hashIdx);
  }
  const colonLine = /^(.*?):(\d+)(?::\d+)?$/.exec(target);
  if (colonLine && colonLine[1]) {
    if (line === null) line = Number.parseInt(colonLine[2], 10);
    target = colonLine[1];
  }
  if (!target) return null;

  const baseCwd = String(cwd || "").replace(/\/+$/, "");
  let combined = target;
  if (!target.startsWith("/")) {
    if (!baseCwd) return null;
    combined = `${baseCwd}/${target}`;
  }

  const parts = [];
  for (const seg of combined.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const fullPath = "/" + parts.join("/");
  if (fullPath === "/") return null;

  let folder;
  let file;
  if (baseCwd && fullPath.startsWith(`${baseCwd}/`)) {
    folder = baseCwd;
    file = fullPath.slice(baseCwd.length + 1);
  } else {
    const lastSlash = fullPath.lastIndexOf("/");
    folder = lastSlash > 0 ? fullPath.slice(0, lastSlash) : "/";
    file = fullPath.slice(lastSlash + 1);
  }
  if (!file) return null;
  const name = file.split("/").pop() || file;
  return { fullPath, folder, file, name, line };
}

/**
 * Prepends newly discovered earlier CLI blocks above `currentBlocks`,
 * deduplicating any overlap with the start of `currentBlocks`.
 *
 * @param {Array<object>} olderBlocks
 * @param {Array<object>} currentBlocks
 * @returns {{ merged: Array<object>, addedCount: number }}
 */
export function prependEarlierBlocks(olderBlocks = [], currentBlocks = []) {
  if (!Array.isArray(olderBlocks) || olderBlocks.length === 0) {
    return { merged: currentBlocks || [], addedCount: 0 };
  }
  if (!Array.isArray(currentBlocks) || currentBlocks.length === 0) {
    return { merged: olderBlocks.slice(), addedCount: olderBlocks.length };
  }
  const head = currentBlocks[0];
  const sameBlock = (a, b) =>
    a &&
    b &&
    a.type === b.type &&
    (a.text || "") === (b.text || "") &&
    (a.title || "") === (b.title || "");

  let overlapIdx = -1;
  for (let i = olderBlocks.length - 1; i >= 0; i--) {
    if (sameBlock(olderBlocks[i], head)) {
      overlapIdx = i;
      break;
    }
  }
  if (overlapIdx > 0) {
    const prefix = olderBlocks.slice(0, overlapIdx);
    return { merged: prefix.concat(currentBlocks), addedCount: prefix.length };
  }
  if (overlapIdx === 0) {
    return { merged: currentBlocks, addedCount: 0 };
  }
  const tail = olderBlocks[olderBlocks.length - 1];
  const tailInCurrent = currentBlocks.some((b) => sameBlock(b, tail));
  if (tailInCurrent) {
    return { merged: currentBlocks, addedCount: 0 };
  }
  return { merged: olderBlocks.concat(currentBlocks), addedCount: olderBlocks.length };
}

/**
 * Adjusts `scrollFromBottom` after a viewport resize so the top visible pixel
 * (`scrollY = maxScroll - scrollFromBottom`) stays anchored at the same content.
 *
 * @param {number} scrollFromBottom
 * @param {number} prevMaxScroll
 * @param {number} nextMaxScroll
 * @returns {number}
 */
export function preserveScrollOnResize(scrollFromBottom, prevMaxScroll, nextMaxScroll) {
  const prevScrollY = Math.max(0, (prevMaxScroll || 0) - (scrollFromBottom || 0));
  return Math.max(0, Math.min(nextMaxScroll || 0, (nextMaxScroll || 0) - prevScrollY));
}

/**
 * Computes the exact new `scrollY` after prepending content above the viewport
 * using the real measured content height delta so visible rows stay pixel-locked.
 *
 * @param {number} prevScrollY
 * @param {number} prevHeight
 * @param {number} newHeight
 * @returns {number}
 */
export function applyPrependAnchor(prevScrollY, prevHeight, newHeight) {
  const delta = Math.max(0, (newHeight || 0) - (prevHeight || 0));
  return Math.max(0, (prevScrollY || 0) + delta);
}
