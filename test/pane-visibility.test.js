import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePaneVisibility } from "../mods/agent-chat/pane-visibility.js";

const panes = [
  { pane: "term-open", terminal: "t8s", tab: "tab-open", mod: undefined, zoomed: false },
  { pane: "chat-open", terminal: null, tab: "tab-open", mod: "agent-chat", zoomed: false },
  { pane: "chat-other", terminal: null, tab: "tab-other", mod: "agent-chat", zoomed: false },
];

test("a chat copy in another tab is hidden", () => {
  const { shown, paneId } = resolvePaneVisibility({
    hostTerminal: "t8s",
    panes,
    focused: { tab: "tab-other" },
    windowActive: true,
  });
  assert.equal(shown, false);
  assert.equal(paneId, "chat-open");
});

test("the chat copy beside its terminal is shown when that tab is active", () => {
  const { shown, paneId } = resolvePaneVisibility({
    hostTerminal: "t8s",
    panes,
    focused: { tab: "tab-open" },
    windowActive: true,
  });
  assert.equal(shown, true);
  assert.equal(paneId, "chat-open");
});

test("a zoomed terminal hides the chat split beside it", () => {
  const zoomed = panes.map((p) => (p.pane === "term-open" ? { ...p, zoomed: true } : p));
  assert.equal(
    resolvePaneVisibility({
      hostTerminal: "t8s",
      panes: zoomed,
      focused: { tab: "tab-open" },
      windowActive: true,
    }).shown,
    false
  );
});

test("a zoomed chat pane is shown", () => {
  const zoomed = panes.map((p) => (p.pane === "chat-open" ? { ...p, zoomed: true } : p));
  assert.equal(
    resolvePaneVisibility({
      hostTerminal: "t8s",
      panes: zoomed,
      focused: { tab: "tab-open" },
      windowActive: true,
    }).shown,
    true
  );
});

test("an inactive window pauses every copy", () => {
  assert.equal(
    resolvePaneVisibility({
      hostTerminal: "t8s",
      panes,
      focused: { tab: "tab-open" },
      windowActive: false,
    }).shown,
    false
  );
});

test("overlays and floating copies are always considered shown inside an active window", () => {
  assert.equal(
    resolvePaneVisibility({ focused: null, windowActive: true, overlay: true }).shown,
    true
  );
  assert.equal(
    resolvePaneVisibility({ focused: null, windowActive: true, floating: true }).shown,
    true
  );
});

test("without a pane id, a copy is hidden when no chat is in the active tab", () => {
  assert.equal(
    resolvePaneVisibility({
      panes,
      focused: { tab: "tab-claude" },
      windowActive: true,
    }).shown,
    false
  );
});

test("without a pane id, a chat in the active tab keeps the copy polling", () => {
  assert.equal(
    resolvePaneVisibility({
      panes,
      focused: { tab: "tab-other" },
      windowActive: true,
    }).shown,
    true
  );
});

test("a learned pane id wins over the terminal fallback", () => {
  const { shown, paneId } = resolvePaneVisibility({
    paneId: "chat-other",
    hostTerminal: "t8s",
    panes,
    focused: { tab: "tab-other" },
    windowActive: true,
  });
  assert.equal(shown, true);
  assert.equal(paneId, "chat-other");
});
