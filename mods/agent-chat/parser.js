// Parser for terminal conversation streams into structured chat turns.
import {
  classifyTool,
  summarizeToolGroup,
  toolGroupSummaryKind,
  liveThoughtLine,
} from "./transcript-blocks.js";

export {
  classifyTool,
  summarizeToolGroup,
  toolGroupSummaryKind,
  liveThoughtLine,
};

export function stripAnsi(str) {
  return (str ?? "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "");
}

/**
 * Reads an agent's current quota/usage-limit failure from the screen above its
 * idle composer (Antigravity or Codex). Other output below the error (such as a
 * permission dialog or a new prompt) makes it historical, even if the error is
 * still visible.
 */
/**
 * The last `count` lines of a screen, without ANSI codes. Callers only look at
 * the bottom of the screen, and a long scrollback must not cost every render.
 * @param {string} text
 * @param {number} count
 * @param {boolean} [nonblank=false] Skip blank rows when collecting the tail.
 * @returns {string[]}
 */
function tailLines(text, count, nonblank = false) {
  const lines = stripAnsi(text).split("\n");
  if (!nonblank) return lines.slice(-count);
  const tail = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < count; i--) {
    if (lines[i].trim() !== "") tail.push(lines[i]);
  }
  return tail.reverse();
}

/**
 * Trims whitespace and the given border characters from both ends in linear
 * time. A regex such as `/[\s│┃]+$/` retries from every position of a long
 * run of spaces (quadratic), which on a wide screen exceeded the render budget.
 * @param {string} line
 * @param {string} borders
 * @returns {string}
 */
function trimBorders(line, borders) {
  const strip = (ch) => ch.trim() === "" || borders.includes(ch);
  let start = 0;
  let end = line.length;
  while (start < end && strip(line[start])) start++;
  while (end > start && strip(line[end - 1])) end--;
  return line.slice(start, end);
}

/**
 * Whether the bottom of the screen shows a prompt that takes a key press
 * (a permission dialog, a numbered menu, a y/n question). Herdr also reports
 * `blocked` when an agent simply ends its turn with a question at an idle
 * composer; approval keys would be meaningless there.
 * @param {string} text terminal screen text
 * @returns {boolean}
 */
export function screenAwaitsChoice(text) {
  const tail = tailLines(text, 120, true)
    .map((line) => trimBorders(line, "│┃|"))
    .filter(Boolean)
    .slice(-25);
  return tail.some(
    (line) =>
      // Highlighted numbered option: "❯ 1. Yes", "› 2) No".
      /^[❯›>▶]\s*\d+[.)]\s+\S/.test(line) ||
      // Plain numbered answer options of a permission dialog.
      /^\d+[.)]\s+(?:Yes|No|Allow|Approve|Deny|Reject|Always)\b/i.test(line) ||
      // Short standalone choice lines: "Allow once", "> Deny".
      /^(?:[❯›>▶]\s*)?(?:Allow|Deny|Approve|Reject)\b.{0,40}$/i.test(line) ||
      /[([](?:y\/n|Y\/n|y\/N|yes\/no)[)\]]/.test(line)
  );
}

/**
 * Reads the selection menu at the bottom of the screen: a highlighted option
 * (`❯ No, exit`) with sibling options at the same indent, numbered or not.
 * Claude's folder-trust prompt has unnumbered options whose default is
 * "No, exit", so its choices must come from the screen, not guessed keys.
 * Antigravity marks its highlight with `>`; to tell a menu from an old user
 * turn (`> question` plus indented lines), at most a short footer may follow.
 * The heading is the dialog text between the last rule line and the options.
 * @param {string} text terminal screen text
 * @returns {{ title: string, body: string[], options: { label: string }[], selected: number } | null}
 */
