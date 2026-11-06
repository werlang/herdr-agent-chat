// Pure visibility decision for one chat copy.
//
// Herdr keeps a mod's timers running while the copy is hidden (another tab, a
// settled tab, behind a zoomed sibling, or an inactive window). A mod pane
// created with `pane.split {mod, props}` only receives its props, not its pane
// id, so this resolves the pane from the props' terminal when possible and
// otherwise falls back to a coarse "is any chat in the active tab" signal.

/**
 * @param {object} state
 * @param {string|null} [state.paneId] a pane id learned earlier
 * @param {string|null} [state.hostTerminal] the `terminal` prop this copy was opened with
 * @param {Array<object>} [state.panes] Herdr's pane list
 * @param {{tab?: string}|null} [state.focused] `focused()`
 * @param {boolean} [state.windowActive] `window().active`
 * @param {boolean} [state.overlay] this copy is an overlay
 * @param {boolean} [state.floating] this copy floats
 * @returns {{shown: boolean, paneId: string|null}}
 */
export function resolvePaneVisibility({
  paneId = null,
  hostTerminal = null,
  panes = [],
  focused = null,
  windowActive = false,
  overlay = false,
  floating = false,
} = {}) {
  if (!windowActive) return { shown: false, paneId };
  if (overlay || floating) return { shown: true, paneId };
  if (!focused?.tab) return { shown: true, paneId };

  const all = panes || [];
  let pane = paneId ? all.find((p) => p.pane === paneId) : null;

  // A copy opened for a terminal lives in that terminal's tab. Only accept the
  // match when exactly one chat pane is there; two splits are ambiguous.
  if (!pane && hostTerminal) {
    const host = all.find((p) => p.terminal === hostTerminal);
    if (host) {
      const chats = all.filter((p) => p.mod === "agent-chat" && p.tab === host.tab);
      if (chats.length === 1) pane = chats[0];
    }
  }

  if (!pane) {
    // No pane id: the only definitive answer is when no chat lives in the
    // active tab, because then this copy cannot be the one on screen.
    return {
      shown: all.some((p) => p.mod === "agent-chat" && p.tab === focused.tab),
      paneId: null,
    };
  }

  if (pane.tab !== focused.tab) return { shown: false, paneId: pane.pane };

  // A zoomed sibling replaces every other pane in the tab, including this one.
  const zoomed = all.find((p) => p.tab === focused.tab && p.zoomed);
  return { shown: !zoomed || zoomed.pane === pane.pane, paneId: pane.pane };
}
