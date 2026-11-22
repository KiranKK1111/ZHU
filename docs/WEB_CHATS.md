# AI Chats (embedded provider websites)

The **AI chats** screen opens the chat websites you already use (ChatGPT, Claude, Gemini, Qwen, Meta AI, DeepSeek, Grok, Copilot, Perplexity, Le Chat, or any other https site) as tabs inside the ZHU window. You sign in with your own account, as you would in a browser. While you are listening, ZHU puts each detected question into the message box of the open tabs and attaches each captured screenshot to the draft. **You press Send.**

## What ZHU does and does not do on a website

| ZHU does | ZHU never does |
|---|---|
| Finds the page's message box and inserts the question text | Sign in, fill in credentials, or solve CAPTCHAs |
| Attaches captured screenshots to the draft (paste, then the page's file input, then drop) | Press Send, submit a form, or click anything |
| Replaces its own unsent draft with the next question; appends below text you typed yourself | Read your conversations, answers, cookies, or page content |
| Reports honestly what the page accepted ("attached", "sent, not confirmed", "not accepted") | Insert anything on a sign-in, sign-up, or single-sign-on page |

The websites are the providers' own pages. Your use of them is governed by each provider's terms and by your account's limits.

**Privacy note.** A website can see what is in its message box before you press Send, and most sites upload an attachment as soon as it is added to a draft. With chat tabs open, detected questions and captured screenshots therefore reach those sites when they are placed in the draft, not when you press Send. Both automatic deliveries can be switched off (the options button on the AI chats tab strip, or Settings → AI chat tabs); nothing is delivered when no chat tab is open.

## Sign-in: once, for every tab

All chat tabs share one browser profile (`%LOCALAPPDATA%\app.zhu.desktop\webchat`), separate from the profile of ZHU's own interface. Cookies and site data are kept there, so:

* a sign-in to a site applies to every tab of that site and survives restarts;
* a Google, Microsoft or Apple sign-in done in one tab is available to the "Continue with …" buttons of the other sites;
* **Sign out of all chat sites** (delivery options) clears the whole profile. ZHU's own data is not touched.

One account cannot be shared between different providers: ChatGPT, Claude and Gemini each need their own sign-in (or the same Google/Microsoft/Apple identity through their "Continue with …" button).

Some providers refuse sign-in inside application-embedded browsers. Google does this for some accounts ("This browser or app may not be secure"). ZHU does not disguise itself to get around that. If a provider refuses, use its API (Providers) or its website in your normal browser with the copy workflow.

## Delivery

| Option | Default | Meaning |
|---|---|---|
| Send detected questions | on | Each question that completes while listening (or is revised afterwards) goes to the target tabs |
| Attach captured screenshots | on | Each new, non-duplicate screenshot is attached to the current draft |
| Send to | All tabs | *All tabs*, or only the *Selected tab*. Target tabs that have not been opened yet in this run are loaded in the background when listening starts (or when a delivery targets them), so the first question is not delayed by a page load |
| How answers should sound (Settings) | empty | When set, this sentence is placed before each question in the draft. The same text guides API models |

Manual delivery: **Send latest question** in the tab toolbar, and the chat icon on a question card.

Tab status dot: purple = a draft is waiting in a tab you are not looking at; green = loaded; orange = the last delivery needs attention (the message is shown in the tab's toolbar); grey = not loaded yet.

Rules the page helper follows (`apps/desktop/src-tauri/src/webchat_inject.js`):

1. A page that looks like a sign-in page (path such as `/login`, `/sign_in`, `/auth`; a host such as `accounts.*`; or a password field) is never written to. The delivery reports "sign-in page" after 4 s.
2. The message box is found through per-site hints first, then generically (the widest visible multi-line editor, low in the page). Single-line inputs are used only where a site's own hint names them.
3. Text: empty box or ZHU's own previous text → replace. Your own text in the box → append below it. Same text already there → nothing. The shell remembers the last text it inserted in each tab, so ZHU's own draft is still recognised when a site restores it after a page reload (not after ZHU itself restarts: then the restored draft counts as your text and is kept).
4. Text goes in the way the site's editor expects: the native value setter plus an `input` event for plain boxes; a paste event, then `insertText`, then `beforeinput` for rich editors, each verified before the next is tried so text is never inserted twice.
5. No timers are used. Chromium throttles timers in hidden tabs to as little as one wake-up per minute, and most deliveries go to hidden tabs; the shell drives every step.

## Tested behaviour

Measured on 2026-11-20 with the debug build on the development laptop (WebView2 157), **signed out** on every site; no account was used. Deliveries went to tabs that were not on screen, except where noted.

| Site | Question inserted | Next question replaces the draft | Screenshot | Notes |
|---|---|---|---|---|
| ChatGPT | ✓ | ✓ | ✓ attached (preview appeared) | Signed-out page uses a plain text box. The signed-in rich editor was not tested |
| Gemini | ✓ (rich editor, paste) | ✓ | ✗ page did not accept it | Signed-out Gemini offers no upload |
| Grok | ✓ | ✓ (rich editor, paste) | sent, not confirmed | The page swaps its text box for a rich editor while loading; handled |
| Perplexity | ✓ (rich editor, paste) | ✓ | sent, not confirmed | |
| Qwen | ✓ | ✓ | sent, not confirmed | |
| Le Chat (Mistral) | ✓ (rich editor, paste) | ✓ | sent, not confirmed | |
| Meta AI | ✓ | ✓ | ✗ page did not accept it | Its layout collapses to 0 × 0 while hidden; handled through the site hint |
| DeepSeek | — | — | — | Redirects to sign-in: correctly refused, nothing inserted |
| Claude | — | — | — | Redirects to sign-in: correctly refused, nothing inserted |
| Copilot | — | — | — | Shows a sign-in page: no message box, nothing inserted |

End to end (spoken question → local transcription → question detection → tabs): two questions played through the speakers appeared in a ChatGPT tab (hidden, loaded in the background for the delivery) and a Meta AI tab 1.8 s after the speaker stopped; the second question replaced the first, unsent draft in both; a captured screenshot attached itself in ChatGPT. Nothing was submitted on any site.

The same run with **ZHU's main window minimized** (both tabs hidden, loaded when listening started): the question was in both tabs within 1.6 s and the screenshot attached in ChatGPT. After a page reload in which ChatGPT restored the unsent draft, the next question replaced it.

Packaged release build: a Gemini tab opened from the AI chats screen and rendered in place; its browser process uses the separate `webchat` profile, has no DevTools port, and keeps SmartScreen enabled. Deliveries were exercised in the debug build only, because the release build has no test hook.

**Not tested:** any signed-in state (so: the signed-in editors of ChatGPT and Claude, attachments on sites that allow them only after sign-in, and whether each provider accepts sign-in inside ZHU), sites behind a CAPTCHA, and non-English site variants. Websites change without notice; when a site's message box is no longer found, the generic search is the fallback and the delivery otherwise reports the failure instead of guessing.

## Security

* Chat pages are remote content. Tauri rejects every IPC command from a non-local origin unless a capability names that origin, and none does. ZHU's capability also lists its own webviews by label (`main`, `bubble`), so a chat webview (`chat-…`) never matches. Verified in the running app: from a chat page, `engine_info` (which holds the engine token), `webchat_tabs`, `event.listen` and `clipboard-manager.write_text` are all rejected.
* Chat tabs may only navigate to `https:` pages, and never to `*.localhost`, so ZHU's own interface (which does have IPC access) cannot be loaded inside a chat tab.
* The only script ZHU runs in a page is the bundled helper; question text and image data are passed as JSON/base64 literals (image data is checked against the base64 alphabet before it is spliced into a script).
* The page can read anything the helper leaves in the page (`window.__zhu`): the text and images of the current delivery, which the page receives anyway. The helper reports only status back to the shell; a hostile page could at most fake a "delivered" status.
* SmartScreen stays enabled for the chat profile. Release builds never open a DevTools port (`ZHU_WEBCHAT_DEBUG_PORT` is honoured by debug builds only).
* A delivery is limited to 100,000 characters of text and 10 images of about 9 MB each; screenshots over 4 MB are re-encoded (JPEG, longest side 2560 px) before delivery.

## Memory

Each loaded chat tab is a full web page in its own renderer process (typically 150–400 MB). Tabs are created when first shown, when listening starts (target tabs only), or when first targeted by a delivery, and stay loaded until closed. On a machine that is short of memory, use **Selected tab** as the target, or keep fewer tabs.

## Architecture

```
question.completed / screenshot.created (engine WebSocket, main window only)
   └─ services/webchatDelivery.ts      gating (listening, switches, dedupe), template, per-tab queue, image re-encode
        └─ shell.webchatDeliver        Tauri command (apps/desktop/src-tauri/src/webchat.rs)
             ├─ eval webchat_inject.js + staged base64 chunks + begin(meta)
             └─ poll __zhu.step(job) every 150 ms through eval_with_callback until done / sign-in / no message box
features/webchat/WebChatScreen.tsx     tab strip + toolbar; reports the page area to the shell
webchat.rs                             child webviews of the main window (Window::add_child, Tauri "unstable" feature),
                                       shared data directory, https-only navigation, show/hide/bounds, clear data
```

ZHU's own menus and dialogs would be covered by the native page, so the page is hidden while one is open, and on this screen toasts are shown inline in the tab strip.
