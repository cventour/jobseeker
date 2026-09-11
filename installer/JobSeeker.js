// JobSeeker.app — the setup window on first run, and the app window every time after.
//
// Compiled by scripts/build-app.sh with `osacompile -l JavaScript -s`, which every Mac already has.
// That is the whole point: this file draws a real Cocoa window with nothing installed, so setup can
// be graphical BEFORE Node exists rather than only after.
//
// ---------------------------------------------------------------------------------------------
// The bridge, and the one rule that matters.
//
//   app  -> page : evaluateJavaScript, calling __render(state) in the page.
//   page -> app  : the page sets location.hash; this loop polls wv.URL and parses it.
//
// THE RULE: evaluateJavaScript's completion handler must be a REAL JS function. Passing $() looks
// like passing nil, but JXA instead hands WebKit a forwarding proxy; when WebKit invokes it,
// JSOCForwardInvocation raises an ObjC exception inside a noexcept C++ frame and the process
// aborts. SIGABRT, from inside WebKit's IPC callback, uncatchable. It cost a rewrite to find, so
// the no-op handler below is not decoration -- it is the fix.
//
// The loop is a plain poll: pump the run loop for a slice, read what changed, render what changed.
// ---------------------------------------------------------------------------------------------

ObjC.import('Cocoa');
ObjC.import('WebKit');
ObjC.import('CoreGraphics');

var FM = $.NSFileManager.defaultManager;

// ------------------------------------------------------------------ paths
// build-app.sh bakes the checkout's absolute path into the bundle, so the app always knows which
// JobSeeker it belongs to even when launched from the Dock with no working directory.
var BUNDLE = $.NSBundle.mainBundle.bundlePath.js;
var RES = BUNDLE + '/Contents/Resources';
var REPO = readFile(RES + '/repo-path.txt').trim();

var WORK = REPO + '/data/.setup';
var UI = RES + '/ui.html';          // read-only, straight from the bundle
var STEPLOG = WORK + '/step.log';
var FULLLOG = WORK + '/setup.log';
var PIDFILE = WORK + '/server.pid';

