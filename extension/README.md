# JobSeeker Bridge

A small Chrome extension that lets the JobSeeker dashboard running on this computer read WhatsApp
Web, LinkedIn and (optionally) careers pages in your own, already-logged-in Chrome.

On macOS JobSeeker reads Chrome through Apple Events (`scripts/browser.mjs`). Windows has nothing
equivalent, and the alternative, Chrome's remote-debugging port, would let any local process drive
the browser as you. The bridge replaces both: the extension polls the dashboard on `127.0.0.1` for
commands, runs them itself, and posts the results back. Only a process holding the token issued at
pairing time can hand it a command, and the dashboard pins the extension's origin
(`chrome-extension://<id>`) so a stray web page cannot pair in its place.

Everything stays on this computer. The extension talks to `127.0.0.1` and `localhost` only.

## Load it (unpacked, for now)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` folder.
4. Chrome will show a **"Disable developer mode extensions"** bar on every start while an unpacked
   extension is loaded. Click the X to dismiss it; it comes back next start. A Chrome Web Store
   listing removes it for good, which is the plan once the extension has settled.

### Why by hand, and not by the installer

The Windows setup does everything either side of those two clicks — it starts the bridge, mints the
pairing code, copies this folder's path to the clipboard and opens `chrome://extensions` — but it
cannot do the loading itself. That is Chrome's position, not a gap in the setup, and it was measured
on Chrome 152.0.7977.83 (Windows 11 ARM) rather than assumed:

| Route | Result |
|---|---|
| `chrome.exe --load-extension=<dir>` | Installs nothing. The switch was removed, and `--disable-features=DisableLoadExtensionCommandLineSwitch` does not bring it back: the profile's extension list stayed empty. |
| `HKCU\Software\Google\Chrome\Extensions\<id>` with `path` to a packed `.crx` and `version` | Does not install it. |
| Enterprise policy force-install (`ExtensionInstallForcelist` with `ExtensionInstallAllowlist`, `ExtensionAllowedTypes` and a `file:///` update manifest), at both `HKCU\Software\Policies\Google\Chrome` and `HKLM\SOFTWARE\Policies\Google\Chrome` | Does not install it. |
| `chrome.exe --pack-extension=<dir>` | Works, and produces a `.crx` and a `.pem` — but nothing above will install that `.crx` automatically, so it buys nothing on its own. |

So on Chrome 152 an off-store extension can only be added by a person, here, with Developer mode on.
A **Chrome Web Store listing is the only route to a fully automatic install**, and it would remove
both the manual load and the developer-mode warning bar. That is a later phase.

## Pair it with the dashboard

1. Start the dashboard (`npm run dashboard`, default port 4319).
2. In the dashboard open **Settings ▸ Browser ▸ Connect**. It shows a six-digit code.
3. Open the extension's options (`chrome://extensions` ▸ JobSeeker Bridge ▸ Details ▸ Extension
   options), type the code and click **Connect**.

The status line turns to "Connected to the dashboard". If the dashboard runs on another port, type it
in the "Dashboard port" field first; the extension remembers it and also tries 4319 and 4320.

**Forget pairing** removes the token from Chrome. The dashboard will show a new code next time.

## What it can and cannot do

Can:

- list open tabs (URL, title, which one is active);
- read the content of a page it is allowed on (see permission tiers below), by running one of the
  read-only extraction snippets it ships in `snippets.js` — the dashboard names a snippet, it never
  sends code;
- open a tab of its own in the background and close tabs it opened (matched by URL prefix, never by
  position, so it cannot close one of yours by accident);
- tell whether a tab is still loading.

Cannot:

- type into anything, submit a form, press a button, or click around a page. There is no method for
  any of that in the extension, so it cannot be asked to. The one click that exists in the whole
  system is the `openConversationClick` snippet in `snippets.js`, driven by `openConversation` in
  `scripts/browser.mjs`: it opens a conversation row in a chat list and nothing else, it refuses to
  dispatch on anything that is not inside the row it was given (asserted with `Node.contains`), it
  refuses a button, input, textarea, form or editable field, and the caller skips unread threads so
  it never marks something read that you have not seen. There is no generic click method, and
  nothing on the extension side can widen that snippet.

The method allowlist is in `background.js` (`METHODS`): `ping`, `listTabs`, `runSnippet`, `openTab`,
`navigateTab`, `closeTab`, `closeTabsByUrlPrefix`, `tabLoading`. Anything else is answered with
`unknown method`. `navigateTab` and `closeTab` are refused for any tab the extension did not open
itself (it keeps the ids of the ones it did), so reusing one tab across a sweep can never move or
close a tab of yours. The snippet
allowlist is `SNIPPETS` in `snippets.js`: `pageAlive`, `hasSelector`, `extractPageText`,
`whatsappChatList`, `linkedinChatList`, `openConversationClick`, `readThreadMessages`. An unknown
name is refused on both sides, with the list of real names.

## Two permission tiers

1. **Default.** `web.whatsapp.com` and `www.linkedin.com` (plus `127.0.0.1` and `localhost` for the
   dashboard itself). Enough to track your chats and LinkedIn messages.
2. **Optional: "Also let it read careers pages."** Grants `<all_urls>` so the role scout can read job
   postings on company careers sites. Chrome asks you to confirm. It is still read-only, and the same
   button takes the grant back. Without it, a read of a careers page fails with a message telling you
   to grant it in the extension options.

