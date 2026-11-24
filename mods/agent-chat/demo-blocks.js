// A fixed conversation that exercises every element the chat can draw, for
// looking at the UI without a live agent:
//
//   herdr-app do tab.new --name "Chat demo" --mod agent-chat --props '{"demo":"opencode"}'
//   herdr-app do tab.new --name "Chat demo" --mod agent-chat --props '{"demo":"claude"}'
//
// Pure data: no `herdr` import, so tests can run it under plain Node. The
// items go through the real `itemsToBlocks`, so the demo shows what a live
// session would.
import { itemsToBlocks } from "./transcript-blocks.js";

/** Markdown covering headings, inline styles, lists, a table, quotes, code and rules. */
const SHOWCASE_RAW = `# Heading 1
## Heading 2
### Heading 3

A normal paragraph with **bold**, *italic*, ***both***, ~~strikethrough~~, \`inline code\` and a [link](https://github.com/stablyai/orca). This sentence is deliberately long, so it has to wrap across several lines and show the line height, the measure of the column and the rhythm of a paragraph in a chat feed.

A second paragraph straight after the first, to judge the space between paragraphs.

- Unordered item one
- Unordered item two with \`code\` inside
  - Nested item A
  - Nested item B
    - Third level
- Unordered item three

1. Ordered first
2. Ordered second
   1. Nested ordered
   2. Nested ordered again
3. Ordered third

@@SPLIT@@- [x] A finished task
- [ ] An open task

| Element | Status | Notes |
|:--------|:------:|------:|
| Tables | ok | left, centre and right alignment |
| Lists | ok | nested three deep |
| Code | \`ok\` | inline code in a cell |

> A blockquote with *emphasis* in it.
>
> > A quote nested inside it.

\`\`\`js
// A fenced block with a long line, to see wrapping or scrolling
export function greet(name) {
  const line = \`Hello, \${name}! This line is long enough that it has to wrap or scroll inside the block.\`;
  return line;
}
\`\`\`

\`\`\`diff
- removed line
+ added line
\`\`\`

---

A last paragraph after a horizontal rule.`;


/** Awkward but common: wide tables, long unbroken text, deep headings, code inside lists and quotes. */
export const EDGE_MARKDOWN = `#### Heading 4
##### Heading 5
###### Heading 6

A very long unbroken string: https://example.com/a/really/long/path/that/keeps/going/and/going/and/going/and/going/until/it/must/wrap/or/clip?query=value&another=value&more=stuff and \`an_extremely_long_inline_code_identifier_that_has_no_spaces_to_break_on_at_all_1234567890\` end.

| Column A | Column B | Column C | Column D | Column E | Column F |
|---|---|---|---|---|---|
| A short cell | A much longer cell with several words that will need to wrap inside the column | \`code\` | **bold** | 12345 | the last column also has quite a lot of text in it |
| x | y | z | w | v | u |

5. A list that starts at five
6. Second item

- A list item with a paragraph and code inside

  A second paragraph inside the same item.

  \`\`\`sh
  npm test && npm run build
  \`\`\`

- Next item after the code

> A quote that holds code:
>
> \`\`\`js
> const quoted = true;
> \`\`\`

![A local image](/Users/pablowerlang/Documents/Workspaces/herdr/herdr-agent-chat/preview.png)\n\n![A missing image](/tmp/definitely-not-here.png)

Line one of a hard break  
line two right after it, and an entity: 5 &lt; 6 &amp; 7 &gt; 3.`;

/** Part A: headings, paragraphs, lists. Part B: tasks, table, quote, code, rule. */
export const SHOWCASE_PARTS = SHOWCASE_RAW.split("@@SPLIT@@");
export const SHOWCASE_MARKDOWN = SHOWCASE_PARTS.join("");

/** A polished English conversation for the README preview: one real coding turn. */
const PREVIEW_MARKDOWN = `## Streaming session store

The store keeps its last snapshot and emits only the rows that changed. The feed merges them into the existing block keys, so the scroll anchor survives every poll.

### What changed

- [x] \`session-store.js\` diffs each poll against the last snapshot.
- [x] \`feed.js\` applies the delta in place and keeps the sticky tail.
- [x] Identical polls cost one comparison and zero repaints.

| Before | After |
|:-------|:------|
| Rebuilt every turn | Merges changed rows |
| Scroll jumped while streaming | Sticky tail stays put |

\`\`\`js
export function applyDelta(previous, next) {
  const changed = next.filter((row) => previous.get(row.seq) !== row);
  return { rows: next, changed };
}
\`\`\`

> New turns stream in underneath. The reading window only moves when you scroll.

\`npm test\` — 24 files passed · \`npm run lint\` — clean.`;

