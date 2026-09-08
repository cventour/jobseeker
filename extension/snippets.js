// The page snippets — the ONE source of truth for every piece of code JobSeeker runs inside a page.
//
// WHY THIS FILE EXISTS (measured, not assumed). Sending JavaScript to a page as a STRING cannot work
// under Manifest V3. On Windows 11, Chrome 152.0.7977.83, with this extension really loaded and
// paired, all three string-evaluation routes were refused on https://web.whatsapp.com/ — a host in
// the extension's own host_permissions:
//
//     this page's Content Security Policy refuses string evaluation
//     (ISOLATED/eval, ISOLATED/function, MAIN/eval)
//
// Indirect `eval` and `new Function` are both governed by the extension's own CSP in the isolated
// world (script-src 'self', and Chrome will not accept 'unsafe-eval' there), and the MAIN world is
// governed by the page's CSP. What DID work in the same run — it is how the failing probe itself
// ran — is `chrome.scripting.executeScript({ target, world, func, args })` with `func` being a real
// function reference from the extension's own code. So Node no longer sends JavaScript text; it
// names a snippet that the extension already ships, and the extension passes the function itself.
//
// BOTH PLATFORMS RUN THE CODE IN THIS FILE.
//   * Windows: the extension hands `SNIPPETS[name]` straight to chrome.scripting.executeScript.
//   * macOS:   scripts/browser/applescript.mjs stringifies the SAME function with
//              Function.prototype.toString(), flattens it to one line, and evaluates
//              `(<source>)(<args as JSON>)` through Apple Events, which allows that.
// One file, one copy, no drift — that is the whole point.
//
// RULES for anything added here:
//   1. A snippet is a REAL named function taking a single `args` object (or nothing) and returning a
//      string, or a JSON string for anything structured. Both transports return a string to Node, so
//      returning JSON keeps the two paths byte-identical.
//   2. It must be SELF-CONTAINED: chrome.scripting serialises the function source, so nothing else in
//      this file — no helper, no constant — is reachable from inside it. Same on the AppleScript path.
//   3. BLOCK COMMENTS ONLY, and no template literals. The source is flattened to a single line before
//      it is handed to Apple Events, so a `//` comment would silently comment out everything after
//      it. scripts/test-security.mjs asserts this, and asserts that the flattening still parses.
//   4. Read-only. There is exactly one click in the whole system (openConversationClick) and it
//      carries its own three constraints; nothing here may widen that.
//
// LOADED TWO WAYS FROM ONE FILE — see the bottom of the file for how, and why it is written as a
// classic script rather than an ES module.

"use strict";

/**
 * Does this tab answer at all? The permission probe: any value coming back proves the mechanism
 * works, which is the only question assertCanReadContent() asks.
 */
function pageAlive() {
  return "1";
}

/** Is `args.selector` present yet? "1"/"0" so the poll in waitForSelector stays a string compare. */
function hasSelector(args) {
  return document.querySelector(args.selector) ? "1" : "0";
}

/**
 * Visible text of the current page, for careers boards and any URL we open ourselves.
 * Extracts TEXT, not markup: scripts, styles and nav chrome are stripped so a scout reads the
 * listing rather than a page of boilerplate.
 */