// ------------------------------------------------------------------ tiny fs helpers
function readFile(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null);
  return s.isNil() ? '' : s.js;
}
function writeFile(p, s) {
  return $(s).writeToFileAtomicallyEncodingError($(p), true, $.NSUTF8StringEncoding, null);
}
function appendFile(p, s) { writeFile(p, readFile(p) + s); }
// Ask the window server whether this process actually has a window on screen.
function onScreen() {
  try {
    // Two JXA traps here, both of which silently produce a wrong answer rather than an error:
    // kCGNullWindowID is not bridged (it reads undefined), so pass its literal value 0; and the
    // CFArrayRef must be cast before it behaves like an NSArray.
    var ref = $.CGWindowListCopyWindowInfo(
      $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
    var arr = ObjC.castRefToObject(ref);
    var pid = $.NSProcessInfo.processInfo.processIdentifier, n = 0;
    for (var i = 0; i < arr.count; i++) {
      var o = arr.objectAtIndex(i).objectForKey('kCGWindowOwnerPID');
      if (!o.isNil() && o.js === pid) n++;
    }
    return n + ' window(s)';
  } catch (e) { return 'unknown (' + e.message + ')'; }
}

function stamp() {
  var d = new Date();
  function two(n) { return (n < 10 ? '0' : '') + n; }
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}
function exists(p) { return FM.fileExistsAtPath($(p)); }

// ------------------------------------------------------------------ the steps
// `password` and `optional` are presentation only — setup-step.sh decides what actually happens.
// They exist so the plan screen can tell the truth about a step before the user agrees to it.
var STEPS = [
  { id: 'node', label: 'Install Node 22 LTS',
    note: 'The engine JobSeeker runs on. Downloaded from nodejs.org.',
    password: true },
  { id: 'claude', label: 'Install Claude Code',
    note: 'Where the agents live. Downloaded from claude.ai.',
    password: false },
  { id: 'chrome', label: 'Install Google Chrome',
    note: 'Only for reading WhatsApp and LinkedIn. Everything else works without it.',
    password: true, optional: true },
  { id: 'configure', label: 'Set up your settings and agents',
    note: 'Creates your settings file and installs the browser agent.',
    password: false },
  { id: 'start', label: 'Start JobSeeker',
    note: 'On this Mac only. Nothing is sent anywhere.',
    password: false },
  // Listed so "everything that will happen" is true, but `interactive` keeps it out of the queue:
  // it needs a phone number and a phone, so it gets its own screen after the rest is done.
  { id: 'whatsapp', label: 'Connect WhatsApp',
    note: 'Optional, and you choose. Asked at the end.',
    password: false, optional: true, interactive: true }
];

var state = {
  view: 'plan', title: 'Checking this Mac',
  subtitle: 'One moment — looking at what is already installed.',
  brandnote: '· first run on this Mac',
  steps: [], pct: 0, say: '', log: '', need: '', code: '', waKnown: '', status: 'Looking…',
  busy: false, failed: false, allInstalled: false
};

function stepById(id) {
  for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return STEPS[i];
  return null;
}

function syncSteps() {
  // A quiet start has nothing to show: the rows are a list of things being installed, and on this
  // path nothing is. An empty list renders as no list.
  if (quietStart) { state.steps = []; return; }
  state.steps = STEPS.map(function (s) {
    return { id: s.id, label: s.label, note: s.note, password: !!s.password,
             optional: !!s.optional, state: s.state || 'todo', detail: s.detail || '' };
  });
}

// The completion handler is deliberately a real, named function -- see THE RULE at the top.
function ignoreResult(result, error) { /* fire and forget */ }

function push() {
  syncSteps();
  if (mode === 'app' || !wv) return;   // the dashboard owns the web view; it has no __render
  var js = 'window.__render && __render(' + JSON.stringify(state) + ')';
  try {
    wv.evaluateJavaScriptCompletionHandler($(js), ignoreResult);
  } catch (e) {
    appendFile(FULLLOG, stamp() + '  render failed: ' + e.message + '\n');
  }
}

// ------------------------------------------------------------------ run loop
var app = $.NSApplication.sharedApplication;
var win, wv;

// ---- link opener ---------------------------------------------------------------------------------
// Every external link on the dashboard is <a target="_blank">. In a WKWebView, clicking one asks the
// host's WKUIDelegate for a new window -- and this app used to set no delegate at all, so WebKit got
// no answer and the click did nothing, silently: job postings, LinkedIn profiles, "See everything
// that changed". The same page in a browser, and on Windows (Edge/Chrome in --app mode), always
// worked, which is why it looked like a page bug and was not one.
//
// So the delegate answers the new-window request by handing the link to the default browser --
// where the user is already signed in to LinkedIn and the job sites -- and returns NO window.
//
// The return value is the trap. It must be $(), JXA's nil. Returning null from a JXA method typed
// 'id' segfaults the whole process on the first click (measured: exit 139, every time), so a
// "harmless" null here would have turned a dead link into a crashed app.
//
// Only http and https leave the app. A file:, javascript: or custom-scheme link is dropped: this is
// the one path by which page content can make the Mac open something, and none of those is a page.
//
// linkOpener is kept in a global because WKWebView holds its UI delegate WEAKLY: a local would be
// collected and the webview would quietly go back to having no delegate.
var openExternally = function (url) { $.NSWorkspace.sharedWorkspace.openURL(url); };
try {
  ObjC.registerSubclass({
    name: 'JobSeekerLinkOpener',
    protocols: ['WKUIDelegate'],
    methods: {
      'webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:': {
        types: ['id', ['id', 'id', 'id', 'id']],
        implementation: function (webView, configuration, navigationAction, windowFeatures) {
          try {
            var url = navigationAction.request.URL;
            var scheme = String(ObjC.unwrap(url.scheme) || '').toLowerCase();
            if (scheme === 'http' || scheme === 'https') {
              openExternally(url);
              // The host only: enough to see that a click was handled, without writing job URLs
              // (and whatever tracking tokens ride on them) into a log that goes into bug reports.
              appendFile(FULLLOG, stamp() + '  opened a link in the browser: ' + ObjC.unwrap(url.host) + '\n');
            }
          } catch (e) {
            appendFile(FULLLOG, stamp() + '  link opener error: ' + e.message + '\n');
          }
          return $();
        }
      }
    }
  });
} catch (e) { /* already registered in this process -- $.JobSeekerLinkOpener still exists */ }
var linkOpener = $.JobSeekerLinkOpener.alloc.init;
// ---- end link opener -----------------------------------------------------------------------------
var mode = 'setup';

// ------------------------------------------------------------------ native chrome follows the page
// The page can restyle itself, but the traffic lights, the title bar and the menus are AppKit's --
// so choosing Light left the window painted dark around a cream page. This closes that gap.
//
// It reads the page rather than taking a message, which means ONE code path covers both the setup
// page and the dashboard: whichever is loaded, the app asks it what appearance it is showing and
// matches the window to it. The dashboard's own switch therefore drives the native chrome too,
// without dashboard.mjs needing to know this app exists.
var themeSeen = null, themeApplied = null, themeTick = 0;

// An ordinary launch is not an installation, and must not be dressed as one.
//
// Reopening the app on a set-up Mac has exactly one thing to do: start the server. That went through
// the same startNext() as a real install, so for the second or so it takes, the window showed
// "Getting this Mac ready · Step 1 of 1 · start jobseeker" over a filling progress bar -- which
// reads as setup running again, on an app you have used for weeks. Quiet mode keeps the same work
// and drops the costume.
var quietStart = false;

function themeAnswer(result, error) {
  // A real function, never $() -- see THE RULE at the top of this file.
  try { themeSeen = result.isNil() ? 'auto' : String(result.js); }
  catch (e) { themeSeen = null; }
}

function syncAppearance() {
  if (!wv) return;
  themeTick++;
  if (themeTick % 4 === 0) {          // ~0.6s: chrome should lag a click, not a second
    try {
      wv.evaluateJavaScriptCompletionHandler(
        $("(document.documentElement.getAttribute('data-theme')||'auto')"), themeAnswer);
    } catch (e) { /* page mid-navigation */ }
  }
  if (!themeSeen || themeSeen === themeApplied) return;
  themeApplied = themeSeen;
  try {
    if (themeApplied === 'light') {
      app.appearance = $.NSAppearance.appearanceNamed($.NSAppearanceNameAqua);
    } else if (themeApplied === 'dark') {
      app.appearance = $.NSAppearance.appearanceNamed($.NSAppearanceNameDarkAqua);
    } else {
      // nil is not "no appearance", it is "inherit" -- which is exactly what Auto means.
      app.appearance = $();
    }
    appendFile(FULLLOG, stamp() + '  appearance: ' + themeApplied + '\n');
  } catch (e) {
    appendFile(FULLLOG, stamp() + '  appearance failed: ' + e.message + '\n');
  }
}

// ------------------------------------------------------------------ window placement
// Centre on the MENU BAR screen, and nowhere else.
//
// This used to follow the pointer onto whichever display it was on, which sounds friendlier and is
// not. Measured against the window server: placing on the main screen lands exactly where asked
// every time, but asking for a spot on a secondary display produced a window the window server put
// somewhere else entirely -- requested 248,1566 on the second display, actually placed at the
// bottom-left of the built-in with most of it below the screen edge and behind the Dock. Worse,
// NSWindow.frame kept reporting the position it was TOLD, so the app could not even tell.
//
// So: one screen, the one with the menu bar, centred. Predictable beats clever, and a window you
// have to drag back from under the Dock is not friendly at any price.
function placeWindow(w) {
  try {
    var vf = $.NSScreen.mainScreen.visibleFrame, f = w.frame;
    w.setFrameOrigin($.NSMakePoint(
      vf.origin.x + Math.max(0, (vf.size.width - f.size.width) / 2),
      vf.origin.y + Math.max(0, (vf.size.height - f.size.height) / 2)));
  } catch (e) {
    w.center;
  }
}

// The window server's own answer, which is the only one that has proved trustworthy.
function cgBounds() {
  try {
    var arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
      $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
    var pid = $.NSProcessInfo.processInfo.processIdentifier;
    for (var i = 0; i < arr.count; i++) {
      var d = arr.objectAtIndex(i), o = d.objectForKey('kCGWindowOwnerPID');
      if (o.isNil() || o.js !== pid) continue;
      var b = d.objectForKey('kCGWindowBounds');
      return { x: b.objectForKey('X').js, y: b.objectForKey('Y').js,
               w: b.objectForKey('Width').js, h: b.objectForKey('Height').js };
    }
  } catch (e) {}
  return null;
}

// Checked after the window is up, against the window server rather than against AppKit -- because
// AppKit was the thing reporting a position the window did not have.
function ensureOnScreen(w) {
  try {
    var b = cgBounds();
    if (!b) return false;          // not registered yet; the caller will ask again
    var sf = $.NSScreen.mainScreen.frame;          // CG space: main screen is 0,0 .. width,height
    var off = (b.x < 0 || b.y < 0 || b.x + b.w > sf.size.width || b.y + b.h > sf.size.height);
    appendFile(FULLLOG, stamp() + '  window at ' + Math.round(b.x) + ',' + Math.round(b.y) + ' '
      + Math.round(b.w) + 'x' + Math.round(b.h) + (off ? '  — off screen, re-centring' : '') + '\n');
    if (!off) return true;
    w.center;
    var after = cgBounds();
    if (after) {
      appendFile(FULLLOG, stamp() + '  re-centred to ' + Math.round(after.x) + ','
        + Math.round(after.y) + '\n');
    }
    return true;
  } catch (e) {
    appendFile(FULLLOG, stamp() + '  ensureOnScreen failed: ' + e.message + '\n');
    return true;                   // do not retry a throw forever
  }
}

// ------------------------------------------------------------------ page -> app
var lastSeq = 0;
function readCommand() {
  var u = wv.URL;
  if (u.isNil()) return null;
  var s = u.absoluteString.js;
  var h = s.indexOf('#');
  if (h === -1) return null;
  var cmd;
  try { cmd = JSON.parse(decodeURIComponent(s.slice(h + 1))); } catch (e) { return null; }
  if (!cmd || cmd.n <= lastSeq) return null;   // already handled
  lastSeq = cmd.n;
  // Every button press, in the log. If someone reports "I clicked Begin and nothing happened",
  // the presence or absence of this line says which half of the bridge broke.
  appendFile(FULLLOG, stamp() + '  ui: ' + cmd.cmd + (cmd.id ? ' ' + cmd.id : '') + '\n');
  return cmd;
}

// ------------------------------------------------------------------ running a step
var task = null, running = null;

function launchStep(id, extraArg) {
  writeFile(STEPLOG, '');
  FM.createFileAtPathContentsAttributes($(STEPLOG), $(), $());
  task = $.NSTask.alloc.init;
  task.launchPath = '/bin/bash';
  var args = [REPO + '/scripts/setup-step.sh', id];
  if (extraArg) args.push(extraArg);
  task.arguments = $(args);
  var fh = $.NSFileHandle.fileHandleForWritingAtPath($(STEPLOG));
  task.standardOutput = fh;
  task.standardError = fh;
  try { task.launch; } catch (e) {
    running = null; task = null;
    var st = stepById(id);
    if (st) { st.state = 'fail'; st.detail = 'Could not start this step: ' + e.message; }
    return false;
  }
  running = id;
  state.busy = true;
  state.pct = 0;
  state.say = '';
  state.log = '';
  push();
  return true;
}

// Read the step's output and turn the "::" lines into state. Everything else is transcript.
function drainStepLog() {
  var text = readFile(STEPLOG);
  var lines = text.split('\n');
  var plain = [];
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i];
    if (L.slice(0, 2) !== '::') { if (L.length) plain.push(L); continue; }
    var sp = L.indexOf(' ', 2);
    var verb = sp === -1 ? L.slice(2) : L.slice(2, sp);
    var rest = sp === -1 ? '' : L.slice(sp + 1);
    if (verb === 'code') { state.code = rest.trim(); }
    else if (verb === 'pct') { state.pct = parseInt(rest, 10) || 0; }
    else if (verb === 'say') { state.say = rest; }
    else if (verb === 'need') { state.need = rest; }
    else if (verb === 'step') {
      var p = rest.split(' ');
      var s1 = stepById(p[0]);
      if (s1) s1.state = p[1];
    } else if (verb === 'detail') {
      var q = rest.indexOf(' ');
      var s2 = stepById(q === -1 ? rest : rest.slice(0, q));
      if (s2) s2.detail = q === -1 ? '' : rest.slice(q + 1);
    }
  }
  state.log = plain.slice(-200).join('\n');
}

