// ZHU web chat helper. Evaluated by the shell inside an embedded chat tab (never loaded from the network).
//
// What it does: finds the page's message box, puts the question text into it, and attaches
// screenshots to the draft. In a new chat it also adds the user's resume (as a text file, or as
// text before the question), once. What it never does: sign in, press Send, read conversations, or
// send anything anywhere. The user reviews the draft and presses the site's own Send button.
// (To tell whether the resume is already in a chat it only looks for its marker, a short code in
// the resume's file name and first line.)
//
// It is driven entirely by the shell: `begin` registers a delivery and each `step` call advances it
// by one phase and returns its status. No timers are used, because Chromium throttles timers in
// hidden tabs to as little as one wake-up per minute, and most deliveries go to background tabs.
(function () {
  "use strict";
  var VERSION = 9;
  if (window.__zhu && window.__zhu.version === VERSION) return;

  // Known message-box selectors per site. They are hints only: when none matches, the generic
  // search below picks the largest visible editable area, so a site redesign degrades gracefully.
  var SELECTORS = {
    chatgpt: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', 'textarea[data-testid="prompt-textarea"]'],
    claude: ['div[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]', 'fieldset [contenteditable="true"]'],
    gemini: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]'],
    qwen: ["textarea#chat-input", "#chat-input", "textarea.chat-input", 'textarea[placeholder]'],
    meta: ['input[placeholder*="Meta AI" i]', '[role="textbox"][contenteditable="true"]', "textarea"],
    deepseek: ["textarea#chat-input", "textarea"],
    grok: ['div.ProseMirror[contenteditable="true"]', 'textarea[aria-label]', "textarea"],
    copilot: ["textarea#userInput", 'textarea[data-testid="composer-input"]', "textarea"],
    perplexity: ["#ask-input", 'div[contenteditable="true"][role="textbox"]', "textarea"],
    mistral: ['div.ProseMirror[contenteditable="true"]', "textarea"],
    chatbox: ["textarea", 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
  };
  var EDITABLE = 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]';

  // The address of a new, empty chat on each site. Once the first message is sent, the sites move
  // to the conversation's own address (/c/…, /chat/…), and every later question goes there.
  var NEW_CHAT = {
    chatgpt: ["/"],
    claude: ["/new", "/"],
    gemini: ["/app", "/"],
    qwen: ["/"],
    meta: ["/"],
    deepseek: ["/"],
    grok: ["/"],
    copilot: ["/"],
    perplexity: ["/"],
    mistral: ["/chat", "/"],
    chatbox: ["/app/chat", "/app", "/"],
  };

  var jobs = {};
  var staged = {};
  // Per-document memory: the last text ZHU put into the box (so an unsent draft can be replaced by
  // the next question), the screenshots already attached here (so none is attached twice), and
  // where the resume was last attached (so a draft whose attachment shows no name gets no second one).
  // The shell also passes the last text it inserted in this tab (`previous`), which survives reloads.
  var memory = { lastText: "", sentImages: {}, contextAt: null };

  function isTextControl(el) {
    return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === "text");
  }

  /**
   * Can text be put into this element? `anySize` skips the size check: some sites collapse their
   * whole layout to 0 x 0 while the tab is hidden, and most deliveries go to hidden tabs. It is only
   * used for a site's own known message box, never for the generic search.
   */
  function usable(el, anySize) {
    if (!el || !el.isConnected) return false;
    if (isTextControl(el)) {
      if (el.disabled || el.readOnly) return false;
    } else if (!el.isContentEditable) {
      return false;
    }
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    if (anySize) return true;
    var r = el.getBoundingClientRect();
    return r.width >= 80 && r.height >= 12;
  }

  /**
   * Sign-in, sign-up and single-sign-on pages. Nothing is ever inserted on these: their text
   * fields are for credentials, not for questions.
   */
  function signInPage() {
    var path = location.pathname || "";
    if (/(^|\/)(sign[_-]?in|log[_-]?in|sign[_-]?up|register|auth|oauth2?|sso|challenge|verify)(\/|$)/i.test(path)) return true;
    if (/^(accounts|account|login|auth|id|signin|sso|appleid)\./i.test(location.hostname)) return true;
    var pw = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < pw.length; i++) if (getComputedStyle(pw[i]).display !== "none") return true;
    return false;
  }

  function queryDeep(selector, root, out, budget) {
    // Light DOM first; then open shadow roots (bounded, so a huge page cannot stall the tab).
    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) out.push(found[i]);
    var all = root.querySelectorAll("*");
    for (var k = 0; k < all.length && budget.left > 0; k++) {
      budget.left--;
      if (all[k].shadowRoot) queryDeep(selector, all[k].shadowRoot, out, budget);
    }
    return out;
  }

  function findComposer(service) {
    var hints = SELECTORS[service] || [];
    var passes = document.visibilityState === "hidden" ? [false, true] : [false];
    for (var p = 0; p < passes.length; p++) {
      for (var i = 0; i < hints.length; i++) {
        var els = document.querySelectorAll(hints[i]);
        for (var k = 0; k < els.length; k++) if (usable(els[k], passes[p])) return els[k];
      }
    }
    var cands = queryDeep(EDITABLE, document, [], { left: 20000 });
    var best = null;
    var bestScore = 0;
    var vh = window.innerHeight || 1;
    for (var c = 0; c < cands.length; c++) {
      var el = cands[c];
      if (!usable(el)) continue;
      // Skip an editable region nested in another candidate (the outer one is the editor root).
      if (!isTextControl(el) && el.parentElement && el.parentElement.closest('[contenteditable="true"]')) continue;
      var r = el.getBoundingClientRect();
      // Chat composers are wide and sit low in the viewport; search boxes are narrow and sit high.
      var score = r.width * (1 + Math.max(0, Math.min(1, r.bottom / vh)));

      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function readText(el) {
    return isTextControl(el) ? el.value : el.innerText || el.textContent || "";
  }

  function norm(s) {
    return String(s || "").replace(/[​﻿]/g, "").replace(/\s+/g, " ").trim();
  }

  function selectIn(el, mode) {
    el.focus();
    if (isTextControl(el)) {
      var n = el.value.length;
      try {
        el.setSelectionRange(mode === "replace" ? 0 : n, n);
      } catch (e) {
        /* some input types have no selection API */
      }
      return;
    }
    var sel = window.getSelection();
    if (!sel) return;
    var range = document.createRange();
    range.selectNodeContents(el);
    if (mode !== "replace") range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function setNativeValue(el, value) {
    // Frameworks such as React track the value through the prototype setter, so assigning
    // el.value directly would be ignored. Use the native setter, then fire a real input event.
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Returns true when the page's editor claimed the event (called preventDefault). */
  function pasteData(el, dt) {
    var ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    return !el.dispatchEvent(ev);
  }

  function insertText(j, attempt) {
    var el = j.el;
    var text = j.textMode === "append" ? "\n\n" + j.text : j.text;
    j.insertPreviewsBefore = previewCount();
    if (isTextControl(el)) {
      var base = j.textMode === "append" ? el.value.replace(/\s+$/, "") : "";
      setNativeValue(el, base + text);
      j.method = "value";
      j.claimed = true;
      return;
    }
    if (attempt === 0) {
      var dt = new DataTransfer();
      dt.setData("text/plain", text);
      j.claimed = pasteData(el, dt);
      j.method = "paste";
    } else if (attempt === 1) {
      j.claimed = !!document.execCommand("insertText", false, text);
      j.method = "insertText";
    } else {
      var ev = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text });
      j.claimed = !el.dispatchEvent(ev);
      j.method = "beforeinput";
    }
  }

  function buildFiles(j) {
    var files = [];
    var parts = staged[j.meta.job] || [];
    for (var i = 0; i < j.meta.images.length; i++) {
      var info = j.meta.images[i];
      if (!j.meta.force && memory.sentImages[info.id]) continue;
      var b64 = parts[i];
      if (!b64) continue;
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      files.push({ id: info.id, file: new File([bytes], info.name, { type: info.mime, lastModified: Date.now() }) });
    }
    return files;
  }

  function previewCount() {
    // Rough signal that the page accepted an image: uploads show a blob/data preview or an
    // attachment chip near the composer. Used only to report "confirmed" or "not confirmed".
    return document.querySelectorAll('img[src^="blob:"], img[src^="data:image"], [class*="attachment" i], [data-testid*="attachment" i], [class*="file-preview" i], [aria-label*="Remove" i]').length;
  }

  /** Does a file input's `accept` list take this file? (empty: anything) */
  function accepts(input, file) {
    var list = (input.getAttribute("accept") || "").toLowerCase().split(",");
    var name = file.name.toLowerCase();
    var type = (file.type || "").toLowerCase();
    var any = true;
    for (var i = 0; i < list.length; i++) {
      var a = list[i].trim();
      if (!a) continue;
      any = false;
      if (a === "*" || a === "*/*" || a === type) return true;
      if (a.charAt(0) === "." && name.slice(-a.length) === a) return true;
      if (a.slice(-2) === "/*" && type.indexOf(a.slice(0, -1)) === 0) return true;
    }
    return any;
  }

  /**
   * Hand files to the page the way a person would: paste them into the message box, else put them
   * into the page's own file picker, else drop them on the box. Returns how, or "none".
   */
  function handOver(el, files) {
    var dt = new DataTransfer();
    for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
    el.focus();
    if (pasteData(el, dt)) return "paste";
    var inputs = queryDeep('input[type="file"]', document, [], { left: 20000 });
    for (var k = 0; k < inputs.length; k++) {
      if (inputs[k].disabled) continue;
      var ok = true;
      for (var f = 0; f < files.length; f++) ok = ok && accepts(inputs[k], files[f]);
      if (!ok) continue;
      inputs[k].files = dt.files;
      inputs[k].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[k].dispatchEvent(new Event("change", { bubbles: true }));
      return "file-input";
    }
    // Last resort: many pages accept files dropped on the message box.
    var types = ["dragenter", "dragover", "drop"];
    var dropped = false;
    for (var t = 0; t < types.length; t++) {
      var de = new DragEvent(types[t], { dataTransfer: dt, bubbles: true, cancelable: true });
      dropped = !el.dispatchEvent(de);
    }
    return dropped ? "drop" : "none";
  }

  function attachImages(j) {
    var files = buildFiles(j);
    j.imagesTotal = files.length;
    if (!files.length) return;
    j.previewsBefore = previewCount();
    j.imagesMethod = handOver(
      j.el,
      files.map(function (f) {
        return f.file;
      }),
    );
    if (j.imagesMethod !== "none") for (var m = 0; m < files.length; m++) memory.sentImages[files[m].id] = true;
  }

  // ------------------------------------------------------------------ the resume in a new chat
  function pathOf(p) {
    return String(p || "/").replace(/\/+$/, "") || "/";
  }

  function newChat(service, home) {
    var here = pathOf(location.pathname);
    var known = (NEW_CHAT[service] || ["/"]).concat(home ? [pathOf(home)] : []);
    return known.indexOf(here) >= 0;
  }

  function count(haystack, needle) {
    return needle ? String(haystack || "").toLowerCase().split(needle).length - 1 : 0;
  }

  /** The marker somewhere other than the message box: in a sent message, or on the draft's attachment. */
  function onPage(marker, el) {
    var m = marker.toLowerCase();
    if (count(document.body ? document.body.textContent : "", m) > count(readText(el), m)) return true;
    // Attachment chips often show the file name only in a tooltip or a label. The marker is
    // letters, digits and hyphens, so it is safe inside a selector.
    var sel = ["title", "aria-label", "alt", "download", "data-filename"]
      .map(function (a) {
        return "[" + a + '*="' + m + '" i]';
      })
      .join(",");
    try {
      return !!document.querySelector(sel);
    } catch (e) {
      return false;
    }
  }

  /**
   * Does this delivery add the resume? Returns null (no), "file" or "text" (add it that way), or
   * "keep" / "keep-file": ZHU's own unsent draft already holds it (as text, or as an attachment
   * with its note), and it stays when the draft is replaced by the new question.
   */
  function contextPlan(m, el) {
    var c = m.context;
    if (!c || !c.marker) return null;
    var draft = norm(readText(el)).toLowerCase();
    // The note names the file, so it holds the marker too: look for the note first.
    if (c.note && draft.indexOf(norm(c.note).toLowerCase()) >= 0) return "keep-file";
    if (draft.indexOf(c.marker.toLowerCase()) >= 0) return "keep";
    var here = pathOf(location.pathname);
    // The draft already carries ZHU's attachment (whose chip may show no name).
    if (memory.contextAt && memory.contextAt.path === here && memory.contextAt.marker === c.marker && previewCount() > 0) return "keep-file";
    if (!c.force) {
      if (!newChat(m.service, c.home)) return null; // a chat under way has it already, or the user adds it
      if (onPage(c.marker, el)) return null;
    }
    return c.mode === "text" ? "text" : "file";
  }

  /** The text that goes into the box: the note or the resume itself, then the question. */
  function composeText(j) {
    var c = j.meta.context;
    var q = j.meta.text || "";
    if (j.ctxAs === "text") return q ? c.text + "\n\n" + c.question_heading + "\n" + q : c.text;
    if (j.ctxAs === "file") return q ? c.note + "\n\n" + q : c.note;
    return q;
  }

  function attachContext(j) {
    var c = j.meta.context;
    var file = new File([c.text], c.file_name, { type: "text/plain", lastModified: Date.now() });
    j.ctxPreviewsBefore = previewCount();
    j.ctxMethod = handOver(j.el, [file]);
    if (j.ctxMethod === "none") {
      j.ctxAs = "text"; // this site takes no files here: the resume goes in the message instead
      return false;
    }
    j.ctxAs = "file";
    memory.contextAt = { path: pathOf(location.pathname), marker: c.marker };
    return true;
  }

  function contextResult(j) {
    if (!j.meta.context) return null;
    if (j.ctxPlan === "keep" || j.ctxPlan === "keep-file") return "already_there";
    if (!j.ctxPlan) return "skipped";
    if (j.ctxAs === "file") return "file";
    return j.textOk ? "text" : "failed";
  }

  function finish(j, extra) {
    var r = {
      done: true,
      ok: true,
      url: location.href,
      text: j.textMode === "none" ? "none" : j.textMode === "skip" ? "already_there" : j.textOk ? j.textMode : "failed",
      text_method: j.method || null,
      images: j.imagesTotal || 0,
      images_method: j.imagesMethod || null,
      images_confirmed: !!j.imagesConfirmed,
      context: contextResult(j),
      context_method: j.ctxMethod || null,
      context_confirmed: !!j.ctxConfirmed,
    };
    // What now stands in the box, so the shell can recognize ZHU's own draft after a reload.
    if (j.textMode === "replace" && j.textOk) r.inserted = j.text;
    if (extra) for (var k in extra) r[k] = extra[k];
    if (r.text === "failed" || r.context === "failed" || (r.images > 0 && r.images_method === "none")) r.ok = false;
    j.result = r;
    delete staged[j.meta.job];
    j.el = null;
    return r;
  }

  /** Decide what the box receives and how (replace ZHU's own draft, add to the user's, or nothing). */
  function planText(j) {
    var m = j.meta;
    var cur = norm(readText(j.el));
    var ours = !cur || cur === norm(memory.lastText) || cur === norm(m.previous);
    // ZHU's unsent draft holds the resume as text: it goes again with the new question. If the
    // user changed the draft, the question is added below and the resume stays where it is.
    if (j.ctxPlan === "keep") j.ctxAs = ours ? "text" : null;
    if (j.ctxPlan === "keep-file") j.ctxAs = ours ? "file" : null;
    j.text = composeText(j);
    var want = norm(j.text);
    if (!want) j.textMode = "none";
    else if (cur.indexOf(want) >= 0) j.textMode = "skip";
    else if (ours) j.textMode = "replace";
    else j.textMode = "append";
    if (j.textMode === "replace" || j.textMode === "append") {
      // Selection changes reach rich-text editors asynchronously, so the insert happens on the next step.
      selectIn(j.el, j.textMode);
      j.attempt = 0;
      j.phase = "insert";
    } else {
      j.textOk = true;
      j.phase = "images";
    }
    return { done: false, phase: j.phase };
  }

  function advance(j) {
    if (j.result) return j.result;
    var m = j.meta;
    // Pages often swap a plain textarea for a rich editor while they finish loading. If that happens
    // before the text is confirmed, start over on the new element (text already there is detected).
    if ((j.phase === "insert" || j.phase === "verify") && (!j.el || !j.el.isConnected)) j.phase = "find";

    if (j.phase === "find") {
      if (signInPage()) return { done: false, phase: "find", url: location.href, ready: document.readyState, sign_in: true };
      var el = findComposer(m.service);
      if (!el) return { done: false, phase: "find", url: location.href, ready: document.readyState };
      j.el = el;
      if (!j.ctxDecided) {
        // Decided once per delivery, before anything is typed (the box may be replaced later).
        j.ctxDecided = true;
        j.ctxPlan = contextPlan(m, el);
        if (j.ctxPlan === "text") j.ctxAs = "text";
        if (j.ctxPlan === "file") {
          j.phase = "context";
          return { done: false, phase: "context" };
        }
      }
      return planText(j);
    }

    if (j.phase === "context") {
      if (!attachContext(j)) return planText(j);
      j.checks = 0;
      j.phase = "verify-context";
      return { done: false, phase: "verify-context" };
    }

    if (j.phase === "verify-context") {
      if (previewCount() > j.ctxPreviewsBefore) {
        j.ctxConfirmed = true;
        return planText(j);
      }
      j.checks++;
      if (j.checks < 8) return { done: false, phase: "verify-context" };
      return planText(j);
    }

    if (j.phase === "insert") {
      insertText(j, j.attempt);
      j.checks = 0;
      j.phase = "verify";
      return { done: false, phase: "verify" };
    }

    if (j.phase === "verify") {
      var now = norm(readText(j.el));
      var probe = norm(j.text).slice(0, 60);
      // Some sites turn a long paste into an attachment instead of text in the box: that counts too,
      // and trying another way would put the text in twice.
      var tookAsFile = j.method === "paste" && j.text.length > 2000 && previewCount() > j.insertPreviewsBefore;
      if (now.indexOf(probe) >= 0 || tookAsFile) {
        j.textOk = true;
        if (j.textMode === "replace") memory.lastText = j.text;
        j.phase = "images";
        return { done: false, phase: "images" };
      }
      j.checks++;
      // An editor that claimed the event may still be applying it; give it a few polls before
      // trying the next method, so the text is never inserted twice.
      var patience = j.claimed ? 6 : 1;
      if (j.checks < patience) return { done: false, phase: "verify" };
      if (!isTextControl(j.el) && j.attempt < 2) {
        j.attempt++;
        selectIn(j.el, j.textMode);
        j.phase = "insert";
        return { done: false, phase: "insert" };
      }
      j.textOk = false;
      j.phase = "images";
      return { done: false, phase: "images" };
    }

    if (j.phase === "images") {
      if (!j.el || !j.el.isConnected) {
        j.el = signInPage() ? null : findComposer(m.service);
        if (!j.el) return { done: false, phase: "find", url: location.href, ready: document.readyState };
      }
      attachImages(j);
      if (!j.imagesTotal || j.imagesMethod === "none") return finish(j);
      j.checks = 0;
      j.phase = "verify-images";
      return { done: false, phase: "verify-images" };
    }

    if (j.phase === "verify-images") {
      if (previewCount() > j.previewsBefore) {
        j.imagesConfirmed = true;
        return finish(j);
      }
      j.checks++;
      if (j.checks < 12) return { done: false, phase: "verify-images" };
      return finish(j);
    }
    return finish(j, { ok: false, reason: "bad_phase" });
  }

  window.__zhu = {
    version: VERSION,
    stage: function (job, index, chunk) {
      var s = staged[job] || (staged[job] = []);
      s[index] = (s[index] || "") + chunk;
      return true;
    },
    begin: function (meta) {
      jobs[meta.job] = { meta: meta, phase: "find" };
      return true;
    },
    step: function (job) {
      var j = jobs[job];
      if (!j) return { done: true, ok: false, reason: "unknown_job" };
      try {
        return advance(j);
      } catch (e) {
        return finish(j, { ok: false, reason: "script_error", message: String((e && e.message) || e) });
      }
    },
    cancel: function (job) {
      delete jobs[job];
      delete staged[job];
      return true;
    },
  };
})();
