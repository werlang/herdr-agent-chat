# herdr-agent-chat

Source of truth for the `agent-chat` mod: a native Chat UI inside Herdr to follow, inspect, and talk with CLI coding agents (Claude Code, Antigravity, OpenCode, Codex, Aider, etc.).

## Rule: always update Herdr's live folder

Herdr loads mods from `~/.config/herdr-app/mods/<name>`. After **any** change here:

```sh
./sync.sh
```

The script copies `mods/agent-chat` to the live folder and runs `herdr-app check`. Do not edit the live folder directly.

## How it works

The `agent-chat` mod connects directly to the agent's terminal (`$HC_TERMINAL_ID`):

- **Agent Selector & Follow Mode**: Switch between any active agent or sub-agent (in the current space or other spaces), spawn new agents (`hc spawn claude`), or automatically follow the focused agent (`followFocused`).
- **View Toggle (Chat View vs. Original View)**: Top toggle button to switch instantly between the formatted visual feed and the raw terminal stream with line count and full copy button.
- **Stream Reading & History Cache**: Polls via `hc read <terminal> --lines 200 --json`, preserving previous turns in cache when `hc read` returns only the visible screen (`complete: false`) during `working` state, and parses the stream (`parser.js`) into user turns, thoughts (*thought*), tool invocations/groups (*tool* / *tool_group*), and assistant replies in native Markdown (`TextView.markdown`).
- **Sticky Tail Scroll**: The feed is an inverted scroll column, so the newest turn stays at the bottom and follows streaming natively. Scrolling up freezes the reading window (new messages do not jump the screen); the "Scroll to end" pill jumps back to the bottom and "Load earlier messages" paginates older turns. Only a bounded window of rows is built, keeping long sessions cheap.
- **Real-Time Status & Panel Controls**: Shows the agent status badge (`working` with spinner, `blocked` "Needs you", `done`, `error`, `idle`), Git branch, current directory, and quick buttons for `Peek` (`pane.peek`), `Focus` (`terminal.focus`), and copying replies (`cx.write_to_clipboard`).
- **Poll Only When Visible**: Herdr keeps timers alive for hidden instances (another tab, settled, behind a zoom). The mod checks `window().active`, `focused()`, and `panes()` every second and only reads transcripts / `hc read` when the pane is actually on screen; hidden instances spend no CPU or I/O and the `working` spinner stays static.
- **Quick Approval Actions**: When the agent is waiting (`blocked`), displays immediate contextual buttons: `Approve (Enter)`, `Yes (y)`, `No (n)`, `Cancel (Esc)` firing `hc keys` or `hc send`.
- **Bidirectional Interaction & Interruption**: The composer is a multi-line `Textarea`: **Enter sends** the message via `hc send <terminal> <text>` and **Shift+Enter inserts a newline** (`submit` arrives with `event.shift`). The **Stop** button interrupts running executions via `hc interrupt <terminal>`.
- **Model Selector**: Claude uses `/model <id>` and `/effort <level>` commands with the same list as the native picker (Default, Opus 5.5, Sonnet 5.5, Fable 5.1, Haiku 5.5; "More models…" opens the native `/model`) and the five levels `low`/`medium`/`high`/`xhigh`/`max`. Switches become notices in the feed (read from `<local-command-stdout>` in the transcript) and update the current model immediately; before the first reply, the model comes from the screen banner. A newly opened Claude session (no `.jsonl` yet, and sometimes no `app` reported — uses `program.key`) shows the empty state instead of the banner/placeholder. OpenCode is read and switched via its own server API — `opencode api GET /api/model` and `/api/provider` build the provider-grouped list (the current model's provider comes first), and `POST /api/session/<sessionID>/model` switches the active session's model (`sessionID` comes from `OpenCodeTranscript`). In OpenCode, **effort is the model's `variant`**: the effort column lists the current model's `variants` and switches via the same call (`{ model: { id, providerID, variant } }`); there is no `/effort` command, typing it would send a chat message. The source of truth for the current model is the `session_v2` row (a switch appears there before any new reply exists); with no session yet, the model is read from the TUI screen. If the API is unavailable, it falls back to the terminal's native picker (`/models`). Both the model menu and the agent selector float above the feed (`absolute` overlay at the root, anchored to the measured composer height via `on_size_change`), so opening either never reserves space or shifts the conversation; menu height is capped by the feed space and lists scroll inside it.
- **Thoughts, tools, and notices**: Each thought is a collapsible row (brain icon + summary) whose body is Markdown in a bounded panel; each tool call also opens independently with output collapsed by default. A sequence of thoughts and tools becomes a section ("Worked for 12s · Ran 3 commands…"; failures appear as a "N failed" badge rather than tinting the header). Provider errors (`error.message`), interruptions, model switches, and compactions become a subtle line in the turn (`noticeItem` in `opencode-data.js`). Model/effort switches read "Model set to …" / "Effort set to …" in every harness. Inter-agent messages (`<hc from="tX">…</hc>`) are unwrapped and show "from tX".
- **Response text**: The default UI font (Geist) lacks bold/italic here, so the feed body uses the first installed family from `body-font.js` (Inter, SF Pro Text, Helvetica Neue, Arial). Native `TextView.markdown` does not render images or color diffs and does not accept styles; image-only lines become an attachment row (alt + path), since the host only loads images from the app's own folder. Code blocks have their own header with the language and a **Copy** button; right-clicking inside the block copies just the snippet and shows "Copied", without triggering whole-message copy.

## Demo and visual inspection

`demo-blocks.js` has a fixed conversation with all elements (headings, lists, table, blockquote, code, tasks, errors). Opens without an agent, in its own tab:

```sh
herdr-app do tab.new --name "Chat demo" --mod agent-chat --props '{"demo":"opencode"}'
```

The `preview` preset is a shorter, realistic English conversation used for the README's `preview.png`:

```sh
herdr-app do tab.new --name "Agent Chat" --mod agent-chat --props '{"demo":"preview"}'
```

Inspection props: `demo` (`opencode` groups by turn, `claude` groups sequences, `preview` shows the README turn), `part` (`a`, `b`, `short`, `edge`: Markdown parts; ignored in `preview`), `expand` (expands sections, thoughts, and tools), `open` (`model` or `agent`: opens the selector on load). Then `herdr-app shot file.png` saves the window frame. The chat only reads the transcript while the Herdr window is active; when another app is in the foreground it intentionally stays paused.

## How to open in Herdr

### Split pane next to a terminal
```sh
herdr-app do pane.split --direction right --mod agent-chat
```
Or targeting a specific terminal:
```sh
herdr-app do pane.split --direction right --mod agent-chat --props '{"terminal":"t2n"}'
```

### Open in a new tab
```sh
herdr-app do tab.new --name "Agent Chat" --mod agent-chat
```

## Skill

The `herdr-publish` skill is in `.agents/skills/herdr-publish/SKILL.md`. It covers validation, sync, `RECIPE.md`/`preview.png`, and publishing to `herdr.dev/mods` with the `herdr-mod` topic.