export function parseScreenChoice(text) {
  // The menu sits in the last 40 lines; its heading at most 14 above that.
  const lines = tailLines(text, 80).map((line) => {
    const start = line.replace(/^\s*[│┃]\s?/, "").trimEnd();
    return /[│┃]$/.test(start) ? start.slice(0, -1).trimEnd() : start;
  });
  const indentOf = (line) => line.search(/\S/);
  const isRule = (line) => /^\s*[─━╌┄\-╭╰╮╯]{8,}\s*$/.test(line);
  const marker = /^(\s*)[❯›▶>]\s+(\S.*)$/;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const m = marker.exec(lines[i]);
    if (!m) continue;
    const col = lines[i].indexOf(m[2]);
    // Siblings sit at the label's column; deeper lines are descriptions.
    const isOption = (line) => !marker.test(line) && indentOf(line) === col;
    const belongs = (line) => line.trim() !== "" && !isRule(line) && indentOf(line) >= col && !marker.test(line);
    let first = i;
    while (first > 0 && belongs(lines[first - 1])) first--;
    let last = i;
    while (last < lines.length - 1 && belongs(lines[last + 1])) last++;
    const options = [];
    let selected = -1;
    for (let k = first; k <= last; k++) {
      if (k === i) selected = options.length;
      else if (!isOption(lines[k])) continue;
      const label = (k === i ? m[2] : lines[k].trim()).replace(/^\d+[.)]\s+/, "").trim();
      if (label) options.push({ label });
    }
    if (options.length < 2) return null;
    if (lines.slice(last + 1).filter((line) => line.trim()).length > 4) return null;
    // A line that follows a long one is its soft wrap; others start a new row.
    let top = first;
    while (top > 0 && first - top < 14 && !isRule(lines[top - 1])) top--;
    const head = [];
    let prevLong = false;
    for (let k = top; k < first; k++) {
      const line = lines[k].trim();
      if (!line) {
        prevLong = false;
        continue;
      }
      if (prevLong && head.length) head[head.length - 1] += ` ${line}`;
      else head.push(line);
      prevLong = line.length >= 70;
    }
    return { title: head[0] || "", body: head.slice(1, 5), options, selected };
  }
  return null;
}

export function terminalQuotaFailure(text) {
  const lines = stripAnsi(text).trimEnd().split("\n");
  return antigravityQuotaFailure(lines) || codexQuotaFailure(lines);
}

function antigravityQuotaFailure(lines) {
  const errorId = lines.findLastIndex((line) => /^\s*Error ID:\s*[\da-f-]+\s*$/i.test(line));
  if (errorId < 1) return null;
  const tail = lines.slice(errorId + 1).map((line) => line.trim()).filter(Boolean);
  if (!tail.includes(">") || !tail.every((line) => /^(?:>|[─━]{4,}|\? for shortcuts(?:\s.*)?)$/.test(line))) {
    return null;
  }
  const start = lines.slice(0, errorId).findLastIndex((line) => /^\s*⚠\s+Individual quota reached\b/i.test(line));
  if (start < 0) return null;
  const message = lines.slice(start, errorId).map((line) => line.trim()).join(" ");
  const match = message.match(/^⚠\s+(Individual quota reached\.[^⚠>]*\bResets in [\dhms]+\.)$/i);
  return match ? { start, text: match[1] } : null;
}

function codexQuotaFailure(lines) {
  const start = lines.findLastIndex((line) => /^\s*■\s+You['’]ve hit your usage limit\b/i.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const trimmed = lines[end].trim();
    if (!trimmed || /^[›>⚠]/.test(trimmed)) break;
    end++;
  }
  const tail = lines.slice(end).map((line) => line.trim()).filter(Boolean);
  const promptIdx = tail.findIndex((line) => /^[›>](?:\s+Ask Codex to do anything)?$/.test(line));
  if (promptIdx < 0) return null;
  const between = tail.slice(0, promptIdx);
  if (!between.every((line) => /^⚠\s+/.test(line))) return null;
  const footer = tail.slice(promptIdx + 1);
  if (footer.length > 3 || !footer.every((line) => /·|\? for shortcuts|for agents|^[─━]{4,}$/.test(line))) {
    return null;
  }
  const message = lines.slice(start, end).map((line) => line.trim()).join(" ").replace(/^■\s+/, "");
  return message ? { start, text: message } : null;
}

const SPINNERS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷";
const SPINNER_REGEX = new RegExp(`^[${SPINNERS}]`);

/**
 * Strips startup banners (Antigravity ASCII logo, Claude box, etc.)
 * from the beginning of the lines array.
 */
function stripStartupBanners(lines) {
  let startIndex = 0;
  let inBanner = false;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i].trim();
    if (
      /[▄▀█▌▐▛▜▙▟▝▘▗▖]/.test(line) ||
      /Antigravity CLI/i.test(line) ||
      /Welcome to Claude Code/i.test(line) ||
      /^[╭╰│]/.test(line)
    ) {
      inBanner = true;
      startIndex = i + 1;
      continue;
    }
    if (inBanner && (/@/.test(line) || /^~?\//.test(line) || /^[─━\-_=]{4,}$/.test(line) || line === "")) {
      startIndex = i + 1;
      continue;
    }
    if (/^(?:>|❯|User:|Human:)/.test(line)) {
      startIndex = i;
      break;
    }
    if (inBanner) {
      break;
    }
  }
  return lines.slice(startIndex);
}

