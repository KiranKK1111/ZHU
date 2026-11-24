# Front End

React 18 + TypeScript + Vite 6 + Tailwind 3.4 (Node 18 compatible), with Radix primitives, Zustand, TanStack Query and TanStack Virtual. There is one bundle for two windows; each window's root is lazy-loaded based on the Tauri window label.

## Component hierarchy

```text
main.tsx ─ picks the root by window label (main | bubble: the floating icon shown while the main window is minimized)
├── MainApp ── AppProviders (React Query, prefs/theme, toasts) ── EngineGate (starting / failed / ready)
│   ├── ModelSetup                  first-run, one-time model download (shown only while no model is installed)
│   └── AppShell
│       ├── TitleBar                drag region · ListeningControl (start, with a menu of what to listen to · live state · pause · stop) · OpacityButton · HideFromBarsButton · side-panel button · Settings gear (pressed while Settings is open; again: back to the chats) · WindowControls
│       ├── <Screen>                lazy (app/routing/routes.ts): "webchats" (label Chats, the start) · "settings"
│       │     Chats      → WebChatScreen (features/webchat) inside QuestionsColumn (components/questions: QuestionCard list, newest first;
│       │                  optional TranscriptView, its height a SplitHandle; a SplitHandle for the column's width; collapsible)
│       │                  · tab strip (+ menu → openChatTab in features/webchat/tabs.ts), WebChatOptions
│       │                  · a Custom chat tab → ChatPane (features/chat: messages, model picker, New chat, earlier conversations)
│       │                  · a website tab → a native child webview placed over a placeholder
│       │     Settings   → one page: ModelsSection (connect with a key) · answer instructions · WebChatOptions · Listening · App (+ shortcuts) · Your data; Esc goes back to the chats
│       └── SidePanel               ScreenshotsSection (capture, Add to …, drag) · ResumeSection (resumes and the job)
└── BubbleApp                       the floating icon
```

## State and data flow

* **Engine connection** (`hooks/useEngineConnection`): `engine_info` from the shell plus the `zhu://engine` event. Every window opens its own WebSocket (`services/eventStream`) with seq dedupe, replay from `last_seq`, and cache invalidation on instance change or gap.
* **Questions into the chats** (`services/webchatDelivery`): **Send to chat** on a card, and each detected question while automatic delivery is on, put the question (with the user's answer instructions) into the message boxes of the target tabs; nothing is submitted. With no chat tab open, `chatTabsOrCustom` (`features/webchat/tabs.ts`) opens a Custom chat tab first. Screenshots from the side panel go the same way (`services/screenshotActions`): to the tab that is shown, or to a new Custom chat. Answers from ZHU's own models come from the Custom chat (CHAT.md).
* **Event dispatch** (`services/dispatch`): batched per animation frame (a hidden window flushes in a microtask) into separate Zustand stores. `transcript` is a bounded ring keyed by segment, where a newer revision replaces an older one. `questions` holds revision-guarded upserts. Answers arrive as `chat.delta` / `chat.completed` / `chat.error` for the Custom chat; the engine's `provider.started` / `delta` / `completed` / `error` events (from `submit`) are not used by the app. The other stores are `session` (the session that listening records into, kept behind the scenes), `chat` (Custom chat conversations, drafts and attachments per tab), `webchat` (chat tab state), `ui` (navigation and toasts), and `prefs` (theme, window opacity, hotkeys, close-to-tray, the questions column's layout, the chat tabs; synced across windows through `zhu://prefs`).
* **REST** (`services/engine`): one typed function per engine route. Images are fetched with the auth header as blobs and revoked on unmount.
* **Shell** (`services/shell`): typed wrappers for the Rust commands. Every wrapper fails gracefully outside Tauri.
* **Opacity** (`app/state/opacity`): the everyday level is a preference; the hidden level starts at 80% on the eye button. A ZHU that closed hidden opens hidden, and the page takes the level it had from the shell (`hidden_opacity`). No opacity is applied until the shell has said whether ZHU is hidden, so a page loading in a hidden ZHU never makes it opaque for a moment.

## Design system

`styles/tokens.css` defines the `--zhu-*` tokens: color (the dark and light palettes from UI prompt §4), typography scale, spacing, radii, motion, elevation, and layout sizes. `tailwind.config.ts` maps utilities to those tokens, so components contain no raw colors. `prefers-reduced-motion` disables transitions. Layout modes (wide, standard, compact) use container widths, not only viewport media queries.

## The ZHU mark

One file, `apps/desktop/public/zhu-mark.svg`, is the app's only icon: `Logo` (title bar, setup and start-up screens) and the floating icon show it directly, it is the page icon, and `npm run icons` renders it with headless Edge and `tauri icon` into `src-tauri/icons` (taskbar, window, tray, installer). To change the icon, edit the SVG and run that command; never edit the PNG or ICO files by hand.

## Pointer

The pointer over ZHU is always an arrow, and nothing else (no hand, text beam or resize arrows). Three places make sure of that:

* **Inside the window** one rule in `globals.css` gives every element `cursor: var(--zhu-cursor, default) !important`, so no other rule (a library's, or a Tailwind `cursor-*` class) can bring another pointer back. With the Custom pointer preference on and ZHU not hidden, `styles/cursors.ts` sets `--zhu-cursor` on `<html>` to ZHU's 24 px SVG arrow, an ordinary CSS cursor that Windows draws; otherwise the variable is unset and the rule gives the Windows arrow. While ZHU is hidden (bars.rs) the page's pointer is always the Windows arrow, because a screen share shows the pointer over a window it leaves out (and with the frozen pointer, below, the real pointer does not come over ZHU's content at all).
* **In a strip along the edges** the browser engine refuses a custom cursor whenever part of its image would reach past the window, whatever the image's size (measured with 32, 24 and 16 px images: the standard arrow appeared across exactly the image's reach to the right of and below the pointer). There `followAtEdges` hides the system pointer (`cursor: none`) and moves an `<img>` of the same arrow with the mouse. At the very edge the image is cut off by the window, as any page content is.
* **On the resize border** (the invisible frame around the frameless window, and the thin native strip along its top) the page has no say: Windows asks the window which cursor to show and, unanswered, shows its resize arrows. `src-tauri/src/resize_cursor.rs` answers `WM_SETCURSOR` for the eight resize positions with the standard arrow; dragging still resizes.

While ZHU is hidden, with "Freeze the pointer while hidden" on (pref `freezePointer`, sent to the shell with `set_freeze_pointer`), the real pointer does not come over ZHU's page at all, title bar included: `src-tauri/src/pointer_freeze.rs` keeps it where it entered and moves a stand-in arrow (the arrow of the user's Windows pointer scheme: a hidden ZHU never shows its violet arrow), and posts the mouse messages to the page under it. The page needs nothing for that: it receives ordinary mouse events. Its title bar keeps `data-tauri-drag-region`: the drag that Tauri asks Windows for is taken over in the shell and the window follows the arrow. The window's resize border is left out of the freezing, so the real pointer resizes there as always.

Chat websites opened in a tab are separate pages in their own browser view; `webchat.rs` adopts a style sheet with `cursor: default !important` for every element into each page as it loads (`POINTER_JS`), so they show the Windows arrow.

## Verified in the running app (2026-11-17, RTX 5060 laptop, 125% scaling)

See [TESTING.md](TESTING.md#live-desktop-test-2026-11-17).
