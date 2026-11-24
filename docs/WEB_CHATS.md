# Chat websites (embedded provider websites)

The chat tabs beside the questions open the chat websites you already use (ChatGPT, Claude, Gemini, Qwen, Meta AI, DeepSeek, Grok, Copilot, Perplexity, Le Chat, or any other https site) inside the ZHU window, next to ZHU's own Custom chat (CHAT.md). Open one with the **+** on the tab strip. You sign in with your own account, as you would in a browser. While you are listening, ZHU puts each detected question into the message box of the open tabs and attaches each captured screenshot to the draft. **You press Send.**

## What ZHU does and does not do on a website

| ZHU does | ZHU never does |
|---|---|
| Finds the page's message box and inserts the question text | Sign in, fill in credentials, or solve CAPTCHAs |
| Attaches captured screenshots to the draft (paste, then the page's file input, then drop) | Press Send, submit a form, or click anything |
| Replaces its own unsent draft with the next question; appends below text you typed yourself | Read your conversations, answers, cookies, or page content |
| Adds your resume (and the job, if you added one) to the first question of a **new** chat, once: as a text file, or as text where the site takes no files | Add the resume to a chat that is already under way |
| Reports honestly what the page accepted ("attached", "sent, not confirmed", "not accepted") | Insert anything on a sign-in, sign-up, or single-sign-on page |

The websites are the providers' own pages. Your use of them is governed by each provider's terms and by your account's limits.

**Privacy note.** A website can see what is in its message box before you press Send, and most sites upload an attachment as soon as it is added to a draft. With chat tabs open, detected questions, captured screenshots and your resume therefore reach those sites when they are placed in the draft, not when you press Send. Each automatic delivery can be switched off (the options button at the right of the chat tab strip, or Settings → Chat tabs); nothing is delivered automatically when no chat tab is open. The resume goes only while its switch in the side panel is on.

## Sign-in: once, for every tab

All chat tabs share one browser profile (`%LOCALAPPDATA%\app.zhu.desktop\webchat`), separate from the profile of ZHU's own interface. Cookies and site data are kept there, so:

* a sign-in to a site applies to every tab of that site and survives restarts;
* a Google, Microsoft or Apple sign-in done in one tab is available to the "Continue with …" buttons of the other sites;
* **Sign out of all chat sites** (delivery options) clears the whole profile. ZHU's own data is not touched.

One account cannot be shared between different providers: ChatGPT, Claude and Gemini each need their own sign-in (or the same Google/Microsoft/Apple identity through their "Continue with …" button). Signing in to one site does not sign you in to the others: each site has its own accounts and its own session, and a website cannot read another site's sign-in (browsers keep each site's cookies to that site). What carries over is the identity: after the first "Continue with Google" (or Microsoft, Apple), the others ask only which account to use, without the password. Each site is signed in to once; after that it stays signed in, in every tab and after a restart, until the site itself ends the session.

**Sign-in windows.** Some "Continue with …" buttons open a small sign-in window. It opens as a separate window in the same profile and closes itself when the sign-in is done. (Builds before 2026-11-24 refused every window a chat page opened, so such a button did nothing.) A link that a site opens in a new tab, such as a source in an answer, opens in your normal browser instead (at most one a second). A sign-in window is an ordinary window: while ZHU is hidden it appears in the taskbar and in screen captures, and it can open behind ZHU's main window, which then stays on top. Sign in while ZHU is shown.

Some providers refuse sign-in inside application-embedded browsers. Google does this for some accounts ("This browser or app may not be secure"). ZHU does not disguise itself to get around that. If a provider refuses, use its API (Providers) or its website in your normal browser with the copy workflow.

## Delivery