/** One user turn that shows the feed, a worked section, and rich Markdown. */
function previewItems() {
  const workedMs = 18200;
  const turn = { turn: 2, workedMs };
  const tool = (name, input, title, detail) => ({
    type: "tool",
    name,
    input,
    title,
    detail,
    status: "done",
    ...turn,
  });
  return [
    {
      type: "user",
      text: "Add streaming deltas to the session store, then verify the chat stays pinned while it updates.",
    },
    {
      type: "thought",
      text: "**Tracing the store's read path** The feed rebuilds every block from the polled rows, so the delta needs stable keys and an anchor. I'll diff by row seq, keep the last snapshot, and merge only changed rows.",
      status: "done",
      ...turn,
    },
    tool("bash", { command: "wc -l src/session-store.js" }, "bash · wc -l session-store.js", "412 src/session-store.js"),
    tool("bash", { command: "npm test -- session-store" }, "bash · npm test -- session-store", "✔ 18 tests passed"),
    tool("edit", { file_path: "src/session-store.js" }, "edit · session-store.js", "+ export function applyDelta(previous, next) { … }"),
    tool("edit", { file_path: "src/feed.js" }, "edit · feed.js", "merge the delta into the existing blocks"),
    tool("bash", { command: "npm run lint" }, "bash · npm run lint", "24 files, no issues"),
    { type: "assistant", text: PREVIEW_MARKDOWN, seq: 2, ...turn },
    { type: "user", text: "What happens if I scroll up while it streams?", seq: 3, turn: 3 },
    {
      type: "assistant",
      text: "The window stays frozen where you left it. New turns keep streaming underneath, and **Scroll to end** jumps back to the live tail.",
      seq: 4,
      turn: 4,
    },
  ];
}

/**
 * Items for the demo conversation.
 * @param {"opencode"|"claude"|"preview"} [style] opencode groups a turn under
 *   "Worked for…"; claude folds runs of tool calls (its items carry no `turn`);
 *   preview is the curated English turn used for the README screenshot.
 * @returns {Array<object>}
 */
export function demoItems(style = "opencode", part = null) {
  if (style === "preview") return previewItems();
  const showcase =
    part === "a"
      ? SHOWCASE_PARTS[0].trimEnd()
      : part === "b"
        ? SHOWCASE_PARTS[1]
        : part === "short"
          ? "Here is the tour of every element."
          : part === "edge"
            ? EDGE_MARKDOWN
            : SHOWCASE_MARKDOWN;
  const turn = (n) => (style === "opencode" ? { turn: n } : {});
  const worked = style === "opencode" ? { workedMs: 12400 } : {};
  return [
    { type: "user", text: "Show me every kind of element the chat can render." },
    {
      type: "thought",
      text: "**Planning the answer** The user wants a tour of the renderer, so I should read the sources first and then reply with one message that uses every element.",
      status: "done",
      ...turn(2),
      ...worked,
    },
    {
      type: "tool",
      name: "read",
      input: { file_path: "/repo/src/render.js" },
      title: "read · render.js",
      detail: "export function render() {\n  return h('div', null, 'hello');\n}",
      status: "done",
      ...turn(2),
      ...worked,
    },
    {
      type: "tool",
      name: "bash",
      input: { command: "node --test" },
      title: "bash · node --test",
      detail: "✔ renders headings\n✔ renders tables\nℹ pass 2",
      status: "done",
      ...turn(2),
      ...worked,
    },
    {
      type: "tool",
      name: "bash",
      input: { command: "npm run lint" },
      title: "bash · npm run lint",
      detail: "error: unexpected token",
      status: "error",
      ...turn(2),
      ...worked,
    },
    { type: "assistant", text: showcase, seq: 2, ...turn(2) },
    { type: "notice", tone: "info", text: "Model switched to Claude Opus 5.5 · high", seq: 3, ...turn(3) },
    { type: "user", text: "And what happens when the provider fails?" },
    {
      type: "assistant",
      text: "Short reply before the failure.",
      seq: 5,
      ...turn(5),
    },
    {
      type: "notice",
      tone: "error",
      text: "Upstream request failed: [overloaded] the server is overloaded; retry shortly",
      seq: 6,
      ...turn(6),
    },
    { type: "notice", tone: "info", text: "Interrupted", seq: 7, ...turn(7) },
  ];
}

/**
 * Feed blocks for the demo conversation.
 * @param {"opencode"|"claude"} [style]
 * @returns {Array<object>}
 */
export function demoBlocks(style = "opencode", part = null) {
  return itemsToBlocks(demoItems(style, part), false);
}
