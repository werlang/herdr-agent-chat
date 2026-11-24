const MODEL_PICKER = /^\s*(?:Select Model(?: and Effort)?|Select Reasoning Level[^\n]*|Advanced Reasoning|Apply reasoning change|Loading models…)\s*$/im;
const MODEL_CHANGE = /^•\s+Model changed to (\S+)(?:\s+([\w-]+))?(?:\s+for\s+.+)?\.?$/i;
const MODEL_ERROR = /^(?:[•✕!]\s*)?(?:Reasoning level \S+ is unavailable|Model \S+ is unavailable|Model arguments are unavailable|Session is still starting; try \/model)\b/i;

/** Extracts the version of the Codex executable that supplied the catalogue. */
export function codexAppServerVersion(stdout) {
  for (const line of stdout.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message.id === 1) return message.result?.userAgent?.match(/^herdr\/(\d+\.\d+\.\d+)/)?.[1] || null;
    } catch (_err) {
      // Other server output can precede the JSON-RPC handshake.
    }
  }
  return null;
}

/** Prefers the version of the running TUI over the executable found during discovery. */
export function codexSupportsInlineModel(text, catalogueVersion) {
  const bannerVersion = text.match(/\bOpenAI Codex\s+\(v(\d+\.\d+\.\d+)[^)]*\)/i)?.[1];
  const [major, minor] = (bannerVersion || catalogueVersion || "").split(".").map(Number);
  return major > 0 || (major === 0 && minor >= 164);
}

/** Retains the current effort if the destination offers it, otherwise uses its default. */
export function codexModelEffort(model, currentEffort) {
  return model.supported_reasoning_levels.some(({ effort }) => effort === currentEffort)
    ? currentEffort
    : model.default_reasoning_level || model.supported_reasoning_levels[0]?.effort || null;
}

/** Resolves current model and effort from Codex's footer and latest native confirmation. */
export function codexScreenModel(text, models) {
  const lines = text.split("\n").slice(-10).reverse();
  // A session-only change may leave the global effort in the footer.
  const change = lines.map((line) => line.trim().match(MODEL_CHANGE)).find(Boolean);
  const confirmedModel = models.find((m) => m.slug === change?.[1]);
  for (const line of lines) {
    const [status, ...rest] = line.trim().split(/\s+·\s+/);
    if (!rest.length) continue;
    const match = status.match(/^(.+?)\s+(default|none|minimal|low|medium|high|xhigh|extra high|max|ultra|persistent)$/i);
    const name = (match?.[1] || status).toLowerCase();
    const model = models.find((m) => [m.slug, m.display_name].some((label) => label.toLowerCase() === name));
    if (!model) continue;
    const reported = (confirmedModel === model ? change[2] : null) || match?.[2].toLowerCase();
    const effort = !reported || reported === "default" ? model.default_reasoning_level : reported;
    return { model: model.slug, effort: effort === "extra high" ? "xhigh" : effort };
  }
  // The footer can be disabled. In that case a native notice still confirms the new settings.
  return confirmedModel
    ? { model: confirmedModel.slug, effort: change[2] === "default" ? confirmedModel.default_reasoning_level : change[2] || null }
    : null;
}

/**
 * Sends one inline /model command and waits for the active Codex conversation
 * to report the requested state. A completed hc send only acknowledges delivery.
 */
export async function applyCodexModel({ model, models, effort, effortOnly, read, send, wait }) {
  const before = await read();
  if (MODEL_PICKER.test(before)) throw new Error("Close the open /model menu in Codex’s terminal, then try again.");
  const expectedEffort = effort || model.default_reasoning_level;
  const initial = codexScreenModel(before, models);
  if (effortOnly && initial && initial.model !== model.slug) {
    throw new Error("The active Codex model changed. Reopen the selector to see its reasoning levels.");
  }
  const isSelected = (text) => {
    const state = codexScreenModel(text, models);
    return state?.model === model.slug && (!expectedEffort || state.effort === expectedEffort);
  };
  if (isSelected(before)) return before;

  const command = ["/model", effortOnly ? null : model.slug, effort ? `--reasoning=${effort}` : null]
    .filter(Boolean).join(" ");
  const readError = (text) => text.split("\n").slice(-10).reverse().map((line) => line.trim())
    .find((line) => MODEL_ERROR.test(line));
  const previousError = readError(before);
  let sendError;
  send(command).catch((error) => { sendError = error; });
  const until = Date.now() + 8000;
  do {
    const text = await read();
    if (isSelected(text)) return text;
    if (sendError) throw sendError;
    const error = readError(text);
    if (error && error !== previousError) throw new Error(error.replace(/^[•✕!]\s*/, ""));
    await wait(100);
  } while (Date.now() < until);
  throw new Error("Codex hasn’t confirmed the change. Check the active session in its terminal.");
}