| Option | Default | Meaning |
|---|---|---|
| Send detected questions | on | Each question that completes while listening (or is revised afterwards) goes to the target tabs |
| Attach captured screenshots | on | Each new, non-duplicate screenshot is attached to the current draft |
| Send to | All tabs | *All tabs*, or only the *Selected tab*. Target tabs that have not been opened yet in this run are loaded in the background when listening starts (or when a delivery targets them), so the first question is not delayed by a page load |
| (no setting) Your resume in new chats | always | `resume-zhu-….txt` (or `resume-and-job-zhu-….txt`, the whole resume and job) is attached to the first question of a new chat, once, and a one-line note above the question asks the site to use it for the whole chat; where the site takes no file, the text goes in the message instead. Later questions in that chat go without it |
| How answers should sound (Settings) | empty | When set, this sentence is placed before each question in the draft. The same text guides API models |

Manual delivery: **Send to chat** on a question card in the questions column beside the tabs (collapsible), and **Add to …** on a screenshot in the panel on the right (the tab that is shown). There is no strip under the tabs (back, reload, address, buttons): the site's page starts right below them, and the site's own links do the navigating. With no chat tab open, **Send to chat** and **Add to …** open a Custom chat tab and put the question or screenshot there.

What goes with the resume: the same instruction the API models get, written as you ("When a question in this chat is about me … answer it from my resume, in the first person … use only facts my resume states"), then the resume in use and the job. It is built by the engine (`resume.chat_context`), so the text is exactly what **View and edit** shows.

Tab status dot: purple = a draft is waiting in a tab you are not looking at; green = loaded; orange = the last delivery needs attention (pointing at the tab shows the message); grey = not loaded yet.

Rules the page helper follows (`apps/desktop/src-tauri/src/webchat_inject.js`):

1. A page that looks like a sign-in page (path such as `/login`, `/sign_in`, `/auth`; a host such as `accounts.*`; or a password field) is never written to. The delivery reports "sign-in page" after 4 s.
2. The message box is found through per-site hints first, then generically (the widest visible multi-line editor, low in the page). Single-line inputs are used only where a site's own hint names them.
3. Text: empty box or ZHU's own previous text → replace. Your own text in the box → append below it. Same text already there → nothing. The shell remembers the last text it inserted in each tab, so ZHU's own draft is still recognised when a site restores it after a page reload (not after ZHU itself restarts: then the restored draft counts as your text and is kept).
4. Text goes in the way the site's editor expects: the native value setter plus an `input` event for plain boxes; a paste event, then `insertText`, then `beforeinput` for rich editors, each verified before the next is tried so text is never inserted twice.
5. No timers are used. Chromium throttles timers in hidden tabs to as little as one wake-up per minute, and most deliveries go to hidden tabs; the shell drives every step.
6. The resume, decided once per delivery before anything is typed:
   * **A new chat** is the site's empty-chat address (`/` on most sites, `/new` on Claude, `/app` on Gemini, `/chat` on Le Chat, and the tab's own start page). After the first message the sites move to the conversation's address (`/c/…`, `/chat/…`), so later questions go without it.
   * **Already there**: every copy carries a marker (`zhu-` and 8 characters, from the text), in the file name and the first line. It is looked for outside the message box: in the conversation, and in the name, tooltip or label of an attachment. A changed resume has a new marker.
   * **ZHU's own unsent draft** that holds the resume (as text, or the note of the attached file) keeps it when the next question replaces the draft; no second file is attached.
   * **The file** is handed over like a screenshot: paste, then a file picker whose `accept` list takes `.txt`, then a drop. When none takes it, the resume goes in the message as text.
   * A site that turns a long paste into an attachment (rather than text in the box) counts as done, so the text is never put in twice.

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

Packaged release build: a Gemini tab opened from the tab strip and rendered in place; its browser process uses the separate `webchat` profile, has no DevTools port, and keeps SmartScreen enabled. Deliveries were exercised in the debug build only, because the release build has no test hook.