/**
 * Strips bottom composer chrome and status footer lines from the end of the lines array.
 */
function stripBottomChrome(lines) {
  let endIndex = lines.length;

  while (endIndex > 0) {
    const line = lines[endIndex - 1].trim();
    if (line === "") {
      endIndex--;
      continue;
    }
    if (/^[─━\-_=]{4,}$/.test(line)) {
      endIndex--;
      continue;
    }
    if (/^(?:>|❯)$/.test(line)) {
      endIndex--;
      continue;
    }
    // Claude Code's input placeholder ("❯ Try \"fix typecheck errors\""),
    // mode footer ("⏵⏵ auto mode on…") and effort hint ("◐ medium · /effort").
    if (
      /^(?:>|❯)\s+Try\s+".*"$/.test(line) ||
      /^[⏵⏸]{1,2}\s/.test(line) ||
      /·\s+\/effort$/.test(line)
    ) {
      endIndex--;
      continue;
    }
    if (
      /^(?:esc to cancel|ctrl\+c to cancel|\? for shortcuts|\[hc\]|└\s*Tip:)/i.test(line) ||
      /(?:esc to cancel|\? for shortcuts|\/artifact to review)/i.test(line) ||
      /^(?:Gemini|Claude|OpenCode|Codex)\s+[\w.\s·]+$/i.test(line) ||
      /^[a-z0-9][a-z0-9._-]+(?:\s+(?:low|medium|high|xhigh|extra high|max|ultra))?\s+·\s+\d+%\s+left\b/i.test(line) ||
      /^(?:tab\s+agents?|ctrl\+p\s+commands?|ctrl\+t\s+variants?)/i.test(line) ||
      /●\s+\[[\d:]+\]\s+hc\s+wait/i.test(line) ||
      /^[✔✓]\s*Update installed\b/i.test(line) ||
      /^⚠\s*\d+\s+warnings?\s*·/i.test(line) ||
      /←\s*for agents/i.test(line) ||
      /^›\s*Ask Codex to do anything/i.test(line) ||
      /^[A-Za-z0-9._-]+\s+(?:low|medium|high|xhigh|max|ultra)\s+·\s+~?\//i.test(line)
    ) {
      endIndex--;
      continue;
    }
    break;
  }

  return lines.slice(0, endIndex);
}

/**
 * Parses raw terminal text into structured chat blocks (user, thought, tool, assistant).
 * @param {string} rawText
 * @returns {Array<object>}
 */