function extractPageText(args) {
  try {
    var max = Number(args && args.max) || 20000;
    var kill = document.querySelectorAll('script,style,noscript,svg,iframe');
    for (var i = 0; i < kill.length; i++) kill[i].remove();
    var main = document.querySelector('main,[role="main"],#content,.careers,.jobs') || document.body;
    var t = (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return JSON.stringify({ title: document.title || '', href: location.href, text: t.slice(0, max), length: t.length });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
}

/**
 * The WhatsApp Web chat list.
 *
 * Extraction snippets are defensive: WhatsApp/LinkedIn ship DOM changes constantly, so each one
 * tries a few selector generations and returns [] rather than throwing. An empty result is
 * reported as "extraction found nothing" — never silently as "no messages", which would advance
 * the watermark over an unread inbox.
 */
function whatsappChatList() {
  try {
    if (document.querySelector('canvas[aria-label*="scan"], canvas[aria-label*="Scan"], [data-ref]')) {
      return JSON.stringify({ logged_out: true });
    }
    var pane = document.querySelector('#pane-side') || document.querySelector('[aria-label="Chat list"]');
    if (!pane) return JSON.stringify({ error: 'chat list not found' });
    /* WhatsApp moved the chat list from role="listitem" to role="row"; accept either, since the */
    /* next redesign will move it again and a hard-coded single selector is how this silently breaks. */
    var items = pane.querySelectorAll('[role="row"], [role="listitem"]');
    var out = [];
    var seen = {};
    for (var i = 0; i < items.length && out.length < 60; i++) {
      var el = items[i];
      var titled = el.querySelector('span[title]');
      var name = titled ? (titled.getAttribute('title') || titled.textContent || '') : '';
      if (!name) continue;
      /* The list virtualises and re-renders, so the same chat can appear twice in one pass. */
      if (seen[name]) continue;
      seen[name] = 1;
      var unread = 0;
      var badge = el.querySelector('[aria-label*="unread"], [aria-label*="Unread"]');
      if (badge) {
        var m = /(\d+)/.exec(badge.getAttribute('aria-label') || '');
        unread = m ? parseInt(m[1], 10) : 1;
      }
      /* innerText is far more stable than WhatsApp's generated class names: line 1 is the name, */
      /* line 2 the timestamp, and the last line the message preview. */
      var lines = (el.innerText || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      var body = lines.filter(function (x) {
        /* Drop the name, the bare unread badge and its aria text — on an unread chat the badge is
           the LAST line, so taking lines[last] naively yields "3" instead of the message. */
        return x !== name && !/^\d+$/.test(x) && !/^\d+ unread/i.test(x);
      });
      out.push({
        /* DOM index, so a later click targets the right row: this loop skips items without a name,
           so an array position is not a list position. */
        idx: i,
        name: name,
        preview: (body.length ? body[body.length - 1] : '').slice(0, 300),
        unread: unread,
        time: lines.length > 1 ? lines[1] : '',
        muted: !!el.querySelector('[aria-label="Muted chat"]')
      });
    }
    return JSON.stringify({ chats: out });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
}

/** The LinkedIn messaging conversation list. Same defensive shape as whatsappChatList. */
function linkedinChatList() {
  try {
    var items = document.querySelectorAll('li.msg-conversation-listitem, li[class*="conversation-listitem"]');
    var out = [];
    for (var i = 0; i < items.length && out.length < 40; i++) {
      var el = items[i];
      var nameEl = el.querySelector('.msg-conversation-listitem__participant-names, [class*="participant-names"]');
      var snipEl = el.querySelector('.msg-conversation-card__message-snippet, [class*="message-snippet"]');
      var timeEl = el.querySelector('time, [class*="time-stamp"]');
      var name = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!name) continue;
      var unread = /unread/i.test(el.className) || !!el.querySelector('[class*="unread"]');
      out.push({ idx: i, name: name, preview: snipEl ? (snipEl.textContent || '').trim().slice(0, 300) : '', unread: unread ? 1 : 0, time: timeEl ? (timeEl.textContent || '').trim() : '' });
    }
    return JSON.stringify({ chats: out });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
}

/**
 * Open one conversation in a chat list. THE ONLY CLICK IN THE SYSTEM, and shaped so it cannot become
 * a general one: the caller supplies a list selector and a name/index, this resolves that to an
 * element INSIDE the list and clicks it, and nothing else on the page is reachable. It cannot submit
 * a form, type into a field, or press a send button — those elements are never selected.
 *
 * Three constraints, all of which must hold:
 *   1. the element it dispatches on must be INSIDE the chat-list row the caller named — asserted
 *      with Node.contains, not assumed from the selector;
 *   2. it must not be a button, input, textarea, form or contenteditable;
 *   3. the caller must not have marked the conversation unread. Opening an unread conversation marks
 *      it read on the real account and destroys the user's own signal about what still needs them,
 *      so that filter lives with the caller (see openConversation in scripts/browser/snippets.mjs
 *      and readThreads in scripts/chat-sweep.mjs) and is asserted by npm run test:sweep.
 */
function openConversationClick(args) {
  try {
    var items = document.querySelectorAll(args.listSelector);
    var want = args.name || '';
    var el = null;
    /* Prefer matching by NAME. Both chat lists virtualise: scrolling re-renders the rows, so an
       index captured during extraction can point at a different conversation by the time we click.
       Opening the wrong thread is not a cosmetic bug here — it can be an unread one.
       NOTE: block comments only in here. This whole function is flattened to ONE LINE before it is
       sent to Apple Events, so a line comment would silently comment out everything after it. */
    if (want) {
      for (var i = 0; i < items.length && !el; i++) {
        var t = items[i].querySelector(args.nameSelector || 'span[title]');
        var got = t ? (t.getAttribute('title') || t.textContent || '').trim() : '';
        if (got === want) el = items[i];
      }
    }
    if (!el) el = items[Number(args.index)];
    if (!el) return JSON.stringify({ error: 'conversation not found (name/index both missed)' });

    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return JSON.stringify({ error: 'conversation row is not visible' });
    /* Dispatch on the deepest element under the row centre, not on the row itself. Measured on a
       live WhatsApp: an event dispatched at the row does nothing — the handler is bound further
       down — while the same sequence on elementFromPoint() opens the thread. A plain .click() does
       not work either; the list wants the pointer/mouse pair. */
    var target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!target) return JSON.stringify({ error: 'nothing at the row centre' });
    /* Two independent guards, both of which must hold. The containment check is the real one: it
       makes "we only ever click inside the conversation row we chose" a property of the code rather
       than of the selector being well behaved. */
    if (!el.contains(target)) return JSON.stringify({ error: 'point resolved outside the row' });
    if (target.closest('button, input, textarea, form, [contenteditable="true"]')) {
      return JSON.stringify({ error: 'refusing to click a control' });
    }

    var b = { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, detail: 1 };
    var p = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, b, p, { buttons: 1 })));
    target.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, b, { buttons: 1 })));
    target.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, b, p, { buttons: 0 })));
    target.dispatchEvent(new MouseEvent('mouseup', b));
    target.dispatchEvent(new MouseEvent('click', b));
    return JSON.stringify({ ok: true });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
}