// ------------------------------------------------------------------ the queue
var queue = [];
var skipped = {};
var phase = 'boot';
var waOffered = false;
var placementChecked = false;
var placementTries = 0;
var openAt = 0;

function enqueueAll() {
  queue = [];
  for (var i = 0; i < STEPS.length; i++) {
    var s = STEPS[i];
    if (s.interactive) continue;                      // its own screen, not a queued task
    if (s.state !== 'ok' && !skipped[s.id]) queue.push(s.id);
  }
  queuedTotal = queue.length;
  queuedDone = 0;
}

var queuedTotal = 0, queuedDone = 0;

function startNext() {
  if (queue.length === 0) { onQueueEmpty(); return; }
  var id = queue.shift();
  var s = stepById(id);
  if (s && s.state === 'ok') { startNext(); return; }
  queuedDone++;
  state.view = 'work';
  if (quietStart) {
    // Said once by decideWhatToDo and left alone: no step count, no row list, nothing to read.
    state.title = 'Starting JobSeeker';
    state.subtitle = 'One moment.';
  } else {
    state.title = 'Getting this Mac ready';
    state.subtitle = 'Step ' + queuedDone + ' of ' + queuedTotal + ' \u00b7 '
      + (s ? s.label.toLowerCase() : id);
  }
  // The server must not outlive the app, so `start` gets our pid and watches it.
  if (!launchStep(id, id === 'start' ? String($.NSProcessInfo.processInfo.processIdentifier) : null)) {
    afterStep(false);
  }
}

