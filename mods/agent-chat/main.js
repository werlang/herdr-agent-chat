// Native Chat UI for AI agent terminals in Herdr.
//
// Layout follows the familiar assistant-chat pattern: one centered reading
// column, the person's turns as rounded bubbles on the right, the agent's
// replies as plain full-width Markdown, collapsed "thinking" and tool lines,
// and a rounded composer pinned to the bottom.
//
// The feed is a reversed scroll container: rows are drawn newest-first inside
// a `flex_col_reverse`, so GPUI starts at the bottom and keeps the newest turn
// visible without any programmatic scrolling. When the person scrolls up, the
// feed freezes its window (new turns do not move their view), and older turns
// load a page at a time. Only a bounded window of rows is built, so a long
// session does not cost a full transcript render on every poll.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, TextView } from "gpui-base";
import {
  hc,
  exec,
  run,
  props,
  theme,
  settings,
  terminals,
  agents,
  panes,
  focused,
  spaces,
  knownAgents,
  placement,
  window,
} from "herdr";
import {
  parseConversation,
  spliceHistory,
  toolGroupSummaryKind,
  summarizeToolGroup,
  classifyTool,
} from "./parser.js";
import { annotateRows, contentHash, liveThoughtLine } from "./transcript-blocks.js";
import { resolvePaneVisibility } from "./pane-visibility.js";
import { ClaudeTranscript } from "./claude-transcript.js";
import { OpenCodeTranscript } from "./opencode-transcript.js";

/** Width of the reading column, in px. */
const COLUMN = 760;

/** Turns kept in the live window, and added per "Load earlier" click. */
const FEED_WINDOW = 20;
const FEED_PAGE = 60;

/**
 * Claude Code's own `/model` picker, in its order. `/model <id>` switches the
 * session (and saves it as the default); "default" follows the account's
 * recommended model. Older models live behind its "More models" row, so the
 * last entry here opens the native picker instead of guessing their ids.
 */
const CLAUDE_MODELS = [
  { id: "default", label: "Default", note: "Recommended model for your plan" },
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "For complex work and everyday tasks" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Most efficient for simpler tasks" },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "For your toughest challenges" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "Fastest for quick answers" },
];

/** Claude Code's `/effort` levels, the same five its picker steps through. */
const CLAUDE_EFFORTS = [
  { id: "low", label: "Low", note: "Quickest, for simple tasks" },
  { id: "medium", label: "Medium", note: "Balanced speed and depth" },
  { id: "high", label: "High", note: "Thinks longer on hard problems" },
  { id: "xhigh", label: "xHigh", note: "Deeper than high" },
  { id: "max", label: "Max", note: "Most thorough, slowest" },
];