## Design notes for whoever works on this next

- **Protocol** is frozen and documented at the top of `background.js`. `server/bridge.mjs` is the
  other side, and it keeps its OWN copy of the method allowlist (`METHODS`, near the top of that
  file). A method that is not in both lists is refused on the wire with `method not allowed`, so
  `runSnippet` has to be in both.
- **Keep-alive.** MV3 service workers are killed after roughly 30 s idle. A `chrome.alarms` tick every
  30 s (`periodInMinutes: 0.5`, allowed since Chrome 120; older Chrome clamps it to one minute, which
  is fine) restarts the poll loop if it died, `onStartup`/`onInstalled` start it, and a change to the
  stored token restarts it. Each long-poll is capped client-side at 25 s so the worker is never idle
  on a single pending request past the kill window; the dashboard queues anything that arrives in the
  gap.
- **How a snippet runs, and why it is not a string.** Node names a snippet; `runSnippet` looks it up
  in `snippets.js` and hands the REAL FUNCTION to
  `chrome.scripting.executeScript({ target, world: "ISOLATED", func, args })`. Nothing is evaluated
  from text.

  That is a measurement, not a preference. On Windows 11, Chrome 152.0.7977.83, with this extension
  loaded and paired, the previous string-evaluation path reported on `https://web.whatsapp.com/` — a
  host in our own `host_permissions`:

  > this page's Content Security Policy refuses string evaluation (ISOLATED/eval, ISOLATED/function,
  > MAIN/eval)

  All three routes are closed: MV3 applies the extension's own CSP (`script-src 'self'`, and Chrome
  will not accept `'unsafe-eval'`) to isolated worlds, so indirect `eval` and `new Function` are
  refused there, and in the MAIN world the page's own CSP refuses them too. `executeScript` with a
  `func` reference is what worked — it is how that failing probe itself ran. The old fallback chain
  and its `TODO(runSnippet)` are gone; this is the implementation they predicted.

- **`snippets.js` is shared with the Node side, on purpose.** `scripts/browser/applescript.mjs`
  imports the same file and stringifies the same functions (`Function.prototype.toString()`,
  flattened to one line) to evaluate `(<source>)(<args>)` through Apple Events, which macOS allows.
  So both platforms run identical page code from one file, and there is no second copy to drift.
  Two rules follow, and `npm run test:security` asserts them: a snippet must be SELF-CONTAINED
  (`chrome.scripting` serialises only the function, so nothing else in the file is reachable inside
  it), and it must use BLOCK COMMENTS ONLY (a `//` comment would swallow the rest of the line once
  flattened — that has silently broken the conversation click before).
- **It is loaded with `importScripts`, not as a module.** `snippets.js` is a classic script that
  publishes `self.SNIPPETS`, so the manifest's background entry needs no `"type": "module"` and the
  service worker registers exactly as it did. The same file exports `module.exports` when Node loads
  it, which keeps Node from reparsing it by syntax detection and printing a warning on every command.
- **Error mapping.** "Cannot access contents of url" from `chrome.scripting` becomes a message that
  points at the careers-pages button; chrome:// pages and discarded tabs get their own wording.
- **Status** is kept in `storage.session` (falls back to `storage.local`) and served to the options
  page over `runtime.onMessage` (`status`, `pair`, `forget`, `setPort`).

## Verified here, and what needs the Windows rig

Verified on this Mac without loading the extension: `node --check` on `background.js`, `snippets.js`
and `options.js`, and `manifest.json` parses. Every snippet in `snippets.js` was also run for real
against a local test page through the macOS Apple Events driver — the same functions the extension
ships — including the conversation click and the thread read. The extension itself was not loaded
into the local Chrome on purpose (that Chrome holds the live WhatsApp session and is driven by other
tooling), so nothing here exercises `chrome.scripting`.

Still to be done on the Windows machine with a real Chrome and a running dashboard:

0. Reload the extension (it is version 0.2.0 now — `ping` reports the version, which is the quickest
   way to confirm Chrome picked the new code up) and confirm the service worker still registers with
   `importScripts("snippets.js")` at its top.
1. Load unpacked; confirm no manifest warnings in `chrome://extensions`.
2. Pair; confirm `ping` and `listTabs` round-trip.
3. `runSnippet` on a WhatsApp Web tab and a LinkedIn tab, once per snippet:
   `pageAlive`, `hasSelector`, `extractPageText`, `whatsappChatList`, `linkedinChatList`,
   `openConversationClick`, `readThreadMessages`. `pageAlive` returning `"1"` is the one that proves
   the whole mechanism; the two chat-list snippets prove the selectors; `openConversationClick`
   should be exercised on an ALREADY-READ thread only. Also confirm an unknown name is refused with
   the list of real names.
4. Leave Chrome idle for a few minutes and confirm the poll loop comes back (alarm keep-alive).
5. Open a careers page without the optional grant; confirm the error message tells you to grant it,
   then grant and retry.

## Icons

`icons/icon-16/32/48.png` are copies of `public/favicon-16/32/48.png`. There was no 128 px PNG in
`public/`; `icons/icon-128.png` is `public/logo-mark.png` (256 px, same mark) scaled down with `sips`.