The resume in a new chat (2026-11-24) is covered by the page helper's tests in `apps/desktop/tests/webchat.test.ts`, on plain pages: as text above the question, kept when the draft is replaced, left out after the conversation moves to its own address and back in for the next new chat; as a file through a file picker (name, type and content checked), with no second file for the next question; text instead where the page takes no files; left out of a chat under way unless asked for; not added again where the marker shows in the page or in an attachment's label.

**Not tested:** any signed-in state (so: the signed-in editors of ChatGPT and Claude, attachments on sites that allow them only after sign-in, and whether each provider accepts sign-in inside ZHU), the resume on the live sites (which of them take a text file in the draft, and whether each moves to a conversation address after the first message), sites behind a CAPTCHA, and non-English site variants. Websites change without notice; when a site's message box is no longer found, the generic search is the fallback and the delivery otherwise reports the failure instead of guessing.

## Security

* Chat pages are remote content. Tauri rejects every IPC command from a non-local origin unless a capability names that origin, and none does. ZHU's capability also lists its own webviews by label (`main`, `bubble`), so a chat webview (`chat-…`) never matches. Verified in the running app: from a chat page, `engine_info` (which holds the engine token), `webchat_tabs`, `event.listen` and `clipboard-manager.write_text` are all rejected.
* Chat tabs may only navigate to `https:` pages, and never to `*.localhost`, so ZHU's own interface (which does have IPC access) cannot be loaded inside a chat tab.
* The scripts ZHU runs in a page are the bundled helper, with question text and image data passed as JSON/base64 literals (image data is checked against the base64 alphabet before it is spliced into a script), and a fixed style rule that keeps the pointer the arrow, as everywhere in ZHU (`POINTER_JS` in `webchat.rs`; it carries no data).
* The page can read anything the helper leaves in the page (`window.__zhu`): the text and images of the current delivery, which the page receives anyway. The helper reports only status back to the shell; a hostile page could at most fake a "delivered" status.
* SmartScreen stays enabled for the chat profile. Release builds never open a DevTools port (`ZHU_WEBCHAT_DEBUG_PORT` is honoured by debug builds only).
* A delivery is limited to 100,000 characters of text and 10 images of about 9 MB each; screenshots over 4 MB are re-encoded (JPEG, longest side 2560 px) before delivery.
* The resume part of a delivery is checked by the shell before it reaches a page (`DeliverContext::check`): the marker is letters, digits and hyphens only (the helper puts it in a CSS attribute selector), the file name is plain characters ending in `.txt`, and the text is at most 80,000 characters.

## Memory

Each loaded chat tab is a full web page in its own renderer process (typically 150–400 MB). Tabs are created when first shown, when listening starts (target tabs only), or when first targeted by a delivery, and stay loaded until closed. On a machine that is short of memory, use **Selected tab** as the target, or keep fewer tabs.

## Architecture

```
question.completed / screenshot.created (engine WebSocket, main window only)
   └─ services/webchatDelivery.ts      gating (listening, switches, dedupe), template, per-tab queue, image re-encode
        └─ shell.webchatDeliver        Tauri command (apps/desktop/src-tauri/src/webchat.rs)
             ├─ eval webchat_inject.js + staged base64 chunks + begin(meta)
             └─ poll __zhu.step(job) every 150 ms through eval_with_callback until done / sign-in / no message box
features/webchat/WebChatScreen.tsx     the app's main screen: questions column (components/questions/QuestionsColumn.tsx)
                                       + tab strip; reports the page area to the shell, which a ResizeObserver keeps
                                       current while the column is dragged, collapsed or opened
features/webchat/tabs.ts               openChatTab (the + menu), chatTabsOrCustom (a Custom chat for a question or
                                       screenshot when no tab is open)
webchat.rs                             child webviews of the main window (Window::add_child, Tauri "unstable" feature),
                                       shared data directory, https-only navigation, show/hide/bounds, clear data
```

ZHU's own menus and dialogs would be covered by the native page, so the page is hidden while one is open, and on this screen toasts are shown inline in the tab strip.
