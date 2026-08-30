/**
 * HITT Ops — assistant widget
 * ---------------------------------------------------------------------------
 * A floating chat panel that talks to POST /api/chat (server/routes/chat.js).
 * The server does all the model + tool work; this file is just UI + history.
 *
 * Loaded on every module page (after js/api.js). It self-injects only when:
 *   - HITT_CONFIG.FEATURES.chatEnabled is true, AND
 *   - there's a signed-in session, AND
 *   - GET /api/chat/status reports { enabled: true, configured: true }
 * so it stays invisible until Azure OpenAI is actually wired up server-side.
 *
 * Conversation history lives in sessionStorage (per tab), so it survives
 * navigating between pages but not closing the tab.
 * ---------------------------------------------------------------------------
 */
(() => {
  const THREAD_KEY = "hitt.chat.thread";
  const MAX_KEPT = 24;

  // Pull in the widget stylesheet next to this script (…/js/chat.js ->
  // …/css/chat.css), so pages only need the one <script> tag.
  const SELF_SRC = document.currentScript && document.currentScript.src;
  function injectStylesheet() {
    if (!SELF_SRC || document.querySelector('link[data-opsc-css]')) return;
    const href = SELF_SRC.replace(/\/js\/chat\.js(\?.*)?$/, "/css/chat.css");
    if (href === SELF_SRC) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-opsc-css", "");
    document.head.appendChild(link);
  }

  let messages = loadThread();
  let busy = false;
  let els = null;

  function loadThread() {
    try {
      const v = JSON.parse(sessionStorage.getItem(THREAD_KEY));
      return Array.isArray(v) ? v.slice(-MAX_KEPT) : [];
    } catch {
      return [];
    }
  }
  function saveThread() {
    try {
      sessionStorage.setItem(THREAD_KEY, JSON.stringify(messages.slice(-MAX_KEPT)));
    } catch {
      /* private mode / quota — history just won't persist */
    }
  }

  // --- tiny, safe markdown: escape everything, then re-introduce a few marks
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function renderMarkdown(text) {
    const lines = String(text || "").split("\n");
    let html = "";
    let inList = false;
    const inline = (s) =>
      escapeHtml(s)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    for (const raw of lines) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += `<li>${inline(bullet[1])}</li>`;
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line) html += `<p>${inline(line)}</p>`;
      }
    }
    if (inList) html += "</ul>";
    return html || `<p>${inline(text)}</p>`;
  }

  function addBubble(role, text, opts = {}) {
    const div = document.createElement("div");
    div.className = "opsc-msg " + (role === "user" ? "opsc-msg-user" : "opsc-msg-bot");
    if (opts.error) div.classList.add("opsc-error");
    if (role === "user") div.textContent = text;
    else div.innerHTML = renderMarkdown(text);
    els.log.appendChild(div);
    els.log.scrollTop = els.log.scrollHeight;
    return div;
  }

  function setTyping(on) {
    const existing = els.log.querySelector(".opsc-typing");
    if (on && !existing) {
      const t = document.createElement("div");
      t.className = "opsc-typing opsc-msg-bot";
      t.innerHTML = "<span></span><span></span><span></span>";
      els.log.appendChild(t);
      els.log.scrollTop = els.log.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    els.send.disabled = true;
    els.input.value = "";
    els.input.style.height = "auto";

    messages.push({ role: "user", content: text.trim() });
    addBubble("user", text.trim());
    saveThread();
    setTyping(true);

    try {
      const res = await HITT_API.sendChat(messages);
      setTyping(false);
      const reply = res?.reply || "(no answer)";
      messages.push({ role: "assistant", content: reply });
      addBubble("assistant", reply);
      saveThread();
    } catch (err) {
      setTyping(false);
      // Roll the unanswered question back out of history so a retry is clean.
      messages.pop();
      saveThread();
      addBubble("assistant", err?.message || "Something went wrong. Try again.", { error: true });
    } finally {
      busy = false;
      els.send.disabled = false;
      els.input.focus();
    }
  }

  function buildWidget() {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "opsc-fab";
    fab.setAttribute("aria-label", "Open the Ops assistant");
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      "<span>Ask Ops</span>";

    const panel = document.createElement("div");
    panel.className = "opsc-panel opsc-hidden";
    panel.innerHTML = `
      <div class="opsc-head">
        <strong>Ops assistant</strong>
        <button type="button" data-act="clear" title="Clear conversation">&#x21bb;</button>
        <button type="button" data-act="close" title="Close">&times;</button>
      </div>
      <div class="opsc-log"></div>
      <div class="opsc-hint">Reads live data. Ask about a project, a partner, or budgeted vs invoiced.</div>
      <form class="opsc-form">
        <textarea rows="1" placeholder="Ask about a project or the portfolio&hellip;" aria-label="Message"></textarea>
        <button type="submit">Send</button>
      </form>`;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    els = {
      fab,
      panel,
      log: panel.querySelector(".opsc-log"),
      form: panel.querySelector(".opsc-form"),
      input: panel.querySelector("textarea"),
      send: panel.querySelector('button[type="submit"]'),
    };

    const open = () => {
      panel.classList.remove("opsc-hidden");
      fab.classList.add("opsc-hidden");
      if (!els.log.children.length) {
        if (messages.length) messages.forEach((m) => addBubble(m.role, m.content));
        else addBubble("assistant", "Hi — ask me about any project or business partner, or how budgeted compares to invoiced.");
      }
      els.input.focus();
    };
    const close = () => {
      panel.classList.add("opsc-hidden");
      fab.classList.remove("opsc-hidden");
    };

    fab.addEventListener("click", open);
    panel.querySelector('[data-act="close"]').addEventListener("click", close);
    panel.querySelector('[data-act="clear"]').addEventListener("click", () => {
      messages = [];
      saveThread();
      els.log.innerHTML = "";
      addBubble("assistant", "Cleared. What would you like to know?");
    });

    els.input.addEventListener("input", () => {
      els.input.style.height = "auto";
      els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
    });
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send(els.input.value);
      }
    });
    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      send(els.input.value);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !panel.classList.contains("opsc-hidden")) close();
    });
  }

  async function init() {
    if (!window.HITT_CONFIG?.FEATURES?.chatEnabled) return;
    if (!window.HITT_API || !window.HITT_AUTH?.getSession?.()) return;
    try {
      const status = await HITT_API.getChatStatus();
      if (status?.enabled && status?.configured) {
        injectStylesheet();
        buildWidget();
      }
    } catch {
      /* no access to the chat module, or server said no — stay hidden */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
