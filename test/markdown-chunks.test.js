import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownChunks, annotateRows } from "../mods/agent-chat/transcript-blocks.js";

/** Chunks close once they reach this many characters (see MIN_CHUNK_CHARS). */
const MIN = 1200;

/** Every case must split into chunks that join back to the original text. */
function splitAndCheck(text) {
  const chunks = splitMarkdownChunks(text);
  assert.equal(chunks.join(""), text, "chunks must concatenate to the original text");
  return chunks;
}

/** A paragraph of `chars` characters that starts with `label`. */
function para(label, chars = 300) {
  return `${label} ${"w".repeat(Math.max(0, chars - label.length - 1))}`;
}

test("paragraphs split once a chunk reaches 1200 characters", () => {
  const text = [para("A", 1300), para("B", 1300), para("C", 1300)].join("\n\n");
  const chunks = splitAndCheck(text);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0], `${para("A", 1300)}\n\n`);
  assert.equal(chunks[2], para("C", 1300));
});

test("short replies stay one chunk", () => {
  assert.deepEqual(splitAndCheck("First para.\n\nSecond para.\n\nThird."), ["First para.\n\nSecond para.\n\nThird."]);
});

test("a fenced code block containing a blank line is not cut inside", () => {
  const body = `${"x".repeat(1300)}\n\n${"y".repeat(1300)}`;
  const text = `${para("Intro", 1300)}\n\n\`\`\`js\n${body}\n\`\`\`\n\nAfter.`;
  const chunks = splitAndCheck(text);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[1].includes(body), "the blank line inside the fence must not cut it");
});

test("a tilde fence only closes on a fence of the same character and length", () => {
  const text = `~~~~\nkeep\n\`\`\`\n${"a".repeat(1300)}\n\nstill inside\n~~~~\n\nAfter.`;
  const chunks = splitAndCheck(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].includes("still inside"));
});

test("list items separated by blank lines stay together", () => {
  const item = (n) => `- item ${n} ${"w".repeat(700)}`;
  assert.equal(splitAndCheck([item(1), item(2), item(3)].join("\n\n")).length, 1);

  const ordered = (n) => `${n}. item ${"w".repeat(700)}`;
  assert.equal(splitAndCheck([ordered(1), ordered(2), ordered(3)].join("\n\n")).length, 1);

  const continued = `- item ${"w".repeat(700)}\n\n  continued under the item ${"w".repeat(700)}`;
  assert.equal(splitAndCheck(continued).length, 1);
});

test("a paragraph after a list is a new chunk", () => {
  const list = `- ${"w".repeat(1300)}`;
  const chunks = splitAndCheck(`${list}\n\nAfter the list.`);
  assert.deepEqual(chunks, [`${list}\n\n`, "After the list."]);
});

test("CRLF text is returned as a single chunk", () => {
  const text = `${"a".repeat(1300)}\r\n\r\nb`;
  assert.deepEqual(splitMarkdownChunks(text), [text]);
});

test("a link reference definition makes the text a single chunk", () => {
  const text = `${"a".repeat(1300)}\n\n[x]: https://example.com\n\nAfter.`;
  assert.deepEqual(splitMarkdownChunks(text), [text]);
});

test("a footnote reference makes the text a single chunk", () => {
  const text = `${"a".repeat(1300)}\n\n[^1]: the note`;
  assert.deepEqual(splitMarkdownChunks(text), [text]);
});

test("empty text gives one empty chunk", () => {
  assert.deepEqual(splitMarkdownChunks(""), [""]);
});

test("trailing blank lines stay with the last chunk", () => {
  const text = `${"a".repeat(1300)}\n\ntwo\n\n\n`;
  assert.deepEqual(splitAndCheck(text), [`${"a".repeat(1300)}\n\n`, "two\n\n\n"]);
});

