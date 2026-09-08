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
- read the content of a page it is allowed on (see permission tiers below), by running a read-only
  extraction snippet that the dashboard sends;
- open a tab of its own in the background and close tabs it opened (matched by URL prefix, never by
  position, so it cannot close one of yours by accident);
- tell whether a tab is still loading.

Cannot:

- type into anything, submit a form, press a button, or click around a page. There is no method for
  any of that in the extension, so it cannot be asked to. The one click that exists in the whole
  system is `openConversation` in `scripts/browser.mjs`: it opens a conversation row in a chat list
  and nothing else, it refuses to touch a button, input, textarea, form or editable field, and it
  skips unread threads so it never marks something read that you have not seen. That snippet is
  built and guarded on the Node side and runs through the same read-only evaluation path; the
  extension does not add any click capability of its own.

The method allowlist is in `background.js` (`METHODS`): `ping`, `listTabs`, `evalInTab`, `openTab`,
`closeTabsByUrlPrefix`, `tabLoading`. Anything else is answered with `unknown method`.

## Two permission tiers

1. **Default.** `web.whatsapp.com` and `www.linkedin.com` (plus `127.0.0.1` and `localhost` for the
   dashboard itself). Enough to track your chats and LinkedIn messages.
2. **Optional: "Also let it read careers pages."** Grants `<all_urls>` so the role scout can read job
   postings on company careers sites. Chrome asks you to confirm. It is still read-only, and the same
   button takes the grant back. Without it, a read of a careers page fails with a message telling you
   to grant it in the extension options.

## Design notes for whoever works on this next

- **Protocol** is frozen and documented at the top of `background.js`. `server/bridge.mjs` is the
  other side.
- **Keep-alive.** MV3 service workers are killed after roughly 30 s idle. A `chrome.alarms` tick every
  30 s (`periodInMinutes: 0.5`, allowed since Chrome 120; older Chrome clamps it to one minute, which
  is fine) restarts the poll loop if it died, `onStartup`/`onInstalled` start it, and a change to the
  stored token restarts it. Each long-poll is capped client-side at 25 s so the worker is never idle
  on a single pending request past the kill window; the dashboard queues anything that arrives in the
  gap.
- **How a snippet is evaluated.** `evalInTab` must behave like AppleScript's `execute javascript`:
  the snippet is a program whose completion value comes back (the Node side sends
  `(function(){...})()` and bare expressions). Three attempts, in order, each reported by name in the
  result's `via` field:
  1. indirect `eval` in the `ISOLATED` world;
  2. `new Function("return (" + src + ")")()` in the `ISOLATED` world;
  3. indirect `eval` in the `MAIN` world.

  The reasoning, which needs confirming on a real Chrome (see below): MV3 applies the extension's own
  CSP (`script-src 'self'`, and Chrome will not accept `'unsafe-eval'` there) to content-script
  isolated worlds as well as to extension pages, so attempts 1 and 2 are expected to be refused with
  an `EvalError`. In the `MAIN` world the page's CSP decides instead; WhatsApp Web and LinkedIn both
  ship one and whether it allows `unsafe-eval` has to be observed. The injected function catches its
  own errors and returns them as data, because older Chrome resolves a throwing injection as
  `result: undefined`, which would look exactly like "the snippet returned null" and hide the refusal.
  If all three are refused on the target sites, the fallback is `TODO(runSnippet)` in `background.js`:
  a `runSnippet {name, args}` method that runs named functions shipped inside the extension, with no
  string evaluation at all. It is deliberately not implemented until the eval path has been measured.
- **Error mapping.** "Cannot access contents of url" from `chrome.scripting` becomes a message that
  points at the careers-pages button; chrome:// pages and discarded tabs get their own wording.
- **Status** is kept in `storage.session` (falls back to `storage.local`) and served to the options
  page over `runtime.onMessage` (`status`, `pair`, `forget`, `setPort`).

## Verified here, and what needs the Windows rig

Verified on this Mac without loading the extension: `node --check` on `background.js` and
`options.js`, and `manifest.json` parses. The extension was not loaded into the local Chrome on
purpose (that Chrome holds the live WhatsApp session and is driven by other tooling).

Still to be done on the Windows machine with a real Chrome and a running dashboard:

1. Load unpacked; confirm no manifest warnings in `chrome://extensions`.
2. Pair; confirm `ping` and `listTabs` round-trip.
3. `evalInTab` on a WhatsApp Web tab and a LinkedIn tab: check the `via` field to learn which of the
   three evaluation attempts Chrome allowed, then trim the attempt list (or implement
   `TODO(runSnippet)`) accordingly and update this section.
4. Leave Chrome idle for a few minutes and confirm the poll loop comes back (alarm keep-alive).
5. Open a careers page without the optional grant; confirm the error message tells you to grant it,
   then grant and retry.

## Icons

`icons/icon-16/32/48.png` are copies of `public/favicon-16/32/48.png`. There was no 128 px PNG in
`public/`; `icons/icon-128.png` is `public/logo-mark.png` (256 px, same mark) scaled down with `sips`.
