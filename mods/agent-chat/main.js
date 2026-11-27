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
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
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
  fonts,
  checking,
  shared,
  setShared,
  appHome,
  readTextFile,
} from "herdr";
import {
  parseConversation,
  terminalQuotaFailure,
  screenAwaitsChoice,
  parseScreenChoice,
  spliceHistory,
  toolGroupSummaryKind,
  summarizeToolGroup,
  classifyTool,
} from "./parser.js";
import {
  annotateRows,
  contentHash,
  liveThoughtLine,
  terminalMachine,
  terminalLocalAddress,
  groupAntigravityModels,
  parseAntigravityModel,
  computeFeedLayout,
  parseClaudeModelsResponse,
  parseCodexModelsResponse,
  parseAntigravityModelsOutput,
  parseMarkdownBlocks,
  resolveInternalFileLink,
  prependEarlierBlocks,
  preserveScrollOnResize,
  applyPrependAnchor,
  matchesModelQuery,
  parseScreenModel,
  needsInitialEarlierLoad,
} from "./transcript-blocks.js";
import { resolvePaneVisibility } from "./pane-visibility.js";
import { demoBlocks } from "./demo-blocks.js";
import { pickBodyFont } from "./body-font.js";
import { ClaudeTranscript } from "./claude-transcript.js";
import { OpenCodeTranscript } from "./opencode-transcript.js";
import { CodexTranscript } from "./codex-transcript.js";
import { applyCodexModel, codexAppServerVersion, codexModelEffort, codexScreenModel, codexSupportsInlineModel } from "./codex-model-picker.js";
import { resolveOpenCodeModel } from "./opencode-data.js";
import { AntigravityTranscript } from "./antigravity-transcript.js";

/** Width of the reading column, in px. */
const COLUMN = 760;

/** Turns kept in the initial batch, and added per lazy-load batch. */
const FEED_WINDOW = 8;
const FEED_PAGE = 8;

/** Show the model search input when more than this many models are available. */
const MODEL_SEARCH_THRESHOLD = 6;

/**
 * Installs app-wide keybindings for AgentChat once per process.
 * @param {any} cx
 */
function ensureAgentChatKeyBindings(cx) {
  if (globalThis.__agentChatKeyBindingsInstalled === true) return;
  try {
    cx.bind_keys([
      { keystroke: "pageup", action: "agent-chat.page-up", context: "AgentChat" },
      { keystroke: "pagedown", action: "agent-chat.page-down", context: "AgentChat" },
      { keystroke: "home", action: "agent-chat.scroll-top", context: "AgentChat" },
      { keystroke: "end", action: "agent-chat.scroll-bottom", context: "AgentChat" },
    ]);
    globalThis.__agentChatKeyBindingsInstalled = true;
  } catch (_e) {}
}

/**
 * Returns human-readable label for an effort ID.
 * @param {string|null} id
 * @returns {string|null}
 */
function effortLabel(id) {
  if (!id) return null;
  const low = String(id).toLowerCase();
  if (low === "xhigh") return "xHigh";
  if (low === "ultra") return "Ultra";
  return low[0].toUpperCase() + low.slice(1);
}

/** Display label for a discovered Claude model id. */
function claudeModelLabel(id, discovered = []) {
  if (!id) return null;
  // A concrete id ("claude-opus-5-5") names its own version; the catalogue's
  // "default" alias resolves to the same id, so matching it would show
  // "Default (recommended)" for a session explicitly set to Opus.
  const family = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/i);
  if (family) return `${family[1][0].toUpperCase()}${family[1].slice(1)} ${family[2]}.${family[3]}`;
  return findClaudeModel(id, discovered)?.label || id;
}

/**
 * Finds the catalogue entry for a Claude model id or alias. An exact alias
 * wins, then a concrete entry resolving to that model, and only then the
 * `default` alias, which resolves to the same model as one of the others.
 * @param {string|null} id
 * @param {Array<{id: string, resolvedModel?: string}>} discovered
 */