/** Models Antigravity CLI can switch to. */
const ANTIGRAVITY_MODELS = [
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", note: "Fast with deep reasoning" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "High speed for coding" },
  { id: "gemini-3.8-pro", label: "Gemini 3.8 Pro", note: "Most complex reasoning" },
  { id: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet", note: "Hybrid reasoning" },
];

/** Effort levels agents accept with `/effort <level>`. */
const EFFORTS = [
  { id: "low", label: "Low", note: "Quickest, for simple tasks", bars: 1 },
  { id: "medium", label: "Medium", note: "Balanced speed and depth", bars: 2 },
  { id: "high", label: "High", note: "Thinks longer on hard problems", bars: 3 },
  { id: "max", label: "Max", note: "Most thorough, slowest", bars: 3 },
];

/**
 * Returns human-readable label for an effort ID.
 * @param {string|null} id
 * @returns {string|null}
 */
function effortLabel(id) {
  if (id === "xhigh") return "xHigh";
  return EFFORTS.find((e) => e.id === id)?.label || (id ? id[0].toUpperCase() + id.slice(1) : null);
}

/** "Opus 5.5" for "claude-opus-5-5" (and dated or suffixed variants of it). */
function claudeModelLabel(id) {
  return CLAUDE_MODELS.find((m) => id && id.startsWith(m.id))?.label || id || null;
}

/** "deepseek-v4.1-flash" → "Deepseek V4.1 Flash", for before the catalogue loads. */
function prettyModel(id) {
  if (!id) return null;
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => (/^v?\d/.test(w) ? w.toUpperCase().replace(/^V/, "V") : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Renders rising effort bars: one per level, from low (1) to max (5).
 * @param {string|null} effortId
 * @param {any} t
 * @param {boolean} [highlightMax=false]
 * @returns {any}
 */
function renderEffortGlyph(effortId, t, highlightMax = false) {
  const id = (effortId || "").toLowerCase();
  const count = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }[id] || 0;

  const heights = [3, 5, 7, 9, 11];
  return h_flex()
    .items_end()
    .gap(2)
    .h(12)
    .children(
      heights.map((h, i) =>
        div()
          .w(2)
          .h(h)
          .rounded(1)
          .bg(
            i < count
              ? t.accent
              : withAlpha(t.dim, "40")
          )
      )
    );
}


/**
 * Claude Code's model and effort as its screen shows them: the welcome banner
 * ("Opus 5.5 with medium effort · Claude Pro") and the effort hint above the
 * input ("◉ xhigh · /effort"), which is the more current of the two.
 * @param {string} text
 * @returns {{model: string|null, effort: string|null}|null}
 */
function claudeScreenModel(text) {
  const lines = (text || "").split("\n");
  let model = null;
  let effort = null;
  for (const line of lines) {
    const banner = line.match(/[▐▛█▜▀▝▘\s]*(\S.*?)\s+with\s+(\w+)\s+effort\b/);
    if (banner && !model) {
      model = banner[1].trim();
      effort = effort || banner[2].toLowerCase();
    }
    const hint = line.match(/(?:^|\s)\S\s+(minimal|low|medium|high|xhigh|max)\s+·\s+\/effort\s*$/);
    if (hint) effort = hint[1];
  }
  return model || effort ? { model, effort } : null;
}

/**
 * The model an agent's own status line names, read from its screen:
 * OpenCode: "Build auto · DeepSeek V4.1 Flash OpenCode Go · max"
 * Antigravity: "? for shortcuts      Gemini 3.8 Flash · medium"
 */
function screenModel(text) {
  const lines = (text || "").split("\n").slice(-20).reverse();
  for (const raw of lines) {
    const line = raw.replace(/[│┃▏▕█▌▐|]/g, " ").trim();
    // The mode may carry a word ("Build auto · …") or stand alone ("Build · …").
    const mode = line.match(/(?:^|\s)(?:Build|Plan)(?:\s+[^\s·]+)?\s+·\s+(.+?)(?:\s+·\s+(\S+))?$/);
    if (mode) return { model: mode[1].trim(), effort: mode[2] || null };
    const tail = line.match(/\s{2,}(\S.*?)\s+·\s+(minimal|low|medium|high|xhigh|max)$/);
    if (tail) return { model: tail[1].trim(), effort: tail[2] };
  }
  return null;
}

/**
 * Which agent a terminal runs, as its own report names it ("claude-code",
 * "opencode", …). A freshly started agent has not reported yet (`app` is
 * null until its first status), so the program it runs stands in for it;
 * otherwise a new Claude session would be read off its welcome screen.
 * @param {any} agent an `agents()` entry
 * @returns {string|null}
 */
function agentApp(agent) {
  if (agent?.app) return agent.app;
  const key = agent?.program?.key;
  return { claude: "claude-code", opencode: "opencode", antigravity: "antigravity", agy: "antigravity" }[key] || key || null;
}

/**
 * The `agents()` entry for a terminal. A headless agent (started with
 * `hc run`, a sub-agent with no pane of its own) is not in `agents()`, so its
 * `terminals()` row stands in, shaped the same where the chat reads it.
 * @param {string|null} address
 * @returns {any|null}
 */
function findAgent(address) {
  if (!address) return null;
  const agent = agents().find((a) => a.address === address);
  if (agent) return agent;
  const term = terminals().find((t) => t.address === address);
  // Only agents: a plain shell reports no status and is not an agent program.
  if (!term || (!term.report?.app && !term.program?.agent && !term.status)) return null;
  return {
    address,
    app: term.report?.app || term.agent || null,
    program: term.program,
    status: term.status || "idle",
    title: term.name || term.program?.name || address,
  };
}

function resolveTerminal() {
  const p = props();
  if (p?.terminal) return p.terminal;
  const f = focused();
  if (f?.agent) return f.agent;
  if (f?.terminal) {
    const isLive = terminals().some((t) => t.address === f.terminal && t.state === "live");
    if (isLive) return f.terminal;
  }
  const s = spaces().find((sp) => sp.active);
  if (s) {
    const tabIds = new Set((s.tabs ?? []).map((t) => t.id));
    const agentInSpace = agents().find((a) => tabIds.has(a.tab));
    if (agentInSpace) return agentInSpace.address;
    const paneInSpace = panes().find((pn) => tabIds.has(pn.tab) && pn.terminal);
    if (paneInSpace?.terminal) return paneInSpace.terminal;
  }
  return agents()[0]?.address ?? terminals().find((t) => t.state === "live")?.address ?? null;
}

function iconFor(program, size, color) {
  if (!program?.icon) return svg("mods/agent-chat/icons/chat.svg").size(size).text_color(color);
  return program.tint
    ? svg(program.icon).size(size).flex_none().text_color(color)
    : image(program.icon).w(size).h(size).flex_none();
}

function withAlpha(color, alphaHex) {
  if (!color || typeof color !== "string") return color;
  if (color.startsWith("#")) {
    const base = color.length >= 7 ? color.slice(0, 7) : color;
    return base + alphaHex;
  }
  return color;
}

/**
 * Whether two blocks at the same `ekey` draw the same content. Transcript
 * readers reuse the underlying strings for unchanged turns, so most checks are
 * reference comparisons and a stream only hashes the row that grew.
 * @param {object} a previous block
 * @param {object} b current block
 * @returns {boolean}
 */
function sameBlockContent(a, b) {
  if (a.type !== b.type) return false;
  if (b.type === "tool_group") {
    if (a.tools.length !== b.tools.length) return false;
    for (let i = 0; i < b.tools.length; i++) {
      const x = a.tools[i];
      const y = b.tools[i];
      if (
        x.title !== y.title ||
        x.status !== y.status ||
        x.action !== y.action ||
        x.detail !== y.detail ||
        x.hasFailure !== y.hasFailure
      ) {
        return false;
      }
      const xf = x.changedFiles || [];
      const yf = y.changedFiles || [];
      if (xf.length !== yf.length || xf.some((file, i) => file !== yf[i])) return false;
    }
    const at = a.thoughts || [];
    const bt = b.thoughts || [];
    if (at.length !== bt.length) return false;
    for (let i = 0; i < bt.length; i++) {
      if (at[i].text !== bt[i].text || at[i].status !== bt[i].status) return false;
    }
    return a.summary === b.summary && a.summaryKind === b.summaryKind;
  }
  return (
    a.text === b.text &&
    a.title === b.title &&
    a.action === b.action &&
    a.detail === b.detail &&
    a.status === b.status &&
    a.duration === b.duration
  );
}

/**
 * Gives every block two identities, computed once per update (never in render):
 * - `ekey`: `type#ordinal`, stable while a block streams; holds expand state.
 * - `key`:  `ekey:contentHash`, changes when the content does, so a row whose
 *   text grew is rebuilt instead of reusing stale content.
 * A block whose content is unchanged keeps its previous key, so a streaming
 * reply does not re-hash the whole transcript once a second.
 * @param {Array<object>} blocks
 * @param {Array<object>} [previous] the blocks currently on screen
 */
function assignKeys(blocks, previous) {
  const previousByEkey = new Map();
  if (previous) {
    for (const b of previous) if (b.ekey) previousByEkey.set(b.ekey, b);
  }
  const ordinals = new Map();
  for (const b of blocks) {
    const n = (ordinals.get(b.type) || 0) + 1;
    ordinals.set(b.type, n);
    b.ekey = `${b.type}#${n}`;
    const old = previousByEkey.get(b.ekey);
    if (old?.key && sameBlockContent(old, b)) {
      b.key = old.key;
      continue;
    }
    const body =
      b.type === "tool_group"
        ? b.tools.map((x) => `${x.title}|${x.status}|${x.action ?? ""}|${x.detail ?? ""}`).join("\n") +
          `|${b.summary ?? ""}|${b.summaryKind ?? ""}|` +
          (b.thoughts || []).map((x) => `${x.status}|${x.text}`).join("\n")
        : `${b.text ?? ""}|${b.title ?? ""}|${b.action ?? ""}|${b.detail ?? ""}|${b.status ?? ""}|${b.duration ?? ""}`;
    b.key = `${b.ekey}:${contentHash(body)}`;
  }
  return blocks;
}

/**
 * Deep-copies blocks for the frozen reading window. Transcript readers reuse
 * block objects between polls, so the frozen view must not alias them.
 * @param {Array<object>} blocks
 * @returns {Array<object>}
 */
function cloneBlocks(blocks) {
  return blocks.map((b) => JSON.parse(JSON.stringify(b)));
}

/**
 * Runs an hc command and throws if it exits non-zero.
 * @param {string[]} args
 * @returns {Promise<any>}
 */
async function hcOrThrow(args) {
  const res = await hc(args);
  const stderr = res?.stderr || "";
  if (res.code !== 0) {
    throw new Error(stderr.trim() || `hc ${args[0]} exited ${res.code}`);
  }
  return res;
}

export default class AgentChat extends View {
  init(_props, cx) {
    const p = props();
    this.terminal = resolveTerminal();
    this.hostTerminal = p?.terminal || null;
    this.followFocused = !p?.terminal;
    this._paneId = p?.pane || null;
    this.blocks = [];
    this.activeDetail = "";
    this.status = "idle";
    this.inputFocused = false;
    this.pickerOpen = false;
    this.modelMenuOpen = false;
    this.copiedKey = null;
    this.pinned = true;
    this.readingBlocks = null;
    this.readingStart = 0;
    this.hasPending = false;
    this.windowStart = 0;
    this._feedId = 0;
    this._feedWidth = -1;
    this._feedHeight = -1;
    this._drawnStatus = "";
    this._blockKeys = "";
    this.attached = 0;
    this.rawText = "";
    this.historyCache = new Map();
    this.rawHistoryCache = new Map();
    this.expanded = new Set();
    this.known = [];
    this._signature = "";
    this._updating = false;
    this._updatingSince = 0;
    this._generation = 0;
    this._verifiedPaths = false;
    this.models = []; // OpenCode's catalogue: { id, modelID, providerID, name }
    this.providers = {}; // providerID → display name
    this.modelsAt = 0;
    this.modelsLoading = false;

    this.handle = cx.focus_handle();

    this.input = TextareaState.new({ placeholder: "Message the agent…", value: "", rows: 1 });
    this.input.set_auto_grow(1, 8);
    this.input.set_soft_wrap(true);
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (event, cx) => {
      // Enter sends; Shift+Enter is a line break in the message.
      if (event?.shift) {
        cx.notify();
        return;
      }
      this.send(cx);
    });
    // An image paste has no text for the input; the agent reads the clipboard itself.
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("focus", (_e, cx) => {
      this.inputFocused = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });

    cx.spawn(async (cx) => {
      try {
        this.known = await knownAgents();
        cx.notify();
      } catch (_e) {}
    });

    this._shown = this.isShown();
    if (this._shown) this.update(cx);
    cx.timer.every(1000, (cx) => this.poll(cx));
  }

  /** Runs an update from an event handler with a context that survives awaits. */
  refreshLater(cx) {
    cx.spawn(async (cx) => {
      await this.update(cx);
    });
  }

  /** Switches the view to another terminal, restoring its cached history. */
  switchTo(address, cx) {
    if (!address) return;
    this.terminal = address;
    // A poll still running for the previous agent must not land on this one:
    // a new generation makes it drop its result, and clearing the busy flag
    // lets the refresh below run now instead of being skipped.
    this._generation++;
    this._updating = false;
    this.transcript = null;
    this.setBlocks(this.historyCache.get(address) || []);
    this.rawText = this.rawHistoryCache.get(address) || "";
    this._screenAt = 0;
    this._signature = "";
    this._blockKeys = "";
    this._lastText = undefined;
    this.expanded.clear();
    this.returnToLive(cx);
    this.refreshLater(cx);
  }

  /**
   * Whether this copy is actually on screen. Herdr keeps a hidden mod's
   * timers running (another tab, a settled tab, a hidden layout block, or
   * behind a zoomed sibling), so polling there only steals frames from the
   * TUI the person is using.
   *
   * A pane created with `pane.split {mod, props}` gets only its props, not its
   * pane id. When the copy was opened for a terminal, the chat pane is the one
   * in that terminal's tab; otherwise the active tab is used as a coarse
   * "is any chat visible" signal.
   * @returns {boolean}
   */
  isShown() {
    const { shown, paneId } = resolvePaneVisibility({
      paneId: this._paneId,
      hostTerminal: this.hostTerminal,
      panes: panes(),
      focused: focused(),
      windowActive: window()?.active ?? false,
      overlay: Boolean(props()?.overlay),
      floating: placement() !== null,
    });
    if (paneId) this._paneId = paneId;
    return shown;
  }

  async poll(cx) {
    const shown = this.isShown();
    if (shown !== this._shown) {
      this._shown = shown;
      // Drop the working spinner while hidden: it is a native animation, so
      // leaving it on keeps the window painting for a pane nobody sees.
      cx.notify();
    }
    if (!shown) return;

    if (this.followFocused) {
      const f = focused();
      const current =
        f?.agent || (f?.terminal && agents().some((a) => a.address === f.terminal) ? f.terminal : null);
      if (current && current !== this.terminal) {
        this.switchTo(current, cx);
        return;
      }
    }
    await this.update(cx);
  }

  async update(cx) {
    const now = Date.now();
    if (this._updating && now - (this._updatingSince || 0) < 30_000) return;
    this._updating = true;
    this._updatingSince = now;
    const gen = ++this._generation;
    try {
      if (!this.terminal) this.terminal = resolveTerminal();
      if (!this.terminal) return;
      if (agentApp(findAgent(this.terminal)) === "opencode") this.refreshModels(cx);

      // Claude Code: read its own transcript (real Markdown, tool results).
      if (await this.updateFromTranscript(cx, gen)) return;

      const res = await hc(["read", this.terminal, "--lines", "200", "--json"]);
      if (gen !== this._generation) return;
      if (res.code !== 0 || !res.stdout) return;
      const data = JSON.parse(res.stdout);
      const liveAgent = findAgent(this.terminal);
      const newStatus = data.why || liveAgent?.status || "idle";
      if (this._lastText === data.text && this.status === newStatus) return;
      if (gen !== this._generation) return;
      this._lastText = data.text;
      this.status = newStatus;
      this.rawText = data.text || "";
      this.rawHistoryCache.set(this.terminal, this.rawText);

      const parsed = parseConversation(data.text);
      let blocks;
      if (data.complete === true) {
        blocks = parsed;
        this.historyCache.set(this.terminal, parsed);
      } else {
        // While working, `hc read` returns only the screen (complete: false).
        // Keep the cached earlier turns above the live screen turns.
        const cached = this.historyCache.get(this.terminal) || [];
        blocks = spliceHistory(cached, parsed);
        if (cached.length === 0) {
          this.historyCache.set(this.terminal, parsed);
        }
      }
      // Fresh objects: cached blocks are shared, keys are written onto them.
      blocks = assignKeys(blocks.map((b) => ({ ...b })), this.blocks);

      if (gen !== this._generation) return;
      this.applyBlocks(blocks, cx);
    } catch (_err) {
      // A failed poll leaves the last good state on screen.
    } finally {
      if (gen === this._generation) {
        this._updating = false;
      }
    }
  }

  /**
   * Reads a Claude Code or OpenCode terminal from the agent's own session store.
   * @param {any} cx
   * @param {number} [gen]
   * @returns {Promise<boolean>} false when the terminal has no transcript, so
   *   the caller falls back to reading the screen.
   */
  async updateFromTranscript(cx, gen) {
    const live = findAgent(this.terminal);
    const Reader = { "claude-code": ClaudeTranscript, opencode: OpenCodeTranscript }[agentApp(live)];
    if (!Reader) return false;
    if (!(this.transcript instanceof Reader) || this.transcript.terminal !== this.terminal) {
      this.transcript = new Reader(this.terminal);
    }
    const result = await this.transcript.refresh((live?.status || "idle") === "working");
    if (gen !== undefined && gen !== this._generation) return true;
    if (!result) return false;

    // Claude Code names its model only in replies; until the first one, the
    // welcome banner on screen is the only place it shows. Read it slowly.
    if (this.transcript instanceof ClaudeTranscript && !this.transcript.model) {
      const now = Date.now();
      if (!this._screenAt || now - this._screenAt > 3000) {
        this._screenAt = now;
        const res = await hc(["read", this.terminal, "--lines", "60", "--json"]);
        if (gen !== undefined && gen !== this._generation) return true;
        if (res.code === 0 && res.stdout) {
          const text = JSON.parse(res.stdout)?.text || "";
          if (text !== this.rawText) {
            this.rawText = text;
            cx.notify();
          }
        }
      }
    }

    const nextStatus = live?.status || "idle";
    const first = this._signature === "";
    if (!result.changed && !first && nextStatus === this.status) return true;
    this.status = nextStatus;
    if (result.changed || first) this.applyBlocks(assignKeys(result.blocks, this.blocks), cx);
    else this.applyBlocks(this.blocks, cx);
    return true;
  }

  /**
   * Puts new blocks on screen if anything drawn changed. While the person is
   * at the bottom, the reversed feed keeps the newest turn visible by itself;
   * once they scroll up, the frozen window stays put and only the new-content
   * pill changes.
   */
  applyBlocks(blocks, cx) {
    const blockKeys = blocks.map((b) => b.key).join(",");
    const signature = `${this.status}|${blockKeys}`;
    if (signature === this._signature) return;
    const contentChanged = blockKeys !== this._blockKeys;
    this._signature = signature;
    this._blockKeys = blockKeys;
    this.setBlocks(blocks);

    if (this.readingBlocks) {
      const wasPending = this.hasPending;
      if (contentChanged) this.hasPending = true;
      // Repaint once when content starts queueing and on status changes. A
      // stream that only grows while the person reads costs no extra render.
      const statusChanged = this.status !== this._drawnStatus;
      if ((contentChanged && !wasPending) || statusChanged) {
        this._drawnStatus = this.status;
        cx.notify();
      }
      return;
    }

    this.windowStart = Math.max(0, this.blocks.length - FEED_WINDOW);
    this.pinned = true;
    this._drawnStatus = this.status;
    cx.notify();
  }

  /**
   * Sets the feed's blocks and precomputes their row facts (see annotateRows),
   * so every place that replaces the feed goes through the same annotation.
   * @param {Array<object>} blocks
   */
  setBlocks(blocks) {
    const previous = this.blocks;
    this.blocks = blocks;
    this.activeDetail = annotateRows(blocks, previous).activeDetail;
  }

  /** The id the reversed scroll container and its Scrollbar share. */
  feedScrollId() {
    return `chat-feed-${this._feedId}`;
  }

  /**
   * Freezes the window the person is reading. The native reversed container
   * already kept the newest turn at the bottom; from here on, new turns wait
   * in `this.blocks` instead of moving their view.
   * @param {any} cx
   */
  startReading(cx) {
    if (this.readingBlocks) return;
    this.readingStart = this.windowStart;
    this.readingBlocks = cloneBlocks(this.blocks.slice(this.readingStart));
    this.pinned = false;
    this.hasPending = false;
    this._drawnStatus = this.status;
    cx.notify();
  }

  /**
   * Adds one page of older turns above the current window. The reversed flex
   * appends at the visual top, so the reading position below is untouched.
   * @param {any} cx
   */
  loadEarlier(cx) {
    if (this.readingBlocks) {
      if (this.readingStart === 0) return;
      const start = Math.max(0, this.readingStart - FEED_PAGE);
      const older = cloneBlocks(this.blocks.slice(start, this.readingStart));
      this.readingBlocks = older.concat(this.readingBlocks);
      this.readingStart = start;
    } else {
      if (this.windowStart === 0) return;
      this.windowStart = Math.max(0, this.windowStart - FEED_PAGE);
    }
    cx.notify();
  }

  /**
   * Returns to the live tail and forces a fresh scroll state, which starts the
   * reversed container at its bottom again.
   * @param {any} cx
   */
  returnToLive(cx) {
    this.readingBlocks = null;
    this.readingStart = 0;
    this.pinned = true;
    this.hasPending = false;
    this._feedId++;
    this.windowStart = Math.max(0, this.blocks.length - FEED_WINDOW);
    this._drawnStatus = this.status;
    cx.notify();
  }

  /**
   * Wheel over the feed: the native container scrolls itself. The first
   * upward gesture freezes the window so new turns do not drag the view.
   * @param {any} e
   * @param {any} cx
   */
  onFeedWheel(e, cx) {
    const dy = e?.delta?.y ?? 0;
    if (dy > 0 && !this.readingBlocks) this.startReading(cx);
  }

  /**
   * The feed viewport changed height (composer growth, working line, resize).
   * While live, a fresh scroll state re-anchors the reversed container at the
   * bottom; while reading, leave the person's position alone.
   * @param {{ width: number, height: number }} size
   * @param {any} cx
   */
  onFeedResize(size, cx) {
    const width = Math.round(size.width);
    const height = Math.round(size.height);
    if (width === this._feedWidth && height === this._feedHeight) return;
    this._feedWidth = width;
    this._feedHeight = height;
    if (!this.readingBlocks) {
      this._feedId++;
      cx.notify();
    }
  }

  /**
   * Sets this.notice to an error message and clears it after 4000 ms.
   * @param {any} err
   * @param {any} cx
   */
  flashNotice(err, cx) {
    this.notice = err instanceof Error ? err.message : String(err);
    cx.timer.after(4000, (cx) => {
      this.notice = null;
      cx.notify();
    });
  }

  /** Forwards a non-text paste (an image) to the agent as Ctrl+V. */
  pasteImage(cx) {
    if (!this.terminal) return;
    cx.spawn(async (cx) => {
      try {
        await hcOrThrow(["keys", this.terminal, "ctrl+v"]);
        this.attached = (this.attached || 0) + 1;
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /** Sends the composer input or attached images to the agent terminal. */
  send(cx) {
    const val = (this.input.value() || "").trim();
    if (!this.terminal || (!val && !this.attached)) return;
    cx.spawn(async (cx) => {
      try {
        if (!val) {
          // Only images attached: submit what the agent already holds.
          await hcOrThrow(["keys", this.terminal, "enter"]);
        } else if (this.status === "blocked") {
          await hcOrThrow(["send", "--force", this.terminal, val]);
        } else {
          await hcOrThrow(["send", this.terminal, val]);
        }
        this.input.set_value("");
        this.attached = 0;
        this.returnToLive(cx);
        await this.update(cx);
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /** Sends a single key to the agent terminal. */
  sendKey(key, cx) {
    if (!this.terminal) return;
    cx.spawn(async (cx) => {
      try {
        await hcOrThrow(["keys", this.terminal, key]);
        await this.update(cx);
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /** Sends a sequence of keys to the agent terminal. */
  sendKeys(keys, cx) {
    if (!this.terminal) return;
    cx.spawn(async (cx) => {
      try {
        await hcOrThrow(["keys", this.terminal, ...keys]);
        await this.update(cx);
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /** Interrupts the running agent. */
  interrupt(cx) {
    if (!this.terminal) return;
    cx.spawn(async (cx) => {
      try {
        await hcOrThrow(["interrupt", this.terminal]);
        await this.update(cx);
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /**
   * Primary click on a feed row: expands or collapses thinking, tool calls,
   * and long user prompts.
   * @param {string} key
   * @param {any} cx
   */
  onFeedItemClick(key, cx) {
    const block =
      this.blocks.find((b) => b.key === key) || this.readingBlocks?.find((b) => b.key === key);
    if (!block) return;
    if (block.type === "assistant" || block.type === "notice") return;
    if (this.expanded.has(block.ekey)) this.expanded.delete(block.ekey);
    else this.expanded.add(block.ekey);
    cx.notify();
  }

  /** Alias for backward compatibility. */
  onRowClick(key, cx) {
    this.onFeedItemClick(key, cx);
  }

  /** Secondary click on a feed row: copy a message's text. */
  onRowCopy(key, cx) {
    const block =
      this.blocks.find((b) => b.key === key) || this.readingBlocks?.find((b) => b.key === key);
    const text =
      block?.type === "tool_group"
        ? block.tools.map((x) => [x.title, x.detail].filter(Boolean).join("\n")).join("\n\n")
        : block?.type === "tool"
        ? [block.title, block.detail].filter(Boolean).join("\n")
        : block?.text;
    if (!text) return;
    this.copy(text, block.ekey, cx);
  }

  copy(text, id, cx) {
    cx.write_to_clipboard(text);
    this.copiedKey = id;
    cx.notify();
    cx.timer.after(1500, (cx) => {
      if (this.copiedKey === id) {
        this.copiedKey = null;
        cx.notify();
      }
    });
  }

  renderAgentPicker(t, monoFont, cx) {
    if (!this.pickerOpen) return null;

    const liveAgents = agents();
    const liveTerminals = terminals().filter((term) => term.state === "live");
    const agentAddresses = new Set(liveAgents.map((a) => a.address));
    const subterminals = liveTerminals.filter((term) => !agentAddresses.has(term.address));

    return v_flex()
      .id("agent-picker-dropdown")
      .w_full()
      .p(10)
      .gap(8)
      .bg(t.raised || t.surface)
      .border_b(1)
      .border_color(t.border)
      // Follow focused agent row
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .px(8)
          .py(6)
          .rounded(6)
          .bg(this.followFocused ? withAlpha(t.accent, "1a") : t.background)
          .border_1()
          .border_color(this.followFocused ? t.accent : t.border)
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.followFocused = !this.followFocused;
            if (this.followFocused) {
              this.terminal = resolveTerminal();
              this.blocks = this.historyCache.get(this.terminal) || [];
              this.rawText = this.rawHistoryCache.get(this.terminal) || "";
              this.refreshLater(cx);
            }
            this.pickerOpen = false;
            cx.notify();
          })
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(
                svg(this.followFocused ? "mods/agent-chat/icons/check.svg" : "mods/agent-chat/icons/chat.svg")
                  .size(14)
                  .text_color(this.followFocused ? t.accent : t.dim)
              )
              .child(
                div()
                  .text_size(12)
                  .font_medium()
                  .text_color(this.followFocused ? t.accent : t.foreground)
                  .child("Follow focused agent")
              )
          )
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child("Auto-switches with focused pane")
          )
      )
      // Live Agents & Sub-agents List
      .child(
        v_flex()
          .gap(4)
          .child(div().px(4).text_size(10.5).font_semibold().text_color(t.dim).child("LIVE AGENTS & TERMINALS"))
          .children([
            ...liveAgents.map((ag) => {
              const isSelected = ag.address === this.terminal;
              return h_flex()
                .id(`pick-${ag.address}`)
                .items_center()
                .justify_between()
                .px(8)
                .py(6)
                .rounded(6)
                .bg(isSelected ? t.hover : t.background)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.terminal = ag.address;
                  this.followFocused = false;
                  this.pickerOpen = false;
                  this.blocks = this.historyCache.get(this.terminal) || [];
                  this.rawText = this.rawHistoryCache.get(this.terminal) || "";
                  this.refreshLater(cx);
                })
                .child(
                  h_flex()
                    .items_center()
                    .gap(8)
                    .child(iconFor(ag.program, 14, t.accent))
                    .child(
                      div()
                        .text_size(12)
                        .font_medium()
                        .text_color(isSelected ? t.accent : t.foreground)
                        .child(ag.title || ag.program?.name || ag.address)
                    )
                    .child(
                      div()
                        .px(4)
                        .py(1)
                        .rounded(3)
                        .bg(t.raised)
                        .text_size(10)
                        .font_family(monoFont)
                        .text_color(t.dim)
                        .child(ag.address)
                    )
                )
                .child(
                  h_flex()
                    .items_center()
                    .gap(6)
                    .child(
                      div()
                        .size(6)
                        .rounded_full()
                        .bg(
                          ag.status === "working"
                            ? t.working
                            : ag.status === "blocked"
                            ? t.blocked
                            : ag.status === "done"
                            ? t.done
                            : t.dim
                        )
                    )
                    .when(isSelected, (el) =>
                      el.child(svg("mods/agent-chat/icons/check.svg").size(12).text_color(t.accent))
                    )
                );
            }),
            ...subterminals.map((term) => {
              const isSelected = term.address === this.terminal;
              const termName =
                term.name || term.report?.app || term.foreground?.name || term.program?.name || term.address;
              const parentNote = term.parent ? `(sub-agent of ${term.parent})` : null;
              const rawStat =
                term.status?.state || term.status?.word || (typeof term.status === "string" ? term.status : "idle");

              return h_flex()
                .id(`pick-${term.address}`)
                .items_center()
                .justify_between()
                .px(8)
                .py(6)
                .rounded(6)
                .bg(isSelected ? t.hover : t.background)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.terminal = term.address;
                  this.followFocused = false;
                  this.pickerOpen = false;
                  this.blocks = this.historyCache.get(this.terminal) || [];
                  this.rawText = this.rawHistoryCache.get(this.terminal) || "";
                  this.refreshLater(cx);
                })
                .child(
                  h_flex()
                    .items_center()
                    .gap(8)
                    .child(iconFor(term.program, 14, t.accent))
                    .child(
                      div()
                        .text_size(12)
                        .font_medium()
                        .text_color(isSelected ? t.accent : t.foreground)
                        .child(termName)
                    )
                    .when(Boolean(parentNote), (el) =>
                      el.child(div().text_size(10.5).text_color(t.dim).child(parentNote))
                    )
                    .child(
                      div()
                        .px(4)
                        .py(1)
                        .rounded(3)
                        .bg(t.raised)
                        .text_size(10)
                        .font_family(monoFont)
                        .text_color(t.dim)
                        .child(term.address)
                    )
                )
                .child(
                  h_flex()
                    .items_center()
                    .gap(6)
                    .child(
                      div()
                        .size(6)
                        .rounded_full()
                        .bg(
                          rawStat === "working"
                            ? t.working
                            : rawStat === "blocked"
                            ? t.blocked
                            : rawStat === "done"
                            ? t.done
                            : t.dim
                        )
                    )
                    .when(isSelected, (el) =>
                      el.child(svg("mods/agent-chat/icons/check.svg").size(12).text_color(t.accent))
                    )
                );
            }),
          ])
      )
      // Launch New Agent section
      .when(this.known.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .child(div().px(4).text_size(10.5).font_semibold().text_color(t.dim).child("+ NEW AGENT"))
            .child(
              h_flex()
                .gap(6)
                .children(
                  this.known.map((k) =>
                    h_flex()
                      .id(`known-${k.key}`)
                      .items_center()
                      .gap(6)
                      .px(8)
                      .py(4)
                      .rounded(6)
                      .bg(t.background)
                      .border_1()
                      .border_color(t.border)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, _cx) => {
                        run("terminal.open", { argv: k.run });
                        this.pickerOpen = false;
                      })
                      .child(iconFor(k, 13, t.accent))
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(k.name))
                  )
                )
            )
        )
      );
  }


  /** Approval chips, shown above the composer while the agent waits. */
  renderQuickActions(t, cx) {
    if (this.status !== "blocked") return null;
    const chip = (id, label, onClick, primary) =>
      div()
        .id(id)
        .px(12)
        .h(30)
        .flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(primary ? t.foreground : t.border)
        .bg(primary ? t.foreground : t.background)
        .text_color(primary ? t.background : t.foreground)
        .text_size(12)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => onClick(cx))
        .child(label);

    return h_flex()
      .id("chat-actions")
      .w_full()
      .max_w(COLUMN)
      .flex_wrap()
      .gap(6)
      .pb(10)
      .items_center()
      .child(
        h_flex()
          .items_center()
          .gap(6)
          .pr(4)
          .child(div().size(7).rounded_full().bg(t.blocked))
          .child(div().text_size(12).font_medium().text_color(t.blocked).child("Needs your input"))
      )
      .child(chip("act-approve", "Approve", (cx) => this.sendKey("enter", cx), true))
      .child(chip("act-yes", "Yes", (cx) => this.sendKeys(["y", "enter"], cx), false))
      .child(chip("act-no", "No", (cx) => this.sendKeys(["n", "enter"], cx), false))
      .child(chip("act-opt2", "Option 2", (cx) => this.sendKeys(["down", "enter"], cx), false))
      .child(chip("act-cancel", "Cancel", (cx) => this.sendKey("esc", cx), false));
  }

  /**
   * One feed row. Stateless: the wrapper in feedRow owns the click handlers.
   * @param {object} block
   * @param {any} t theme
   * @param {string} monoFont
   */
  renderRow(block, t, monoFont) {
    const column = (content) =>
      h_flex()
        .w_full()
        .justify_center()
        .child(v_flex().w_full().max_w(COLUMN).px(24).child(content));

    if (block.type === "spacer") return div().w_full().h(block.size);
    const copied = this.copiedKey === block.ekey;
    const copiedNote = () =>
      h_flex()
        .items_center()
        .gap(4)
        .pt(4)
        .child(svg("mods/agent-chat/icons/check.svg").size(11).text_color(t.done))
        .child(div().text_size(11).text_color(t.done).child("Copied"));

    if (block.type === "user") {
      return column(
        v_flex()
          .w_full()
          .items_end()
          .pt(22)
          .pb(6)
          .child(
            div()
              .max_w(560)
              .px(16)
              .py(10)
              .rounded(20)
              .bg(t.raised)
              .text_size(14)
              .line_height("22px")
              .text_color(t.foreground)
              .child(block.text)
          )
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    if (block.type === "assistant") {
      return column(
        v_flex()
          .w_full()
          .py(8)
          .text_size(14)
          .line_height("24px")
          .text_color(t.foreground)
          .child(TextView.markdown(`md-${block.key}`, block.text || "").selectable(true))
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    const open = this.expanded.has(block.ekey);
    const chevron = svg(open ? "mods/agent-chat/icons/chevron-down.svg" : "mods/agent-chat/icons/chevron-right.svg")
      .size(11)
      .text_color(t.dim);
    const detailBox = (text) =>
      div()
        .w_full()
        .mt(6)
        .p(12)
        .rounded(10)
        .bg(t.raised)
        .text_size(12)
        .line_height("18px")
        .font_family(monoFont)
        .text_color(t.dim)
        .child(text);
    const running = block.status === "running";
    const statusIcon = () =>
      running
        ? svg("mods/agent-chat/icons/refresh.svg").size(11).text_color(t.working).spin(900)
        : div().size(5).rounded_full().bg(t.dim);

    if (block.type === "thought") {
      const label = running ? "Thinking…" : block.duration ? `Thought for ${block.duration}` : "Thought";
      return column(
        v_flex()
          .w_full()
          .py(4)
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .cursor_pointer()
              .child(div().text_size(13).text_color(t.dim).child(label))
              .child(chevron)
          )
          .when(open, (el) =>
            el.child(
              div()
                .mt(6)
                .ml(2)
                .pl(14)
                .border_l(2)
                .border_color(t.border)
                .text_size(13)
                .line_height("21px")
                .text_color(t.dim)
                .child(block.text || block.summary || "")
            )
          )
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    if (block.type === "tool") {
      return column(
        v_flex()
          .w_full()
          .py(3)
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .min_w(0)
              .when(Boolean(block.detail), (el) => el.cursor_pointer())
              .child(statusIcon())
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12.5)
                  .font_family(monoFont)
                  .text_color(t.dim)
                  .child(block.title || "Tool call")
              )
              .when(Boolean(block.detail), (el) => el.child(chevron))
          )
          .when(open && Boolean(block.detail), (el) => el.child(detailBox(block.detail)))
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    if (block.type === "tool_group") {
      const preview =
        block.tools.map((x) => x.title).slice(0, 2).join(" · ") +
        (block.tools.length > 2 ? ` · +${block.tools.length - 2}` : "");
      return column(
        v_flex()
          .w_full()
          .py(3)
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .min_w(0)
              .cursor_pointer()
              .child(statusIcon())
              .child(div().flex_none().text_size(13).text_color(t.dim).child(`Used ${block.count} tools`))
              .when(!open, (el) =>
                el.child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12)
                    .font_family(monoFont)
                    .text_color(withAlpha(t.dim, "b0"))
                    .child(preview)
                )
              )
              .child(chevron)
          )
          .when(open, (el) =>
            el.child(
              v_flex()
                .w_full()
                .mt(4)
                .gap(2)
                .children(
                  block.tools.map((tool) =>
                    v_flex()
                      .w_full()
                      .child(
                        h_flex()
                          .items_center()
                          .gap(8)
                          .py(2)
                          .child(
                            div()
                              .size(5)
                              .rounded_full()
                              .bg(tool.status === "running" ? t.working : t.dim)
                          )
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .truncate()
                              .text_size(12.5)
                              .font_family(monoFont)
                              .text_color(t.dim)
                              .child(tool.title)
                          )
                      )
                      .when(Boolean(tool.detail), (e) => e.child(detailBox(tool.detail)))
                  )
                )
            )
          )
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    return div();
  }

  /** Debug/preview rows: top and bottom breathing room around the turns. */
  feedRows() {
    return [
      { type: "spacer", key: "__top", ekey: "__top", size: 12 },
      ...this.blocks,
      { type: "spacer", key: "__bottom", ekey: "__bottom", size: 24 },
    ];
  }

  /**
   * One feed row plus its actions. In a plain flex column a row can own its
   * handlers (the old virtual list had to route them through the list).
   * @param {object} block
   * @param {any} t theme
   * @param {string} monoFont
   */
  feedRow(block, t, monoFont) {
    if (block.type === "spacer") return this.renderRow(block, t, monoFont);
    return div()
      .id(`feed-row-${block.ekey}`)
      .w_full()
      .on_click((_e, cx) => this.onFeedItemClick(block.key, cx))
      .on_mouse_down("right", (_e, cx) => this.onRowCopy(block.key, cx))
      .child(this.renderRow(block, t, monoFont));
  }

  /** A pill that loads one page of older turns above the window. */
  renderLoadEarlier(t, cx) {
    return h_flex()
      .w_full()
      .justify_center()
      .py(10)
      .child(
        h_flex()
          .id("chat-load-earlier")
          .items_center()
          .gap(6)
          .px(12)
          .py(5)
          .rounded_full()
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.loadEarlier(cx))
          .child(svg("mods/agent-chat/icons/arrow-up.svg").size(12).text_color(t.dim))
          .child(div().text_size(12).text_color(t.dim).child("Load earlier messages"))
      );
  }

  /** The floating "Scroll to end" / "New messages" pill over the feed. */
  renderScrollPill(t, cx) {
    return h_flex()
      .absolute()
      .bottom(8)
      .left(0)
      .right(0)
      .justify_center()
      .child(
        h_flex()
          .id("scroll-to-end-pill")
          .items_center()
          .gap(6)
          .px(12)
          .py(5)
          .rounded_full()
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.returnToLive(cx))
          .child(svg("mods/agent-chat/icons/arrow-down.svg").size(12).text_color(t.foreground))
          .child(
            div()
              .text_size(12)
              .font_medium()
              .text_color(t.foreground)
              .child(this.hasPending ? "New messages" : "Scroll to end")
          )
      );
  }

  /**
   * The scrolling feed. Rows live in a reversed flex column: the first child is
   * the visual bottom, so GPUI opens at the newest turn and keeps it there as
   * content is added. The window is bounded, and older turns load a page at a
   * time.
   */
  renderFeed(t, monoFont, cx) {
    if (this.blocks.length === 0) return this.renderEmptyFeed(t);
    const frozen = this.readingBlocks;
    const start = frozen ? this.readingStart : this.windowStart;
    const visible = frozen || this.blocks.slice(this.windowStart);

    // Children are pushed bottom-first for the reversed column. A filler at the
    // very bottom only exists when the whole conversation fits, so a new chat
    // reads top-down while a long one stays anchored to its tail.
    const children = [];
    if (start === 0) children.push(div().w_full().flex_1());
    children.push(div().w_full().h(24));
    for (let i = visible.length - 1; i >= 0; i--) {
      children.push(this.feedRow(visible[i], t, monoFont));
    }
    children.push(div().w_full().h(12));
    if (start > 0) children.push(this.renderLoadEarlier(t, cx));

    return v_flex()
      .id("chat-feed-container")
      .flex_1()
      .min_h(0)
      .child(
        div()
          .id("chat-feed-viewport")
          .flex_1()
          .min_h(0)
          .w_full()
          .relative()
          .on_size_change((size, cx) => this.onFeedResize(size, cx))
          .on_scroll_wheel((e, cx) => this.onFeedWheel(e, cx))
          .child(
            v_flex()
              .id(this.feedScrollId())
              .size_full()
              .flex_col_reverse()
              .overflow_y_scroll()
              .on_scroll_wheel((e, cx) => this.onFeedWheel(e, cx))
              .children(children)
          )
          .child(
            Scrollbar.vertical(this.feedScrollId())
              .absolute()
              .inset_0()
              .on_mouse_down("left", (_e, cx) => this.startReading(cx))
          )
          .when(!this.pinned, (el) => el.child(this.renderScrollPill(t, cx)))
      )
      .when(this.status === "working", (el) => el.child(this.renderWorkingBar(t)));
  }

  /**
   * The "Working · <what it is doing>" line under the feed, in the same column
   * as the rows. Shown only while the agent works.
   * @param {any} t theme
   */
  renderWorkingBar(t) {
    const label = this.activeDetail ? `Working · ${this.activeDetail}` : "Working...";
    return h_flex()
      .w_full()
      .justify_center()
      .child(
        v_flex()
          .w_full()
          .max_w(COLUMN)
          .px(24)
          .child(
            div()
              .id("working-timeline-row")
              .w_full()
              .py(8)
              .border_b(1)
              .border_color(withAlpha(t.border, "60"))
              .child(
                h_flex()
                  .items_center()
                  .gap(8)
                  .child(
                    svg("mods/agent-chat/icons/refresh.svg")
                      .size(12)
                      .text_color(t.working)
                      .when(this._shown, (el) => el.spin(900))
                  )
                  .child(div().text_size(13).text_color(t.dim).child(label))
              )
          )
      );
  }

  renderEmptyFeed(t) {
    const agent = agents().find((a) => a.address === this.terminal);
    const name = agent?.title || agent?.program?.name || "the agent";
    return v_flex()
      .id("chat-empty-feed")
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .gap(10)
      .child(iconFor(agent?.program, 28, t.dim))
      .child(div().text_size(22).font_semibold().text_color(t.foreground).child(`What should ${name} work on?`))
      .child(div().text_size(13).text_color(t.dim).child("Messages are typed into the agent's terminal."));
  }

  /** `{ model, effort }` display names; either may be null when it cannot be told. */
  currentModelInfo() {
    const agent = findAgent(this.terminal);
    if (this.transcript?.terminal === this.terminal) {
      if (this.transcript instanceof ClaudeTranscript && agentApp(agent) === "claude-code") {
        // Before the first reply there is no model on record: read the banner.
        const seen = claudeScreenModel(this.rawText);
        return {
          model: claudeModelLabel(this.transcript.model) || seen?.model || null,
          effort: effortLabel(this.transcript.effort || seen?.effort),
        };
      }
      if (this.transcript instanceof OpenCodeTranscript && agentApp(agent) === "opencode") {
        const known = this.models.find(
          (m) =>
            m.modelID === this.transcript.model &&
            (!this.transcript.provider || m.providerID === this.transcript.provider)
        );
        const name = known?.name || this.transcript.modelLabel;
        // A session with no messages yet has no model on record: read the TUI.
        if (name) return { model: name, effort: effortLabel(this.transcript.effort) };
      }
    }
    const seen = screenModel(this.rawText);
    return { model: seen?.model || null, effort: effortLabel(seen?.effort) };
  }

  /** The model's display name, or null when it cannot be told. */
  currentModel() {
    return this.currentModelInfo().model;
  }

  /** Switches models the way the agent itself does: a slash command typed into it. */
  chooseModel(command, cx) {
    this.modelMenuOpen = false;
    cx.notify();
    if (!this.terminal) return;
    if (this.attached > 0) {
      this.notice = "Send or clear the attached image before switching models.";
      cx.notify();
      cx.timer.after(4000, (cx) => {
        this.notice = null;
        cx.notify();
      });
      return;
    }
    cx.spawn(async (cx) => {
      try {
        await hcOrThrow(["send", this.terminal, command]);
        await this.update(cx);
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /** Loads OpenCode's model catalogue and provider names. */
  refreshModels(cx, force = false) {
    if (this.modelsLoading) return;
    if (!force && this.modelsAt && Date.now() - this.modelsAt < 60_000) return;
    this.modelsLoading = true;
    cx.notify();
    const on = spaces().find((s) => s.active)?.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        const [catalogue, providerList] = await Promise.all([
          exec("opencode", ["api", "GET", "/api/model"], { on }),
          exec("opencode", ["api", "GET", "/api/provider"], { on }),
        ]);
        if (catalogue.code === 0) {
          const data = JSON.parse(catalogue.stdout)?.data ?? [];
          this.models = data.filter((m) => !m.type || m.type === "chat");
        }
        if (providerList.code === 0) {
          const data = JSON.parse(providerList.stdout)?.data ?? [];
          this.providers = Object.fromEntries(data.map((p) => [p.id, p.name || p.id]));
        }
      } catch (_err) {
        // Keep the last good catalogue
      } finally {
        this.modelsLoading = false;
        this.modelsAt = Date.now();
        cx.notify();
      }
    });
  }

  /** The catalogue entry of the OpenCode session's current model, or null. */
  currentOpenCodeModel() {
    const tr = this.transcript;
    if (!(tr instanceof OpenCodeTranscript) || tr.terminal !== this.terminal || !tr.model) return null;
    return (
      this.models.find((m) => m.modelID === tr.model && (!tr.provider || m.providerID === tr.provider)) || null
    );
  }

  /**
   * Switches an OpenCode session to a catalogue model through its server API.
   * Effort is the model's `variant`: pass one to change it, or leave it out to
   * keep the current effort when the new model offers it.
   * @param {any} model catalogue entry
   * @param {any} cx
   * @param {string|null} [variant]
   */
  switchOpenCodeModel(model, cx, variant) {
    if (variant === undefined) {
      const current = this.transcript instanceof OpenCodeTranscript ? this.transcript.effort : null;
      variant = current && (model.variants || []).some((v) => v.id === current) ? current : null;
    }
    this.modelMenuOpen = false;
    cx.notify();
    const session =
      this.transcript instanceof OpenCodeTranscript && this.transcript.terminal === this.terminal
        ? this.transcript.sessionId
        : null;
    if (!session) {
      this.chooseModel("/models", cx);
      return;
    }
    const on = spaces().find((s) => s.active)?.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        const ref = { id: model.modelID, providerID: model.providerID };
        if (variant) ref.variant = variant;
        const body = JSON.stringify({ model: ref });
        const r = await exec("opencode", ["api", "--data", body, "POST", `/api/session/${session}/model`], { on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
        const name = model.name || model.modelID;
        this.notice = variant ? `${name} · ${effortLabel(variant)} selected` : `${name} selected`;
        cx.timer.after(2500, (cx) => {
          this.notice = null;
          cx.notify();
        });
        await this.update(cx);
      } catch (err) {
        this.notice = `Could not switch model: ${err instanceof Error ? err.message : String(err)}`;
      }
      cx.notify();
    });
  }

  /**
   * Two-column Model & Reasoning Effort Popover.
   */
  renderModelMenu(t, cx) {
    const agent = findAgent(this.terminal);
    const term = terminals().find((x) => x.address === this.terminal);
    const agentName = agent?.title || agent?.program?.name || term?.name || this.terminal || "No agent";
    const app = agentApp(agent);
    const isClaude = app === "claude-code";
    const isOpenCode = app === "opencode";
    const isAntigravity = app === "antigravity" || app === "agy";

    const currentModelInfo = this.currentModelInfo();
    const currentModelName = currentModelInfo.model;
    const currentEffort = currentModelInfo.effort;

    const row = (id, title, note, selected, onClick) =>
      h_flex()
        .id(id)
        .items_center()
        .gap(10)
        .px(10)
        .py(6)
        .rounded(8)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(onClick)
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(
              div()
                .text_size(12.5)
                .font_medium()
                .text_color(selected ? t.accent : t.foreground)
                .child(title)
            )
            .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(t.dim).child(note)))
        )
        .when(selected, (el) => el.child(svg("mods/agent-chat/icons/check.svg").size(13).text_color(t.accent)));

    /** @type {any[]} */
    let modelRows = [];
    if (isClaude) {
      modelRows = [
        ...CLAUDE_MODELS.map((m) =>
          row(
            `model-${m.id}`,
            m.label,
            m.note,
            m.id !== "default" && Boolean(currentModelName && currentModelName.includes(m.label)),
            (_e, cx) => this.chooseModel(`/model ${m.id}`, cx)
          )
        ),
        row("model-open-native", "More models…", "Older models, in Claude Code's own picker", false, (_e, cx) =>
          this.chooseModel("/model", cx)
        ),
      ];
    } else if (isOpenCode && this.models.length > 0) {
      const groups = new Map();
      for (const m of this.models) {
        if (!groups.has(m.providerID)) groups.set(m.providerID, []);
        groups.get(m.providerID).push(m);
      }
      const providerName = (id) => this.providers[id] || id;
      // The current model's provider leads, so the checked row is on screen
      // when the menu opens; the rest follow alphabetically.
      const currentProvider = this.currentOpenCodeModel()?.providerID;
      const order = [...groups.keys()].sort((a, b) => {
        if (a === currentProvider) return -1;
        if (b === currentProvider) return 1;
        return providerName(a).localeCompare(providerName(b));
      });
      for (const provider of order) {
        modelRows.push(
          div().px(10).pt(6).pb(2).text_size(10.5).font_semibold().text_color(t.dim).child(providerName(provider))
        );
        const entries = groups
          .get(provider)
          .slice()
          .sort((a, b) => (a.name || a.modelID).localeCompare(b.name || b.modelID));
        for (const m of entries) {
          modelRows.push(
            row(
              `model-${provider}-${m.modelID}`,
              m.name || prettyModel(m.modelID) || m.modelID,
              "",
              Boolean(currentModelName && (currentModelName === m.name || currentModelName === m.modelID)),
              (_e, cx) => this.switchOpenCodeModel(m, cx)
            )
          );
        }
      }
    } else if (isAntigravity) {
      modelRows = ANTIGRAVITY_MODELS.map((m) =>
        row(
          `model-${m.id}`,
          m.label,
          m.note,
          Boolean(currentModelName && (currentModelName === m.label || currentModelName.includes(m.id))),
          (_e, cx) => this.chooseModel(`/model ${m.id}`, cx)
        )
      );
    } else {
      modelRows = [
        ...ANTIGRAVITY_MODELS.map((m) =>
          row(
            `model-${m.id}`,
            m.label,
            m.note,
            Boolean(currentModelName && (currentModelName === m.label || currentModelName.includes(m.id))),
            (_e, cx) => this.chooseModel(`/model ${m.id}`, cx)
          )
        ),
        row("model-open-native", "Open native model selector", `Run /models in ${agentName}`, false, (_e, cx) =>
          this.chooseModel("/models", cx)
        ),
      ];
    }

    // OpenCode has no `/effort` command (typing one just sends a message):
    // effort is the model's `variant`, switched through the session API, and
    // each model lists its own variants.
    const ocModel = isOpenCode ? this.currentOpenCodeModel() : null;
    const effortOptions = isOpenCode
      ? ocModel?.variants?.length
        ? [
            { id: "default", label: "Default", note: "Model default" },
            ...ocModel.variants.map((v) => ({ id: v.id, label: effortLabel(v.id), note: null })),
          ]
        : []
      : isClaude
      ? CLAUDE_EFFORTS
      : EFFORTS;
    const pickEffort = (id, cx) => {
      if (isOpenCode) {
        if (ocModel) this.switchOpenCodeModel(ocModel, cx, id === "default" ? null : id);
      } else {
        this.chooseModel(`/effort ${id}`, cx);
      }
    };
    const effortRows = effortOptions.map((e) => {
      const isSelected = currentEffort
        ? currentEffort.toLowerCase() === e.id
        : isOpenCode && e.id === "default";
      return h_flex()
        .id(`effort-${e.id}`)
        .items_center()
        .justify_between()
        .px(8)
        .py(6)
        .rounded(8)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => pickEffort(e.id, cx))
        .child(
          h_flex()
            .items_center()
            .gap(8)
            .child(renderEffortGlyph(e.id, t, true))
            .child(
              v_flex()
                .child(
                  div()
                    .text_size(12.5)
                    .font_medium()
                    .text_color(isSelected ? t.accent : t.foreground)
                    .child(e.label)
                )
                .when(Boolean(e.note), (el) =>
                  el.child(div().text_size(10.5).text_color(t.dim).child(e.note))
                )
            )
        )
        .when(isSelected, (el) =>
          el.child(svg("mods/agent-chat/icons/check.svg").size(13).text_color(t.accent))
        );
    });

    return v_flex()
      .id("model-menu")
      .w_full()
      .max_h(420)
      .rounded(16)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .child(
        h_flex()
          .w_full()
          .h(340)
          // Left Column: Models
          .child(
            v_flex()
              .id("model-menu-models")
              .flex_1()
              .min_w(0)
              .h_full()
              .p(8)
              .border_r(1)
              .border_color(t.border)
              .overflow_y_scrollbar()
              .child(
                div()
                  .px(8)
                  .pt(4)
                  .pb(6)
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.dim)
                  .child("MODELS")
              )
              .children(modelRows)
          )
          // Right Column: Reasoning Effort
          .child(
            v_flex()
              .id("model-menu-efforts")
              .w(180)
              .h_full()
              .p(8)
              .overflow_y_scrollbar()
              .child(
                div()
                  .px(8)
                  .pt(4)
                  .pb(6)
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.dim)
                  .child("REASONING EFFORT")
              )
              .children(effortRows)
              .when(effortRows.length === 0, (el) =>
                el.child(
                  div()
                    .px(8)
                    .text_size(11)
                    .text_color(t.dim)
                    .child(ocModel ? "This model has no effort levels." : "Loading model details…")
                )
              )
          )
      );
  }

  renderComposer(t, cx) {
    const hasText = Boolean((this.input.value() || "").trim()) || this.attached > 0;
    const working = this.status === "working";
    const actions = this.renderQuickActions(t, cx);
    const picker = this.pickerOpen
      ? this.renderAgentPicker(t, settings().font_family ?? "JetBrains Mono", cx)
      : this.modelMenuOpen
      ? this.renderModelMenu(t, cx)
      : null;

    return v_flex()
      .id("chat-composer-area")
      .w_full()
      .flex_none()
      .items_center()
      .px(16)
      .pt(4)
      .pb(12)
      .bg(t.background)
      .when(Boolean(picker), (el) =>
        el.child(
          div()
            .w_full()
            .max_w(COLUMN)
            .mb(8)
            .rounded(16)
            .border_1()
            .border_color(t.border)
            .overflow_hidden()
            .child(picker)
        )
      )
      .when(Boolean(actions), (el) => el.child(actions))
      .child(
        v_flex()
          .id("chat-composer")
          .w_full()
          .max_w(COLUMN)
          .px(18)
          .pt(12)
          .pb(10)
          .gap(8)
          .rounded(26)
          .bg(t.raised)
          .border_1()
          .border_color(this.inputFocused ? withAlpha(t.foreground, "40") : t.border)
          .child(Textarea.new(this.input).w_full().min_h(24).text_size(14).text_color(t.foreground))
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .child(
                // Model picker: what the agent runs on. Click to choose another.
                h_flex()
                  .id("model-picker-trigger")
                  .items_center()
                  .gap(6)
                  .px(10)
                  .h(28)
                  .rounded_full()
                  .cursor_pointer()
                  .when(this.modelMenuOpen, (el) => el.bg(t.hover))
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.modelMenuOpen = !this.modelMenuOpen;
                    this.pickerOpen = false;
                    if (this.modelMenuOpen) this.refreshModels(cx);
                    cx.notify();
                  })
                  .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(this.currentModelInfo().model || "Model"))
                  .when(Boolean(this.currentModelInfo().effort), (el) =>
                    el.child(div().text_size(12.5).text_color(t.dim).child(this.currentModelInfo().effort))
                  )
                  .child(svg("mods/agent-chat/icons/chevron-down.svg").size(11).text_color(t.dim))
              )
              .when(this.attached > 0, (el) =>
                el.child(
                  h_flex()
                    .items_center()
                    .gap(5)
                    .px(10)
                    .h(28)
                    .rounded_full()
                    .bg(t.background)
                    .child(div().text_size(12).text_color(t.foreground).child(
                      this.attached === 1 ? "🖼 Image attached" : `🖼 ${this.attached} images attached`
                    ))
                )
              )
              .child(div().flex_1())
              .child(
                div()
                  .id(working ? "chat-stop" : "chat-send")
                  .size(34)
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded_full()
                  .bg(working || hasText ? t.foreground : t.hover)
                  .cursor_pointer()
                  .hover((s) => s.opacity(0.85))
                  .on_click((_e, cx) => (working && !hasText ? this.interrupt(cx) : this.send(cx)))
                  .child(
                    svg(working && !hasText ? "mods/agent-chat/icons/stop.svg" : "mods/agent-chat/icons/send.svg")
                      .size(14)
                      .text_color(working || hasText ? t.background : t.dim)
                  )
              )
          )
      )
      .child(
        div()
          .pt(6)
          .text_size(11)
          .text_color(t.dim)
          .child(this.notice || "Click thinking or tools to expand · right-click a message to copy")
      );
  }

  /**
   * Builds every branch once so `herdr-app check` (which has no terminal)
   * validates the whole surface, including rows the list would only build on
   * screen.
   */
  renderVerificationSample(t, monoFont, cx) {
    const samples = assignKeys([
      { type: "user", text: "test prompt" },
      { type: "thought", text: "test thought", duration: "1s", summary: "test" },
      { type: "thought", text: "streaming", status: "running" },
      { type: "tool", title: "test tool", detail: "output", status: "done" },
      { type: "tool", title: "running tool", status: "running" },
      {
        type: "tool_group",
        count: 2,
        tools: [{ title: "t1", detail: "d1", status: "done" }, { title: "t2", status: "running" }],
        status: "done",
      },
      { type: "assistant", text: "test **markdown**\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
    ]);
    const saved = {
      pickerOpen: this.pickerOpen,
      known: this.known,
      status: this.status,
      rawText: this.rawText,
      blocks: this.blocks,
    };
    const out = [];
    this.pickerOpen = true;
    if (!this.known || this.known.length === 0) this.known = [{ key: "test-agent", name: "Test Agent", run: ["test"] }];
    this.status = "blocked";
    this.rawText = "Sample raw terminal output\nLine 2";
    this.blocks = samples;
    out.push(this.renderAgentPicker(t, monoFont, cx), this.renderModelMenu(t, cx), this.renderComposer(t, cx));
    out.push(this.renderFeed(t, monoFont, cx), this.renderEmptyFeed(t));
    this.status = "working";
    out.push(...this.feedRows().map((b) => this.renderRow(b, t, monoFont)));
    for (const b of samples) this.expanded.add(b.ekey);
    this.copiedKey = samples[0].ekey;
    out.push(...samples.map((b) => this.renderRow(b, t, monoFont)));
    for (const b of samples) this.expanded.delete(b.ekey);
    this.copiedKey = null;
    Object.assign(this, saved);
    return v_flex().children(out.filter(Boolean));
  }

  render(cx) {
    const t = theme();
    const monoFont = settings().font_family ?? "JetBrains Mono";

    if (!this.terminal) {
      if (!this._verifiedPaths) {
        this._verifiedPaths = true;
        this.renderVerificationSample(t, monoFont, cx);
      }
      return v_flex()
        .id("agent-chat-empty")
        .track_focus(this.handle)
        .size_full()
        .items_center()
        .justify_center()
        .bg(t.background)
        .gap(10)
        .child(svg("mods/agent-chat/icons/chat.svg").size(32).text_color(t.dim))
        .child(div().text_size(18).font_semibold().text_color(t.foreground).child("No agent connected"))
        .child(div().text_size(13).text_color(t.dim).child("Open or focus an agent terminal to start chatting."))
        .when(this.known.length > 0, (el) =>
          el.child(
            h_flex()
              .gap(8)
              .pt(8)
              .children(
                this.known.map((k) =>
                  h_flex()
                    .id(`empty-known-${k.key}`)
                    .items_center()
                    .gap(6)
                    .px(12)
                    .h(32)
                    .rounded_full()
                    .border_1()
                    .border_color(t.border)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click(() => run("terminal.open", { argv: k.run }))
                    .child(iconFor(k, 14, t.foreground))
                    .child(div().text_size(12.5).text_color(t.foreground).child(k.name))
                )
              )
          )
        );
    }

    return v_flex()
      .id("agent-chat-view")
      .track_focus(this.handle)
      .size_full()
      .bg(t.background)
      .child(this.renderFeed(t, monoFont, cx))
      .child(this.renderComposer(t, cx));
  }
}