function afterStep(ok) {
  appendFile(FULLLOG, readFile(STEPLOG) + '\n');
  state.busy = false;
  state.say = '';
  state.pct = 0;

  // WhatsApp lives on its own screen: success moves on, failure stays put with the reason so the
  // number can be corrected, and neither touches the install queue.
  if (running === 'whatsapp') {
    running = null; task = null;
    if (ok) { state.code = ''; onQueueEmpty(); }
    else { state.code = ''; state.view = 'whatsapp'; push(); }
    return;
  }
  if (!ok) {
    var s = stepById(running);
    // A failed optional step is not a failed install — note it and keep going.
    if (s && s.optional) { skipped[s.id] = true; }
    else { state.failed = true; }
  }
  running = null; task = null;
  if (state.failed) {
    // Stop the run and let the user decide: retry that row, or continue without it.
    state.title = 'One step did not finish';
    state.subtitle = 'Nothing else was changed. Try it again, or carry on without it.';
    state.status = 'Stopped|— the row below says what happened.';
    push();
    return;
  }
  startNext();
}

function onQueueEmpty() {
  var startStep = stepById('start');
  var anySkipped = Object.keys(skipped).length > 0;
  var waStep = stepById('whatsapp');

  // An ordinary launch is not a setup run.
  //
  // This screen used to appear EVERY time the app was opened on a Mac whose server simply was not
  // running yet -- a reboot, a quit, anything. decideWhatToDo() correctly sent a fully-running
  // install straight to the dashboard, but the far more common "installed, just not started yet"
  // path queued `start` and then fell into the WhatsApp offer, so a finished install was asked to
  // connect WhatsApp on every single launch. Offering an optional extra once is help; offering it
  // forever is a nag with a Continue button.
  //
  // So the offer belongs to a run that actually SET SOMETHING UP. If the wizard has been finished
  // (or deliberately left), this launch is just opening the app: go to the dashboard.
  if (setupFinished() && startStep && startStep.state === 'ok') {
    state.brandnote = '';
    openDashboard();
    return;
  }

  if (startStep && startStep.state === 'ok' && waStep && !skipped.whatsapp && !waOffered) {
    waOffered = true;                       // shown once per run, never nagged
    state.view = 'whatsapp';
    state.busy = false;
    state.code = '';
    if (waStep.state === 'ok') {
      // Already linked. Say so and name the number: a listed step that silently disappears
      // reads as a step that failed.
      state.waKnown = waStep.detail || 'connected';
      state.status = 'Already connected.|Nothing to do here.';
    } else {
      state.waKnown = '';
      state.status = 'Everything else is set up.|WhatsApp is optional.';
    }
    push();
    return;
  }

  if (startStep && startStep.state === 'ok') {
    state.view = 'done';
    state.title = 'JobSeeker is ready';
    state.subtitle = anySkipped
      ? 'Set up, without ' + Object.keys(skipped).join(' and ') + '. You can add that later.'
      : 'Everything is installed and running on this Mac.';
    state.status = 'Done|— nothing has run yet, and nothing will without your say-so.';
    // Wait for the user. Setup used to hand the window over on a timer, which meant the one screen
    // saying what had just been done to their Mac was gone before it could be read.
    push();
    return;
  }
  state.view = 'work';
  state.title = 'Not finished';
  state.subtitle = 'JobSeeker could not start. The rows below say why.';
  state.status = 'Stopped|';
  push();
}

