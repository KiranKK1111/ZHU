// ZHU web chat helper. Evaluated by the shell inside an embedded chat tab (never loaded from the network).
//
// What it does: finds the page's message box, puts the question text into it, and attaches
// screenshots to the draft. What it never does: sign in, press Send, read conversations, or send
// anything anywhere. The user reviews the draft and presses the site's own Send button.
//
// It is driven entirely by the shell: `begin` registers a delivery and each `step` call advances it
// by one phase and returns its status. No timers are used, because Chromium throttles timers in
// hidden tabs to as little as one wake-up per minute, and most deliveries go to background tabs.
(function () {
  "use strict";
  var VERSION = 8;
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

  var jobs = {};
  var staged = {};
  // Per-document memory: the last text ZHU put into the box (so an unsent draft can be replaced by
  // the next question) and the screenshots already attached here (so none is attached twice).
  // The shell also passes the last text it inserted in this tab (`previous`), which survives reloads.
  var memory = { lastText: "", sentImages: {} };

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
    var text = j.textMode === "append" ? "\n\n" + j.meta.text : j.meta.text;
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

  function attachImages(j) {
    var files = buildFiles(j);
    j.imagesTotal = files.length;
    if (!files.length) return;
    var dt = new DataTransfer();
    for (var i = 0; i < files.length; i++) dt.items.add(files[i].file);
    j.previewsBefore = previewCount();
    j.el.focus();
    if (pasteData(j.el, dt)) {
      j.imagesMethod = "paste";
    } else {
      var inputs = queryDeep('input[type="file"]', document, [], { left: 20000 });
      var target = null;
      for (var k = 0; k < inputs.length; k++) {
        var accept = (inputs[k].getAttribute("accept") || "").toLowerCase();
        if (inputs[k].disabled) continue;
        if (!accept || accept.indexOf("image") >= 0 || accept.indexOf("*") >= 0 || accept.indexOf(".png") >= 0) {
          target = inputs[k];
          break;
        }
      }
      if (target) {
        target.files = dt.files;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        j.imagesMethod = "file-input";
      } else {
        // Last resort: many pages accept files dropped on the message box.
        var types = ["dragenter", "dragover", "drop"];
        var dropped = false;
        for (var t = 0; t < types.length; t++) {
          var de = new DragEvent(types[t], { dataTransfer: dt, bubbles: true, cancelable: true });
          dropped = !j.el.dispatchEvent(de);
        }
        j.imagesMethod = dropped ? "drop" : "none";
      }
    }
    if (j.imagesMethod !== "none") for (var m = 0; m < files.length; m++) memory.sentImages[files[m].id] = true;
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
    };
    if (extra) for (var k in extra) r[k] = extra[k];
    if (r.text === "failed" || (r.images > 0 && r.images_method === "none")) r.ok = false;
    j.result = r;
    delete staged[j.meta.job];
    j.el = null;
    return r;
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
      var cur = norm(readText(el));
      var want = norm(m.text);
      if (!want) j.textMode = "none";
      else if (cur.indexOf(want) >= 0) j.textMode = "skip";
      else if (!cur || cur === norm(memory.lastText) || cur === norm(m.previous)) j.textMode = "replace";
      else j.textMode = "append";
      if (j.textMode === "replace" || j.textMode === "append") {
        // Selection changes reach rich-text editors asynchronously, so the insert happens on the next step.
        selectIn(el, j.textMode);
        j.attempt = 0;
        j.phase = "insert";
      } else {
        j.textOk = true;
        j.phase = "images";
      }
      return { done: false, phase: j.phase };
    }

    if (j.phase === "insert") {
      insertText(j, j.attempt);
      j.checks = 0;
      j.phase = "verify";
      return { done: false, phase: "verify" };
    }

    if (j.phase === "verify") {
      var now = norm(readText(j.el));
      var probe = norm(m.text).slice(0, 60);
      if (now.indexOf(probe) >= 0) {
        j.textOk = true;
        if (j.textMode === "replace") memory.lastText = m.text;
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
