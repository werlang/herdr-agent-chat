// Parser for terminal conversation streams into structured chat turns.

export function stripAnsi(str) {
  return (str ?? "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "");
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
      /[▄▀█▌▐]/.test(line) ||
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
    if (
      /^(?:esc to cancel|ctrl\+c to cancel|\? for shortcuts|\[hc\]|└\s*Tip:)/i.test(line) ||
      /(?:esc to cancel|\? for shortcuts)/i.test(line) ||
      /^(?:Gemini|Claude|OpenCode|Codex)\s+[\w\.\s\·]+$/i.test(line) ||
      /●\s+\[[\d:]+\]\s+hc\s+wait/i.test(line)
    ) {
      endIndex--;
      continue;
    }
    break;
  }

  return lines.slice(0, endIndex);
}

export function parseConversation(rawText) {
  const clean = stripAnsi(rawText);
  let rawLines = clean.split("\n");

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
      rawBlocks.push({
        type: "tool",
        title,
        detail,
        status: currentBlock.status || "done",
      });
    } else if (currentBlock.type === "assistant") {
      const text = currentBlock.lines.join("\n").trim();
      if (text) {
        rawBlocks.push({ type: "assistant", text });
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

    // User turn detection
    const userMatch = trimmed.match(/^(?:>|❯|User:|Human:)\s*(.*)$/);
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
    const isBulletTool = /^[●○…]\s*(Ran|Running|Explored|Read|Edited|Updated|Created|Write|Bash|\d+\s+more\s+actions)\b/i.test(trimmed);
    const isGenericTool = /^[●○]\s+(.+)$/.test(trimmed);

    if (isSpinner || isBulletTool || isGenericTool) {
      pushCurrent();
      const isRunning = isSpinner || /Running/i.test(trimmed);
      let cleanTitle = trimmed
        .replace(/^[●○…\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]+/, "")
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

    // Tool detail lines
    if (currentBlock && currentBlock.type === "tool") {
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

    // Assistant response lines
    if (!currentBlock || currentBlock.type !== "assistant") {
      pushCurrent();
      currentBlock = { type: "assistant", lines: [line] };
    } else {
      currentBlock.lines.push(line);
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

  // Group consecutive tool blocks into tool groups
  const finalBlocks = [];
  let currentToolGroup = null;

  for (const block of consolidated) {
    if (block.type === "tool") {
      if (!currentToolGroup) {
        currentToolGroup = [block];
      } else {
        currentToolGroup.push(block);
      }
    } else {
      if (currentToolGroup) {
        if (currentToolGroup.length === 1) {
          finalBlocks.push(currentToolGroup[0]);
        } else {
          finalBlocks.push({
            type: "tool_group",
            tools: currentToolGroup,
            status: currentToolGroup.some((t) => t.status === "running") ? "running" : "done",
            count: currentToolGroup.length,
          });
        }
        currentToolGroup = null;
      }
      finalBlocks.push(block);
    }
  }

  if (currentToolGroup) {
    if (currentToolGroup.length === 1) {
      finalBlocks.push(currentToolGroup[0]);
    } else {
      finalBlocks.push({
        type: "tool_group",
        tools: currentToolGroup,
        status: currentToolGroup.some((t) => t.status === "running") ? "running" : "done",
        count: currentToolGroup.length,
      });
    }
  }

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
  const firstUser = parsed.find((b) => b.type === "user");
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
  return (at >= 0 ? cached.slice(0, at) : cached).concat(parsed);
}