// Has this Mac finished setting up?
//
// The same three tests the dashboard's own needsWelcome() uses, so the app and the dashboard can
// never disagree about whether this is a first run:
//   * `welcome_done:`  the wizard was finished,
//   * `welcome_left:`  the user walked out of it deliberately,
//   * markets or roles in data/criteria.md — an install from BEFORE the wizard existed, or one set
//     up with /onboard in the terminal. This is the case that matters most here: an established
//     install has none of the wizard's bookkeeping and must not be treated as brand new.
function setupFinished() {
  var cfg = readFile(REPO + '/config/job-seeker.config.md');
  if (/^welcome_(done|left):[ \t]*\S/m.test(cfg)) return true;
  var crit = readFile(REPO + '/data/criteria.md');
  return /^markets:[ \t]*\S/m.test(crit) || /^roles:[ \t]*\S/m.test(crit);
}

// ------------------------------------------------------------------ the handoff
function dashboardPort() {
  var cfg = readFile(REPO + '/config/job-seeker.config.md');
  var m = /^dashboard_port:[ \t]*(\d+)/m.exec(cfg);
  return m ? m[1] : '4319';
}

// The whole point of the exercise: the window we have been talking to the user in becomes the app.
// Not a Chrome window, not a new window — this one.
function openDashboard() {
  mode = 'app';
  var url = 'http://localhost:' + dashboardPort();

  // Give the window an ordinary title bar for the dashboard.
  //
  // The setup page is ours and pads its top for the traffic lights, so it can afford a transparent
  // full-height title bar. The dashboard cannot: it is a normal multi-page web app served by
  // dashboard.mjs, its header starts at y=0, and it collides with the close/minimise buttons.
  // Injecting padding would work until the first navigation to /settings or /welcome and then
  // silently stop. A real title bar is the honest fix, and it gives the window somewhere to say
  // its own name.
  try {
    win.styleMask = win.styleMask | $.NSWindowStyleMaskResizable;
  } catch (e) { /* keep whatever we had */ }
  win.title = 'JobSeeker';
  // Breadcrumb. When someone reports "it opened on a blank window", this line in
  // data/.setup/setup.log is the difference between knowing the handoff happened and guessing.
  appendFile(FULLLOG, stamp() + '  window handed over to ' + url + '\n');
  win.setFrameDisplayAnimate($.NSMakeRect(0, 0, 1180, 900), true, false);
  placeWindow(win);
  placementChecked = false; placementTries = 0;   // re-check once the resized window is up
  win.minSize = $.NSMakeSize(880, 620);
  wv.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString($(url))));
}