/** The visible messages of the conversation that is currently open. */
function readThreadMessages(args) {
  try {
    /* Selector GENERATIONS, tried newest-first, first non-empty one wins — not one combined
       selector. Combining them double-counts: on the current WhatsApp a message matches both
       'div[role="row"]' and its nested '[data-testid="msg-container"]', so every message was
       logged twice. Keeping the older generations still guards against the next DOM rotation. */
    var gens = Array.isArray(args.messageSelector) ? args.messageSelector : [args.messageSelector];
    var nodes = [];
    for (var g = 0; g < gens.length && nodes.length === 0; g++) {
      nodes = document.querySelectorAll(gens[g]);
    }
    var out = [];
    for (var i = Math.max(0, nodes.length - 40); i < nodes.length; i++) {
      var t = (nodes[i].innerText || '').replace(/\n{2,}/g, '\n').trim();
      if (t) out.push(t);
    }
    var joined = out.join('\n---\n');
    /* Truncate from the FRONT, not the back: in a long thread the recent end is what matters, and
       slicing the head would keep the oldest of the last 40 and drop what was just agreed. */
    var cap = Number(args.max) || 8000;
    if (joined.length > cap) joined = '[earlier messages omitted] ' + joined.slice(joined.length - cap);
    return JSON.stringify({ messages: out.length, text: joined });
  } catch (e) {
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
}

/**
 * The allowlist. Node names a snippet, both drivers look it up here, and an unknown name is refused
 * on both sides. There is no generic "click", "type" or "submit" and none should ever be added.
 */
var SNIPPETS = {
  pageAlive: pageAlive,
  hasSelector: hasSelector,
  extractPageText: extractPageText,
  whatsappChatList: whatsappChatList,
  linkedinChatList: linkedinChatList,
  openConversationClick: openConversationClick,
  readThreadMessages: readThreadMessages
};

// One file, loaded two ways — deliberately a CLASSIC script rather than an ES module, because that
// is the only shape both consumers accept without a build step or a second copy:
//
//   * Chrome: background.js is a classic MV3 service worker and pulls this in with
//     importScripts("snippets.js"), which needs no "type": "module" in the manifest (so the service
//     worker registration is unchanged) and no MIME guesswork.
//   * Node: the repo's package.json has no "type", so a `.js` file is CommonJS. `module.exports`
//     means Node parses it silently as CJS — writing `export` here instead would make Node reparse
//     it by syntax detection and print a MODULE_TYPELESS_PACKAGE_JSON warning on stderr on EVERY
//     browser command, which would be a visible behaviour change on macOS.
//
// Node imports the default export: `import snippets from "../../extension/snippets.js"`.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SNIPPETS: SNIPPETS };
} else if (typeof self !== "undefined") {
  self.SNIPPETS = SNIPPETS;
}