test("40 paragraphs of about 300 characters give about 10 chunks, each but the last at least 1200 characters", () => {
  const text = Array.from({ length: 40 }, (_, i) => para(`paragraph ${i}`, 300)).join("\n\n");
  const chunks = splitAndCheck(text);
  assert.ok(chunks.length >= 9 && chunks.length <= 11, `got ${chunks.length} chunks`);
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.length >= MIN, `chunk of ${chunk.length} characters is under ${MIN}`);
  }
});

test("streaming a long reply leaves every earlier chunk id unchanged", () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => para(`paragraph ${i}`, 300));
  const block = { type: "assistant", text: paragraphs.join("\n\n"), ekey: "assistant#1" };
  annotateRows([block]);
  const before = block.mdChunks.map((c) => c.id);

  // A new paragraph arrives, then more text streams into it.
  block.text += `\n\n${para("paragraph 40 new", 300)} more text`;
  annotateRows([block]);
  const after = block.mdChunks.map((c) => c.id);

  const stable = before.slice(0, -1);
  assert.deepEqual(after.slice(0, stable.length), stable, "every id but the last must be a prefix of the new ids");
  assert.equal(block.mdChunks.map((c) => c.text).join(""), block.text);

  // Word-by-word streaming into the last paragraph keeps the same invariant.
  for (let k = 1; k <= 5; k++) {
    const previous = block.mdChunks.map((c) => c.id);
    block.text += ` word${k}`;
    annotateRows([block]);
    const ids = block.mdChunks.map((c) => c.id);
    assert.deepEqual(ids.slice(0, previous.length - 1), previous.slice(0, -1));
    assert.equal(block.mdChunks.map((c) => c.text).join(""), block.text);
  }
});

test("annotateRows reuses unchanged assistant chunks from the previous render", () => {
  const first = [{ type: "assistant", text: "first reply", ekey: "assistant#1" }];
  annotateRows(first);
  const firstChunks = first[0].mdChunks;

  const next = [
    { type: "assistant", text: "first reply", ekey: "assistant#1" },
    { type: "assistant", text: "second reply", ekey: "assistant#2" },
  ];
  annotateRows(next, first);
  assert.strictEqual(next[0].mdChunks, firstChunks, "unchanged block keeps its chunk objects");
  assert.notStrictEqual(next[1].mdChunks, firstChunks, "a new block gets its own chunks");
});

test("annotateRows chunk ids use the block's ekey, then key, then a fallback", () => {
  const withEkey = { type: "assistant", text: "one", ekey: "assistant#2", key: "k" };
  const withKey = { type: "assistant", text: "one", key: "k9" };
  const bare = { type: "assistant", text: "one" };
  annotateRows([withEkey, withKey, bare]);
  assert.ok(withEkey.mdChunks[0].id.startsWith("md-assistant#2-0-"));
  assert.ok(withKey.mdChunks[0].id.startsWith("md-k9-0-"));
  assert.ok(bare.mdChunks[0].id.startsWith("md-a-0-"));
});

test("splitImageLines pulls standalone image lines out and keeps fenced ones", async () => {
  const { splitImageLines } = await import("../mods/agent-chat/transcript-blocks.js");
  // No image: unchanged, single entry.
  assert.deepEqual(splitImageLines("plain **text**", "id"), [{ id: "id", text: "plain **text**" }]);
  const parts = splitImageLines('before\n\n![shot](/tmp/a.png "title")\n\nafter\n\n```md\n![inside](/tmp/b.png)\n```', "id");
  assert.deepEqual(parts.map((p) => (p.image ? `img:${p.image.alt}:${p.image.src}` : "text")), [
    "text",
    "img:shot:/tmp/a.png",
    "text",
  ]);
  assert.match(parts[2].text, /!\[inside\]/); // the fenced image stays text
  // An image inside a sentence is left for the Markdown view.
  assert.equal(splitImageLines("see ![x](/a.png) here", "id").length, 1);
});