// ------------------------------------------------------------------ shutdown
function stopServer() {
  var pid = readFile(PIDFILE).trim();
  if (!pid) return;
  try {
    var k = $.NSTask.alloc.init;
    k.launchPath = '/bin/kill';
    k.arguments = $([pid]);
    k.launch;
    k.waitUntilExit;
  } catch (e) { /* already gone */ }
  try { FM.removeItemAtPathError($(PIDFILE), null); } catch (e) {}
}

// A server left behind by a previous run would make `start` think it had succeeded when this
// launch had done nothing. Clear it out first.
function reapStaleServer() {
  var pid = readFile(PIDFILE).trim();
  if (!pid) return;
  var chk = $.NSTask.alloc.init;
  chk.launchPath = '/bin/kill';
  chk.arguments = $(['-0', pid]);
  try { chk.launch; chk.waitUntilExit; } catch (e) { return; }
  if (chk.terminationStatus === 0) stopServer();
}

// ------------------------------------------------------------------ menu (so Cmd-Q exists)
function buildMenu() {
  // Guarded: an app with no menu is a usable app, an app that aborted building one is not.
  try {
    var bar = $.NSMenu.alloc.init;
    var appItem = $.NSMenuItem.alloc.init;
    bar.addItem(appItem);
    var m = $.NSMenu.alloc.init;
    m.addItemWithTitleActionKeyEquivalent($('Hide JobSeeker'), 'hide:', $('h'));
    m.addItem($.NSMenuItem.separatorItem);
    m.addItemWithTitleActionKeyEquivalent($('Quit JobSeeker'), 'terminate:', $('q'));
    appItem.submenu = m;

    // Without an Edit menu the standard shortcuts do nothing inside the web view, which is
    // maddening when you are trying to copy an error out of the log.
    var editItem = $.NSMenuItem.alloc.init;
    bar.addItem(editItem);
    var e = $.NSMenu.alloc.initWithTitle($('Edit'));
    e.addItemWithTitleActionKeyEquivalent($('Cut'), 'cut:', $('x'));
    e.addItemWithTitleActionKeyEquivalent($('Copy'), 'copy:', $('c'));
    e.addItemWithTitleActionKeyEquivalent($('Paste'), 'paste:', $('v'));
    e.addItemWithTitleActionKeyEquivalent($('Select All'), 'selectAll:', $('a'));
    editItem.submenu = e;
    app.mainMenu = bar;
  } catch (err) { /* no menu; the close button still quits */ }
}

