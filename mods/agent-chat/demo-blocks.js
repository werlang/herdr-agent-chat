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

/**
 * Items for the demo conversation.
 * @param {"opencode"|"claude"} [style] opencode groups a turn under "Worked for…";
 *   claude folds runs of tool calls (its items carry no `turn`).
 * @returns {Array<object>}
 */
export function demoItems(style = "opencode", part = null) {
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
    { type: "notice", tone: "info", text: "Model switched to big-pickle · max", seq: 3, ...turn(3) },
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