function findClaudeModel(id, discovered = []) {
  if (!id) return null;
  const list = discovered || [];
  const resolves = (m) => m.resolvedModel === id || id.startsWith(m.resolvedModel || m.id);
  return (
    list.find((m) => m.id === id) ||
    list.find((m) => m.id !== "default" && resolves(m)) ||
    list.find(resolves) ||
    null
  );
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
 * Returns the final path segment of a file path.
 * @param {string} path
 * @returns {string}
 */
function basename(path) {
  return typeof path === "string" ? path.split("/").pop() || path : "";
}

/**
 * Returns a human-readable agent name without duplicating the terminal ID.
 * @param {any} agent
 * @param {string|null} terminal
 * @returns {string}
 */
function agentDisplayName(agent, terminal) {
  const title = (agent?.title || "").trim();
  if (title && title !== terminal) return title;
  return agent?.program?.name || title || "Agent";
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
  const count = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 5 }[id] || 0;

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
 * Returns the SVG icon path corresponding to a semantic tool action.
 * @param {string} action
 * @returns {string}
 */
function toolActionIcon(action) {
  switch (action) {
    case "read":
      return "mods/agent-chat/icons/eye.svg";
    case "edit":
      return "mods/agent-chat/icons/square-pen.svg";
    case "command":
      return "mods/agent-chat/icons/terminal.svg";
    case "code-search":
      return "mods/agent-chat/icons/search.svg";
    case "search":
      return "mods/agent-chat/icons/globe.svg";
    case "reasoning":
    case "thought":
      return "mods/agent-chat/icons/brain.svg";
    case "other":
    case "mixed":
    default:
      return "mods/agent-chat/icons/wrench.svg";
  }
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
  return { claude: "claude-code", opencode: "opencode", antigravity: "antigravity", agy: "antigravity", codex: "codex" }[key] || key || null;
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
 * Key names that type `text` into a TUI search field with `hc keys`: lowercase
 * letters, digits, `.` `-` `/` and `space`. Other characters are dropped; the
 * OpenCode pickers match fuzzily and ignore case.
 * @param {string} text
 * @returns {string[]}
 */
function pickerKeys(text) {
  return [...String(text).toLowerCase()]
    .map((ch) => (ch === " " ? "space" : /[a-z0-9.\-/]/.test(ch) ? ch : null))
    .filter(Boolean);
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

/** Prose font with real bold and italic faces; looked up once. See body-font.js. */
let bodyFontName;
function bodyFont() {
  if (bodyFontName === undefined) {
    try {
      bodyFontName = pickBodyFont(fonts());
    } catch (_e) {
      bodyFontName = null;
    }
  }
  return bodyFontName;
}

export default class AgentChat extends View {
  init(_props, cx) {
    const p = props();
    this.terminal = resolveTerminal();
    this.hostTerminal = p?.terminal || null;
    this.followFocused = !p?.terminal;
    this._paneId = p?.pane || null;
    this.gitBranch = "";
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
    this.scrollY = 0;
    this.scrollFromBottom = 0;
    this._contentHeight = 0;
    this._pendingPrepend = null;
    this._feedWidth = -1;
    this._feedHeight = -1;
    this._composerHeight = -1;
    this._drawnStatus = "";
    this._blockKeys = "";
    this.attached = 0;
    this.rawText = "";
    this.historyCache = new Map();
    this.rawHistoryCache = new Map();
    this.terminalMetaCache = new Map();
    this.transcriptCache = new Map();
    this.expanded = new Set();
    this.known = [];
    this._signature = "";
    this._updating = false;
    this._updatingSince = 0;
    this._generation = 0;
    this._switchGen = 0;
    this._verifiedPaths = false;
    this.claudeModels = [];
    this.models = []; // OpenCode's catalogue: { id, modelID, providerID, name }
    this.providers = {}; // providerID → display name
    this.codexModels = [];
    this.agyModels = [];
    this.agyPendingModel = null;
    this.modelsTerminal = null;
    this.modelsAt = 0;
    this.modelsLoading = false;
    this._cliLines = 0;
    this._cliFetching = false;
    this._cliExhausted = false;
    this._cliPageUps = 0;
    this._transcriptFetching = false;
    this.hasFileEditor = false;
    this._restoredScrollFor = null;
    this.sendMode = this.loadSendMode();
    this.messageQueues = new Map();
    this.pendingSteers = new Map();
    this._drainingQueue = false;

    ensureAgentChatKeyBindings(cx);
    this.handle = cx.focus_handle();

    this.input = TextareaState.new({ placeholder: "Ask anything…", value: "", rows: 1 });
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
      this.markTerminalRead(cx, { restoreInput: true });
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.inputFocused = false;
      cx.notify();
    });

    this.modelSearch = InputState.new({ placeholder: "Search models…", value: "" });
    this.modelSearch.on("change", (_e, cx) => cx.notify());

    cx.spawn(async (cx) => {
      try {
        this.known = await knownAgents();
        cx.notify();
      } catch (_e) {}
    });

    // `props.demo` ("opencode" | "claude" | "preview") shows a fixed
    // conversation that uses every element, with no agent behind it. See
    // demo-blocks.js.
    this.demo = p?.demo ? String(p.demo) : null;
    if (this.demo) {
      this.terminal = "demo";
      this.followFocused = false;
      const demoStyle = this.demo === "claude" ? "claude" : this.demo === "preview" ? "preview" : "opencode";
      this.setBlocks(assignKeys(demoBlocks(demoStyle, p?.part ?? null), []));
      this.windowStart = Math.max(0, this.blocks.length - FEED_WINDOW);
      // `props.expand` opens every group, thought and tool call up front.
      if (p?.expand) {
        for (const b of this.blocks) {
          this.expanded.add(b.ekey);
          (b.tools || []).forEach((_x, i) => this.expanded.add(`${b.ekey}:tool${i}`));
          (b.thoughts || []).forEach((_x, i) => this.expanded.add(`${b.ekey}:thought${i}`));
        }
      }
    }

    // `herdr-app check` calls init() only to validate the view tree; skip
    // background spawns and timers so no tasks are left stranded on reload.
    if (checking()) return;

    this.primeScreenModel(cx);

    // `props.open` ("model" | "agent") starts with that picker open, so it can
    // be looked at without a click.
    if (p?.open === "model") {
      this.modelMenuOpen = true;
      this.refreshModels(cx);
    } else if (p?.open === "agent") {
      this.pickerOpen = true;
    }

    this.updateGitBranch();
    this.probeFileEditor(cx);
    this._shown = this.isShown();
    if (this._shown) this.update(cx);
    if (this._shown && !this.modelMenuOpen && !this.pickerOpen) {
      cx.timer.after(50, () => {
        if (this.isShown() && !this.modelMenuOpen && !this.pickerOpen) {
          this.input.focus();
        }
      });
    }
    cx.timer.every(1000, (cx) => this.poll(cx));
    cx.timer.every(15000, (cx) => this.probeFileEditor(cx));
  }

  /** Probes whether the optional `file-editor` mod is installed before wiring file links to it. */
  probeFileEditor(cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      let installed = false;
      try {
        await readTextFile(`${appHome()}/mods/file-editor/mod.json`);
        installed = true;
      } catch (_e) {
        installed = false;
      }
      if (this.hasFileEditor !== installed) {
        this.hasFileEditor = installed;
        cx.notify();
      }
    });
  }

  /**
   * Reads the current git branch from Herdr's live pane data. The pane already
   * carries the branch, so this costs no `git` process per poll.
   */
  updateGitBranch() {
    const pane = panes().find((p) => p.terminal === this.terminal && p.branch);
    this.gitBranch = pane?.branch || spaces().find((s) => s.active)?.branch || "";
  }

  /** Returns current active workspace or folder name. */
  workspaceName() {
    const s = spaces().find((sp) => sp.active);
    if (s?.name) return s.name;
    const term = terminals().find((t) => t.address === this.terminal);
    if (term?.cwd) {
      const parts = term.cwd.split("/").filter(Boolean);
      return parts.pop() || "workspace";
    }
    return "workspace";
  }

  /** Runs an update from an event handler with a context that survives awaits. */
  refreshLater(cx) {
    cx.spawn(async (cx) => {
      await this.update(cx);
    });
  }

  /**
   * Removes cached state for closed terminals and enforces an LRU cap so
   * memory stays bounded across long sessions.
   * @param {number} [maxEntries]
   */
  pruneTerminalCaches(maxEntries = 25) {
    const live = new Set(terminals().map((t) => t.address));
    const caches = [this.transcriptCache, this.historyCache, this.rawHistoryCache, this.terminalMetaCache];
    for (const cache of caches) {
      if (live.size > 0) {
        for (const key of cache.keys()) {
          if (key !== this.terminal && !live.has(key)) cache.delete(key);
        }
      }
      while (cache.size > maxEntries) {
        let evicted = false;
        for (const key of cache.keys()) {
          if (key !== this.terminal) {
            cache.delete(key);
            evicted = true;
            break;
          }
        }
        if (!evicted) break;
      }
    }
  }

  /** Switches the chat view to a different agent terminal. */
  switchTo(address, cx) {
    if (!address) return;
    this.terminal = address;
    this._feedSource = null;
    this.status = "idle";
    const term = terminals().find((t) => t.address === address);
    const createdMs = term?.created_ms || 0;
    if (this.terminalMetaCache.get(address) !== createdMs) {
      this.terminalMetaCache.set(address, createdMs);
      this.historyCache.delete(address);
      this.rawHistoryCache.delete(address);
      this.transcriptCache.delete(address);
    }
    this.pruneTerminalCaches();
    // A poll still running for the previous agent must not land on this one:
    // a new generation makes it drop its result, and clearing the busy flag
    // lets the refresh below run now instead of being skipped.
    this._generation++;
    this._switchGen++;
    this._updating = false;
    this._contentHeight = 0;
    this._pendingPrepend = null;
    this.scrollY = 0;
    const cachedTranscript = this.transcriptCache.get(address) || null;
    if (cachedTranscript) {
      this.transcriptCache.delete(address);
      this.transcriptCache.set(address, cachedTranscript);
    }
    this.transcript = cachedTranscript;
    const cachedBlocks = this.historyCache.get(address) || [];
    if (cachedBlocks.length > 0) {
      this.historyCache.delete(address);
      this.historyCache.set(address, cachedBlocks);
    }
    this.setBlocks(cachedBlocks);
    this.rawText = this.rawHistoryCache.get(address) || "";
    this._transcriptQuota = null;
    this._screenAt = 0;
    this._readFor = cachedBlocks.length > 0 ? address : null;
    this.sendMode = this.loadSendMode(address);
    this._signature = "";
    this._blockKeys = "";
    this._lastText = undefined;
    this.expanded.clear();
    this._cliLines = 0;
    this._cliFetching = false;
    this._cliExhausted = false;
    this._cliPageUps = 0;
    this._transcriptFetching = false;
    this._restoredScrollFor = null;
    this.returnToLive(cx);
    this.updateGitBranch();
    this.primeScreenModel(cx);
    this.refreshLater(cx);
  }

  /**
   * Immediately reads the terminal's visible screen and refreshes its model
   * catalogue so the active CLI model appears on startup without waiting for a poll.
   */
  primeScreenModel(cx) {
    if (checking() || this.demo || !this.terminal) return;
    const terminal = this.terminal;
    const app = agentApp(findAgent(terminal));
    if (app) this.refreshModels(cx);
    cx.spawn(async (cx) => {
      try {
        const res = await hc(["read", terminal, "--lines", app === "claude-code" ? "60" : "0", "--json"]);
        if (this.terminal !== terminal || res.code !== 0 || !res.stdout) return;
        const text = JSON.parse(res.stdout)?.text || "";
        if (!text) return;
        this._screenAt = Date.now();
        if (app === "codex") {
          if (this.codexModelScreen?.terminal !== terminal || text !== this.codexModelScreen.text) {
            this.codexModelScreen = { terminal, text };
            cx.notify();
          }
        } else if (text !== this.rawText) {
          this.rawText = text;
          cx.notify();
        }
      } catch (_e) {}
    });
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
    if (this.demo) return;
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
    if (this.demo) return;
    const now = Date.now();
    if (this._updating && now - (this._updatingSince || 0) < 30_000) return;
    this._updating = true;
    this._updatingSince = now;
    const gen = ++this._generation;
    try {
      if (!this.terminal) this.terminal = resolveTerminal();
      if (!this.terminal) return;
      const term = terminals().find((t) => t.address === this.terminal);
      const createdMs = term?.created_ms || 0;
      if (this.terminalMetaCache.get(this.terminal) !== createdMs) {
        this.terminalMetaCache.set(this.terminal, createdMs);
        this.historyCache.delete(this.terminal);
        this.rawHistoryCache.delete(this.terminal);
        this.transcriptCache.delete(this.terminal);
        this.rawText = "";
        this._screenAt = 0;
        this._transcriptQuota = null;
        this.transcript = null;
        this._feedSource = null;
      }
      if (agentApp(findAgent(this.terminal))) this.refreshModels(cx);

      // Claude Code: read its own transcript (real Markdown, tool results).
      if (await this.updateFromTranscript(cx, gen)) {
        this.updateGitBranch();
        return;
      }

      const res = await hc(["read", this.terminal, "--lines", String(this._cliLines ?? 0), "--json"]);
      if (gen !== this._generation) return;
      if (res.code !== 0 || !res.stdout) return;
      const data = JSON.parse(res.stdout);
      const liveAgent = findAgent(this.terminal);
      const reportedStatus = data.why || liveAgent?.status || "idle";
      const newStatus = reportedStatus === "blocked" && terminalQuotaFailure(data.text)
        ? "error"
        : reportedStatus;
      if (this._lastText === data.text && this.status === newStatus) return;
      if (gen !== this._generation) return;
      this._lastText = data.text;
      this.status = newStatus;
      this.rawText = data.text || "";
      this.rawHistoryCache.set(this.terminal, this.rawText);

      // A startup menu (Codex folder trust) is not conversation: with no history
      // yet, keep the feed empty and let the choice card offer the options.
      const startupMenu = !this.historyCache.get(this.terminal)?.length && newStatus !== "working" && parseScreenChoice(data.text);
      const parsed = startupMenu ? [] : parseConversation(data.text);
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
      this._feedSource = `screen:${this.terminal}`;
      this.applyBlocks(blocks, cx);
      this.updateGitBranch();
    } catch (_err) {
      // A failed poll leaves the last good state on screen.
    } finally {
      if (gen === this._generation) {
        this._updating = false;
        this.drainQueue(cx);
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
    const Reader = {
      "claude-code": ClaudeTranscript,
      opencode: OpenCodeTranscript,
      codex: CodexTranscript,
      antigravity: AntigravityTranscript,
      agy: AntigravityTranscript,
    }[agentApp(live)];
    if (!Reader) return false;
    if (!(this.transcript instanceof Reader) || this.transcript.terminal !== this.terminal) {
      const previous = this.transcript;
      const cached = this.transcriptCache.get(this.terminal);
      this.transcript =
        cached instanceof Reader && cached.terminal === this.terminal
          ? cached
          : new Reader(this.terminal);
      if (previous !== this.transcript) this._feedSource = null;
      this.transcriptCache.delete(this.terminal);
      this.transcriptCache.set(this.terminal, this.transcript);
      this.pruneTerminalCaches();
    }
    let result = await this.transcript.refresh((live?.status || "idle") === "working");
    if (gen !== undefined && gen !== this._generation) return true;
    if (!result) {
      // One failed read (the store busy while the agent writes a switch) is
      // not "no transcript": once this reader has drawn the feed, keep it
      // rather than flash the parsed screen into the conversation.
      return this._feedSource === `transcript:${this.terminal}`;
    }

    // If the initial tail does not yet fill approximately one screen of
    // meaningful conversation, pull earlier batches automatically.
    const first = this._signature === "";
    const vh = this._feedHeight > 0 ? this._feedHeight : 600;
    const colW = Math.min(COLUMN, this._feedWidth > 0 ? this._feedWidth : COLUMN);
    if (
      first &&
      typeof this.transcript.loadEarlier === "function" &&
      this.transcript.hasEarlier &&
      needsInitialEarlierLoad(result.blocks, vh, colW)
    ) {
      let loads = 0;
      while (loads < 6 && this.transcript.hasEarlier && needsInitialEarlierLoad(result.blocks, vh, colW)) {
        const earlier = await this.transcript.loadEarlier();
        if (gen !== undefined && gen !== this._generation) return true;
        loads++;
        if (!earlier?.changed || !Array.isArray(earlier.blocks)) break;
        result = { blocks: earlier.blocks, changed: true };
      }
    }

    // Codex and Antigravity can change their model and effort between transcript turns.
    const isCodex = this.transcript instanceof CodexTranscript;
    const isAntigravity = this.transcript instanceof AntigravityTranscript;
    if ((!this.transcript.model || isCodex || isAntigravity) && !this.codexSwitching) {
      const now = Date.now();
      if (!this._screenAt || now - this._screenAt > 3000) {
        this._screenAt = now;
        const res = await hc(["read", this.terminal, "--lines", isCodex || isAntigravity ? "0" : "60", "--json"]);
        if (gen !== undefined && gen !== this._generation) return true;
        if (res.code === 0 && res.stdout) {
          const text = JSON.parse(res.stdout)?.text || "";
          if (isCodex && (this.codexModelScreen?.terminal !== this.terminal || text !== this.codexModelScreen.text)) {
            this.codexModelScreen = { terminal: this.terminal, text };
            cx.notify();
          } else if (!isCodex && text !== this.rawText) {
            this.rawText = text;
            cx.notify();
          }
        }
      }
    }

    // Antigravity writes a model/effort switch to its transcript only with the
    // next prompt, and Codex may not have flushed it yet (a fresh session has
    // no rollout entries at all), so the switch is read off the screen footer
    // and shown as a live notice until the transcript carries it.
    // OpenCode logs every switch as a `model-switched` row, but only once a
    // session exists; before the first prompt the footer is all there is.
    const isFreshOpenCode = this.transcript instanceof OpenCodeTranscript && !this.transcript.sessionId;
    let screenSeen = null;
    if (isAntigravity) screenSeen = parseScreenModel(this.rawText, "antigravity");
    else if (isCodex) {
      const codexScreen = this.currentCodexScreen();
      screenSeen = codexScreenModel(codexScreen, this.codexModels) || parseScreenModel(codexScreen, "codex");
    } else if (isFreshOpenCode) {
      const seen = this.openCodeFooter();
      const known = seen?.model ? resolveOpenCodeModel(this.models, this.providers, seen.model) : null;
      // No "· variant" in the footer means the model default.
      screenSeen = seen ? { model: known?.name || seen.model, effort: seen.effort || "default" } : null;
    }
    const switchNoticeChanged =
      (isAntigravity || isCodex || isFreshOpenCode) && this.trackScreenSwitch(result.blocks, screenSeen);

    const reportedStatus = findAgent(this.terminal)?.status || "idle";
    const screenText = isCodex
      ? this.codexModelScreen?.terminal === this.terminal ? this.codexModelScreen.text : ""
      : this.rawText;
    const quota = (isAntigravity || isCodex) && reportedStatus !== "working"
      ? terminalQuotaFailure(screenText)
      : null;
    // A quota failure can appear only on the screen, before the transcript
    // or the agent status reflects it.
    const nextStatus = quota && reportedStatus === "blocked" ? "error" : reportedStatus;
    const quotaText = quota?.text ?? null;
    const quotaChanged = quotaText !== this._transcriptQuota;
    this._transcriptQuota = quotaText;
    // After a screen fallback drew the feed, the unchanged transcript must
    // still replace it.
    const ownsFeed = this._feedSource === `transcript:${this.terminal}`;
    if (!result.changed && !first && ownsFeed && !quotaChanged && !switchNoticeChanged && nextStatus === this.status) {
      return true;
    }
    this.status = nextStatus;
    let blocks = result.blocks;
    if (this._screenSwitch?.terminal === this.terminal && this._screenSwitch.notices.length) {
      // Skip a live notice once the transcript shows the same switch itself.
      const lastUser = blocks.findLastIndex((block) => block.type === "user");
      const logged = new Set(
        blocks.slice(lastUser + 1).filter((block) => block.type === "notice").map((block) => block.text.toLowerCase())
      );
      const live = this._screenSwitch.notices.filter((notice) => !logged.has(notice.text.toLowerCase()));
      if (live.length) blocks = [...blocks, ...live];
    }
    if (quota) {
      const lastUser = blocks.findLastIndex((block) => block.type === "user");
      const hasQuotaNotice = blocks.slice(lastUser + 1).some(
        (block) => block.type === "notice" && block.text?.includes(quota.text)
      );
      if (!hasQuotaNotice) blocks = [...blocks, { type: "notice", tone: "error", text: quota.text }];
    }
    const keyed = assignKeys(blocks, this.blocks);
    this.historyCache.delete(this.terminal);
    this.historyCache.set(this.terminal, keyed);
    this._feedSource = `transcript:${this.terminal}`;
    this.applyBlocks(keyed, cx);
    return true;
  }

  /**
   * Puts new blocks on screen if anything drawn changed. While the person is
   * at the bottom, the reversed feed keeps the newest turn visible by itself;
   * once they scroll up, the frozen window stays put and only the new-content
   * pill changes.
   */
  applyBlocks(blocks, cx) {
    const steersCleared = this.reconcilePendingSteers(blocks);
    if (this._readFor !== this.terminal) {
      // The first read for this terminal landed: the empty state may now say
      // "start the conversation" instead of "loading".
      this._readFor = this.terminal;
      cx.notify();
    }
    const blockKeys = blocks.map((b) => b.key).join(",");
    const signature = `${this.status}|${blockKeys}`;
    if (signature === this._signature) {
      if (steersCleared) cx.notify();
      return;
    }
    const contentChanged = blockKeys !== this._blockKeys;
    this._signature = signature;
    this._blockKeys = blockKeys;
    this.setBlocks(blocks);

    if (this.restoreScrollState()) {
      cx.notify();
      return;
    }

    if (this.readingBlocks || !this.pinned) {
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

  /** Persists the current scroll position per terminal in `shared("agent-chat.scrollState")`. */
  saveScrollState() {
    if (checking() || this.demo || !this.terminal) return;
    try {
      const current = shared("agent-chat.scrollState") || {};
      const windowCount = this.readingBlocks
        ? this.readingBlocks.length
        : Math.max(FEED_WINDOW, this.blocks.length - this.windowStart);
      shared("agent-chat.scrollState", {
        ...current,
        [this.terminal]: {
          pinned: Boolean(this.pinned),
          scrollY: this.scrollY || 0,
          scrollFromBottom: this.scrollFromBottom || 0,
          windowCount,
        },
      });
    } catch (_e) {}
  }

  /**
   * Restores saved scroll position once per terminal after blocks arrive.
   * @returns {boolean} true if a non-pinned scroll position was restored.
   */
  restoreScrollState() {
    if (!this.terminal || this.demo || this._restoredScrollFor === this.terminal || this.blocks.length === 0) {
      return false;
    }
    this._restoredScrollFor = this.terminal;
    try {
      const saved = shared("agent-chat.scrollState")?.[this.terminal];
      if (!saved || saved.pinned || (!(saved.scrollFromBottom > 0) && !(saved.scrollY >= 0))) return false;
      const count = Math.max(FEED_WINDOW, saved.windowCount || FEED_WINDOW);
      this.windowStart = Math.max(0, this.blocks.length - count);
      this.readingStart = this.windowStart;
      this.readingBlocks = cloneBlocks(this.blocks.slice(this.readingStart));
      this.pinned = false;
      this.hasPending = false;
      this._drawnStatus = this.status;
      const { maxScroll } = this.currentFeedLayout();
      const restoredY = Number.isFinite(saved.scrollY)
        ? saved.scrollY
        : maxScroll - (saved.scrollFromBottom || 0);
      this.scrollY = Math.max(0, Math.min(maxScroll, restoredY));
      this.scrollFromBottom = Math.max(0, maxScroll - this.scrollY);
      return true;
    } catch (_e) {
      return false;
    }
  }

  /** Records the current real content height and scrollY before prepending older blocks. */
  beginPrependAnchor() {
    if (this._contentHeight > 0 && !this._pendingPrepend) {
      this._pendingPrepend = {
        prevHeight: this._contentHeight,
        prevScrollY: this.scrollY || 0,
      };
    }
  }

  /**
   * Tracks real rendered height of `#chat-feed-content` so prepending older batches
   * shifts `scrollY` by the exact rendered pixel delta with zero jump.
   * @param {{ width: number, height: number }} size
   * @param {any} cx
   */
  onContentResize(size, cx) {
    const height = Math.round(size.height);
    if (height <= 0 || height === this._contentHeight) return;
    this._contentHeight = height;
    const vh = this._feedHeight > 0 ? this._feedHeight : 600;
    const maxScroll = Math.max(0, height - vh);
    if (this._pendingPrepend) {
      const anchored = applyPrependAnchor(
        this._pendingPrepend.prevScrollY,
        this._pendingPrepend.prevHeight,
        height
      );
      this._pendingPrepend = null;
      this.scrollY = Math.max(0, Math.min(maxScroll, anchored));
      this.scrollFromBottom = Math.max(0, maxScroll - this.scrollY);
      this.saveScrollState();
      cx.notify();
      return;
    }
    if (this.pinned) {
      this.scrollY = maxScroll;
      this.scrollFromBottom = 0;
    } else {
      this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY || 0));
      this.scrollFromBottom = Math.max(0, maxScroll - this.scrollY);
    }
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

  /**
   * Freezes the window the person is reading. From here on, new turns wait
   * in `this.blocks` instead of moving their view.
   * @param {any} cx
   */
  startReading(cx) {
    if (this.readingBlocks) return;
    if (this.pinned) {
      const { maxScroll } = this.currentFeedLayout();
      this.scrollY = maxScroll;
      this.scrollFromBottom = 0;
    }
    this.readingStart = this.windowStart;
    this.readingBlocks = cloneBlocks(this.blocks.slice(this.readingStart));
    this.pinned = false;
    this.hasPending = false;
    this._drawnStatus = this.status;
    this.saveScrollState();
    cx.notify();
  }

  /**
   * Adds one batch of older turns above the current window. `beginPrependAnchor`
   * captures the current rendered height so `onContentResize` locks the reading position.
   * @param {any} cx
   */
  loadEarlier(cx) {
    if (!this.readingBlocks) this.startReading(cx);
    if (this.readingBlocks) {
      if (this.readingStart === 0) return;
      this.beginPrependAnchor();
      const start = Math.max(0, this.readingStart - FEED_PAGE);
      const older = cloneBlocks(this.blocks.slice(start, this.readingStart));
      this.readingBlocks = older.concat(this.readingBlocks);
      this.readingStart = start;
    } else {
      if (this.windowStart === 0) return;
      this.beginPrependAnchor();
      this.windowStart = Math.max(0, this.windowStart - FEED_PAGE);
    }
    this.saveScrollState();
    cx.notify();
  }

  /**
   * Returns to the live tail (`scrollFromBottom = 0`).
   * @param {any} cx
   */
  returnToLive(cx) {
    this._pendingPrepend = null;
    this.readingBlocks = null;
    this.readingStart = 0;
    this.pinned = true;
    this.scrollFromBottom = 0;
    this.hasPending = false;
    this.windowStart = Math.max(0, this.blocks.length - FEED_WINDOW);
    this._drawnStatus = this.status;
    this.scrollY = this.currentFeedLayout().maxScroll;
    this.saveScrollState();
    if (this._cliPageUps > 0 && this.terminal && !this.demo) {
      const count = Math.min(this._cliPageUps, 12);
      const terminal = this.terminal;
      this._cliPageUps = 0;
      cx.spawn(async () => {
        for (let i = 0; i < count; i++) {
          try {
            await hc(["keys", terminal, "pagedown"]);
          } catch (_e) {
            break;
          }
        }
      });
    }
    cx.notify();
  }

  /**
   * Queries the underlying CLI harness for older scrollback lines using native
   * `pageup` keys + expanded `hc read --lines`, then prepends newly discovered blocks.
   * @param {any} cx
   */
  fetchEarlierFromCli(cx) {
    if (this._cliFetching || this._cliExhausted || this.demo || !this.terminal) return;
    const terminal = this.terminal;
    const switchGen = this._switchGen;
    this._cliFetching = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await hc(["keys", terminal, "pageup"]).catch(() => {});
        this._cliPageUps = (this._cliPageUps || 0) + 1;
        await new Promise((resolve) => cx.timer.after(180, resolve));
        if (switchGen !== this._switchGen || this.terminal !== terminal) return;

        const nextLines = Math.min(4000, (this._cliLines || 0) + 80);
        const res = await hc(["read", terminal, "--lines", String(nextLines), "--json"]);
        if (switchGen !== this._switchGen || this.terminal !== terminal) return;
        if (res.code !== 0 || !res.stdout) {
          this._cliExhausted = true;
          return;
        }

        const data = JSON.parse(res.stdout);
        const parsed = parseConversation(data.text || "");
        const { merged, addedCount } = prependEarlierBlocks(parsed, this.blocks);
        this._cliLines = nextLines;
        this.rawText = data.text || this.rawText;
        this.rawHistoryCache.set(terminal, this.rawText);

        if (addedCount > 0) {
          if (!this.readingBlocks) this.startReading(cx);
          this.beginPrependAnchor();
          const keyed = assignKeys(merged.map((b) => ({ ...b })), this.blocks);
          this.historyCache.set(terminal, keyed);
          this.setBlocks(keyed);
          if (this.readingBlocks) {
            const older = cloneBlocks(keyed.slice(0, addedCount));
            this.readingBlocks = older.concat(this.readingBlocks);
            this.readingStart = 0;
          } else {
            this.windowStart = 0;
          }
          this._blockKeys = keyed.map((b) => b.key).join(",");
          this._signature = `${this.status}|${this._blockKeys}`;
          this.saveScrollState();
        } else {
          this._cliExhausted = true;
        }
      } catch (_err) {
        // Leave existing feed intact on transient read error.
      } finally {
        if (switchGen === this._switchGen) {
          this._cliFetching = false;
          cx.notify();
        }
      }
    });
  }

  /**
   * Loads an older batch from the active transcript reader (JSONL tail or OpenCode SQLite)
   * and prepends the newly discovered blocks above the current frozen window.
   * @param {any} cx
   */
  fetchEarlierFromTranscript(cx) {
    if (
      this._transcriptFetching ||
      !this.transcript?.hasEarlier ||
      typeof this.transcript.loadEarlier !== "function" ||
      this.demo
    ) {
      return;
    }
    const terminal = this.terminal;
    const switchGen = this._switchGen;
    const transcript = this.transcript;
    this._transcriptFetching = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await transcript.loadEarlier();
        if (switchGen !== this._switchGen || this.terminal !== terminal || this.transcript !== transcript) return;
        if (res?.changed && Array.isArray(res.blocks)) {
          if (!this.readingBlocks) this.startReading(cx);
          this.beginPrependAnchor();
          const keyed = assignKeys(res.blocks.map((b) => ({ ...b })), this.blocks);
          const addedCount = Math.max(0, keyed.length - this.blocks.length);
          this.historyCache.set(terminal, keyed);
          this.setBlocks(keyed);
          if (this.readingBlocks && addedCount > 0) {
            const older = cloneBlocks(keyed.slice(0, addedCount));
            this.readingBlocks = older.concat(this.readingBlocks);
            this.readingStart = 0;
          }
          this._blockKeys = keyed.map((b) => b.key).join(",");
          this._signature = `${this.status}|${this._blockKeys}`;
          this.saveScrollState();
        }
      } catch (_err) {
        // Keep current transcript window intact on transient read error.
      } finally {
        if (switchGen === this._switchGen) {
          this._transcriptFetching = false;
          cx.notify();
        }
      }
    });
  }

  /**
   * Computes current feed layout metrics for the visible batch.
   * @returns {{ visible: Array<object>, start: number, totalHeight: number, maxScroll: number }}
   */
  currentFeedLayout() {
    const frozen = this.readingBlocks;
    const start = frozen ? this.readingStart : this.windowStart;
    const visible = frozen || this.blocks.slice(this.windowStart);
    const vh = this._feedHeight > 0 ? this._feedHeight : 600;
    const colW = Math.min(COLUMN, this._feedWidth > 0 ? this._feedWidth : COLUMN);
    const canFetchTranscript = Boolean(this.transcript?.hasEarlier) && !this.demo;
    // Live switch notices before a session exists are not screen history.
    const onlyNotices = this.blocks.every((block) => block.type === "notice");
    const canFetchCli =
      !this.transcript?.path && !this.transcript?.sessionId && !this._cliExhausted && !this.demo && !onlyNotices;
    const hasLoadEarlier = start > 0 || canFetchTranscript || canFetchCli;
    const est = computeFeedLayout(visible, this.expanded, vh, hasLoadEarlier, colW);
    const totalHeight = this._contentHeight > 0 ? this._contentHeight : est.totalHeight;
    const maxScroll = Math.max(0, totalHeight - vh);
    return { visible, start, totalHeight, maxScroll };
  }

  /**
   * Scrolls the feed by `deltaUpPx` (positive = up into history, negative = down toward live tail).
   * Automatically lazy-loads older batches near the top and re-pins near the bottom.
   * @param {number} deltaUpPx
   * @param {any} cx
   */
  scrollFeedBy(deltaUpPx, cx) {
    if (!deltaUpPx) return;
    if (deltaUpPx > 0 && !this.readingBlocks) {
      this.startReading(cx);
    }
    const { start, maxScroll } = this.currentFeedLayout();
    const nextY = Math.max(0, Math.min(maxScroll, (this.scrollY || 0) - deltaUpPx));
    this.scrollY = nextY;
    this.scrollFromBottom = Math.max(0, maxScroll - nextY);

    if (deltaUpPx > 0 && nextY <= 48) {
      if (start > 0) {
        this.loadEarlier(cx);
        return;
      }
      if (this.transcript?.hasEarlier) {
        this.fetchEarlierFromTranscript(cx);
        return;
      }
      if (!this.transcript?.path && !this.transcript?.sessionId && !this._cliExhausted && !this.demo) {
        this.fetchEarlierFromCli(cx);
        return;
      }
    }
    if (deltaUpPx < 0 && maxScroll - nextY <= 8) {
      this.returnToLive(cx);
      return;
    }
    this.saveScrollState();
    cx.notify();
  }

  /**
   * Handles PageUp / PageDown scrolling and lazy batch discovery.
   * @param {1 | -1} direction 1 = PageUp, -1 = PageDown
   * @param {any} cx
   */
  pageScroll(direction, cx) {
    if (this.blocks.length === 0) return;
    const step = Math.max(200, (this._feedHeight > 0 ? this._feedHeight : 560) - 64);
    const { start } = this.currentFeedLayout();
    if (direction > 0 && (this.scrollY || 0) <= step) {
      if (start > 0) {
        if (!this.readingBlocks) this.startReading(cx);
        this.loadEarlier(cx);
      } else if (this.transcript?.hasEarlier) {
        if (!this.readingBlocks) this.startReading(cx);
        this.fetchEarlierFromTranscript(cx);
      } else if (!this.transcript?.path && !this.transcript?.sessionId && !this._cliExhausted && !this.demo) {
        if (!this.readingBlocks) this.startReading(cx);
        this.fetchEarlierFromCli(cx);
      }
    }
    this.scrollFeedBy(direction * step, cx);
  }

  /**
   * Handles direct keydown events for PageUp/PageDown/Home/End.
   * @param {any} event
   * @param {any} cx
   */
  handleKeyDown(event, cx) {
    const key = String(event?.keystroke || event?.key || "").toLowerCase();
    if (key === "pageup") {
      this.pageScroll(1, cx);
      cx.stop_propagation?.();
    } else if (key === "pagedown") {
      this.pageScroll(-1, cx);
      cx.stop_propagation?.();
    } else if (key === "home") {
      if (!this.readingBlocks) this.startReading(cx);
      while (this.readingStart > 0) this.loadEarlier(cx);
      const { maxScroll } = this.currentFeedLayout();
      this.scrollY = 0;
      this.scrollFromBottom = maxScroll;
      this.saveScrollState();
      cx.notify();
      cx.stop_propagation?.();
    } else if (key === "end") {
      this.returnToLive(cx);
      cx.stop_propagation?.();
    }
  }

  /**
   * Wheel over the feed: positive delta scrolls UP into history, negative scrolls DOWN.
   * @param {any} e
   * @param {any} cx
   */
  onFeedWheel(e, cx) {
    const dy =
      e?.delta?.y !== 0 && e?.delta?.y !== undefined
        ? e.delta.y
        : e?.delta_lines?.y
          ? e.delta_lines.y * 24
          : 0;
    if (!dy) return;
    this.scrollFeedBy(dy, cx);
  }

  /**
   * Tracks viewport dimensions so scroll bounds and PageUp/PageDown steps match the pane.
   * @param {{ width: number, height: number }} size
   * @param {any} cx
   */
  onFeedResize(size, cx) {
    const width = Math.round(size.width);
    const height = Math.round(size.height);
    if (width === this._feedWidth && height === this._feedHeight) return;
    this._feedWidth = width;
    this._feedHeight = height;
    const nextMax = this.currentFeedLayout().maxScroll;
    if (this.pinned) {
      this.scrollY = nextMax;
      this.scrollFromBottom = 0;
    } else {
      this.scrollY = Math.max(0, Math.min(nextMax, this.scrollY || 0));
      this.scrollFromBottom = Math.max(0, nextMax - this.scrollY);
      this.saveScrollState();
    }
    cx.notify();
  }

  /**
   * Keeps the floating picker anchored above the composer when it grows or
   * shrinks (attachments, approvals, wrapped context). No layout is reserved
   * for it, so only the stored height changes.
   * @param {{ height: number }} size
   * @param {any} cx
   */
  onComposerResize(size, cx) {
    const height = Math.round(size.height);
    if (height === this._composerHeight) return;
    this._composerHeight = height;
    if (this.pickerOpen || this.modelMenuOpen) cx.notify();
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

  /** Forwards a non-text paste (an image) to the agent as Ctrl+V and marks its position in the input. */
  pasteImage(cx) {
    if (!this.terminal) return;
    cx.spawn(async (cx) => {
      try {
        await hcOrThrow(["keys", this.terminal, "ctrl+v"]);
        const n = (this.attached || 0) + 1;
        this.attached = n;
        const token = { id: `image-${n}`, text: `[Image #${n}]`, label: `🖼 Image #${n}` };
        if (typeof this.input.replace_with_token === "function") {
          this.input.replace_with_token(token);
        } else {
          this.input.replace(token.text);
        }
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /**
   * Sends text to the given terminal, running `hc send` on the target machine
   * when remote so `hc` does not wrap the message in `<hc from="…/ppid:…">`.
   */
  async sendTextToTerminal(text, { force = false, terminal = this.terminal } = {}) {
    const machine = terminalMachine(terminal);
    const localAddr = terminalLocalAddress(terminal);
    const args = ["send", ...(force ? ["--force"] : []), "--", localAddr, text];
    if (!machine) {
      await hcOrThrow(["send", ...(force ? ["--force"] : []), "--", terminal, text]);
      return;
    }
    const res = await exec("hc", args, { on: machine });
    if (res.code !== 0) {
      throw new Error((res.stderr || res.stdout || "").trim() || `hc ${args[0]} failed (${res.code})`);
    }
  }

  /** Loads persisted send mode ("steer" | "queue") for a terminal, defaulting to "steer". */
  loadSendMode(terminal = this.terminal) {
    if (checking()) return "steer";
    try {
      const modes = shared("agent-chat.sendModes");
      if (terminal && modes && typeof modes === "object" && !Array.isArray(modes)) {
        const saved = modes[terminal];
        if (saved === "queue" || saved === "steer") return saved;
      }
      return shared("agent-chat.sendMode") === "queue" ? "queue" : "steer";
    } catch (_e) {
      return "steer";
    }
  }

  /** Toggles between "steer" (send immediately while working) and "queue" (hold until idle). */
  toggleSendMode(cx) {
    this.sendMode = this.sendMode === "queue" ? "steer" : "queue";
    try {
      const prev = shared("agent-chat.sendModes");
      const next = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
      if (this.terminal) next[this.terminal] = this.sendMode;
      setShared("agent-chat.sendModes", next);
    } catch (_e) {}
    cx.notify();
  }

  /** Returns queued messages for the current terminal. */
  currentQueue() {
    return (this.terminal && this.messageQueues.get(this.terminal)) || [];
  }

  /** Returns in-flight steer messages for the current terminal that have not appeared in the feed yet. */
  currentPendingSteers() {
    return (this.terminal && this.pendingSteers.get(this.terminal)) || [];
  }

  /** Tracks a steer message sent while working so it stays visible until it lands in the feed. */
  addPendingSteer(terminal, text) {
    if (!terminal || !text) return null;
    let list = this.pendingSteers.get(terminal);
    if (!list) {
      list = [];
      this.pendingSteers.set(terminal, list);
    }
    const entry = {
      text,
      norm: text.replace(/\s+/g, " ").trim(),
      at: Date.now(),
      baseUserCount: this.blocks.filter((b) => b.type === "user").length,
    };
    list.push(entry);
    return entry;
  }

  /** Dismisses a pending steer entry from the UI strip. */
  removePendingSteer(index, cx) {
    const list = this.currentPendingSteers();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    cx.notify();
  }

  /** Clears pending steer messages once a matching user turn appears in the feed. */
  reconcilePendingSteers(blocks) {
    if (!this.terminal) return false;
    const list = this.pendingSteers.get(this.terminal);
    if (!list || list.length === 0) return false;
    const userBlocks = blocks.filter((b) => b.type === "user");
    const before = list.length;
    const remaining = list.filter((entry) => {
      for (let i = Math.min(entry.baseUserCount, userBlocks.length); i < userBlocks.length; i++) {
        const text = String(userBlocks[i]?.text || "").replace(/\s+/g, " ").trim();
        if (text === entry.norm || (entry.norm && text.includes(entry.norm))) return false;
      }
      return true;
    });
    if (remaining.length === before) return false;
    if (remaining.length === 0) this.pendingSteers.delete(this.terminal);
    else this.pendingSteers.set(this.terminal, remaining);
    return true;
  }

  /** Removes a queued message at `index` for the current terminal. */
  removeQueued(index, cx) {
    const queue = this.currentQueue();
    if (index < 0 || index >= queue.length) return;
    queue.splice(index, 1);
    cx.notify();
  }

  /** Pulls a queued message back into the composer input so it can be edited. */
  editQueued(index, cx) {
    const queue = this.currentQueue();
    if (index < 0 || index >= queue.length) return;
    const [text] = queue.splice(index, 1);
    const existing = (this.input.value() || "").trim();
    this.input.set_value(existing ? `${text}\n${existing}` : text);
    cx.notify();
  }

  /** Immediately sends a specific queued message (steering the agent). */
  sendQueuedNow(index, cx) {
    const terminal = this.terminal;
    const queue = this.currentQueue();
    if (!terminal || index < 0 || index >= queue.length) return;
    const [text] = queue.splice(index, 1);
    const steerEntry = this.status === "working" ? this.addPendingSteer(terminal, text) : null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.sendTextToTerminal(text, { terminal, force: this.status === "blocked" });
        this.returnToLive(cx);
        await this.update(cx);
      } catch (err) {
        if (steerEntry) {
          const list = this.pendingSteers.get(terminal);
          const idx = list ? list.indexOf(steerEntry) : -1;
          if (idx >= 0) list.splice(idx, 1);
        }
        queue.unshift(text);
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /** Dispatches the next queued message once the agent is ready for another turn. */
  drainQueue(cx) {
    if (this._drainingQueue || this.demo || !this.terminal) return;
    if (this.status === "working" || this.status === "blocked" || this.status === "error") return;
    const terminal = this.terminal;
    const queue = this.messageQueues.get(terminal);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    this._drainingQueue = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.sendTextToTerminal(next, { terminal });
        this.returnToLive(cx);
        await this.update(cx);
      } catch (err) {
        queue.unshift(next);
        this.flashNotice(err, cx);
      } finally {
        this._drainingQueue = false;
        cx.notify();
      }
    });
  }

  /** Sends the composer input or attached images to the agent terminal, or queues while working. */
  send(cx) {
    const val = (this.input.value() || "").trim();
    if (this.demo || !this.terminal || (!val && !this.attached)) return;
    if (this.status === "working" && this.sendMode === "queue" && val && !this.attached) {
      let queue = this.messageQueues.get(this.terminal);
      if (!queue) {
        queue = [];
        this.messageQueues.set(this.terminal, queue);
      }
      queue.push(val);
      this.input.set_value("");
      cx.notify();
      return;
    }
    const terminal = this.terminal;
    const steerEntry =
      this.status === "working" && this.sendMode === "steer" && val && !this.attached
        ? this.addPendingSteer(terminal, val)
        : null;
    if (steerEntry) {
      this.input.set_value("");
      cx.notify();
    }
    cx.spawn(async (cx) => {
      try {
        if (!val) {
          // Only images attached: submit what the agent already holds.
          await hcOrThrow(["keys", terminal, "enter"]);
        } else {
          await this.sendTextToTerminal(val, { terminal, force: this.status === "blocked" });
        }
        if (!steerEntry) this.input.set_value("");
        this.attached = 0;
        this.returnToLive(cx);
        await this.update(cx);
      } catch (err) {
        if (steerEntry) {
          const list = this.pendingSteers.get(terminal);
          const idx = list ? list.indexOf(steerEntry) : -1;
          if (idx >= 0) list.splice(idx, 1);
          if (!(this.input.value() || "").trim()) this.input.set_value(val);
        }
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

  /** Stops / interrupts the running agent. */
  stop(cx) {
    this.interrupt(cx);
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
    if (block.type === "user") {
      const lines = (block.text || "").split("\n");
      if (lines.length > 10 || (block.text || "").length > 600) {
        if (this.expanded.has(block.ekey)) this.expanded.delete(block.ekey);
        else this.expanded.add(block.ekey);
        cx.notify();
      }
      return;
    }
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

  renderAgentPicker(t, monoFont, cx, maxH = 420) {
    if (!this.pickerOpen) return null;

    const liveAgents = agents();
    const liveTerminals = terminals().filter((term) => term.state === "live");
    const agentAddresses = new Set(liveAgents.map((a) => a.address));
    const subterminals = liveTerminals.filter((term) => !agentAddresses.has(term.address));

    return v_flex()
      .id("agent-picker-dropdown")
      .w_full()
      .max_h(maxH)
      .p(10)
      .gap(8)
      .bg(t.raised || t.surface)
      .border_b(1)
      .border_color(t.border)
      // Follow focused agent row
      .child(
        h_flex()
          .id("pick-follow-focused")
          .flex_none()
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
              this.switchTo(resolveTerminal(), cx);
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
          .id("agent-picker-list")
          .max_h(Math.max(80, maxH - 72))
          .overflow_y_scrollbar()
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
                  this.followFocused = false;
                  this.pickerOpen = false;
                  this.switchTo(ag.address, cx);
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
                  this.followFocused = false;
                  this.pickerOpen = false;
                  this.switchTo(term.address, cx);
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
      );
  }

  /**
   * Returns the active multiple-choice question when the agent is blocked on a
   * `question` / `ask_question` / `AskUserQuestion` tool call, or null.
   */
  pendingQuestion() {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      const tools = b.type === "tool_group" ? b.tools || [] : b.type === "tool" ? [b] : [];
      for (let j = tools.length - 1; j >= 0; j--) {
        const tool = tools[j];
        if (!tool || !/^(?:question|ask_question|askuserquestion|request_user_input)$/i.test(tool.name || "")) continue;
        const qs = tool.input?.questions;
        if (!Array.isArray(qs) || qs.length === 0) continue;
        const q = qs[0];
        if (!q?.question || !Array.isArray(q.options) || q.options.length === 0) continue;
        const options = q.options
          .map((opt) =>
            typeof opt === "string"
              ? { label: opt, description: "" }
              : { label: String(opt?.label || opt?.text || "").trim(), description: String(opt?.description || "").trim() }
          )
          .filter((opt) => opt.label);
        if (options.length > 0) return { question: String(q.question).trim(), options };
      }
      if (b.type === "user") break;
    }
    return null;
  }

  /**
   * A blocked agent's selection menu: the dialog text, one row per option and
   * Cancel. Clicking a row moves the terminal's highlight to it and confirms.
   * @param {any} t theme
   * @param {{ title: string, body: string[], options: { label: string, description?: string }[], selected: number }} choice
   * @param {Function} btn button factory from renderPendingApprovalActions
   */
  renderChoiceCard(t, choice, btn) {
    const { title, body, options, selected } = choice;
    return v_flex()
      .id("pending-question-card")
      .w_full()
      .max_w(COLUMN)
      .mb(10)
      .p(12)
      .gap(8)
      .rounded(12)
      .bg(withAlpha(t.blocked, "14"))
      .border_1()
      .border_color(t.blocked)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/agent-chat/icons/shield-alert.svg").size(16).flex_none().text_color(t.blocked))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .text_size(13)
              .font_semibold()
              .text_color(t.foreground)
              .child(title || "The agent needs a choice")
          )
      )
      .when(body.length > 0, (el) =>
        el.child(
          v_flex()
            .w_full()
            .gap(4)
            .children(body.map((line) => div().text_size(11.5).text_color(t.dim).child(line)))
        )
      )
      .child(
        v_flex()
          .w_full()
          .gap(4)
          .children(
            options.map((opt, idx) =>
              v_flex()
                .id(`pending-q-opt-${idx}`)
                .w_full()
                .px(10)
                .py(7)
                .gap(2)
                .rounded(8)
                .bg(t.raised)
                .border_1()
                .border_color(idx === selected ? t.blocked : t.border)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  const step = idx - selected;
                  const keys = [...Array(Math.abs(step)).fill(step > 0 ? "down" : "up"), "enter"];
                  this.sendKeys(keys, cx);
                })
                .child(
                  div()
                    .text_size(12.5)
                    .font_medium()
                    .text_color(t.foreground)
                    .child(`${idx + 1}. ${opt.label}`)
                )
                .when(Boolean(opt.description), (el) =>
                  el.child(div().text_size(11.5).text_color(t.dim).child(opt.description))
                )
            )
          )
      )
      .child(
        h_flex()
          .items_center()
          .justify_end()
          .child(btn("act-cancel", "Cancel (Esc)", (cx) => this.sendKey("esc", cx)))
      );
  }

  /**
   * The selection menu on the agent's screen, or null. Blocked agents always
   * get it; before any conversation it is shown regardless of status, since
   * Codex reports no status at its folder-trust prompt.
   * @returns {ReturnType<typeof parseScreenChoice>}
   */
  screenChoice() {
    if (this.status === "working") return null;
    if (this.status !== "blocked" && this.blocks.length > 0) return null;
    const codexScreen = this.codexModelScreen?.terminal === this.terminal ? this.codexModelScreen.text : "";
    return parseScreenChoice(this.rawText) || (codexScreen ? parseScreenChoice(codexScreen) : null);
  }

  /**
   * Renders quick approval actions or interactive decision options when the agent is blocked.
   */
  renderPendingApprovalActions(t, cx) {
    const screenChoice = this.screenChoice();
    if (this.status !== "blocked" && !screenChoice) return null;

    const btn = (id, label, onClick, primary = false) =>
      div()
        .id(id)
        .px(12)
        .h(28)
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .border_1()
        .border_color(primary ? t.blocked : t.border)
        .bg(primary ? t.blocked : t.raised)
        .text_color(primary ? (t.background || "#ffffff") : t.foreground)
        .text_size(12)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => onClick(cx))
        .child(label);

    const pendingQ = this.pendingQuestion();
    if (pendingQ) {
      return this.renderChoiceCard(t, { title: pendingQ.question, body: [], options: pendingQ.options, selected: 0 }, btn);
    }

    // A selection menu on screen (folder trust, permission dialogs): offer its
    // real options, since the highlighted default may be "No, exit".
    if (screenChoice) return this.renderChoiceCard(t, screenChoice, btn);

    // Blocked at an idle composer: the agent asked a question in prose and
    // wants a typed reply, so approval keys would do nothing useful.
    if (!screenAwaitsChoice(this.rawText)) {
      return h_flex()
        .id("pending-reply-hint")
        .w_full()
        .max_w(COLUMN)
        .mb(8)
        .px(4)
        .gap(6)
        .items_center()
        .child(svg("mods/agent-chat/icons/shield-alert.svg").size(13).flex_none().text_color(t.blocked))
        .child(
          div()
            .text_size(12)
            .text_color(t.dim)
            .child("The agent is waiting for your reply")
        );
    }

    return v_flex()
      .id("pending-approval-card")
      .w_full()
      .max_w(COLUMN)
      .mb(10)
      .p(12)
      .gap(8)
      .rounded(12)
      .bg(withAlpha(t.blocked, "14"))
      .border_1()
      .border_color(t.blocked)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg("mods/agent-chat/icons/shield-alert.svg").size(16).text_color(t.blocked))
          .child(
            div()
              .text_size(13)
              .font_semibold()
              .text_color(t.blocked)
              .child("Waiting for approval")
          )
      )
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .flex_wrap()
          .child(btn("act-approve", "Approve (Enter)", (cx) => this.sendKey("enter", cx), true))
          .child(btn("act-yes", "Yes (y)", (cx) => this.sendKeys(["y", "enter"], cx)))
          .child(btn("act-opt2", "Option 2 (2)", (cx) => this.sendKeys(["down", "enter"], cx)))
          .child(btn("act-no", "No (n)", (cx) => this.sendKeys(["n", "enter"], cx)))
          .child(btn("act-cancel", "Cancel (Esc)", (cx) => this.sendKey("esc", cx)))
      );
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
        .child(
          v_flex()
            .w_full()
            .max_w(COLUMN)
            .px(24)
            .child(content)
        );

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
      const isLong = Boolean(block.isLong);
      const isExpanded = this.expanded.has(block.ekey);
      let displayText = block.text || "";
      if (isLong && !isExpanded) {
        displayText = block.preview;
      }

      return column(
        v_flex()
          .w_full()
          .items_end()
          .pt(18)
          .pb(6)
          // A message from another agent (`hc send`): say who sent it.
          .when(Boolean(block.from), (el) =>
            el.child(
              div()
                .pb(4)
                .pr(4)
                .text_size(11)
                .text_color(t.dim)
                .child(`from ${block.from}`)
            )
          )
          .child(
            v_flex()
              .max_w(560)
              .px(14)
              .py(10)
              .rounded(16)
              .bg(withAlpha(t.accent, "2e"))
              .border_1()
              .border_color(withAlpha(t.accent, "80"))
              .cursor_pointer()
              .child(
                div()
                  .text_size(14)
                  .line_height("22px")
                  .when(Boolean(bodyFont()), (el) => el.font_family(bodyFont()))
                  .text_color(t.foreground)
                  .child(displayText)
              )
              .when(isLong, (el) =>
                el.child(
                  div()
                    .pt(6)
                    .text_size(11.5)
                    .font_medium()
                    .text_color(t.accent)
                    .child(
                      isExpanded
                        ? "Show less"
                        : `Show full message (${block.lineCount} lines)`
                    )
                )
              )
          )
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    if (block.type === "assistant") {
      const changedFiles = block.changedFiles || [];

      return column(
        v_flex()
          .w_full()
          .py(8)
          .gap(6)
          .child(
            div()
              .w_full()
              .text_size(14)
              .line_height("22px")
              .when(Boolean(bodyFont()), (el) => el.font_family(bodyFont()))
              .text_color(t.foreground)
              .child(
                this.renderMarkdownBlocks(
                  block.mdBlocks || parseMarkdownBlocks(block.text || ""),
                  t,
                  monoFont,
                  `md-${block.key}`
                )
              )
          )
          // Assistant Message Meta bar
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .pt(4)
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .flex_wrap()
                  .when(changedFiles.length > 0, (el) =>
                    el
                      .child(svg("mods/agent-chat/icons/square-pen.svg").size(12).text_color(t.dim))
                      .children(
                        changedFiles.slice(0, 5).map((f) =>
                          div()
                            .px(6)
                            .py(1.5)
                            .rounded(4)
                            .bg(t.raised)
                            .border_1()
                            .border_color(t.border)
                            .font_family(monoFont)
                            .text_size(11)
                            .text_color(t.dim)
                            .when(this.hasFileEditor, (el) =>
                              el
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                .on_click((_e, cx) => {
                                  cx.stop_propagation();
                                  this.handleLinkClick(f, cx);
                                })
                            )
                            .child(basename(f))
                        )
                      )
                  )
              )
              // Only the confirmation: a "Right-click to copy" hint under every
              // reply is noise, so the tip lives once in the composer footer.
              .when(copied, (el) =>
                el.child(
                  h_flex()
                    .items_center()
                    .gap(4)
                    .child(svg("mods/agent-chat/icons/check.svg").size(11).text_color(t.done))
                    .child(div().text_size(11).text_color(t.done).child("Copied"))
                )
              )
          )
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
    // Thinking is reasoning, not a reply: a bounded, scrollable panel, drawn
    // dimmer than a reply. Its text is Markdown (models write `**headings**`),
    // so it goes through the same renderer instead of showing raw asterisks.
    // Every bounded panel is named: the feed is rebuilt on each poll and rows
    // shift as turns arrive, so a panel identified only by its position would
    // lose its scroll offset (or take another panel's) on the next repaint.
    const thinkingBox = (text, id) =>
      div()
        .id(`${id}-scroll`)
        .w_full()
        .max_h(280)
        .overflow_y_scrollbar()
        .child(
          div()
            .w_full()
            .mt(6)
            .p(12)
            .rounded(10)
            .bg(t.raised)
            .text_size(13)
            .line_height("21px")
            .text_color(t.dim)
            .child(this.renderMarkdownBlocks(parseMarkdownBlocks(text || ""), t, monoFont, id))
        );

    if (block.type === "thought") {
      const isRunning = block.status === "running";
      const line = block.liveLine;
      const label = isRunning
        ? (line ? `Thinking — ${line}` : "Thinking…")
        : (line ? `Thought · ${line}` : (block.duration ? `Thought for ${block.duration}` : "Thought"));

      return column(
        v_flex()
          .w_full()
          .py(4)
          .child(
            h_flex()
              .w_full()
              .min_w(0)
              .items_center()
              .gap(8)
              .cursor_pointer()
              .child(
                svg("mods/agent-chat/icons/brain.svg")
                  .size(13)
                  .flex_none()
                  .text_color(isRunning ? t.working : t.dim)
              )
              .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(label))
              .child(chevron)
          )
          .when(open, (el) =>
            el.child(
              thinkingBox(block.text || block.summary || "", `think-${block.ekey}`)
            )
          )
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    // Errors, warnings, interruptions, model switches: distinct from assistant prose.
    if (block.type === "notice") {
      const tone = block.tone || "info";
      const errColor = t.ansi1 || "#ef4444";
      const warnColor = t.blocked || t.ansi3 || "#f59e0b";

      if (tone === "warning" || tone === "error") {
        const color = tone === "error" ? errColor : warnColor;
        return column(
          h_flex()
            .w_full()
            .items_start()
            .gap(8)
            .my(6)
            .px(12)
            .py(7)
            .rounded(8)
            .bg(withAlpha(color, "14"))
            .border_1()
            .border_color(withAlpha(color, "55"))
            .child(svg("mods/agent-chat/icons/shield-alert.svg").size(13).flex_none().mt(2).text_color(color))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .font_family(monoFont)
                .text_size(11.5)
                .line_height("18px")
                .text_color(color)
                .child(block.text || "")
            )
            .when(block.count > 1, (el) =>
              el.child(
                div()
                  .flex_none()
                  .px(6)
                  .py(1)
                  .rounded_full()
                  .bg(withAlpha(color, "22"))
                  .border_1()
                  .border_color(withAlpha(color, "44"))
                  .font_family(monoFont)
                  .text_size(10.5)
                  .line_height("14px")
                  .text_color(color)
                  .child(`×${block.count}`)
              )
            )
        );
      }

      return column(
        h_flex()
          .w_full()
          .items_center()
          .gap(10)
          .py(8)
          .child(div().flex_1().h(1).bg(withAlpha(t.border, "80")))
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .px(10)
              .py(2)
              .rounded_full()
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .child(svg("mods/agent-chat/icons/corner-up-right.svg").size(11).text_color(t.dim))
              .child(
                div()
                  .font_family(monoFont)
                  .text_size(11)
                  .text_color(t.dim)
                  .child(block.text || "")
              )
          )
          .child(div().flex_1().h(1).bg(withAlpha(t.border, "80")))
      );
    }

    if (block.type === "tool") {
      const action = block.action || "other";
      const iconPath = toolActionIcon(action);
      const isRunning = block.status === "running";
      const isFailed = block.hasFailure || block.status === "error";
      const errColor = t.ansi1 || "#ef4444";

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
              .child(
                isRunning
                  ? svg("mods/agent-chat/icons/refresh.svg").size(12).text_color(t.working)
                  : svg(iconPath)
                      .size(13)
                      .text_color(isFailed ? errColor : t.dim)
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12.5)
                  .font_family(monoFont)
                  .text_color(isFailed ? errColor : t.dim)
                  .child(block.title || "Tool call")
              )
              .when(Boolean(block.detail), (el) => el.child(chevron))
          )
          .when(open && Boolean(block.detail), (el) => el.child(detailBox(block.detail)))
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    if (block.type === "tool_group") {
      const summaryKind = block.summaryKind || "mixed";
      const iconPath = toolActionIcon(summaryKind);
      const isRunning = block.status === "running";
      const errColor = t.ansi1 || "#ef4444";
      const failedCount = (block.tools || []).filter((x) => x.hasFailure || x.status === "error").length;
      const summaryText = block.summary || `Used ${block.count} tools`;

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
              .child(
                isRunning
                  ? svg("mods/agent-chat/icons/refresh.svg").size(12).text_color(t.working)
                  : svg(iconPath).size(13).text_color(t.dim)
              )
              .child(div().flex_none().text_size(13).text_color(t.foreground).child(summaryText))
              .when(failedCount > 0, (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .border_1()
                    .border_color(withAlpha(errColor, "66"))
                    .text_size(10.5)
                    .text_color(errColor)
                    .child(`${failedCount} failed`)
                )
              )
              // Always fills the row, so the count and chevron sit at the right edge.
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_size(12)
                  .text_color(t.dim)
                  .child(block.activity ? `· ${block.activity}` : "")
              )
              .when(block.count > 0, (el) =>
                el.child(
                  div()
                    .px(5)
                    .py(1)
                    .rounded(4)
                    .bg(t.raised)
                    .text_size(10.5)
                    .font_family(monoFont)
                    .text_color(t.dim)
                    .child(String(block.count))
                )
              )
              .child(chevron)
          )
          .when(open, (el) =>
            el.child(
              v_flex()
                .w_full()
                .mt(6)
                .pl(8)
                .gap(4)
                .border_l(2)
                .border_color(withAlpha(t.border, "70"))
                .children([
                  ...(block.thoughts || [])
                    .map((thought, thoughtIndex) => ({ thought, thoughtIndex }))
                    .filter(({ thought }) => Boolean(thought.text))
                    .map(({ thought, thoughtIndex }) => {
                      // Like a tool call: one line, opens on its own.
                      const thoughtKey = `${block.ekey}:thought${thoughtIndex}`;
                      const thoughtOpen = this.expanded.has(thoughtKey);
                      const line = liveThoughtLine(thought.text);
                      const thinking = thought.status === "running";
                      return v_flex()
                        .w_full()
                        .child(
                          h_flex()
                            .id(`thought-${thoughtKey}`)
                            .items_center()
                            .gap(8)
                            .py(2)
                            .cursor_pointer()
                            .on_click((_e, cx) => {
                              cx.stop_propagation();
                              if (this.expanded.has(thoughtKey)) this.expanded.delete(thoughtKey);
                              else this.expanded.add(thoughtKey);
                              cx.notify();
                            })
                            .child(
                              svg("mods/agent-chat/icons/brain.svg")
                                .size(12)
                                .text_color(thinking ? t.working : t.dim)
                            )
                            .child(
                              div()
                                .flex_1()
                                .min_w(0)
                                .truncate()
                                .text_size(12)
                                .text_color(t.dim)
                                .child(
                                  thinking
                                    ? line ? `Thinking — ${line}` : "Thinking…"
                                    : line ? `Thought · ${line}` : "Thought"
                                )
                            )
                            .child(
                              svg(
                                thoughtOpen
                                  ? "mods/agent-chat/icons/chevron-down.svg"
                                  : "mods/agent-chat/icons/chevron-right.svg"
                              )
                                .size(11)
                                .text_color(t.dim)
                            )
                        )
                        .when(thoughtOpen, (el) =>
                          el.child(thinkingBox(thought.text, `think-${thoughtKey}`))
                        );
                    }),
                  ...block.tools.map((tool, toolIndex) => {
                    // Each call opens on its own; output stays folded until asked for.
                    const toolKey = `${block.ekey}:tool${toolIndex}`;
                    const toolOpen = this.expanded.has(toolKey);
                    return v_flex()
                      .w_full()
                      .child(
                        h_flex()
                          .id(`tool-${toolKey}`)
                          .items_center()
                          .gap(8)
                          .py(2)
                          .when(Boolean(tool.detail), (el) =>
                            el.cursor_pointer().on_click((_e, cx) => {
                              cx.stop_propagation();
                              if (this.expanded.has(toolKey)) this.expanded.delete(toolKey);
                              else this.expanded.add(toolKey);
                              cx.notify();
                            })
                          )
                          .child(
                            tool.status === "running"
                              ? svg("mods/agent-chat/icons/refresh.svg").size(11).text_color(t.working)
                              : svg(toolActionIcon(tool.action || "other"))
                                  .size(12)
                                  .text_color(tool.status === "error" || tool.hasFailure ? errColor : t.dim)
                          )
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .truncate()
                              .text_size(12)
                              .font_family(monoFont)
                              .text_color(tool.status === "error" || tool.hasFailure ? errColor : t.dim)
                              .child(tool.title || "Tool")
                          )
                          .when(Boolean(tool.detail), (el) =>
                            el.child(
                              svg(
                                toolOpen
                                  ? "mods/agent-chat/icons/chevron-down.svg"
                                  : "mods/agent-chat/icons/chevron-right.svg"
                              )
                                .size(11)
                                .text_color(t.dim)
                            )
                          )
                      )
                      .when(toolOpen && Boolean(tool.detail), (e) =>
                        e.child(
                          div()
                            .id(`tool-scroll-${toolKey}`)
                            .w_full()
                            .max_h(240)
                            .overflow_y_scrollbar()
                            .child(detailBox(tool.detail))
                        )
                      );
                  }),
                ])
            )
          )
          .when(copied, (el) => el.child(copiedNote()))
      );
    }

    return div();
  }

  /**
   * Opens external HTTP(S) URLs in the browser and internal file links/paths in `file-editor`.
   * @param {string} url
   * @param {any} cx
   */
  handleLinkClick(url, cx) {
    if (!url || typeof url !== "string") return;
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      cx.open_url(trimmed);
      return;
    }
    if (!this.hasFileEditor) return;

    const term = terminals().find((t) => t.address === this.terminal);
    const activeSpace = spaces().find((s) => s.active);
    const cwd = term?.cwd || activeSpace?.folder || "";
    const resolved = resolveInternalFileLink(trimmed, cwd);
    if (!resolved) return;

    const on = terminalMachine(this.terminal) ?? activeSpace?.machine ?? null;
    try {
      const openTabs = shared("file-editor.openTabs") || {};
      const fileKey = resolved.folder ? `${resolved.folder}/${resolved.file}` : resolved.file;
      const existingTabId = openTabs[fileKey]?.tabId;
      if (existingTabId && (activeSpace?.tabs || []).some((tab) => tab.id === existingTabId)) {
        run("tab.select", { id: existingTabId });
        return;
      }

      const tabProps = { folder: resolved.folder, file: resolved.file };
      if (on) tabProps.on = on;
      run("tab.new", { name: resolved.name, mod: "file-editor", props: tabProps });
    } catch (_e) {}
  }

  /**
   * Renders parsed Markdown blocks with real list indentation, headings, code blocks,
   * blockquotes, and tables (since native TextView.markdown only renders inline runs).
   */
  renderMarkdownBlocks(blocks, t, monoFont, path, gap = 10, depth = 0) {
    if (!blocks || blocks.length === 0) return div();
    return v_flex()
      .w_full()
      .gap(gap)
      .children(blocks.map((block, i) => this.renderMarkdownBlock(block, t, monoFont, `${path}.${i}`, depth)));
  }

  renderMarkdownBlock(block, t, monoFont, path, depth = 0) {
    switch (block.type) {
      case "heading": {
        const sizes = { 1: 22, 2: 18, 3: 16, 4: 14.5, 5: 14, 6: 13.5 };
        const sz = sizes[block.level] || 14;
        return div()
          .w_full()
          .min_w(0)
          .font_weight(600)
          .text_size(sz)
          .line_height(`${Math.round(sz * 1.35)}px`)
          .text_color(block.level === 6 ? t.dim : t.foreground)
          .when(block.level <= 2, (el) => el.border_b(1).border_color(withAlpha(t.border, "80")).pb(4))
          .child(
            TextView.markdown(path, block.text || "")
              .selectable(true)
              .on_link_click((url, cx) => this.handleLinkClick(url, cx))
          );
      }
      case "paragraph": {
        if (!block.text || !block.text.trim()) return div();
        return div()
          .w_full()
          .min_w(0)
          .text_size(14)
          .line_height("22px")
          .text_color(t.foreground)
          .child(
            TextView.markdown(path, block.text)
              .selectable(true)
              .on_link_click((url, cx) => this.handleLinkClick(url, cx))
          );
      }
      case "code": {
        const codeText = block.text || "";
        const lines = codeText.split("\n");
        const codeKey = `${path}.code`;
        const copied = this.copiedKey === codeKey;
        // A code block is its own copy unit: the copy control and a secondary
        // click both take the snippet, not the whole reply around it. Inside
        // the block's horizontal scroller the row's secondary-click handler is
        // not guaranteed to run, so the handler lives on the block itself.
        const copyCode = (cx) => {
          if (!codeText) return;
          cx.stop_propagation();
          this.copy(codeText, codeKey, cx);
        };
        return v_flex()
          .w_full()
          .rounded(8)
          .bg(t.raised)
          .border_1()
          .border_color(withAlpha(t.border, "70"))
          .overflow_hidden()
          .on_mouse_down("right", (_e, cx) => copyCode(cx))
          .child(
            h_flex()
              .w_full()
              .items_center()
              .gap(8)
              .px(10)
              .pt(8)
              .pb(2)
              .when(Boolean(block.lang), (el) =>
                el.child(
                  div()
                    .font_family(monoFont)
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(block.lang)
                )
              )
              .child(
                h_flex()
                  .id(`code-copy-${codeKey}`)
                  .flex_none()
                  .items_center()
                  .gap(4)
                  .px(6)
                  .py(2)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => copyCode(cx))
                  .child(
                    svg(copied ? "mods/agent-chat/icons/check.svg" : "mods/agent-chat/icons/copy.svg")
                      .size(11)
                      .text_color(copied ? t.done : t.dim)
                  )
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(copied ? t.done : t.dim)
                      .child(copied ? "Copied" : "Copy")
                  )
              )
          )
          .child(
            v_flex()
              .w_full()
              .px(10)
              .pb(10)
              .items_start()
              .overflow_x_scroll()
              .child(
                v_flex()
                  .font_family(monoFont)
                  .text_size(12.5)
                  .line_height("19px")
                  .text_color(t.foreground)
                  .children(lines.map((line) => div().whitespace_nowrap().child(line === "" ? " " : line)))
              )
          );
      }
      case "image":
        return this.renderImageRef({ alt: block.alt || "", src: block.src || "" }, t, monoFont);
      case "hr":
        return div().w_full().h(1).my(4).bg(withAlpha(t.border, "80"));
      case "quote":
        return h_flex()
          .w_full()
          .gap(12)
          .child(div().w(3).h_full().flex_none().rounded(2).bg(t.dim))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .text_color(t.dim)
              .child(this.renderMarkdownBlocks(block.blocks || [], t, monoFont, path, 8, depth))
          );
      case "list": {
        const bullets = ["•", "◦", "▪"];
        const bullet = bullets[depth % bullets.length];
        return v_flex()
          .w_full()
          .gap(4)
          .pl(8)
          .children(
            (block.items || []).map((item, i) => {
              const marker =
                item.checked !== null
                  ? div()
                      .w(14)
                      .h(14)
                      .mt(4)
                      .flex_none()
                      .rounded(3)
                      .border_1()
                      .border_color(item.checked ? t.accent : t.border)
                      .when(item.checked, (el) =>
                        el
                          .bg(t.accent)
                          .flex()
                          .items_center()
                          .justify_center()
                          .child(div().text_size(10).text_color(t.background || "#fff").child("✓"))
                      )
                  : div()
                      .w(block.ordered ? 22 : 12)
                      .flex_none()
                      .text_size(14)
                      .line_height("22px")
                      .text_color(t.dim)
                      .child(block.ordered ? `${block.start + i}.` : bullet);
              return h_flex()
                .w_full()
                .items_start()
                .gap(6)
                .child(marker)
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .child(this.renderMarkdownBlocks(item.blocks || [], t, monoFont, `${path}.${i}`, 4, depth + 1))
                );
            })
          );
      }
      case "table": {
        const cols = Math.max(1, (block.header || []).length);
        const renderTableRow = (cells, rowIdx, isHeader) =>
          h_flex()
            .w_full()
            .when(isHeader, (el) => el.bg(t.raised))
            .when(!isHeader && rowIdx > 1, (el) => el.border_t(1).border_color(t.border))
            .children(
              Array.from({ length: cols }, (_, c) => {
                const align = block.align?.[c] || "left";
                const content = cells[c] ?? "";
                return div()
                  .flex_1()
                  .min_w(0)
                  .px(10)
                  .py(5)
                  .when(c < cols - 1, (el) => el.border_r(1).border_color(t.border))
                  .child(
                    h_flex()
                      .w_full()
                      .when(align === "right", (el) => el.justify_end())
                      .when(align === "center", (el) => el.justify_center())
                      .child(
                        div()
                          .min_w(0)
                          .text_size(13)
                          .line_height("20px")
                          .text_color(t.foreground)
                          .when(isHeader, (el) => el.font_weight(600))
                          .child(
                            content.trim()
                              ? TextView.markdown(`${path}.r${rowIdx}.c${c}`, content)
                                  .selectable(true)
                                  .on_link_click((url, cx) => this.handleLinkClick(url, cx))
                              : ""
                          )
                      )
                  );
              })
            );
        return div()
          .w_full()
          .overflow_x_scroll()
          .child(
            v_flex()
              .min_w(320)
              .border_1()
              .border_color(t.border)
              .rounded(6)
              .overflow_hidden()
              .child(renderTableRow(block.header || [], 0, true))
              .children((block.rows || []).map((cells, r) => renderTableRow(cells, r + 1, false)))
          );
      }
      default:
        return div();
    }
  }

  /**
   * A Markdown image in a reply. The native Markdown view draws none, and the
   * host only loads images from the app's own folder, so the reference shows
   * as an attachment row: what it is, and where it lives.
   * @param {{alt: string, src: string}} img
   * @param {any} t theme
   * @param {string} monoFont
   */
  renderImageRef(img, t, monoFont) {
    const name = basename(img.src.split("?")[0]) || img.src;
    return h_flex()
      .w_full()
      .pt(10)
      .pb(6)
      .child(
        h_flex()
          .max_w_full()
          .items_center()
          .gap(8)
          .px(10)
          .py(6)
          .rounded(8)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .when(this.hasFileEditor, (el) =>
            el
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.handleLinkClick(img.src, cx);
              })
          )
          .child(svg("mods/agent-chat/icons/paperclip.svg").size(13).flex_none().text_color(t.dim))
          .child(
            div()
              .flex_none()
              .text_size(12.5)
              .text_color(t.foreground)
              .child(img.alt || name)
          )
          .child(
            div()
              .min_w(0)
              .truncate()
              .text_size(11)
              .font_family(monoFont)
              .text_color(t.dim)
              .child(img.src)
          )
      );
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

  /** A pill that loads one page of older turns above the window or fetches from transcript/CLI. */
  renderLoadEarlier(t, cx, mode = "memory") {
    const label = this._cliFetching
      ? "Loading earlier from terminal…"
      : this._transcriptFetching
      ? "Loading earlier messages…"
      : mode === "cli"
      ? "Load earlier from terminal"
      : "Load earlier messages";
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
          .on_click((_e, cx) => {
            if (mode === "memory") this.loadEarlier(cx);
            else if (mode === "transcript") this.fetchEarlierFromTranscript(cx);
            else this.fetchEarlierFromCli(cx);
          })
          .child(svg("mods/agent-chat/icons/arrow-up.svg").size(12).text_color(t.dim))
          .child(div().text_size(12).text_color(t.dim).child(label))
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
   * The scrolling feed. Rows are laid out top-to-bottom in a deterministic
   * viewport anchored by `scrollFromBottom` (`0` = pinned to live tail).
   * Scrolling up freezes the window and lazy-loads older batches as needed.
   */
  renderFeed(t, monoFont, cx) {
    if (this.blocks.length === 0) return this.renderEmptyFeed(t);
    const { visible, start, maxScroll } = this.currentFeedLayout();
    const scrollY = this.pinned ? maxScroll : Math.max(0, Math.min(maxScroll, this.scrollY || 0));
    this.scrollY = scrollY;
    this.scrollFromBottom = Math.max(0, maxScroll - scrollY);

    const children = [];
    const canFetchTranscript = Boolean(this.transcript?.hasEarlier) && !this.demo;
    // Live switch notices before a session exists are not screen history.
    const onlyNotices = this.blocks.every((block) => block.type === "notice");
    const canFetchCli =
      !this.transcript?.path && !this.transcript?.sessionId && !this._cliExhausted && !this.demo && !onlyNotices;
    if (start > 0) children.push(this.renderLoadEarlier(t, cx, "memory"));
    else if (canFetchTranscript) children.push(this.renderLoadEarlier(t, cx, "transcript"));
    else if (canFetchCli) children.push(this.renderLoadEarlier(t, cx, "cli"));
    children.push(div().w_full().h(12));
    for (let i = 0; i < visible.length; i++) {
      children.push(this.feedRow(visible[i], t, monoFont));
    }
    children.push(div().w_full().h(24));

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
          .overflow_hidden()
          .on_size_change((size, cx) => this.onFeedResize(size, cx))
          .on_scroll_wheel((e, cx) => this.onFeedWheel(e, cx))
          .child(
            v_flex()
              .id("chat-feed-content")
              .relative()
              .top(-scrollY)
              .w_full()
              .on_size_change((size, cx) => this.onContentResize(size, cx))
              .children(children)
          )
          .when(!this.pinned && this.scrollFromBottom > 12, (el) => el.child(this.renderScrollPill(t, cx)))
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
    const agent = findAgent(this.terminal);
    const agentName = agentDisplayName(agent, this.terminal);
    const wsName = this.workspaceName();

    return v_flex()
      .id("chat-empty-feed")
      .flex_1()
      .min_h(0)
      .items_center()
      .justify_center()
      .gap(12)
      .child(iconFor(agent?.program, 32, t.dim))
      .child(
        div()
          .text_size(20)
          .font_semibold()
          .text_color(t.foreground)
          .child(`${agentName} · ${wsName}`)
      )
      .child(
        div()
          .text_size(13)
          .text_color(t.dim)
          .child(
            this.terminal && this._readFor !== this.terminal
              ? "Loading conversation…"
              : this.status === "blocked" || this.screenChoice()
              ? "The agent is waiting on the prompt below."
              : "Send a message to start the conversation."
          )
      );
  }

  /**
   * Watches the screen footer (Antigravity, Codex) for a model or effort
   * switch and keeps "Model set to …" / "Effort set to …" notices for it. The
   * notices live only until the next user turn reaches the transcript, which
   * by then carries the switch itself.
   * @param {Array<object>} blocks transcript blocks of this poll
   * @param {{model?: string|null, effort?: string|null}|null} seen footer reading
   * @returns {boolean} true when the live notices changed
   */
  trackScreenSwitch(blocks, seen) {
    const users = blocks.filter((block) => block.type === "user").length;
    let state = this._screenSwitch;
    if (!state || state.terminal !== this.terminal) {
      state = this._screenSwitch = { terminal: this.terminal, model: null, effort: null, users, notices: [] };
    }
    let changed = false;
    if (users !== state.users) {
      state.users = users;
      if (state.notices.length) {
        state.notices = [];
        changed = true;
      }
    }
    // An unreadable footer (picker open, redraw) is not a switch.
    if (!seen?.model) return changed;
    const effort = seen.effort ? String(seen.effort).toLowerCase() : null;
    if (state.model && seen.model.toLowerCase() !== state.model.toLowerCase()) {
      state.notices.push({ type: "notice", tone: "info", text: `Model set to ${seen.model}` });
      changed = true;
    } else if (state.model && effort && effort !== state.effort) {
      state.notices.push({ type: "notice", tone: "info", text: `Effort set to ${effort}` });
      changed = true;
    }
    state.model = seen.model;
    state.effort = effort;
    return changed;
  }

  /** `{ model, effort }` display names; either may be null when it cannot be told. */
  currentModelInfo() {
    // A demo has no terminal behind it; the composer still names a model so
    // the preview looks like a real session.
    if (this.demo) return { model: "Claude Opus 5.5", effort: "high" };
    const agent = findAgent(this.terminal);
    const app = agentApp(agent);
    if (app === "codex") {
      const state = this.currentCodexModelInfo();
      const known = this.codexModels.find((m) => m.slug === state?.model);
      return { model: known?.display_name || state?.model || null, effort: effortLabel(state?.effort) };
    }
    if (app === "claude-code") {
      const seen = parseScreenModel(this.rawText, "claude-code");
      const tr = this.transcript instanceof ClaudeTranscript && this.transcript.terminal === this.terminal
        ? this.transcript
        : null;
      const pending = this.activeClaudePending();
      const pendingModel = pending?.model
        ? this.claudeModels.find((m) => m.id === pending.model)?.label || claudeModelLabel(pending.model, this.claudeModels)
        : null;
      return {
        model: pendingModel || claudeModelLabel(tr?.model, this.claudeModels) || seen?.model || null,
        effort: effortLabel(pending?.effort || tr?.effort || seen?.effort),
      };
    }
    if (app === "antigravity" || app === "agy") {
      const tr = this.transcript instanceof AntigravityTranscript && this.transcript.terminal === this.terminal
        ? this.transcript
        : null;
      const agyScreen = parseScreenModel(this.rawText, "antigravity");
      const families = groupAntigravityModels(this.agyModels);
      if (this.agyPendingModel?.terminal === this.terminal) {
        const pending = this.agyPendingModel;
        const parsed = parseAntigravityModel(pending.id);
        const fam = families.find((f) => f.id === parsed.familyId || f.id === pending.id);
        const pendingLabel = fam?.label || prettyModel(parsed.familyId) || pending.id;
        const screenMatches =
          Boolean(agyScreen?.model) &&
          agyScreen.model.toLowerCase() === pendingLabel.toLowerCase() &&
          (!parsed.effort || (agyScreen.effort || "").toLowerCase() === parsed.effort.toLowerCase());
        const expired = Date.now() - (pending.at || 0) > 10_000;
        if ((tr && tr.model === pending.id) || screenMatches || expired) {
          this.agyPendingModel = null;
        } else {
          return {
            model: pendingLabel,
            effort: effortLabel(parsed.effort || tr?.effort || null),
          };
        }
      }
      if (agyScreen?.model) {
        return { model: agyScreen.model, effort: effortLabel(agyScreen.effort) };
      }
      if (tr?.model) {
        const parsed = parseAntigravityModel(tr.model);
        const fam = families.find(
          (f) => f.id === parsed.familyId || f.id === tr.model || f.label.toLowerCase() === tr.model.toLowerCase()
        );
        return {
          model: fam?.label || prettyModel(parsed.familyId) || tr.model,
          effort: effortLabel(parsed.effort || tr.effort),
        };
      }
      return { model: null, effort: null };
    }
    if (app === "opencode") {
      const tr = this.transcript instanceof OpenCodeTranscript && this.transcript.terminal === this.terminal
        ? this.transcript
        : null;
      const known = this.currentOpenCodeModel();
      const seen = this.openCodeFooter();
      // Before the first session row exists the TUI footer is the only
      // source; it names the model as "<name> <provider>", so resolve it
      // against the catalogue instead of showing the raw label.
      const model = known?.name || tr?.modelLabel || seen?.model || null;
      if (!model) return { model: null, effort: null };
      return { model, effort: effortLabel(tr?.effort || seen?.effort) };
    }
    const seen = parseScreenModel(this.rawText, app || "");
    return { model: seen?.model || null, effort: effortLabel(seen?.effort) };
  }

  /** Returns the current Codex terminal snapshot without reading another terminal’s cache. */
  currentCodexScreen() {
    return this.codexModelScreen?.terminal === this.terminal ? this.codexModelScreen.text : this.rawText;
  }

  /** Uses the live Codex state because the transcript reflects the last turn. */
  currentCodexModelInfo() {
    const screen = this.currentCodexScreen();
    const live = codexScreenModel(screen, this.codexModels);
    if (live) return live;
    const tr = this.transcript;
    if (tr instanceof CodexTranscript && tr.terminal === this.terminal && tr.model) {
      const known = this.codexModels.find((m) => m.slug === tr.model);
      return { model: tr.model, effort: tr.effort || known?.default_reasoning_level || null };
    }
    return parseScreenModel(screen, "codex");
  }

  /** The model's display name, or null when it cannot be told. */
  currentModel() {
    return this.currentModelInfo().model;
  }

  /** Closes the model menu and clears any active search query. */
  closeModelMenu() {
    this.modelMenuOpen = false;
    this.modelSearch?.set_value("");
  }

  /** Switches Antigravity's model optimistically and sends `/model <id>`. */
  switchAntigravityModel(targetId, cx) {
    if (this.terminal && targetId) {
      this.agyPendingModel = { terminal: this.terminal, id: targetId, at: Date.now() };
    }
    this.chooseModel(`/model ${targetId}`, cx);
  }

  /** Closes the picker and prevents its terminal command from consuming an attached image. */
  beginModelSelection(cx) {
    this.closeModelMenu();
    cx.notify();
    if (!this.terminal || this.codexSwitching) return false;
    if (this.attached > 0) {
      this.notice = "Send or clear the attached image before switching models.";
      cx.notify();
      cx.timer.after(4000, (cx) => {
        this.notice = null;
        cx.notify();
      });
      return false;
    }
    return true;
  }

  /** Remembers a Claude `/model` or `/effort` choice so the UI shows it before the transcript confirms. */
  setClaudePending(command) {
    const m = /^\/(model|effort)\s+(\S+)$/.exec(command);
    const tr = this.transcript;
    if (!m || !this.terminal || !(tr instanceof ClaudeTranscript)) return;
    const prev = this.claudePending?.terminal === this.terminal ? this.claudePending : {};
    this.claudePending = {
      terminal: this.terminal,
      model: prev.model,
      effort: prev.effort,
      [m[1]]: m[2],
      base: { model: tr.model, effort: tr.effort },
      at: Date.now(),
    };
  }

  /** The pending Claude choice, or null once confirmed by the transcript or after 10 s. */
  activeClaudePending() {
    const p = this.claudePending;
    if (!p) return null;
    const tr = this.transcript instanceof ClaudeTranscript && this.transcript.terminal === p.terminal ? this.transcript : null;
    const confirmed = tr && ((p.model && tr.model !== p.base.model) || (p.effort && tr.effort !== p.base.effort));
    if (p.terminal !== this.terminal || confirmed || Date.now() - p.at > 10_000) {
      this.claudePending = null;
      return null;
    }
    return p;
  }

  /** Switches models the way the agent itself does: a slash command typed into it. */
  chooseModel(command, cx) {
    if (!this.beginModelSelection(cx)) return;
    this.setClaudePending(command);
    cx.spawn(async (cx) => {
      try {
        await this.sendTextToTerminal(command);
        await this.update(cx);
        // Claude confirms in its transcript a moment later: re-read quickly instead of waiting for the 1 s poll.
        for (let i = 0; i < 6 && this.claudePending; i++) {
          await new Promise((resolve) => cx.timer.after(300, resolve));
          await this.update(cx);
        }
      } catch (err) {
        this.flashNotice(err, cx);
      }
      cx.notify();
    });
  }

  /**
   * Applies a session-only Codex choice using the inline `/model` command.
   * @param {object} model Codex app-server catalogue entry
   * @param {string|null} effort
   * @param {any} cx
   * @param {boolean} [effortOnly=false] Keep the model already selected in Codex.
   */
  switchCodexModel(model, effort, cx, effortOnly = false) {
    if (!this.beginModelSelection(cx)) return;
    const terminal = this.terminal;
    const models = this.codexModels;
    this.codexSwitching = true;
    cx.spawn(async (cx) => {
      try {
        const text = await applyCodexModel({
          model,
          models,
          effort,
          effortOnly,
          wait: (ms) => new Promise((resolve) => cx.timer.after(ms, resolve)),
          send: (command) => this.sendTextToTerminal(command, { terminal }),
          read: async () => {
            const res = await hcOrThrow(["read", terminal, "--lines", "0", "--json"]);
            return JSON.parse(res.stdout)?.text || "";
          },
        });
        if (this.terminal === terminal) {
          this.codexModelScreen = { terminal, text };
          await this.update(cx);
        }
      } catch (err) {
        if (this.terminal === terminal) this.flashNotice(err, cx);
      } finally {
        this.codexSwitching = false;
        cx.notify();
      }
    });
  }

  /** Discovers models and capabilities by running the active harness's own command. */
  refreshModels(cx, force = false) {
    const terminal = this.terminal;
    if (this.modelsTerminal !== this.terminal) {
      this.modelsTerminal = this.terminal;
      this.modelsAt = 0;
    }
    if (this.modelsLoading) return;
    if (!force && this.modelsAt && Date.now() - this.modelsAt < 60_000) return;
    const app = agentApp(findAgent(this.terminal));
    if (!app) return;
    this.modelsLoading = true;
    cx.notify();
    const on = terminalMachine(this.terminal) ?? spaces().find((s) => s.active)?.machine ?? null;
    cx.spawn(async (cx) => {
      try {
        if (app === "claude-code") {
          const cmd =
            'printf \'{"type":"control_request","request_id":"1","request":{"subtype":"initialize"}}\\n\' | claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --bare 2>/dev/null';
          const res = await exec("sh", ["-lc", cmd], { on });
          if (res.code === 0 && res.stdout) {
            const parsed = parseClaudeModelsResponse(res.stdout);
            if (parsed.length > 0) this.claudeModels = parsed;
          }
        } else if (app === "opencode") {
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
        } else if (app === "codex") {
          const cmd =
            '(printf \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr","version":"1.0"}}}\\n{"jsonrpc":"2.0","method":"initialized"}\\n{"jsonrpc":"2.0","id":2,"method":"model/list","params":{}}\\n\'; sleep 0.5) | codex app-server 2>/dev/null';
          const res = await exec("sh", ["-lc", cmd], { on });
          if (res.code === 0 && res.stdout && terminal === this.terminal) {
            const parsed = parseCodexModelsResponse(res.stdout);
            if (parsed.length > 0) this.codexModels = parsed;
            this.codexCatalogueVersion = { terminal, value: codexAppServerVersion(res.stdout) };
          }
        } else if (app === "antigravity" || app === "agy") {
          const res = await exec("sh", ["-lc", "agy models 2>/dev/null"], { on });
          if (res.code === 0 && res.stdout.trim()) {
            const parsed = parseAntigravityModelsOutput(res.stdout);
            if (parsed.length > 0) this.agyModels = parsed;
          }
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

  /**
   * The model and effort in the OpenCode TUI footer. While a picker or the
   * command palette covers the screen the footer cannot be read; the last
   * reading of this terminal stands in so the composer never drops to "Model".
   * @returns {{model: string|null, effort: string|null}|null}
   */
  openCodeFooter() {
    // Render asks several times per frame; parse each screen text once.
    const cache = this._openCodeFooter;
    if (cache?.terminal === this.terminal && cache.text === this.rawText) return cache.seen;
    const parsed = parseScreenModel(this.rawText, "opencode");
    const seen = parsed?.model ? parsed : cache?.terminal === this.terminal ? cache.seen : null;
    this._openCodeFooter = { terminal: this.terminal, text: this.rawText, seen };
    return seen;
  }

  /** The catalogue entry of the OpenCode session's current model, or null. */
  currentOpenCodeModel() {
    const tr = this.transcript instanceof OpenCodeTranscript && this.transcript.terminal === this.terminal
      ? this.transcript
      : null;
    if (!tr && agentApp(findAgent(this.terminal)) !== "opencode") return null;
    if (tr?.model) {
      const exact =
        this.models.find((m) => m.modelID === tr.model && (!tr.provider || m.providerID === tr.provider)) ||
        this.models.find((m) => m.modelID === tr.model);
      if (exact) return exact;
    }
    // No session row yet (a fresh TUI): the footer still names the model and
    // the catalogue knows its variants, so effort stays selectable.
    const seen = this.openCodeFooter();
    return resolveOpenCodeModel(this.models, this.providers, tr?.model || seen?.model, tr?.provider || null);
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
      // Before the first prompt there is no session row; the footer has it.
      const current =
        (this.transcript instanceof OpenCodeTranscript ? this.transcript.effort : null) || this.openCodeFooter()?.effort || null;
      variant = current && (model.variants || []).some((v) => v.id === current) ? current : null;
    }
    this.closeModelMenu();
    cx.notify();
    const session =
      this.transcript instanceof OpenCodeTranscript && this.transcript.terminal === this.terminal
        ? this.transcript.sessionId
        : null;
    if (!session) {
      this.switchOpenCodeModelInPicker(model, variant, cx);
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
        // The server accepted it: show it now. The next poll reads the same
        // values back from `session_v2` along with the switch notice.
        const tr = this.transcript;
        if (tr instanceof OpenCodeTranscript && tr.sessionId === session) {
          tr.model = model.modelID;
          tr.provider = model.providerID || null;
          tr.effort = variant || null;
        }
        cx.notify();
        cx.spawn(async (cx) => this.update(cx));
      } catch (err) {
        this.notice = `Could not switch model: ${err instanceof Error ? err.message : String(err)}`;
      }
      cx.notify();
    });
  }

  /**
   * Switches a fresh OpenCode TUI (no session row yet, so no API session to
   * address) by driving its native pickers:
   * - another model: `/models` opens "Select model"; typing "<name> <provider>"
   *   filters it and Enter picks the first match. A model with variants then
   *   opens "Select variant", answered the same way.
   * - same model (effort only), or a model pick that skipped "Select variant"
   *   (OpenCode remembers each model's last variant): `ctrl+t` ("Variant
   *   cycle") steps through the variants until the footer shows the target.
   * Text is only typed once the expected picker is on screen, so nothing lands
   * in the prompt as a message. The footer is read back to confirm the result.
   * @param {any} model catalogue entry
   * @param {string|null} variant effort, or null for the model default
   * @param {any} cx
   */
  switchOpenCodeModelInPicker(model, variant, cx) {
    if (!this.beginModelSelection(cx)) return;
    const terminal = this.terminal;
    const current = this.currentOpenCodeModel();
    const sameModel = current?.modelID === model.modelID && current?.providerID === model.providerID;
    const hasVariants = Array.isArray(model.variants) && model.variants.length > 0;
    // An effort the model does not offer would match nothing in its picker.
    if (variant && !(model.variants || []).some((v) => v.id === variant)) variant = null;
    const screen = async () => {
      const res = await hc(["read", terminal, "--lines", "0", "--json"]);
      return res.code === 0 && res.stdout ? JSON.parse(res.stdout)?.text || "" : "";
    };
    // Polls the screen until `test` holds, for up to ~2.4 s. Timers go
    // through the spawned task's own `cx`; the caller's is gone by then.
    const until = async (cx, test, tries = 24) => {
      for (let i = 0; i < tries; i++) {
        await new Promise((resolve) => cx.timer.after(100, resolve));
        const text = await screen();
        if (test(text)) return text;
      }
      return null;
    };
    const footerOf = (text) => parseScreenModel(text, "opencode");
    // The footer already shows the wanted model and effort (OpenCode keeps a
    // model's last variant and then skips "Select variant").
    const done = (text) => {
      if (/Select (?:model|variant)|Commands/.test(text)) return false;
      const seen = footerOf(text);
      const picked = seen?.model ? resolveOpenCodeModel(this.models, this.providers, seen.model) : null;
      return picked?.modelID === model.modelID && (seen.effort || null) === (hasVariants ? variant || null : seen.effort || null);
    };
    // Typed as key presses, not `hc send`: a send waits ~5 s to see whether
    // the text started a turn, which a picker search never does.
    const type = (text) => hcOrThrow(["keys", terminal, ...pickerKeys(text), "enter"]);
    cx.spawn(async (cx) => {
      try {
        let variantOpen = false;
        if (!sameModel) {
          // ctrl+x m is OpenCode's "Switch model"; unlike typing `/models` it
          // leaves a half-written prompt alone.
          await hcOrThrow(["keys", terminal, "ctrl+x", "m"]);
          if (!(await until(cx, (text) => /Select model/.test(text)))) throw new Error("OpenCode model picker did not open");
          // Each key costs ~45 ms: name the provider only when another one
          // offers a model of the same name.
          const name = model.name || model.modelID;
          const shared = this.models.filter((m) => (m.name || m.modelID) === name).length > 1;
          const provider = shared ? this.providers?.[model.providerID] || model.providerID || "" : "";
          await type(`${name} ${provider}`.trim());
          if (hasVariants) {
            // "Select variant" opens a moment after the model picker closes,
            // so a bare footer in between is not an answer yet.
            const text = await until(cx, (text) => /Select variant/.test(text) || done(text), 4);
            variantOpen = Boolean(text && /Select variant/.test(text));
          }
        }
        if (hasVariants && !variantOpen && !done(await screen())) {
          // ctrl+t is OpenCode's "Variant cycle" (default → each variant →
          // default). One key per step and nothing typed into the TUI, so it
          // beats the command palette; stop once the footer shows the target.
          const want = variant || null;
          let reached = false;
          for (let step = 0; step <= model.variants.length && !reached; step++) {
            const before = footerOf(await screen())?.effort || null;
            if (before === want) {
              reached = true;
              break;
            }
            await hcOrThrow(["keys", terminal, "ctrl+t"]);
            await until(cx, (text) => (footerOf(text)?.effort || null) !== before, 6);
          }
          if (!reached && (footerOf(await screen())?.effort || null) !== want) {
            throw new Error(`OpenCode effort ${effortLabel(want) || "Default"} not reached`);
          }
        }
        if (variantOpen) await type(variant || "Default");
        const footer = await until(
          cx,
          // Closed and redrawn: a frame mid-redraw has no footer yet.
          (text) => !/Select (?:model|variant)/.test(text) && Boolean(footerOf(text)?.model)
        );
        if (!footer) {
          await hc(["keys", terminal, "esc"]);
          throw new Error("OpenCode picker did not close");
        }
        this.rawText = footer;
        const seen = footerOf(footer);
        const picked = resolveOpenCodeModel(this.models, this.providers, seen?.model);
        if (picked && picked.modelID !== model.modelID) throw new Error(`OpenCode picked ${picked.name || picked.modelID}`);
        const name = model.name || model.modelID;
        this.notice = variant ? `${name} · ${effortLabel(variant)} selected` : `${name} selected`;
        cx.timer.after(2500, (cx) => {
          this.notice = null;
          cx.notify();
        });
        cx.notify();
        // The badge reads the footer just stored; the full refresh (transcript,
        // switch notice) takes seconds and runs on its own.
        cx.spawn(async (cx) => this.update(cx));
      } catch (err) {
        this.flashNotice(`Could not switch model: ${err instanceof Error ? err.message : String(err)}`, cx);
      }
      cx.notify();
    });
  }

  /**
   * Two-column Model & Reasoning Effort Popover. `maxH` keeps the floating
   * menu inside the room left above the composer.
   */
  renderModelMenu(t, cx, maxH = 420) {
    const agent = findAgent(this.terminal);
    const term = terminals().find((x) => x.address === this.terminal);
    const agentName = agent?.title || agent?.program?.name || term?.name || this.terminal || "No agent";
    const app = agentApp(agent);
    const isClaude = app === "claude-code";
    const isOpenCode = app === "opencode";
    const isCodex = app === "codex";
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

    const agyFamilies = isAntigravity
      ? groupAntigravityModels(this.agyModels)
      : [];
    // Use the composer selection so a transcript worker cannot override the live preset.
    const currentAgyFamily = currentModelName
      ? agyFamilies.find((family) => family.label === currentModelName || family.id === currentModelName)
      : agyFamilies[0];

    const currentClaudeRawId =
      (isClaude && this.activeClaudePending()?.model) ||
      (this.transcript instanceof ClaudeTranscript && this.transcript.terminal === this.terminal
        ? this.transcript.model
        : null);
    const currentClaudeModel = isClaude
      ? findClaudeModel(currentClaudeRawId, this.claudeModels) ||
        this.claudeModels.find(
          (m) => currentModelName && (m.label === currentModelName || currentModelName.includes(m.label))
        ) ||
        this.claudeModels[0] ||
        null
      : null;

    const codexState = isCodex ? this.currentCodexModelInfo() : null;
    const currentCodexModel = this.codexModels.find((m) => m.slug === codexState?.model);
    const codexVersion = this.codexCatalogueVersion?.terminal === this.terminal ? this.codexCatalogueVersion.value : null;
    const codexInline = isCodex && codexSupportsInlineModel(this.currentCodexScreen(), codexVersion);

    const totalModelCount = isClaude
      ? this.claudeModels.length
      : isOpenCode
      ? this.models.length
      : codexInline
      ? this.codexModels.length
      : isAntigravity
      ? agyFamilies.length
      : 0;
    const showSearch = totalModelCount > MODEL_SEARCH_THRESHOLD;
    const searchQuery = showSearch ? (this.modelSearch?.value() || "").trim() : "";

    /** @type {any[]} */
    let modelRows = [];
    if (isClaude && this.claudeModels.length > 0) {
      const filtered = this.claudeModels.filter((m) =>
        matchesModelQuery(searchQuery, [m.label, m.id, m.note])
      );
      modelRows = filtered.map((m) =>
        row(
          `model-${m.id}`,
          m.label,
          m.note,
          m.id !== "default" && Boolean(currentClaudeModel && currentClaudeModel.id === m.id),
          (_e, cx) => this.chooseModel(`/model ${m.id}`, cx)
        )
      );
      if (!searchQuery) {
        modelRows.push(
          row("model-open-native", "More models…", "Open Claude Code's /model picker", false, (_e, cx) =>
            this.chooseModel("/model", cx)
          )
        );
      }
    } else if (isClaude) {
      modelRows = [
        row(
          "model-open-native",
          "Open Claude /model selector",
          this.modelsLoading ? "Discovering models from Claude CLI…" : "Run /model in terminal",
          false,
          (_e, cx) => this.chooseModel("/model", cx)
        ),
      ];
    } else if (isOpenCode && this.models.length > 0) {
      const groups = new Map();
      for (const m of this.models) {
        if (!groups.has(m.providerID)) groups.set(m.providerID, []);
        groups.get(m.providerID).push(m);
      }
      const providerName = (id) => this.providers[id] || id;
      const currentProvider = this.currentOpenCodeModel()?.providerID;
      const order = [...groups.keys()].sort((a, b) => {
        if (a === currentProvider) return -1;
        if (b === currentProvider) return 1;
        return providerName(a).localeCompare(providerName(b));
      });
      const ocCurrent = this.currentOpenCodeModel();
      for (const provider of order) {
        const pName = providerName(provider);
        const entries = groups
          .get(provider)
          .filter((m) => matchesModelQuery(searchQuery, [m.name, m.modelID, pName, provider]))
          .slice()
          .sort((a, b) => (a.name || a.modelID).localeCompare(b.name || b.modelID));
        if (entries.length === 0) continue;
        modelRows.push(
          div().px(10).pt(6).pb(2).text_size(10.5).font_semibold().text_color(t.dim).child(pName)
        );
        for (const m of entries) {
          const isCurrent = ocCurrent
            ? ocCurrent.providerID === m.providerID && ocCurrent.modelID === m.modelID
            : Boolean(currentModelName && (currentModelName === m.name || currentModelName === m.modelID));
          modelRows.push(
            row(
              `model-${provider}-${m.modelID}`,
              m.name || prettyModel(m.modelID) || m.modelID,
              "",
              isCurrent,
              (_e, cx) => this.switchOpenCodeModel(m, cx)
            )
          );
        }
      }
    } else if (codexInline && this.codexModels.length > 0) {
      modelRows = this.codexModels
        .filter((m) => matchesModelQuery(searchQuery, [m.display_name, m.slug, m.description]))
        .map((m) =>
          row(
            `model-${m.slug}`,
            m.display_name || m.slug,
            m.description || "",
            m.slug === currentCodexModel?.slug,
            (_e, cx) => this.switchCodexModel(m, codexModelEffort(m, codexState?.effort), cx)
          )
        );
    } else if (isCodex) {
      modelRows = [
        row(
          "model-open-native",
          "Open Codex /model selector",
          this.modelsLoading ? "Discovering models from Codex…" : "Run /model in terminal",
          false,
          (_e, cx) => this.chooseModel("/model", cx)
        ),
      ];
    } else if (isAntigravity && agyFamilies.length > 0) {
      modelRows = agyFamilies
        .filter((fam) => matchesModelQuery(searchQuery, [fam.label, fam.id, ...Object.values(fam.variants)]))
        .map((fam) => {
          const curEff = (currentEffort || "medium").toLowerCase();
          const targetId = fam.variants[curEff] || fam.variants.medium || fam.variants.default || Object.values(fam.variants)[0] || fam.id;
          return row(
            `model-${fam.id}`,
            fam.label,
            "",
            Boolean(currentAgyFamily && currentAgyFamily.id === fam.id),
            (_e, cx) => this.switchAntigravityModel(targetId, cx)
          );
        });
    } else if (isAntigravity) {
      modelRows = [
        row(
          "model-open-native",
          "Open Antigravity /model selector",
          this.modelsLoading ? "Discovering models from agy…" : "Run /model in terminal",
          false,
          (_e, cx) => this.chooseModel("/model", cx)
        ),
      ];
    } else {
      modelRows = [
        row("model-open-native", "Open native model selector", `Run /models in ${agentName}`, false, (_e, cx) =>
          this.chooseModel("/models", cx)
        ),
      ];
    }

    if (searchQuery && modelRows.length === 0) {
      modelRows = [
        div()
          .px(10)
          .py(12)
          .text_size(12)
          .text_color(t.dim)
          .child(`No models match "${searchQuery}".`),
      ];
    }

    const ocModel = isOpenCode ? this.currentOpenCodeModel() : null;
    const claudeEfforts = isClaude && currentClaudeModel?.efforts?.length
      ? currentClaudeModel.efforts.map((id) => ({ id, label: effortLabel(id), note: null }))
      : [];
    const codexEfforts = codexInline
      ? (currentCodexModel?.supported_reasoning_levels || [])
          .map((l) => l?.effort)
          .filter(Boolean)
          .map((id) => ({ id, label: effortLabel(id), note: null }))
      : [];
    const agyEfforts = isAntigravity && currentAgyFamily?.efforts?.length
      ? currentAgyFamily.efforts.map((id) => ({ id, label: effortLabel(id), note: null }))
      : [];

    const effortOptions = isOpenCode
      ? ocModel?.variants?.length
        ? [
            { id: "default", label: "Default", note: "Model default" },
            ...ocModel.variants.map((v) => ({ id: v.id, label: effortLabel(v.id), note: null })),
          ]
        : []
      : isClaude
      ? claudeEfforts
      : isCodex
      ? codexEfforts
      : isAntigravity
      ? agyEfforts
      : [];
    const pickEffort = (id, cx) => {
      if (isOpenCode) {
        if (ocModel) this.switchOpenCodeModel(ocModel, cx, id === "default" ? null : id);
      } else if (isCodex) {
        if (currentCodexModel) this.switchCodexModel(currentCodexModel, id, cx, true);
      } else if (isAntigravity && currentAgyFamily?.variants?.[id]) {
        this.switchAntigravityModel(currentAgyFamily.variants[id], cx);
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
      .max_h(maxH)
      .rounded(16)
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .overflow_hidden()
      .child(
        h_flex()
          .w_full()
          .h(Math.min(340, Math.max(160, maxH - 2)))
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
              .child(
                div()
                  .flex_none()
                  .px(8)
                  .pt(4)
                  .pb(6)
                  .text_size(10.5)
                  .font_semibold()
                  .text_color(t.dim)
                  .child("MODELS")
              )
              .when(showSearch, (el) =>
                el.child(
                  h_flex()
                    .flex_none()
                    .items_center()
                    .gap(6)
                    .mx(4)
                    .mb(6)
                    .px(8)
                    .h(28)
                    .rounded(8)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .child(svg("mods/agent-chat/icons/search.svg").size(12).flex_none().text_color(t.dim))
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .child(Input.new(this.modelSearch).w_full().text_size(12).text_color(t.foreground))
                    )
                    .when(Boolean(searchQuery), (bar) =>
                      bar.child(
                        div()
                          .id("model-search-clear")
                          .cursor_pointer()
                          .px(4)
                          .text_size(13)
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.foreground))
                          .on_click((_e, cx) => {
                            this.modelSearch.set_value("");
                            cx.notify();
                          })
                          .child("×")
                      )
                    )
                )
              )
              .child(
                v_flex()
                  .id("model-menu-models-list")
                  .flex_1()
                  .min_h(0)
                  .overflow_y_scrollbar()
                  .children(modelRows)
              )
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
                    .child(this.modelsLoading ? "Loading model details…" : "This model has no effort levels.")
                )
              )
          )
      );
  }

  /**
   * The agent picker / model menu floating above the composer. It is an
   * absolute child of the chat column, so opening it never reserves space or
   * moves the feed: the drawer covers the bottom of the conversation instead.
   */
  renderDrawerOverlay(t, cx) {
    if (!this.pickerOpen && !this.modelMenuOpen) return null;
    const monoFont = settings().font_family ?? "JetBrains Mono";
    // Leave a margin of the feed visible; the menu scrolls its own list.
    const maxH = Math.max(
      180,
      Math.min(420, (this._feedHeight > 0 ? this._feedHeight : 420) - 12)
    );
    const picker = this.pickerOpen
      ? this.renderAgentPicker(t, monoFont, cx, maxH)
      : this.renderModelMenu(t, cx, maxH);
    const composerTop = (this._composerHeight > 0 ? this._composerHeight : 96) + 8;

    return h_flex()
      .id("chat-drawer-overlay")
      .absolute()
      .left(0)
      .right(0)
      .bottom(composerTop)
      .px(16)
      .justify_center()
      .child(
        div()
          .w_full()
          .max_w(COLUMN)
          .rounded(16)
          .border_1()
          .border_color(t.border)
          .overflow_hidden()
          .child(picker)
      );
  }

  /**
   * Main composer surface with the model/effort trigger, primary actions, and
   * the bottom workspace context strip.
   */
  renderComposer(t, cx) {
    const rawVal = this.input.value() || "";
    const hasText = Boolean(rawVal.trim()) || this.attached > 0;
    const working = this.status === "working";

    const approvalCard = this.renderPendingApprovalActions(t, cx);
    const queued = this.currentQueue();
    const pendingSteers = this.currentPendingSteers();
    const pendingTotal = pendingSteers.length + queued.length;
    const isQueueMode = this.sendMode === "queue";

    const currentModelInfo = this.currentModelInfo();

    return v_flex()
      .id("chat-composer-area")
      .w_full()
      .flex_none()
      .items_center()
      .px(16)
      .pt(4)
      .pb(12)
      .bg(t.background)
      .on_size_change((size, cx) => this.onComposerResize(size, cx))
      // Pending approvals card docked above composer
      .when(Boolean(approvalCard), (el) => el.child(approvalCard))
      // Pending steer & queued messages strip docked above composer
      .when(pendingTotal > 0, (el) =>
        el.child(
          v_flex()
            .id("queued-messages-card")
            .w_full()
            .max_w(COLUMN)
            .mb(6)
            .px(12)
            .py(8)
            .gap(4)
            .rounded(12)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .child(
              div()
                .text_size(11)
                .font_semibold()
                .text_color(t.dim)
                .child(pendingSteers.length > 0 ? `Pending (${pendingTotal})` : `Queued (${queued.length})`)
            )
            .children(
              pendingSteers.map((entry, i) => {
                const preview = entry.norm.length > 90 ? `${entry.norm.slice(0, 89)}…` : entry.norm;
                return h_flex()
                  .id(`steer-msg-${i}`)
                  .w_full()
                  .items_center()
                  .justify_between()
                  .gap(8)
                  .px(8)
                  .py(4)
                  .rounded(6)
                  .bg(t.background)
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .text_size(12)
                      .text_color(t.foreground)
                      .child(preview)
                  )
                  .child(
                    h_flex()
                      .flex_none()
                      .items_center()
                      .gap(6)
                      .child(
                        div()
                          .px(6)
                          .py(2)
                          .rounded(4)
                          .text_size(11)
                          .font_medium()
                          .text_color(t.accent)
                          .child("Steering…")
                      )
                      .child(
                        div()
                          .id(`steer-remove-${i}`)
                          .px(4)
                          .cursor_pointer()
                          .text_size(13)
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.ansi1 || "#ef4444"))
                          .on_click((_e, cx) => this.removePendingSteer(i, cx))
                          .child("×")
                      )
                  );
              })
            )
            .children(
              queued.map((msg, i) => {
                const oneLine = msg.replace(/\s+/g, " ").trim();
                const preview = oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine;
                return h_flex()
                  .id(`queued-msg-${i}`)
                  .w_full()
                  .items_center()
                  .justify_between()
                  .gap(8)
                  .px(8)
                  .py(4)
                  .rounded(6)
                  .bg(t.background)
                  .child(
                    div()
                      .id(`queued-edit-${i}`)
                      .flex_1()
                      .min_w(0)
                      .cursor_pointer()
                      .rounded(4)
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => this.editQueued(i, cx))
                      .text_size(12)
                      .text_color(t.foreground)
                      .child(preview)
                  )
                  .child(
                    h_flex()
                      .flex_none()
                      .items_center()
                      .gap(6)
                      .child(
                        div()
                          .id(`queued-steer-${i}`)
                          .px(6)
                          .py(2)
                          .rounded(4)
                          .cursor_pointer()
                          .text_size(11)
                          .font_medium()
                          .text_color(t.accent)
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => this.sendQueuedNow(i, cx))
                          .child("Steer")
                      )
                      .child(
                        div()
                          .id(`queued-remove-${i}`)
                          .px(4)
                          .cursor_pointer()
                          .text_size(13)
                          .text_color(t.dim)
                          .hover((s) => s.text_color(t.ansi1 || "#ef4444"))
                          .on_click((_e, cx) => this.removeQueued(i, cx))
                          .child("×")
                      )
                  );
              })
            )
        )
      )
      // Composer surface card
      .child(
        v_flex()
          .id("chat-composer")
          .w_full()
          .max_w(COLUMN)
          .px(16)
          .pt(10)
          .pb(10)
          .gap(8)
          .rounded(16)
          .bg(t.raised)
          .border_1()
          .border_color(
            this.status === "blocked"
              ? t.blocked
              : this.inputFocused
              ? withAlpha(t.foreground, "40")
              : t.border
          )
          // Top attachment strip
          .when(this.attached > 0, (el) =>
            el.child(
              h_flex()
                .items_center()
                .gap(6)
                .px(8)
                .py(4)
                .rounded(6)
                .bg(t.background)
                .border_1()
                .border_color(t.border)
                .child(
                  div()
                    .text_size(12)
                    .text_color(t.foreground)
                    .child(this.attached === 1 ? "🖼 Image attached" : `🖼 ${this.attached} images attached`)
                )
                .child(
                  div()
                    .id("clear-attachment")
                    .cursor_pointer()
                    .text_size(14)
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.ansi1 || "#ef4444"))
                    .on_click((_e, cx) => {
                      this.attached = 0;
                      cx.notify();
                    })
                    .child("×")
                )
            )
          )
          // Input textarea
          .child(
            Textarea.new(this.input)
              .w_full()
              .min_h(28)
              .text_size(14)
              .text_color(t.foreground)
          )
          // Composer footer controls bar
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .pt(4)
              // Left: Attach & Queue/Steer toggle
              .child(
                h_flex()
                  .items_center()
                  .gap(8)
                  .child(
                    h_flex()
                      .id("composer-attach")
                      .items_center()
                      .gap(4)
                      .px(8)
                      .py(4)
                      .rounded(6)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => this.pasteImage(cx))
                      .child(svg("mods/agent-chat/icons/paperclip.svg").size(14).text_color(t.dim))
                      .child(div().text_size(12).font_medium().text_color(t.dim).child("Attach"))
                  )
                  .child(
                    h_flex()
                      .id("composer-send-mode")
                      .items_center()
                      .gap(4)
                      .px(8)
                      .py(4)
                      .rounded(6)
                      .cursor_pointer()
                      .when(isQueueMode, (el) => el.bg(withAlpha(t.accent, "18")))
                      .hover((s) => s.bg(isQueueMode ? withAlpha(t.accent, "26") : t.hover))
                      .on_click((_e, cx) => this.toggleSendMode(cx))
                      .child(
                        svg(
                          isQueueMode
                            ? "mods/agent-chat/icons/arrow-up.svg"
                            : "mods/agent-chat/icons/corner-up-right.svg"
                        )
                          .size(13)
                          .text_color(isQueueMode ? t.accent : t.dim)
                      )
                      .child(
                        div()
                          .text_size(12)
                          .font_medium()
                          .text_color(isQueueMode ? t.accent : t.dim)
                          .child(isQueueMode ? "Queue" : "Steer")
                      )
                  )
              )
              // Right: Model + Effort trigger & Primary Action button
              .child(
                h_flex()
                  .items_center()
                  .gap(8)
                  // Model + Effort Trigger
                  .child(
                    h_flex()
                      .id("model-picker-trigger")
                      .items_center()
                      .gap(6)
                      .px(10)
                      .h(28)
                      .rounded(8)
                      .cursor_pointer()
                      .when(this.modelMenuOpen, (el) => el.bg(t.hover))
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => {
                        if (this.modelMenuOpen) {
                          this.closeModelMenu();
                        } else {
                          this.modelMenuOpen = true;
                          this.pickerOpen = false;
                          this.refreshModels(cx);
                        }
                        cx.notify();
                      })
                      .child(
                        div()
                          .text_size(12)
                          .font_medium()
                          .text_color(t.foreground)
                          .child(currentModelInfo.model || "Model")
                      )
                      .when(Boolean(currentModelInfo.effort), (el) =>
                        el.child(div().text_size(11.5).text_color(t.dim).child(currentModelInfo.effort))
                      )
                      .child(renderEffortGlyph(currentModelInfo.effort, t, true))
                      .child(svg("mods/agent-chat/icons/chevron-down.svg").size(11).text_color(t.dim))
                  )
                  // Primary Action Button (Stop / Queue / Steer / Send)
                  .child(
                    div()
                      .id(
                        working && !hasText
                          ? "chat-stop"
                          : working && hasText
                          ? isQueueMode
                            ? "chat-queue"
                            : "chat-steer"
                          : "chat-send"
                      )
                      .size(32)
                      .flex()
                      .items_center()
                      .justify_center()
                      .rounded_full()
                      .bg(
                        working && !hasText
                          ? (t.ansi1 || "#ef4444")
                          : working && hasText
                          ? t.accent
                          : hasText
                          ? t.accent
                          : t.hover
                      )
                      .opacity(working || hasText ? 1.0 : 0.38)
                      .cursor_pointer()
                      .hover((s) => s.opacity(0.85))
                      .on_click((_e, cx) => {
                        if (working && !hasText) {
                          this.stop(cx);
                        } else {
                          this.send(cx);
                        }
                      })
                      .child(
                        working && !hasText
                          ? svg("mods/agent-chat/icons/stop.svg").size(14).text_color("#ffffff")
                          : working && hasText
                          ? svg(
                              isQueueMode
                                ? "mods/agent-chat/icons/arrow-up.svg"
                                : "mods/agent-chat/icons/corner-up-right.svg"
                            )
                              .size(14)
                              .text_color("#ffffff")
                          : svg("mods/agent-chat/icons/send.svg")
                              .size(14)
                              .text_color(hasText ? "#ffffff" : t.foreground)
                      )
                  )
              )
          )
      )
      // Bottom context strip
      .child(
        h_flex()
          .id("composer-context-strip")
          .w_full()
          .max_w(COLUMN)
          .pt(6)
          .px(6)
          .gap(8)
          .items_center()
          .justify_between()
          // Left: Agent switcher, Folder & Git Branch
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .items_center()
              .gap(10)
              .child(
                h_flex()
                  .id("agent-picker-trigger")
                  .flex_none()
                  .items_center()
                  .gap(4)
                  .px(6)
                  .py(2)
                  .rounded(6)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.pickerOpen = !this.pickerOpen;
                    this.closeModelMenu();
                    cx.notify();
                  })
                  .child(svg("mods/agent-chat/icons/terminal.svg").size(11.5).flex_none().text_color(t.dim))
                  .child(
                    div()
                      .text_size(11.5)
                      .text_color(t.foreground)
                      .child(this.demo ? "Preview" : this.followFocused ? "Auto" : (this.terminal || "Agent"))
                  )
                  .child(svg("mods/agent-chat/icons/chevron-down.svg").size(10).flex_none().text_color(t.dim))
              )
              .child(
                h_flex()
                  .min_w(0)
                  .items_center()
                  .gap(4)
                  .child(svg("mods/agent-chat/icons/folder.svg").size(12).flex_none().text_color(t.dim))
                  .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.workspaceName()))
              )
              .when(Boolean(this.gitBranch), (el) =>
                el.child(
                  h_flex()
                    .min_w(0)
                    .items_center()
                    .gap(4)
                    .child(svg("mods/agent-chat/icons/git-branch.svg").size(12).flex_none().text_color(t.dim))
                    .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(this.gitBranch))
                )
              )
          )
          // Right: Notice or keyboard hint
          .child(
            div()
              .flex_none()
              .text_size(11)
              .text_color(this.notice ? t.accent : t.dim)
              .child(this.notice || "Enter to send · Shift+Enter newline · Right-click to copy")
          )
      );
  }

  /**
   * Builds every branch once so `herdr-app check` (which has no terminal)
   * validates the whole surface, including rows the feed only builds on
   * screen.
   */
  renderVerificationSample(t, monoFont, cx) {
    const samples = assignKeys([
      { type: "user", text: "test prompt" },
      {
        type: "user",
        text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12",
      },
      { type: "thought", text: "**Analyzing code** to find references.", duration: "1s", summary: "test" },
      { type: "thought", text: "Streaming live thought sentence without heading.", status: "running" },
      { type: "tool", title: "read file", detail: "read content", status: "done", action: "read" },
      { type: "tool", title: "edit file", detail: "diff", status: "done", action: "edit", changedFiles: ["main.js"] },
      { type: "tool", title: "run tests", detail: "exit 0", status: "done", action: "command" },
      { type: "tool", title: "grep search", detail: "match", status: "done", action: "code-search" },
      { type: "tool", title: "web search", detail: "results", status: "done", action: "search" },
      { type: "tool", title: "failed command", detail: "exit 1", status: "error", hasFailure: true, action: "command" },
      { type: "tool", title: "running tool", status: "running", action: "other" },
      {
        type: "tool_group",
        count: 2,
        tools: [
          { title: "t1", detail: "d1", status: "done", action: "edit", changedFiles: ["foo.js"] },
          { title: "t2", status: "error", hasFailure: true, action: "command" },
        ],
        summary: "Changed 1 file and ran 1 command",
        summaryKind: "mixed",
        hasFailure: true,
        changedFiles: ["foo.js"],
        status: "running",
      },
      {
        type: "assistant",
        text: "test **markdown**\n\n| a | b |\n|---|---|\n| 1 | 2 |",
        changedFiles: ["foo.js", "main.js"],
      },
    ]);
    const saved = {
      pickerOpen: this.pickerOpen,
      modelMenuOpen: this.modelMenuOpen,
      known: this.known,
      status: this.status,
      rawText: this.rawText,
      blocks: this.blocks,
      activeDetail: this.activeDetail,
      pinned: this.pinned,
      readingBlocks: this.readingBlocks,
      readingStart: this.readingStart,
      windowStart: this.windowStart,
      hasPending: this.hasPending,
      scrollY: this.scrollY,
      scrollFromBottom: this.scrollFromBottom,
      _contentHeight: this._contentHeight,
      _pendingPrepend: this._pendingPrepend,
      _drawnStatus: this._drawnStatus,
      gitBranch: this.gitBranch,
    };
    const out = [];
    this.pickerOpen = true;
    this.modelMenuOpen = true;
    this.gitBranch = "main";
    if (!this.known || this.known.length === 0) {
      this.known = [{ key: "test-agent", name: "Test Agent", run: ["test"] }];
    }
    this.status = "blocked";
    this.rawText = "Sample raw terminal output\nLine 2";
    this.setBlocks(samples);
    this.windowStart = 0;
    this.readingBlocks = null;
    this.pinned = false;

    out.push(
      this.renderAgentPicker(t, monoFont, cx),
      this.renderModelMenu(t, cx),
      this.renderPendingApprovalActions(t, cx),
      this.renderComposer(t, cx)
    );
    out.push(this.renderDrawerOverlay(t, cx));
    this.pickerOpen = false;
    out.push(this.renderDrawerOverlay(t, cx));
    this.pickerOpen = true;
    out.push(this.renderFeed(t, monoFont, cx), this.renderEmptyFeed(t));

    this.status = "working";
    out.push(this.renderComposer(t, cx));
    out.push(this.renderWorkingBar(t));
    out.push(...this.feedRows().map((b) => this.renderRow(b, t, monoFont)));
    for (const b of samples) this.expanded.add(b.ekey);
    this.copiedKey = samples[0].ekey;
    out.push(...samples.map((b) => this.renderRow(b, t, monoFont)));
    for (const b of samples) this.expanded.delete(b.ekey);
    this.copiedKey = null;

    Object.assign(this, saved);
    return v_flex().children(out.filter(Boolean));
  }

  /**
   * Marks the connected terminal as read in Herdr when it is in "done" state,
   * then restores focus back to this chat pane (and composer if it was focused).
   * @param {any} cx
   * @param {{ restoreInput?: boolean }} [opts]
   */
  markTerminalRead(cx, { restoreInput = false } = {}) {
    if (!this.terminal || this.demoMode || this._markingRead) return;
    const agent = agents().find((a) => a.address === this.terminal);
    if (agent?.status !== "done" && this.status !== "done") return;

    const wasInputFocused = restoreInput || this.inputFocused;
    const myPane = this._paneId;
    this._markingRead = true;
    try {
      run("pane.focus", { terminal: this.terminal });
      if (myPane) {
        run("pane.focus", { pane: myPane });
      }
      cx.timer(20, (tcx) => {
        this._markingRead = false;
        if (wasInputFocused) {
          this.input.focus();
        } else {
          this.handle.focus();
        }
        tcx.notify();
      });
    } catch {
      this._markingRead = false;
    }
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
      .key_context("AgentChat")
      .on_mouse_down("left", (_e, cx) => this.markTerminalRead(cx))
      .on_action("agent-chat.page-up", (_e, cx) => this.pageScroll(1, cx))
      .on_action("agent-chat.page-down", (_e, cx) => this.pageScroll(-1, cx))
      .on_action("agent-chat.scroll-top", (_e, cx) => {
        if (!this.readingBlocks) this.startReading(cx);
        while (this.readingStart > 0) this.loadEarlier(cx);
        const { maxScroll } = this.currentFeedLayout();
        this.scrollY = 0;
        this.scrollFromBottom = maxScroll;
        this.saveScrollState();
        cx.notify();
      })
      .on_action("agent-chat.scroll-bottom", (_e, cx) => this.returnToLive(cx))
      .on_key_down((event, cx) => this.handleKeyDown(event, cx))
      .relative()
      .size_full()
      .bg(t.background)
      .child(this.renderFeed(t, monoFont, cx))
      .child(this.renderComposer(t, cx))
      // Floating, in the root so it covers the feed instead of shrinking it.
      .when(this.pickerOpen || this.modelMenuOpen, (el) =>
        el.child(this.renderDrawerOverlay(t, cx))
      );
  }
}
