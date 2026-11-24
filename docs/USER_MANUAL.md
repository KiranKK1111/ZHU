# User Manual

ZHU listens to a conversation, writes down the questions that are asked, and helps you answer them. It has four screens: **Home**, **AI chats**, **History**, and **Settings**.

## First start
1. Install and open ZHU. The first time, it asks you to download a speech model (once; it then works offline). See INSTALLATION.md. An installed model only takes disk space: it uses GPU memory while ZHU is listening, and that memory is released two minutes after you stop. To delete a model's files, open Settings → Speech recognition → **Change**, select the model, and press **Remove**.
2. Choose how you want answers. You can use either way, or both:
   * **An AI model inside ZHU** (Settings → AI models). Google Gemini, Groq, and OpenRouter have free tiers: press **Get a free key**, create the key on their site, paste it, and press **Connect**. ZHU checks the key and picks a model for you.
   * **The chat websites you already use** (AI chats): ChatGPT, Claude, Gemini, and others open as tabs inside ZHU. Sign in once, as in a browser.

## Home
* **Start listening** (in the title bar, on every screen) begins a session. Pressing it opens a short list of what to listen to: **System audio and microphone** (the call, your computer's sound, and what you say), **System audio only**, or **Microphone only**; pick one and ZHU starts. The one you used last is ticked, and the keyboard shortcut and the tray menu start with it. To change it while listening, use Settings → Listening → **Listen to**: it takes effect at once, in the same session. The speaker and the microphone themselves are chosen there too. While it listens, the title bar shows **Live** with the timer, and **Pause** (or **Resume**) and **Stop** next to it; the tray icon shows it too. If listening stops with an error, a notice says why and **Start listening** is offered again.
* **Questions** (left): every question that is asked appears here, newest first, written out clearly. While someone is still speaking, the card says "Still listening…".
  * **Answer** asks your AI model. **Copy** copies the question. The chat icon sends it to your chat tabs.
  * The **⋯** menu: **Edit wording**, or **Not a question** to remove it.
  * **Show transcript** / **Hide transcript** shows everything that was said, below the questions.
  * **Clear** (top of the questions list) removes every question from the list, after one confirmation. The transcript and your answers stay; a question asked again later is picked up again.
  * **Clear** (top right of the transcript) deletes everything transcribed in this session so far, after one confirmation. Questions and answers stay, and listening goes on.
* **Answers** (right): the model's answers for this session, like a chat.
  * The model chip in the box at the bottom shows the model that answers and changes it. The same model answers in Custom chat.
  * **Auto-answer**: when on, every detected question is answered without pressing anything.
  * Answers are shown formatted: headings, lists, tables, highlighted code and formulas.
  * The box at the bottom ("Ask anything") asks your own question. Enter sends; Shift+Enter starts a new line. The screen button on its left takes a screenshot of the whole screen and attaches it (for models that can read images). The capture is silent and leaves ZHU's own windows out of the picture.
* **New session** (the **+** next to Start listening, while nothing is being recorded) starts a fresh, empty session.
* **Sizes:** drag the line between Questions and Answers to give either more width, and the line above the transcript to give it more or less height. The sizes are kept for the next start; double-click a line to go back to the original sizes. With the keyboard: Tab to a line, then the arrow keys (Page Up/Down for bigger steps, Enter for the original size). In a narrow window Questions and Answers are stacked instead.

## AI chats
Sidebar → **AI chats** → **+**, then pick **Custom chat** or a site (or **Other website…**).

**Custom chat** is ZHU's own chat with free AI models. No model connected yet? Press **Start without a key** (two free public services), or **Connect a provider** and paste a free key. Then write a message and press Enter. The chip in the message box changes the model; it shows free models only until you switch that off. **Add or connect a provider** in that list adds any other service: ZHU finds its models and marks the free ones. **New chat** starts a fresh conversation and the clock button reopens earlier ones. Details: CHAT.md.

Chat websites work like this:

1. Sign in once in the tab. The sign-in is kept for every tab and after a restart.
2. While you are listening, each question is typed into the message box of your open tabs, and each screenshot you take is attached. A purple dot marks a tab with a draft waiting.
3. Review the draft and press the site's **Send** button. ZHU never presses it for you.

If you have not sent a draft when the next question arrives, the new question replaces it; text you typed yourself is kept. The button at the right of the tab strip sets what is delivered and to which tabs. An orange dot means a tab needs attention, usually because you need to sign in there. Details and the privacy note are in WEB_CHATS.md.

## Screenshots and résumé panel (right side)
The panel on the right of every screen. The button at the right of the title bar shows and hides it.

* **Screenshots**: everything you captured, newest first (**All**, or **This session**). The button at the top captures the whole screen.
  * **Drag** a screenshot onto a message box to attach it: the Custom chat, the ask box on Home, or a chat website (the page steps aside while you drag and takes the drop).
  * Hover a screenshot for **Add to chat**, **Copy image** and **Delete**. Click it for a large view. Tick several to add or delete them together; dragging one of them drags them all.
  * Nothing is sent to a model until you press Send in that message box.
* **Your résumé** (bottom): upload a PDF, Word (.docx) or text file once. While it is switched on, questions about you ("tell me about yourself", "what was your biggest project?") are answered from it, in your voice; other questions are answered as usual. **View text** shows exactly what ZHU read and sends. The switch stops it being sent; the bin removes it.

## Floating icon
When you minimize ZHU while it is hidden from the taskbar (the eye button, next section), its icon floats on top of your other windows (bottom-right the first time). Click it to bring ZHU back; drag it anywhere. While ZHU is in the taskbar there is no floating icon: the taskbar button brings the window back. A red dot on it means ZHU is recording, amber means paused. Switch it off under Settings → App → **Floating icon when minimized**.

The icon stays for as long as ZHU is hidden and minimized. If something else hides or minimizes it ("Show desktop" does), pushes it behind another window, or its page stops working, ZHU puts it back within a couple of seconds. Each time it is shown, hidden or repaired, one line with the reason is written to `logs\shell.log` in ZHU's data folder.

## Hide from the taskbar, Alt+Tab and screen capture
The eye button in the title bar takes ZHU out of the taskbar, Alt+Tab, Task View and screen captures; press it again to put it back. The tray menu has the same switch (**Hide from taskbar, Alt+Tab and screen capture** / **Show in taskbar, Alt+Tab and screen capture**).

* ZHU's windows stay on your screen where they are. Screenshots, recordings and screen sharing show what is behind them, as if ZHU were not there (Windows 10 version 2004 or later; older versions show a black rectangle). This covers the main window and the floating icon, not the tray menu or a "Save as" dialog.
* While it is hidden, the main window stays on top of your other windows, because Alt+Tab and the taskbar can no longer bring it back from behind them. When you show ZHU in the taskbar again, the main window is an ordinary window again.
* Hiding ZHU sets its opacity to 80%, so you can see what is behind it. Change it with the opacity button as you like while it is hidden; showing ZHU again brings back the opacity you had before. Every time you hide ZHU with the eye button it starts at 80% again.
* ZHU's icon leaves the system tray as well, so nothing by the clock gives it away; it is back as soon as you show ZHU again.
* Over ZHU the pointer freezes for others (see **Pointer** below): the real pointer stops where it enters ZHU, and an arrow that looks just like your own Windows pointer moves for you instead, over the title bar too.
* To get it out of the way while hidden, minimize it: the floating icon brings it back. Closing the window while hidden minimizes it too (with **Keep running when the window is closed** on). If you have switched the floating icon off, start ZHU again from the Start menu: that brings back the window that is already running.
* ZHU remembers it: if ZHU was hidden when it closed (or when the computer shut down), it opens hidden again, at the opacity it had, and it never shows in the taskbar, the tray or a screen share while it starts. Started with Windows, it waits minimized behind the floating icon. Press the eye button to show it again.

## Pointer
Over ZHU the pointer is always an arrow, and nothing else: no hand over buttons and links, no text beam over text boxes or text, no resize arrows over the dividers between panes or at the window's edges, also on the chat websites in AI chats. Typing, clicking, selecting text, dragging the dividers and resizing the window work as usual; only the pointer's shape stays the same.

With **Custom pointer** on (Settings → App), that arrow is ZHU's own violet arrow. It is still your one Windows pointer, so it moves exactly as before, and the moment it leaves ZHU it looks normal again. With it off, it is the Windows arrow. The chat websites show the Windows arrow, because those pages are not ZHU's. While ZHU is hidden there is no violet arrow anywhere: you only ever see your Windows pointer.

### While ZHU is hidden: the frozen pointer
A screen share or recording shows the mouse pointer as it is, even over a window it leaves out. So while ZHU is hidden, the real pointer stops where it enters ZHU, and ZHU moves an arrow of its own instead, which screen sharing leaves out like the rest of ZHU. That arrow looks exactly like your Windows pointer (your pointer scheme, at the size Windows shows it), so nothing on your screen gives ZHU away either:

* **What viewers see:** the pointer stands still where it entered ZHU (to them, an empty part of the screen). When you leave ZHU it glides on to where you left, in a fraction of a second, the way a hand moves a mouse.
* **What you see:** the Windows pointer standing still at the edge of ZHU, and the arrow moving with your mouse over all of ZHU, the title bar included. Clicks, double-clicks, scrolling, dragging (the dividers, text selection) and typing after a click all go to ZHU, as usual; a click also brings ZHU to the front. Drag the title bar to move the window, and double-click it to maximize or restore.
* **Resizing:** at the very edge of the window (where Windows resizes it) the real pointer is back: take the arrow to the edge, and press and drag as usual. Pressing while the pointer is still on its way there works too.
* If ZHU is hidden while the pointer is over it, the arrow takes over at your first movement and the real pointer moves off to ZHU's nearest edge. A dialog or menu in front of ZHU gets the real pointer.
* It lets go by itself when you leave ZHU, show ZHU again, or minimize it (the real pointer glides to the arrow), and at once when a pen, a touch screen or another program moves the pointer.
* **Limits:** dragging text or files out of ZHU into another program needs the real pointer, and a window moved by its title bar while frozen does not snap to the screen's edges. It is experimental: if a click or a drag does not behave, switch it off under Settings → App → **Freeze the pointer while hidden**; the pointer then stays the Windows arrow over a hidden ZHU and moves normally.

## Opacity
The opacity button in the title bar (next to the eye) makes ZHU see-through, from 40% to 100%. It applies to everything in ZHU: every screen with its menus and dialogs, the chat websites in AI chats, and the floating icon. **Back to 100%** in the same place makes ZHU solid again. Your choice is kept for the next start. While ZHU is hidden it has a level of its own (see above).

## Screenshots
**Ctrl+Shift+A** captures the whole screen. A screenshot is attached to your chat-tab drafts, and to the ask box on Home when your model can read images.

## History
Every session with its questions and answers. **Open** shows it on Home again. The **⋯** menu renames it, saves it as a file, or deletes it.

## Settings
Five groups; the list on the left jumps between them.

* **Answers**: **Manage models** opens the AI models dialog (connect, change the model, remove a key, or add a provider of your own: a local Ollama or LM Studio server, or any OpenAI-compatible address). Also here: answer questions automatically, **How answers should sound** (an optional sentence added to every question, for example "Answer briefly, the way I would say it in an interview."), and your résumé.
* **Listening**: the call, the microphone, the language, and the speech model.
* **Chat tabs**: what is filled in automatically, and **Sign out of all chat sites**.
* **App**: dark or light, the panel on the right, start with Windows, ZHU's pointer, freezing the pointer while hidden, keep running in the tray. **Edit shortcuts** opens the keyboard shortcuts dialog: click a shortcut, then press the new keys.
* **Your data**: keep or drop the full transcript, and **Delete everything**.

Recognition and question-detection tuning (thresholds, GPU memory budget, vocabulary) use built-in defaults. They remain adjustable through the engine's settings API for unusual setups; see CONFIGURATION.md.
