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
    password: false }
];

var state = {
  view: 'plan', title: 'Checking this Mac',
  subtitle: 'One moment — looking at what is already installed.',
  brandnote: '· first run on this Mac',
  steps: [], pct: 0, say: '', log: '', need: '', status: 'Looking…',
  busy: false, failed: false, allInstalled: false
};

function stepById(id) {
  for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return STEPS[i];
  return null;
}

function syncSteps() {
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
var mode = 'setup';

// ------------------------------------------------------------------ window placement
// NSWindow's own -center puts the window on the MAIN screen, which on a multi-monitor Mac is
// wherever the menu bar lives -- not necessarily the display the user is looking at. A setup
// window that opens on the other monitor looks exactly like a setup window that failed to open.
// Put it on the screen holding the pointer instead, which is the best available guess at "here".
function placeOnActiveScreen(w) {
  try {
    var mouse = $.NSEvent.mouseLocation;
    var screens = $.NSScreen.screens;
    var target = $.NSScreen.mainScreen;
    for (var i = 0; i < screens.count; i++) {
      var sc = screens.objectAtIndex(i);
      var fr = sc.frame;
      if (mouse.x >= fr.origin.x && mouse.x <= fr.origin.x + fr.size.width &&
          mouse.y >= fr.origin.y && mouse.y <= fr.origin.y + fr.size.height) {
        target = sc; break;
      }
    }
    var vf = target.visibleFrame, f = w.frame;
    // setFrameOrigin: takes ONE argument. An earlier version passed a second (display) flag,
    // which does not match any selector -- it threw, the catch below swallowed it, and the window
    // silently fell back to -center on every launch. A caught exception that changes behaviour is
    // worse than a crash, so this stays a single, correct call.
    w.setFrameOrigin($.NSMakePoint(
      vf.origin.x + (vf.size.width - f.size.width) / 2,
      // Slightly above true centre: a window pinned dead-centre reads as lower than it is.
      vf.origin.y + (vf.size.height - f.size.height) * 0.58));
  } catch (e) {
    w.center;
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
    if (verb === 'pct') { state.pct = parseInt(rest, 10) || 0; }
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
var openAt = 0;

function enqueueAll() {
  queue = [];
  for (var i = 0; i < STEPS.length; i++) {
    var s = STEPS[i];
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
  state.title = 'Getting this Mac ready';
  state.subtitle = 'Step ' + queuedDone + ' of ' + queuedTotal + ' \u00b7 '
    + (s ? s.label.toLowerCase() : id);
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
  if (startStep && startStep.state === 'ok') {
    state.view = 'done';
    state.title = 'JobSeeker is ready';
    state.subtitle = anySkipped
      ? 'Set up, without ' + Object.keys(skipped).join(' and ') + '. You can add that later.'
      : 'Opening it now.';
    state.status = 'Done|— nothing has run yet, and nothing will without your say-so.';
    push();
    // A beat so the finished checklist is readable, then hand the window over. Scheduled rather
    // than slept: idle() must return promptly or the window stops being drawn.
    openAt = Date.now() + (anySkipped ? 1400 : 900);
    return;
  }
  state.view = 'work';
  state.title = 'Not finished';
  state.subtitle = 'JobSeeker could not start. The rows below say why.';
  state.status = 'Stopped|';
  push();
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
    win.styleMask = (win.styleMask & ~$.NSWindowStyleMaskFullSizeContentView)
                  | $.NSWindowStyleMaskResizable;
    win.titlebarAppearsTransparent = false;
    win.titleVisibility = 0;          // NSWindowTitleVisible
  } catch (e) { /* keep whatever we had */ }
  win.title = 'JobSeeker';
  // Breadcrumb. When someone reports "it opened on a blank window", this line in
  // data/.setup/setup.log is the difference between knowing the handoff happened and guessing.
  appendFile(FULLLOG, stamp() + '  window handed over to ' + url + '\n');
  win.setFrameDisplayAnimate($.NSMakeRect(0, 0, 1180, 900), true, false);
  placeOnActiveScreen(win);
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

  var rect = $.NSMakeRect(0, 0, 780, 620);
  win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
    rect,
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskMiniaturizable
      | $.NSWindowStyleMaskFullSizeContentView,
    2, false);
  win.title = 'JobSeeker Setup';
  win.titlebarAppearsTransparent = true;
  win.titleVisibility = 1;             // NSWindowTitleHidden — the page draws its own heading
  win.releasedWhenClosed = false;      // so polling isVisible after a close is safe
  try {
    win.collectionBehavior = $.NSWindowCollectionBehaviorMoveToActiveSpace
                           | $.NSWindowCollectionBehaviorManaged;
  } catch (e) { /* older macOS: leave the default */ }
  placeOnActiveScreen(win);

  var cfg = $.WKWebViewConfiguration.alloc.init;
  wv = $.WKWebView.alloc.initWithFrameConfiguration(rect, cfg);
  wv.loadFileURLAllowingReadAccessToURL(
    $.NSURL.fileURLWithPath($(UI)), $.NSURL.fileURLWithPath($(RES)));
  win.contentView = wv;
  win.makeKeyAndOrderFront(null);
  win.orderFrontRegardless;
  app.activateIgnoringOtherApps(true);

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

  if (phase === 'wait-ui') {
    if (wv.title.isNil() || !wv.title.js) return;   // page still parsing
    appendFile(FULLLOG, stamp() + '  ui loaded, window on screen: ' + onScreen() + '\n');
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
  var missing = STEPS.filter(function (s) { return s.state !== 'ok'; });
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
    queue = ['start'];
    queuedTotal = 1; queuedDone = 0;
    state.title = 'Starting JobSeeker';
    state.subtitle = 'One moment.';
    startNext();
    return;
  }
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
