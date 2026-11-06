// The font for chat prose. Herdr's default UI font (Geist) ships here without
// bold or italic faces, so `**bold**` and `*italic*` in a reply come out
// looking like body text. A system family with real weights fixes that. This
// picks the first one installed, and leaves the default when none is.

/** Families with regular, bold and italic faces, in order of preference. */
export const BODY_FONT_CANDIDATES = ["Inter", "SF Pro Text", "Helvetica Neue", "Arial"];

/**
 * @param {string[]} available families installed on this machine
 * @param {string[]} [candidates]
 * @returns {string|null} a family name, or null to keep the default font
 */
export function pickBodyFont(available, candidates = BODY_FONT_CANDIDATES) {
  const have = new Set((available || []).map((name) => String(name).toLowerCase()));
  return candidates.find((name) => have.has(name.toLowerCase())) ?? null;
}
