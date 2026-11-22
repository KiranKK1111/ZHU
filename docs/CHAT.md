# Custom chat (ZHU's own chat)

AI chats → **Custom chat** opens a chat that ZHU draws itself: a conversation with any model of the providers connected under Settings → AI models. It is a tab like the website tabs, but it has no webview, no sign-in page, and nothing is typed into a third-party page.

## What it does

* **Model per message.** The chip in the message box lists the models of every connected provider, grouped by provider, with a search box. **Free models only** is on by default; switch it off to see the paid ones too. The whole conversation is sent as context with each message, so the model can be changed between turns.
* **Free models are recognized automatically** when a provider is connected, including a provider you add yourself. How: [PROVIDERS.md](PROVIDERS.md#which-models-are-free).
* **Start without a key.** With no provider connected, **Start without a key** connects Kilo Gateway and Pollinations, which answer without an account. Their model providers may log what is sent; the screen says so.
* **Answers stream in** as Markdown: headings, lists, tables, highlighted code with a copy button, and LaTeX. A reasoning model's thinking is shown folded under "Thinking…" / "Thought it through".
* **Stop**, **Answer again** (replaces the last answer, with the model currently selected) and **Try again** after an error. A provider's error message is shown in the answer bubble, with its retry time when it sent one.
* **Conversations are kept** in the local database. **New chat** starts another in the same tab; the clock button reopens or deletes earlier ones. Closing a tab does not delete its conversation.
* **Detected questions** reach a Custom chat tab the same way they reach website tabs: the question is placed in the message box, and you press Send.
* **Screenshots** are attached by dragging them from the panel on the right onto the message box, or with a screenshot's **+** button; new captures are attached automatically while that option is on. They are sent with the message to models that read images. In the model list, small icons after each name show what the model takes, as its provider's list states it: images, documents, audio, video, or **T** for text only; the chips under the search box explain the icons and, when clicked, show only those models. A provider that does not say gets no icons. ZHU itself sends text and screenshots only. Home's ask box has the same model list: choosing a model there also makes it that provider's model in Settings. A gateway (Kilo Gateway, OpenRouter) offers models that read images next to text-only ones, and its model list says which is which: with a text-only model selected, the message box says so and offers a model of the same provider that reads images (a free one when the selected model is free). Other providers do not say; there ZHU cannot know, and when the selected provider is not set to read images, the message box says so and offers **Allow images**. Earlier turns go along as text; only the new message carries its images.
* **Your résumé** (bottom of the panel on the right), while switched on, is given to the model with every message, so questions about you are answered from it. See [Résumé](#résumé).

## Privacy

A message goes to the provider whose model is selected, with the earlier turns of that conversation, its attached screenshots, and your résumé if one is switched on, when you press Send. Nothing is sent before that: placing a detected question or a screenshot in the message box is local. The system prompt is fixed ("You are a helpful assistant in ZHU…"); the "How answers should sound" text from Settings is not added here. Conversations are removed by **Delete everything**.

Text from a model is treated as text. Raw HTML in an answer is not interpreted, remote images are not loaded (the link is shown instead), and links open in your browser, never inside ZHU's window.

## Résumé

Upload a PDF, a Word document (.docx) or a text file in the panel on the right. The engine reads the text out of it (`engine/zhu_engine/resume.py`: pypdf for PDF, the document XML for Word) and keeps only that text, up to 24,000 characters; the file itself is not stored. **View text** shows exactly what was read, which is exactly what a model receives.

Nothing about the résumé is hard-coded. There is no list of "profile questions", no keyword matching and no prepared answers. While the résumé is switched on, its text is appended to the system prompt of every request (the Home answers and the Custom chat) with one instruction: answer questions that are about the user from the résumé, in the first person, using only what it states, and leave it out of everything else. The model decides, per question, whether it is about the user and which parts are relevant. The switch on the résumé card stops it being sent without deleting it. It is not added to the drafts typed into chat websites.

Live check with a made-up résumé and `kilo-auto/free`: "Tell me about yourself, and what was your biggest impact at your current job?" was answered in the first person with the résumé's own facts (role, employer, the latency figures); the next question, about mutexes and semaphores, was answered without any mention of it.

## How it works

```text
ChatPane (features/chat) ── POST /api/chats/{id}/messages {provider_id, model, content | regenerate}
        ▲                              │
        │ chat.delta / chat.completed  ▼
   useChat store  ◄── WebSocket ── SessionService.chat_send → adapter.stream_response
```

* Engine: `SessionService.chat_*` in `engine/zhu_engine/session.py`; routes `GET/POST /api/chats`, `GET/PATCH/DELETE /api/chats/{id}`, `POST /api/chats/{id}/messages`. One answer streams per conversation at a time (409 otherwise). Cancelling uses the existing `POST /api/requests/{id}/cancel`.
* Context (`_chat_history`): the last 40 messages within 120,000 characters, always starting with a user turn. An answer that failed before any text arrived is left out together with its question, so roles alternate. A model's thinking is never sent back.
* Thinking: the OpenAI-compatible adapter turns `reasoning` / `reasoning_content` deltas into `reasoning` events. The chat stores them inside a leading `<think>…</think>` block; the Home screen's answers ignore them.
* Events: `chat.delta`, `chat.completed`, `chat.error` (`status` is `failed` or `cancelled`), `chat.updated`, `chat.deleted`. An answer still streaming when the engine stops is marked `cancelled` on the next start, keeping the text that had arrived.
* Front end: `ChatPane` (header, message box), `Messages` (bubbles, scroll following), `Markdown` (react-markdown with GFM, KaTeX and highlight.js), `ModelPicker`, and the pure helpers `models.ts` and `chatText.ts`. The pane is a separate chunk that loads with the first chat tab.
* Scrolling: while you are at the bottom the view follows the answer; once you scroll up it stays put and a **Latest** button brings you back.

## Tested

`engine/tests/test_chat.py` (free-model detection, model-list shapes, context building, a full conversation against a local gateway-like server: two turns with two models, answer again, a provider error and the retry, thinking, rejected requests, purge and interrupted answers) and `apps/desktop/tests/chat.test.tsx` (model list and default choice, text preparation, the rendered Markdown, the store, questions reaching the chat's message box).

Live on 2026-11-20, front end in a browser against a development engine with throwaway data: Start without a key (Kilo Gateway: 14 free models found), a streamed answer with thinking, code, a table and a formula from `kilo-auto/free`, stop, try again, reopening the conversation after a reload, and adding the same gateway as a custom provider ("14 of them free", a free model selected). **Not tested: the providers that need a key** (SambaNova, NVIDIA NIM, Z.ai and the earlier ones); their addresses and free tiers come from their documentation.