export function parseConversation(rawText) {
  const clean = stripAnsi(rawText);
  let rawLines = clean.split("\n");
  const quota = terminalQuotaFailure(clean);
  if (quota) rawLines = rawLines.slice(0, quota.start);

  rawLines = stripStartupBanners(rawLines);
  rawLines = stripBottomChrome(rawLines);

  const rawBlocks = [];
  let currentBlock = null;

  function pushCurrent() {
    if (!currentBlock) return;
    if (currentBlock.type === "user") {
      const text = currentBlock.lines.join("\n").trim();
      if (text) {
        rawBlocks.push({ type: "user", text });
      }
    } else if (currentBlock.type === "thought") {
      const header = currentBlock.header || "";
      const text = currentBlock.lines.join("\n").trim();
      rawBlocks.push({
        type: "thought",
        text: text || currentBlock.summary || header,
        header,
        duration: currentBlock.duration || null,
        summary: currentBlock.summary || null,
        status: currentBlock.status || "done",
      });
    } else if (currentBlock.type === "tool") {
      const title = currentBlock.title || "";
      const detail = currentBlock.lines.join("\n").trim();
      const classified = classifyTool("", {}, title);
      rawBlocks.push({
        type: "tool",
        title,
        detail,
        action: classified.action,
        changedFiles: classified.changedFiles,
        hasFailure: currentBlock.status === "error",
        status: currentBlock.status || "done",
      });
    } else if (currentBlock.type === "assistant") {
      const text = currentBlock.lines.join("\n").trim();
      if (text) {
        rawBlocks.push({ type: "assistant", text });
      }
    } else if (currentBlock.type === "notice") {
      if (currentBlock.text) {
        rawBlocks.push({ type: "notice", tone: currentBlock.tone || "info", text: currentBlock.text });
      }
    }
    currentBlock = null;
  }

  let inCodeFence = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // Check code fences inside assistant
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      if (!currentBlock || currentBlock.type !== "assistant") {
        pushCurrent();
        currentBlock = { type: "assistant", lines: [line] };
      } else {
        currentBlock.lines.push(line);
      }
      continue;
    }

    if (inCodeFence) {
      if (currentBlock && currentBlock.type === "assistant") {
        currentBlock.lines.push(line);
      } else {
        pushCurrent();
        currentBlock = { type: "assistant", lines: [line] };
      }
      continue;
    }

    // Skip horizontal divider lines between turns
    if (/^[─━\-_=]{4,}$/.test(trimmed)) {
      pushCurrent();
      continue;
    }

    // Skip Claude session feedback prompts
    if (/^How is Claude doing this session\b/i.test(trimmed) || /^1:\s*Bad\s+2:\s*Fine\b/i.test(trimmed)) {
      pushCurrent();
      continue;
    }

    // User turn detection
    const userMatch = trimmed.match(/^(?:>|❯|›|User:|Human:)\s*(.*)$/);
    if (userMatch) {
      pushCurrent();
      currentBlock = { type: "user", lines: userMatch[1] ? [userMatch[1]] : [] };
      continue;
    }

    // If currently accumulating a user turn and line is indented continuation
    if (currentBlock && currentBlock.type === "user") {
      if (/^\s{2,}\S/.test(line)) {
        currentBlock.lines.push(trimmed);
        continue;
      } else if (trimmed === "") {
        pushCurrent();
        continue;
      } else {
        pushCurrent();
      }
    }

    // Skip Claude turn-timer footers ("✻ Worked for 53s · done 3:28 PM")
    if (/^[✻∴]\s*(?:Worked|Cogitated|Churned|Baked|Cooked|Brewed)\s+for\s+/i.test(trimmed)) {
      pushCurrent();
      continue;
    }

    // Harness warnings and errors (never render as assistant prose)
    const warnMatch = trimmed.match(/^(?:⚠|Warning:|WARN\b)\s*(.+)$/);
    if (warnMatch) {
      pushCurrent();
      rawBlocks.push({ type: "notice", tone: "warning", text: warnMatch[1].trim() });
      continue;
    }
    const errMatch = trimmed.match(/^(?:✖|✗|Error:|ERROR\b)\s*(.+)$/);
    if (errMatch) {
      pushCurrent();
      rawBlocks.push({ type: "notice", tone: "error", text: errMatch[1].trim() });
      continue;
    }
    const bgMatch = trimmed.match(/^●\s+(Background command\s+.+)$/);
    if (bgMatch) {
      pushCurrent();
      rawBlocks.push({ type: "notice", tone: "info", text: bgMatch[1].trim() });
      continue;
    }

    // Thought blocks
    const thoughtMatch = trimmed.match(/^(?:[▸○]|✻|∴)\s*(?:Thought\s+(?:for\s+)?|Thinking\b)(.*)$/i);
    if (thoughtMatch) {
      pushCurrent();
      const rest = thoughtMatch[1].trim();
      let duration = null;
      let summary = null;
      const durMatch = rest.match(/^([^()]+?)(?:\s*\((.+)\))?$/);
      if (durMatch) {
        duration = durMatch[1].trim() || null;
        summary = durMatch[2] ? durMatch[2].trim() : null;
      }
      currentBlock = {
        type: "thought",
        header: trimmed,
        duration,
        summary,
        status: /Thinking/i.test(trimmed) ? "running" : "done",
        lines: [],
      };
      continue;
    }

    // Tool executions
    const isSpinner = SPINNER_REGEX.test(trimmed);
    const isBulletTool = /^[●○•…]\s*(Ran|Running|Explored|Read|Edited|Updated|Created|Write|Bash|Searched|Called|\d+\s+more\s+actions)\b/i.test(trimmed);
    const isParenTool = /^[●○•]\s+[A-Za-z_][A-Za-z0-9_.:-]*\(/.test(trimmed);

    if (isSpinner || isBulletTool || isParenTool) {
      pushCurrent();
      const isRunning = isSpinner || /Running/i.test(trimmed);
      let cleanTitle = trimmed
        .replace(/^[●○•…\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+/, "")
        .replace(/\(ctrl\+o to expand\)/i, "")
        .trim();
      currentBlock = {
        type: "tool",
        title: cleanTitle || trimmed,
        status: isRunning ? "running" : "done",
        lines: [],
      };
      continue;
    }

    // Tool detail or wrapped title lines
    if (currentBlock && currentBlock.type === "tool") {
      const openParens = (currentBlock.title.match(/\(/g) || []).length;
      const closeParens = (currentBlock.title.match(/\)/g) || []).length;
      if (openParens > closeParens && trimmed && !/^[>❯●○▸✻∴─━]/.test(trimmed)) {
        currentBlock.title = `${currentBlock.title} ${trimmed}`.replace(/\(ctrl\+o to expand\)/i, "").trim();
        continue;
      }
      if (/^\s*(?:[⎿└]|\s{2,})/.test(line)) {
        currentBlock.lines.push(trimmed);
        continue;
      }
    }

    // Thought detail lines
    if (currentBlock && currentBlock.type === "thought") {
      if (/^\s{2,}/.test(line)) {
        currentBlock.lines.push(trimmed);
        continue;
      }
    }

    // Assistant response lines (strip Claude's leading ● marker on prose, convert •/◦ bullets to markdown)
    const normalizedLine = line
      .replace(/^(\s*)●\s+/, "$1")
      .replace(/^(\s*)[•◦]\s+/, "$1- ");
    if (!currentBlock || currentBlock.type !== "assistant") {
      pushCurrent();
      currentBlock = { type: "assistant", lines: [normalizedLine] };
    } else {
      currentBlock.lines.push(normalizedLine);
    }
  }

  pushCurrent();

  // Consolidate consecutive assistant blocks
  const consolidated = [];
  for (const block of rawBlocks) {
    const prev = consolidated[consolidated.length - 1];
    if (prev && prev.type === "assistant" && block.type === "assistant") {
      prev.text += "\n\n" + block.text;
    } else {
      consolidated.push(block);
    }
  }

  // Group consecutive tool blocks into tool groups and attach changedFiles to assistant
  const finalBlocks = [];
  let currentToolGroup = null;
  let lastChangedFiles = [];

  const flushGroup = () => {
    if (!currentToolGroup) return;
    if (currentToolGroup.length === 1) {
      const single = currentToolGroup[0];
      if (single.changedFiles?.length > 0) {
        lastChangedFiles.push(...single.changedFiles);
      }
      finalBlocks.push(single);
    } else {
      const summaryInfo = summarizeToolGroup(currentToolGroup);
      if (summaryInfo.changedFiles?.length > 0) {
        lastChangedFiles.push(...summaryInfo.changedFiles);
      }
      finalBlocks.push({
        type: "tool_group",
        tools: currentToolGroup,
        summary: summaryInfo.summary,
        summaryKind: summaryInfo.summaryKind,
        hasFailure: summaryInfo.hasFailure,
        changedFiles: summaryInfo.changedFiles,
        status: currentToolGroup.some((t) => t.status === "running") ? "running" : "done",
        count: currentToolGroup.length,
      });
    }
    currentToolGroup = null;
  };

  for (const block of consolidated) {
    if (block.type === "tool") {
      if (!currentToolGroup) {
        currentToolGroup = [block];
      } else {
        currentToolGroup.push(block);
      }
    } else {
      flushGroup();
      const b = { ...block };
      if (b.type === "assistant" && lastChangedFiles.length > 0) {
        b.changedFiles = [...new Set(lastChangedFiles)];
        lastChangedFiles = [];
      } else if (b.type === "user") {
        lastChangedFiles = [];
      }
      finalBlocks.push(b);
    }
  }

  flushGroup();

  if (quota) finalBlocks.push({ type: "notice", tone: "error", text: quota.text });
  return finalBlocks;
}

/**
 * Splices newly parsed screen blocks onto cached history, replacing from the
 * last matching user turn or appending if no match is found.
 * @param {Array<object>} cached
 * @param {Array<object>} parsed
 * @returns {Array<object>}
 */
export function spliceHistory(cached, parsed) {
  if (!cached || cached.length === 0) return parsed;
  const firstUserIdx = parsed.findIndex((b) => b.type === "user");
  const firstUser = firstUserIdx >= 0 ? parsed[firstUserIdx] : null;
  let at = -1;
  if (firstUser) {
    for (let i = cached.length - 1; i >= 0; i--) {
      const b = cached[i];
      if (
        b.type === "user" &&
        (b.text === firstUser.text ||
          b.text.startsWith(firstUser.text.slice(0, 30)) ||
          firstUser.text.startsWith(b.text.slice(0, 30)))
      ) {
        at = i;
        break;
      }
    }
  }
  if (at >= 0) {
    return cached.slice(0, at).concat(parsed.slice(firstUserIdx));
  }
  return cached.concat(parsed);
}