// ------------------------------------------------------------------ main
function run() {
  if (!REPO || !exists(REPO + '/server/dashboard.mjs')) {
    var a = $.NSAlert.alloc.init;
    a.messageText = $('JobSeeker cannot find its files');
    a.informativeText = $('This app expected the JobSeeker folder at:\n\n' + (REPO || '(not recorded)')
      + '\n\nIf you moved it, run the install command again from myjobseeker.ai.');
    a.runModal;
    return;
  }

  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(WORK), true, $(), null);
  reapStaleServer();

  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  buildMenu();

  var rect = $.NSMakeRect(0, 0, 800, 660);   // a title bar costs height; give it back
  win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    rect,
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskMiniaturizable,
    2, false);
  win.title = 'JobSeeker Setup';
  // A normal title bar, not a transparent full-height one. The transparent version let the page
  // draw right to the top, but it left almost nothing to drag the window by -- only a thin,
  // invisible strip -- so the window was awkward to move. A real title bar is the obvious handle,
  // and it matches what the dashboard gets after the handover.
  win.releasedWhenClosed = false;      // so polling isVisible after a close is safe
  try {
    win.collectionBehavior = $.NSWindowCollectionBehaviorMoveToActiveSpace
                           | $.NSWindowCollectionBehaviorManaged;
  } catch (e) { /* older macOS: leave the default */ }
  placeWindow(win);

  var cfg = $.WKWebViewConfiguration.alloc.init;
  wv = $.WKWebView.alloc.initWithFrameConfiguration(rect, cfg);
  wv.setUIDelegate(linkOpener);   // see "link opener" above: without it, no link opens
  wv.loadFileURLAllowingReadAccessToURL(
    $.NSURL.fileURLWithPath($(UI)), $.NSURL.fileURLWithPath($(RES)));
  win.contentView = wv;
  win.makeKeyAndOrderFront(null);
  win.orderFrontRegardless;
  app.activateIgnoringOtherApps(true);
  // The on-screen check happens on the first idle tick, not here: the window server does not know
  // about the window yet in this run-loop turn, so asking it now returns nothing and the check
  // quietly does nothing at all.

  // AND THEN RETURN. This is the whole reason the window appears at all.
  //
  // An earlier version did the work in a `while (true)` loop here, pumping the run loop by hand.
  // Everything about it seemed to function: the page loaded, scripts ran, evaluateJavaScript
  // answered, the checklist rendered. But a blocking run() never gives the applet host its event
  // loop back, AppKit never finishes launching, and the window server never composites the window
  // -- so the app worked perfectly and invisibly. A WKWebView renders just as happily off screen,
  // which is exactly why every other check passed.
  //
  // So: set up, return, and do the polling from idle() below.
  phase = 'wait-ui';
}

// Called repeatedly by the applet host, which owns the event loop. Must return quickly -- whatever
// happens in here, the window is not redrawn until it returns.
function idle() {
  try {
    tick();
  } catch (e) {
    appendFile(FULLLOG, stamp() + '  idle error: ' + e.message + '\n');
  }
  return 0.15;
}

