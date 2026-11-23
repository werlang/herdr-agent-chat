import { exec } from "herdr";

export const INITIAL_TAIL_LINES = 80;
export const EARLIER_BATCH_LINES = 120;

/**
 * Reads the total line count and last `tailLines` complete lines of a JSONL file
 * in a single process, both locally and over SSH.
 */
export async function readJsonlTail(path, tailLines = INITIAL_TAIL_LINES, machine = null) {
  const opts = machine ? { on: machine } : undefined;
  const res = await exec(
    "sh",
    [
      "-lc",
      'n=$(wc -l < "$1" 2>/dev/null || echo 0); printf "%s\\n" "$n"; tail -n "$2" "$1" 2>/dev/null',
      "_",
      path,
      String(tailLines),
    ],
    opts
  );
  if (res.code !== 0) return null;
  const firstNl = res.stdout.indexOf("\n");
  if (firstNl < 0) return { totalLines: 0, startLine: 1, hasEarlier: false, lines: [] };
  const totalLines = Math.max(0, Number.parseInt(res.stdout.slice(0, firstNl).trim(), 10) || 0);
  const rest = res.stdout.slice(firstNl + 1);
  const end = rest.lastIndexOf("\n");
  const complete = end >= 0 ? rest.slice(0, end) : "";
  const lines = complete ? complete.split("\n") : [];
  const startLine = Math.max(1, totalLines - lines.length + 1);
  return {
    totalLines,
    startLine,
    hasEarlier: startLine > 1,
    lines,
  };
}

/**
 * Reads an inclusive 1-based line range `[fromLine, toLine]` from a JSONL file.
 */
export async function readJsonlRange(path, fromLine, toLine, machine = null) {
  if (toLine < fromLine || fromLine < 1) return [];
  const opts = machine ? { on: machine } : undefined;
  const res = await exec("sed", ["-n", `${fromLine},${toLine}p`, path], opts);
  if (res.code !== 0 || !res.stdout) return [];
  const end = res.stdout.lastIndexOf("\n");
  const complete = end >= 0 ? res.stdout.slice(0, end) : "";
  return complete ? complete.split("\n") : [];
}
