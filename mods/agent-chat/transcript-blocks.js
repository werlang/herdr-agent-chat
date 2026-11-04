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

/**
 * "Bash · run the tests", "Edit · main.js": what a tool call did, in one line.
 * @param {string} name
 * @param {object} [input]
 * @returns {string}
 */
export function toolTitle(name, input = {}) {
  const pick =
    input.description ||
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
  const short = String(pick).replace(/\s+/g, " ").trim();
  return short ? `${name} · ${short.length > 120 ? short.slice(0, 118) + "…" : short}` : name;
}

/**
 * Items as feed blocks: runs of tool calls fold into one group.
 * @param {Array<object>} items
 * @param {boolean} agentWorking
 * @returns {Array<object>}
 */
export function itemsToBlocks(items, agentWorking) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) out.push({ ...run[0] });
    else if (run.length > 1) {
      out.push({
        type: "tool_group",
        count: run.length,
        tools: run.map((x) => ({ title: x.title, detail: x.detail, status: x.status })),
        status: run.some((x) => x.status === "running") ? "running" : "done",
      });
    }
    run = [];
  };
  for (const item of items) {
    // A call with no result after the agent stopped did not run (denied or interrupted).
    const it = item.type === "tool" && item.status === "running" && !agentWorking ? { ...item, status: "done" } : item;
    if (it.type === "tool") run.push(it);
    else {
      flush();
      out.push({ ...it });
    }
  }
  flush();
  return out;
}