function tick() {
  if (!win) return;

  // The user closed the window. Minimising is not closing -- isVisible goes false for both.
  if (!win.isVisible && !win.isMiniaturized) { stopServer(); app.terminate(null); return; }

  // A window takes a few run-loop turns to reach the window server, so keep asking until it
  // answers rather than giving up on the first look -- which is what made this check a no-op.
  if (!placementChecked) {
    placementTries++;
    if (ensureOnScreen(win) || placementTries > 40) placementChecked = true;
  }
  syncAppearance();   // every phase, including after the dashboard takes the window over

  if (phase === 'wait-ui') {
    if (wv.title.isNil() || !wv.title.js) return;   // page still parsing
    appendFile(FULLLOG, stamp() + '  ui loaded, window on screen: ' + onScreen() + '\n');
    // Do not show a setup checklist to someone who is not setting anything up.
    //
    // The survey has to run on every launch -- it is the only thing that knows whether Node, Claude
    // Code and the server are actually there. But it used to run in FRONT of the plan view, so
    // reopening a Mac that has been set up for weeks meant watching "Here is everything that will
    // happen" and six rows tick through before the dashboard appeared. The work was right; showing
    // it was not.
    //
    // Whether this is a first run is answerable from two files, with no subprocess and no waiting:
    // setupFinished() reads config/job-seeker.config.md and data/criteria.md. When it says yes, the
    // window holds one quiet line while the survey runs behind it. When the survey then finds real
    // work after all, decideWhatToDo puts the wizard back.
    if (setupFinished()) {
      quietStart = true;
      state.view = 'work';
      state.title = 'Starting JobSeeker';
      state.subtitle = 'One moment.';
      state.brandnote = '';
      state.status = '';
      state.busy = false;
    }
    push();
    launchStep('check-all');
    phase = 'survey';
    return;
  }

  if (phase === 'survey') {
    if (!task) return;
    drainStepLog();
    if (task.isRunning) return;
    drainStepLog();
    appendFile(FULLLOG, readFile(STEPLOG) + '\n');
    running = null; task = null;
    state.busy = false; state.log = '';
    decideWhatToDo();
    phase = 'ready';
    return;
  }

  // ---- ready: the ordinary loop, one iteration per idle ----
  if (openAt && Date.now() >= openAt) { openAt = 0; openDashboard(); return; }
  if (openAt) return;

  if (task) {
    drainStepLog();
    if (!task.isRunning) afterStep(task.terminationStatus === 0);
    push();
    return;
  }

  if (mode === 'app') return;   // the dashboard owns the web view now

  var cmd = readCommand();
  if (!cmd) return;

  if (cmd.cmd === 'quit') { stopServer(); app.terminate(null); return; }
  if (cmd.cmd === 'open') { openDashboard(); return; }
  if (cmd.cmd === 'stop') { if (task) { try { task.terminate; } catch (e) {} } return; }
  if (cmd.cmd === 'wa-skip') {
    skipped.whatsapp = true;
    var ws = stepById('whatsapp');
    if (ws) { ws.state = 'skip'; ws.detail = 'Skipped — you can set this up later.'; }
    state.code = '';
    onQueueEmpty();
    return;
  }
  if (cmd.cmd === 'wa-start') {
    state.code = '';
    state.failed = false;
    queuedTotal = 1; queuedDone = 0;
    launchStep('whatsapp', cmd.v || '');
    return;
  }
  if (cmd.cmd === 'continue') { showPlan(); return; }
  if (cmd.cmd === 'back') { state.view = 'welcome'; push(); return; }
  if (cmd.cmd === 'begin') { state.failed = false; enqueueAll(); startNext(); return; }
  if (cmd.cmd === 'skip') {
    skipped[cmd.id] = true;
    var sk = stepById(cmd.id);
    if (sk) { sk.state = 'skip'; sk.detail = 'Skipped — you can add this later.'; }
    state.failed = false;
    startNext();
    return;
  }
  if (cmd.cmd === 'run') {
    state.failed = false;
    var one = stepById(cmd.id);
    if (one) one.detail = '';
    queue.unshift(cmd.id);
    startNext();
    return;
  }
}

// What the survey found decides which of three things this launch is.
function decideWhatToDo() {
  // Interactive steps are optional by nature, so a Mac that skipped WhatsApp is still "set up" --
  // counting it here would send someone back through setup on every launch.
  var missing = STEPS.filter(function (s) { return s.state !== 'ok' && !s.interactive; });
  var onlyStartMissing = missing.length === 1 && missing[0].id === 'start';
  state.allInstalled = missing.length === 0;

  if (missing.length === 0) {
    // Set up, and already answering: an ordinary launch of an app configured weeks ago.
    state.brandnote = '';
    openDashboard();
    return;
  }
  if (onlyStartMissing) {
    state.brandnote = '';
    quietStart = true;
    queue = ['start'];
    queuedTotal = 1; queuedDone = 0;
    state.title = 'Starting JobSeeker';
    state.subtitle = 'One moment.';
    startNext();
    return;
  }
  // There is real work to do, so open on the welcome rather than dropping someone straight into
  // a list of things about to be installed on their Mac. Whatever the quiet start assumed, this
  // launch IS a setup run.
  quietStart = false;
  state.view = 'welcome';
  state.status = 'Nothing has been installed yet.|';
  push();
}

function showPlan() {
  var missing = STEPS.filter(function (s) { return s.state !== 'ok'; });
  state.view = 'plan';
  state.title = 'Here is everything that will happen.';
  var need = missing.filter(function (s) { return s.id !== 'start' && s.id !== 'configure'; });
  state.subtitle = need.length
    ? 'JobSeeker needs ' + need.length + ' thing' + (need.length > 1 ? 's' : '')
      + ' this Mac does not have yet. Nothing is installed until you press Begin, and nothing '
      + 'is sent anywhere.'
    : 'Almost there — just your settings and a first start.';
  state.status = 'Ready|— it checks first and skips whatever is already installed.';
  push();
}

// The applet host calls this on Cmd-Q and on Quit from the menu.
function quit() {
  stopServer();
  return true;
}
