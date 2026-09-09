// The setup window on Windows: the same page as the Mac, hosted instead of embedded.
//
// On macOS the setup window is installer/JobSeeker.js -- a JXA applet that draws a real Cocoa
// window with a WKWebView in it and loads installer/ui.html from the app bundle. That works there
// because osacompile and WebKit are already on every Mac before anything is installed. Windows has
// no equivalent: there is no stock scriptable window toolkit, and the one thing install.ps1 does
// guarantee is Node.
//
// So Windows keeps the page and replaces the host. This file is a ~200-line HTTP server on
// 127.0.0.1 that serves ui.html and drives exactly the same state machine, and the window is an
// Edge (or Chrome) "app window" -- a browser with no tabs, no address bar and no browser chrome --
// pointed at it. To the user it is a window with the JobSeeker setup in it, which is the point.
//
// What talks to what:
//
//   install.ps1 -> installer\win\JobSeeker.vbs -> node installer/win/setup-server.mjs
//   server  -> page : Server-Sent Events on GET /events. Each event is the SAME `state` object
//                     JobSeeker.js hands to __render(state); ui.html feeds it straight to
//                     __render, so the page cannot tell which host it is running under.
//   page    -> server : POST /cmd with the SAME {n, cmd, id, v} envelope the Mac page writes into
//                     location.hash. `n` is a monotonic sequence and is deduped here, exactly as
//                     JobSeeker.js's readCommand() does with lastSeq.
//   server  -> steps : child_process.spawn of platform.scriptCommand("setup-step", [step, arg]),
//                     which resolves to scripts\win\setup-step.ps1 on Windows and to
//                     scripts/setup-step.sh on macOS. That second half is not an accident: it is
//                     what makes this server runnable and testable on a Mac.
//
// The "::" line protocol (::step / ::detail / ::pct / ::say / ::need / ::code / ::done) is parsed
// by drainStepLog() below, character for character as the JXA version parses it, and the raw
// transcript is written to data/.setup/step.log and data/.setup/setup.log just as the app does.
//
// Two deliberate differences from the Mac app, both marked again where they happen:
//   * the `start` step is NOT given a parent pid -- see startNext();
//   * the handover to the dashboard is a navigation of the page rather than a reload of a web
//     view we own -- see openDashboard().
//
// Node >= 20 built-ins only. No dependencies, by project rule.

import { createServer } from "http";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import * as platform from "../../server/platform.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

const WORK = path.join(REPO, "data", ".setup");
const UI = path.join(REPO, "installer", "ui.html");
const STEPLOG = path.join(WORK, "step.log");
const FULLLOG = path.join(WORK, "setup.log");

// This server also runs on macOS (that is how it is tested), so the copy asks the platform rather
// than assuming. Everything else about the wording is the Mac app's, unchanged.
const HOST_NOUN = platform.IS_WIN ? "this PC" : "this Mac";

// ------------------------------------------------------------------ tiny helpers
function stamp() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
// stderr, never stdout: stdout belongs to whoever launched us and may be a pipe nobody reads.
function log(msg) {
  process.stderr.write(`${stamp()}  ${msg}\n`);
}
function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function appendLog(p, s) {
  try {
    fs.appendFileSync(p, s);
  } catch {
    /* the log is a convenience, never a reason to stop */
  }
}

// ------------------------------------------------------------------ the steps
// Copied from installer/JobSeeker.js, with one addition. `password` and `optional` are presentation
// only -- setup-step decides what actually happens. They exist so the plan screen can tell the
// truth about a step before the user agrees to it.
const STEPS = [
  {
    id: "node",
    label: "Install Node 22 LTS",
    note: "The engine JobSeeker runs on. Downloaded from nodejs.org.",
    password: true,
  },
  // Windows only, and it earns its row: Claude Code on Windows shells out to Git's bundled bash for
  // its own scripts, so without Git for Windows the agents install and then fail to run. On the Mac
  // the equivalent is /bin/bash, which is already there, which is why the Mac list has no such step.
  {
    id: "git",
    label: "Git for Windows",
    note: "Claude Code on Windows runs its commands through Git's bash. Downloaded from git-scm.com.",
    password: true,
  },
  {
    id: "claude",
    label: "Install Claude Code",
    note: "Where the agents live. Downloaded from claude.ai.",
    password: false,
    // Installed and usable are not the same thing: the binary arrives signed out, and the first
    // agent JobSeeker runs would fail with an auth error that says nothing about setup. The step
    // says so on its own row, and this opens a terminal already running the sign-in.
    help: "claude",
    helpLabel: "Sign in",
  },
  {
    id: "chrome",
    label: "Install Google Chrome",
    note: "Only for reading WhatsApp and LinkedIn. Everything else works without it.",
    password: true,
    optional: true,
  },
  {
    id: "configure",
    label: "Set up your settings and agents",
    note: "Creates your settings file and installs the browser agent.",
    password: false,
  },
  {
    id: "start",
    label: "Start JobSeeker",
    note: `On ${HOST_NOUN} only. Nothing is sent anywhere.`,
    password: false,
  },
  // AFTER `start`, not before it, and the ordering is load-bearing rather than cosmetic. The
  // extension finds the bridge by probing 4319 then 4320 and pairs with whichever answers, and
  // "connected" lives in the memory of THAT process only. Run before `start` and the step would
  // stand up its own `bridge.mjs --serve` on 4320, pair the extension against it, and then the
  // dashboard that starts a moment later on 4319 would show Settings > Browser as not connected --
  // a green row in the installer contradicted by the first screen the user sees. Running after
  // `start` means the extension pairs with the dashboard's own bridge, so what this step proves is
  // the same thing the dashboard reports afterwards.
  {
    id: "extension",
    label: "Connect the Chrome extension",
    note: "Chrome makes you load this one by hand — it opens the page and copies the path for you.",
    password: false,
    optional: true,
    // Puts an "Install instructions" button on this row. Chrome will not let a program add the
    // extension, so this is the one step where the person has to do something themselves -- and
    // "Connect the Chrome extension" on its own tells them nothing about what.
    help: "extension",
    helpLabel: "Install instructions",
  },
  // Listed so "everything that will happen" is true, but `interactive` keeps it out of the queue:
  // it needs a phone number and a phone, so it gets its own screen after the rest is done.
  {
    id: "whatsapp",
    label: "Connect WhatsApp",
    note: "Optional, and you choose. Asked at the end.",
    password: false,
    optional: true,
    interactive: true,
    // Same reason as the extension: "Connect WhatsApp" names a thing, not an action. This one also
    // needs a phone in your hand, so what it has to say cannot wait until the screen appears.
    help: "whatsapp",
    // Not "instructions": nothing is installed and there is nothing to read up on. Pressing it
    // starts the connection, in the window, and the label should say so.
    helpLabel: "Start connection",
  },
];

// Opens on the welcome. The survey runs behind it, because nobody wants to meet a piece of software
// for the first time through a list of things it is about to install on their PC, and least of all
// while that list is still being computed and says "Checking..." for several seconds.
const state = {
  view: "welcome",
  // The welcome hides both of these and every other view sets them before it is shown, so they are
  // only ever a fallback. They no longer say "one moment": nothing here waits on the survey.
  title: "JobSeeker",
  subtitle: "",
  brandnote: `· first run on ${HOST_NOUN}`,
  steps: [],
  pct: 0,
  say: "",
  log: "",
  need: "",
  code: "",
  codeFor: "",
  waKnown: "",
  status: "Ready when you are.|",
  busy: false,
  failed: false,
  allInstalled: false,
  // Is the dashboard actually answering? Asked of the dashboard itself, not inferred from a step
  // that may have been skipped, retried, or already green before this window opened.
  started: false,
  // Set on the closing screen: name the two shortcuts the installer made.
  whereItLives: false,
};

function stepById(id) {
  return STEPS.find((s) => s.id === id) || null;
}

// A quiet start has nothing to show: the rows are a list of things being installed, and on this
// path nothing is. An empty list renders as no list.
let quietStart = false;

/**
 * Is Claude Code already signed in?
 *
 * The file is the one Claude Code writes when a sign-in succeeds, and an API key in the
 * environment is the other way to be authorised. Neither is read -- only their presence is
 * checked, and only to decide whether to offer help nobody needs. A wrong answer here costs a
 * button, never a step.
 */
function claudeSignedIn() {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json"));
  } catch {
    return false;
  }
}

function syncSteps() {
  if (quietStart) {
    state.steps = [];
    return;
  }
  const signedIn = claudeSignedIn();
  state.steps = STEPS.map((s) => ({
    id: s.id,
    label: s.label,
    note: s.note,
    password: !!s.password,
    optional: !!s.optional,
    // Someone already signed in does not need a Sign in button on the row, and being told to do
    // something you have done reads as the software not knowing what it is doing.
    help: s.id === "claude" && signedIn ? "" : s.help || "",
    helpLabel: s.helpLabel || "",
    state: s.state || "todo",
    detail: s.detail || "",
  }));
}

// ------------------------------------------------------------------ server -> page
const clients = new Set();
let clientsLeftAt = 0;

function push() {
  syncSteps();
  const frame = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

// ------------------------------------------------------------------ running a step
let child = null;
let running = null;
let stepBuf = "";

function launchStep(id, extraArg) {
  stepBuf = "";
  cancelled = false;
  try {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(STEPLOG, "");
  } catch {
    /* the transcript file is a convenience */
  }
  const args = [id];
  if (extraArg) args.push(String(extraArg));
  const c = platform.scriptCommand("setup-step", args);
  log(`run: ${c.cmd} ${c.args.join(" ")}`);
  try {
    // stdin is a PIPE we never write to and never close, not "ignore".
    //
    // "ignore" gives the step NUL, which reads as end-of-file the instant anything looks at it.
    // That would be harmless if the step were the only reader -- but the WhatsApp channel server it
    // starts inherits that handle, and that server is an MCP stdio server: it has
    // process.stdin.on("end", shutdown). So it shut itself down seconds after starting, took its
    // two-second grace window, and exited while the phone was still on "Logging in". The phone then
    // failed, every time, for a reason nothing on this side reported.
    //
    // Measured on Windows 11: a child of a parent whose stdin is NUL reports STDIN-EOF immediately;
    // the same child under a parent with a real stdin is still alive three seconds later.
    child = spawn(c.cmd, c.args, { cwd: REPO, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    // Never end() this. An open pipe with no writer is exactly what the channel needs: no data, no
    // EOF. It closes when the step exits, which is when the channel should stop caring anyway.
    if (child.stdin) child.stdin.on("error", () => { /* the step may exit first; nothing to do */ });
  } catch (e) {
    child = null;
    running = null;
    const st = stepById(id);
    if (st) {
      st.state = "fail";
      st.detail = `Could not start this step: ${e.message}`;
    }
    return false;
  }
  // PowerShell enumerates every filesystem drive when it starts, and complains on stderr about any
  // that will not answer -- a disconnected network share, or the WebDAV drive a VM's shared-folder
  // feature leaves behind. It has nothing to do with the step, but it lands before every one of
  // them and makes a healthy log read like a broken one. Dropped here rather than suppressed in
  // each script, because it is PowerShell talking, not us.
  const NOISE = /^.*InitializeDefaultDrives operation on the '.*' provider failed.*$\r?\n?/gm;
  let sawDone = false;
  const take = (buf) => {
    const text = String(buf).replace(NOISE, "");
    if (!text) return;
    stepBuf += text;
    if (/^::done\b/m.test(stepBuf)) sawDone = true;
    appendLog(STEPLOG, text);
    drainStepLog();
    push();
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("error", (e) => {
    log(`step ${id} could not run: ${e.message}`);
  });
  // 'exit' says the step is over. 'close' says that AND every pipe it held is shut, which is a
  // different and much later event when the step deliberately leaves something running: the `start`
  // step launches the dashboard, the dashboard inherits this pipe, and it is meant to outlive the
  // installer. Waiting for 'close' there meant waiting forever -- the step wrote "ok", exited, the
  // dashboard answered on its port, and the wizard sat on "Starting JobSeeker" for good.
  //
  // So finish on 'exit', after a beat to collect anything still in flight, and let whichever event
  // arrives first do the work exactly once.
  let settled = false;
  const settle = (code) => {
    if (settled) return;
    settled = true;
    drainStepLog();
    // A step we killed on purpose is not a step that failed. Without this, cancelling an attempt
    // would land in onStepClosed with `running` already cleared, find no step to blame, and mark
    // the whole run failed -- a red screen for someone who had simply closed a window.
    if (cancelled) {
      appendLog(FULLLOG, `${stepBuf}\n`);
      child = null;
      return;
    }
    onStepClosed(code === 0);
  };
  // Every step ends by printing `::done`. Waiting for that, rather than for the process or its
  // pipes, is the only signal that the output has actually been READ -- a step can exit with its
  // last lines still in the pipe, and settling then means acting on a step whose result has not
  // been parsed yet. That is what marked the Chrome extension "Needs Start JobSeeker first" a
  // moment before Start JobSeeker was recorded as ok.
  const waitForDone = (code, tries) => {
    if (settled) return;
    if (sawDone || tries <= 0) return settle(code);
    setTimeout(() => waitForDone(code, tries - 1), 100);
  };
  child.on("exit", (code) => waitForDone(code, 30)); // up to ~3s for the tail to arrive
  child.on("close", (code) => settle(code));
  running = id;
  state.busy = true;
  state.pct = 0;
  state.say = "";
  state.log = "";
  // A `need` (or a `code`) belongs to the step that asked for it. Carrying one into the next step
  // leaves the page asking for something nobody is waiting on any more.
  state.need = "";
  state.code = "";
  state.codeFor = "";
  push();
  return true;
}

// Read the step's output and turn the "::" lines into state. Everything else is transcript.
// Line for line the same parse as JobSeeker.js's drainStepLog(): it re-reads the whole accumulated
// output each time rather than tracking a cursor, which is what makes a late ::detail for an
// earlier row land where it should.
function drainStepLog() {
  const lines = stepBuf.split("\n");
  const plain = [];
  for (const L of lines) {
    if (L.slice(0, 2) !== "::") {
      if (L.length) plain.push(L);
      continue;
    }
    const sp = L.indexOf(" ", 2);
    const verb = sp === -1 ? L.slice(2) : L.slice(2, sp);
    const rest = sp === -1 ? "" : L.slice(sp + 1);
    if (verb === "code") {
      state.code = rest.trim();
      // Which step's code this is. Two steps mint one, they look alike, and only one of them wants
      // the bar at the top of the window -- so the page is told rather than left to guess.
      state.codeFor = running || "";
      if (running === "whatsapp") waCodeShown = true;
    } else if (verb === "pct") {
      state.pct = parseInt(rest, 10) || 0;
    } else if (verb === "say") {
      state.say = rest;
    } else if (verb === "need") {
      state.need = rest;
    } else if (verb === "step") {
      const p = rest.split(" ");
      const s1 = stepById(p[0]);
      if (s1) s1.state = p[1];
    } else if (verb === "detail") {
      const q = rest.indexOf(" ");
      const s2 = stepById(q === -1 ? rest : rest.slice(0, q));
      if (s2) s2.detail = q === -1 ? "" : rest.slice(q + 1);
    }
  }
  // The extension's code used to be folded into the need box, where it read as one more sentence
  // to get through. It now has a bar of its own pinned to the top of the window, which is where a
  // number you have to type into another program belongs: still on screen after you have scrolled
  // the instructions, and one click from the clipboard.
  state.log = plain.slice(-200).join("\n");
}

// ------------------------------------------------------------------ the queue
let queue = [];
const skipped = {};
let phase = "boot";
// Set when the user pressed Continue before the survey had finished; the plan is shown as soon as
// there is one to show.
let wantPlan = false;
// Set when Begin was pressed before the survey had finished; the run starts as soon as it has.
let wantBegin = false;
let waOffered = false;
// True while a WhatsApp run was started from the modal on the row, not from the WhatsApp screen.
let waFromModal = false;
// True once a code has actually been shown to the user in this attempt. A screen carrying a code
// is never replaced by an outcome screen; the outcome is added to it.
let waCodeShown = false;
// Set when a step was killed deliberately, so its exit is not read as a verdict.
let cancelled = false;
let queuedTotal = 0;
let queuedDone = 0;
let flowDone = false;

function enqueueAll() {
  queue = [];
  for (const s of STEPS) {
    if (s.interactive) continue; // its own screen, not a queued task
    if (s.state !== "ok" && !skipped[s.id]) queue.push(s.id);
  }
  queuedTotal = queue.length;
  queuedDone = 0;
}

function startNext() {
  if (queue.length === 0) {
    onQueueEmpty();
    return;
  }
  const id = queue.shift();
  const s = stepById(id);
  if (s && s.state === "ok") {
    startNext();
    return;
  }
  queuedDone++;
  state.view = "work";
  if (quietStart) {
    // Said once by decideWhatToDo and left alone: no step count, no row list, nothing to read.
    state.title = "Starting JobSeeker";
    state.subtitle = "One moment.";
  } else {
    state.title = `Getting ${HOST_NOUN} ready`;
    state.subtitle = `Step ${queuedDone} of ${queuedTotal} \u00b7 ${s ? s.label.toLowerCase() : id}`;
  }
  // DIFFERENT FROM THE MAC ON PURPOSE: no parent pid.
  //
  // JobSeeker.app passes its own pid to `start`, which arms a watchdog that takes the dashboard
  // down when the app quits -- correct there, because the app window BECOMES the dashboard and
  // closing it is how you quit JobSeeker. Here the window is a browser and this server is a
  // setup wizard that exits a few seconds after the handover; the dashboard has to outlive both,
  // because it is the thing the user is about to be looking at. Passing our pid would kill the
  // dashboard moments after opening it.
  if (!launchStep(id, null)) afterStep(false);
}

function onStepClosed(ok) {
  appendLog(FULLLOG, `${stepBuf}\n`);
  child = null;

  if (phase === "survey") {
    running = null;
    state.busy = false;
    state.log = "";
    phase = "ready";
    decideWhatToDo();
    push();
    return;
  }
  afterStep(ok);
}

function afterStep(ok) {
  state.busy = false;
  state.say = "";
  state.pct = 0;

  // WhatsApp lives on its own screen: success moves on, failure stays put with the reason so the
  // number can be corrected, and neither touches the install queue.
  if (running === "whatsapp") {
    running = null;
    child = null;
    state.code = "";
    state.codeFor = "";
    // Started from the row rather than from the WhatsApp screen: the answer belongs in the window
    // the user is looking at, and the install queue is not waiting on it.
    if (waFromModal) {
      waFromModal = false;
      const ws = stepById("whatsapp");
      if (state.modal && state.modal.flow === "whatsapp") {
        // A screen showing a pairing code is never taken away. Whatever happened -- linked, timed
        // out, or the step deciding it was already done -- is reported UNDER the code, on the same
        // page, and the page stays until the user closes it. Replacing it is how the one number
        // somebody had to carry to their phone kept vanishing after a few seconds.
        if (waCodeShown) {
          state.modal.page = "code";
          state.modal.outcome = ok ? "ok" : "fail";
        } else {
          state.modal.page = ok ? "done" : "fail";
        }
        state.modal.err = ok ? "" : (ws && ws.detail) || "The phone did not answer in time.";
      }
      // Closing this modal used to leave the window sitting on the checklist with no action on it
      // at all -- setup finished, nothing running, and nothing to press. The flow is over either
      // way: say so, so the last screen has a way out of itself.
      state.busy = false;
      state.say = "";
      flowDone = true;
      push();
      return;
    }
    if (ok) {
      onQueueEmpty();
    } else {
      state.view = "whatsapp";
      push();
    }
    return;
  }
  if (running === "extension") {
    // Its code is single-use and five minutes old at most; leaving it on screen for the rest of the
    // run would be showing a number that no longer works.
    state.code = "";
    state.codeFor = "";
    state.need = "";
  }
  if (!ok) {
    const s = stepById(running);
    // A failed optional step is not a failed install — note it and keep going.
    if (s && s.optional) skipped[s.id] = true;
    else state.failed = true;
  }
  running = null;
  child = null;
  if (state.failed) {
    // Stop the run and let the user decide: retry that row, or continue without it.
    state.title = "One step did not finish";
    state.subtitle = "Nothing else was changed. Try it again, or carry on without it.";
    state.status = "Stopped|— nothing else will run until that row is dealt with.";
    push();
    return;
  }
  startNext();
}

function onQueueEmpty() {
  const startStep = stepById("start");
  const anySkipped = Object.keys(skipped).length > 0;
  const waStep = stepById("whatsapp");

  // An ordinary launch is not a setup run. If the wizard has been finished (or deliberately left),
  // this launch is just opening the app: go to the dashboard rather than offering WhatsApp again.
  if (setupFinished() && startStep && startStep.state === "ok") {
    state.brandnote = "";
    openDashboard();
    return;
  }

  if (startStep && startStep.state === "ok" && waStep && !skipped.whatsapp && !waOffered) {
    waOffered = true; // shown once per run, never nagged
    state.view = "whatsapp";
    state.busy = false;
    state.code = "";
    state.codeFor = "";
    if (waStep.state === "ok") {
      // Already linked. Say so and name the number: a listed step that silently disappears reads
      // as a step that failed.
      state.waKnown = waStep.detail || "connected";
      state.status = "Already connected.|Nothing to do here.";
    } else {
      state.waKnown = "";
      state.status = "Everything else is set up.|WhatsApp is optional.";
    }
    push();
    return;
  }

  if (startStep && startStep.state === "ok") {
    state.view = "done";
    state.title = "JobSeeker is ready";
    state.subtitle = anySkipped
      ? `Set up, without ${Object.keys(skipped).join(" and ")}. You can add that later.`
      : `Everything is installed and running on ${HOST_NOUN}.`;
    state.status = "Done|— nothing has run yet, and nothing will without your say-so.";
    // Where it lives from now on. The window is about to close and the shortcuts were made without
    // anyone watching, so this is the only moment anyone is told how to open it again.
    state.whereItLives = true;
    // Wait for the user. Setup used to hand the window over on a timer, which meant the one screen
    // saying what had just been done to their PC was gone before it could be read.
    flowDone = true;
    push();
    return;
  }
  state.view = "work";
  state.title = "Not finished";
  state.subtitle = "JobSeeker could not start. The rows below say why.";
  state.status = "Stopped|— nothing else will run. The rows above say which step it was.";
  push();
}

// Has this machine finished setting up?
//
// The same three tests the dashboard's own needsWelcome() uses, so the setup window and the
// dashboard can never disagree about whether this is a first run:
//   * `welcome_done:`  the wizard was finished,
//   * `welcome_left:`  the user walked out of it deliberately,
//   * markets or roles in data/criteria.md — an install from BEFORE the wizard existed, or one set
//     up with /onboard in the terminal.
function setupFinished() {
  const cfg = readFileSafe(path.join(REPO, "config", "job-seeker.config.md"));
  if (/^welcome_(done|left):[ \t]*\S/m.test(cfg)) return true;
  const crit = readFileSafe(path.join(REPO, "data", "criteria.md"));
  return /^markets:[ \t]*\S/m.test(crit) || /^roles:[ \t]*\S/m.test(crit);
}

// ------------------------------------------------------------------ is JobSeeker up?
//
// Two rows depend on this: the Chrome extension pairs against the bridge the dashboard hosts, and
// WhatsApp writes into a configured, running install. Both were gated on the `start` step reading
// "ok", which is a record of what this window did -- not of what is true. A start that was already
// green before the window opened, a step retried on its own, a run that reached the extension by
// another path: each leaves the record saying something other than "ok" while JobSeeker is up and
// answering, and the buttons stayed grey with no way to argue.
//
// So ask the dashboard. It either answers on its port or it does not.
let dashProbe = null;
async function checkStarted() {
  const url = `http://127.0.0.1:${dashboardPort()}/_whoami`;
  let up = false;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    up = r.ok;
  } catch {
    up = false;
  }
  if (up !== state.started) {
    state.started = up;
    log(`JobSeeker is ${up ? "answering" : "not answering"} on port ${dashboardPort()}`);
    push();
  }
}

function watchStarted() {
  if (dashProbe) return;
  checkStarted();
  // Every two seconds while the window is open. It is one loopback request to a server on this
  // machine; the cost of asking is far below the cost of a button that is wrong.
  dashProbe = setInterval(checkStarted, 2000);
  dashProbe.unref();
}

// ------------------------------------------------------------------ the handoff
function dashboardPort() {
  const cfg = readFileSafe(path.join(REPO, "config", "job-seeker.config.md"));
  const m = /^dashboard_port:[ \t]*(\d+)/m.exec(cfg);
  return m ? m[1] : "4319";
}

// DIFFERENT FROM THE MAC ON PURPOSE: the Mac app reloads the web view it owns, so the setup window
// literally becomes the dashboard window. Here the window belongs to Edge, so the page navigates
// itself: state carries a `dashboardUrl`, ui.html sees it and does location.replace(). Same window,
// same effect, and this server is then finished -- it exits a moment later so nothing is left
// running behind the dashboard.
function openDashboard() {
  // 127.0.0.1, not localhost: the dashboard binds the IPv4 loopback only, and localhost resolves to
  // ::1 first on Windows.
  const url = `http://127.0.0.1:${dashboardPort()}`;
  flowDone = true;
  state.dashboardUrl = url;
  log(`window handed over to ${url}`);
  appendLog(FULLLOG, `${stamp()}  window handed over to ${url}\n`);
  push();
  setTimeout(() => shutdown("handed over to the dashboard"), 5000);
}

// ------------------------------------------------------------------ what this launch is
function decideWhatToDo() {
  // Interactive steps are optional by nature, so a machine that skipped WhatsApp is still "set up"
  // -- counting it here would send someone back through setup on every launch.
  const missing = STEPS.filter((s) => s.state !== "ok" && !s.interactive);
  const onlyStartMissing = missing.length === 1 && missing[0].id === "start";
  state.allInstalled = missing.length === 0;

  if (missing.length === 0) {
    // Set up, and already answering: an ordinary launch of an app configured weeks ago.
    state.brandnote = "";
    openDashboard();
    return;
  }
  if (onlyStartMissing) {
    state.brandnote = "";
    quietStart = true;
    queue = ["start"];
    queuedTotal = 1;
    queuedDone = 0;
    state.title = "Starting JobSeeker";
    state.subtitle = "One moment.";
    startNext();
    return;
  }
  // There is real work to do. The welcome is already on screen, so leave it there -- unless the
  // user has already pressed Continue and is waiting on us.
  state.status = "Nothing has been installed yet.|";
  if (wantBegin) {
    wantBegin = false;
    wantPlan = false;
    state.busy = false;
    state.say = "";
    enqueueAll();
    startNext();
    return;
  }
  if (wantPlan) {
    wantPlan = false;
    showPlan();
    return;
  }
  state.view = "welcome";
  push();
}

/**
 * Write everything worth reading into the user's Downloads folder, and say where it went.
 *
 * Downloads rather than the install directory: it is the one folder every Windows user can find
 * without being told a path, and the point of this button is that the person pressing it is already
 * stuck and about to send the file to someone.
 */
/** The five things to do, in order, with the two that are hard to find shown as pictures. */
function showExtensionHelp() {
  const folder = path.join(REPO, "extension");
  state.modal = {
    // Which instructions these are. The page shows the pairing code above them, and only these.
    help: "extension",
    title: "Connect the Chrome extension",
    body:
      "Chrome does not let a program add this for you, so these five steps are yours. Chrome is " +
      "open, and the folder below is already on your clipboard.",
    steps: [
      // Not "it is already open there": Chrome discards chrome:// URLs given on the command line
      // and lands on the new tab instead, so the menu route is the one that is always true.
      "In Chrome, open the \u2807 menu \u25b8 Extensions \u25b8 Manage extensions.",
      "Top right, turn on Developer mode.",
      `Click Load unpacked and choose this folder — press Ctrl+V to paste it:\n${folder}`,
      "On the JobSeeker Bridge card, click Details, then scroll down to Extension options.",
      "Type the pairing code shown at the top of this window, and press Connect.",
    ],
    images: ["/help-chrome-extensions.png", "/help-chrome-details.png"],
    path: "",
  };
  push();
}

/**
 * Connecting WhatsApp, as a small flow inside the modal rather than a page of advice.
 *
 * The first version of this described a "next screen" that only existed at the end of the install
 * queue: read from the row, it named a place the user could not get to. So the screen is here now.
 * Page one says what the step is and what it costs, page two takes the number, page three shows the
 * code to type into the phone. Each is a page of the same window, and the buttons at the foot are
 * whatever that page needs.
 */
function showWhatsAppHelp() {
  state.modal = {
    flow: "whatsapp",
    page: "intro",
    title: "Connect WhatsApp",
    body:
      "Optional. It links this computer to your WhatsApp so JobSeeker can send you the daily " +
      "digest there, and read job-related chats you point it at. It only ever sends \u2014 you " +
      "cannot give JobSeeker instructions over WhatsApp. You can skip this and add it later.",
    steps: [
      "Have your phone to hand \u2014 you finish this on the phone, not here.",
      "Press Start connection below and type your WhatsApp number.",
      "This window then shows a code.",
      "On the phone: WhatsApp \u25b8 Settings \u25b8 Linked Devices \u25b8 Link a Device \u25b8 " +
        "Link with phone number instead.",
      "Type the code into the phone. The row here turns green once the phone answers.",
    ],
    err: "",
  };
  push();
}

/**
 * Signing in to Claude, which cannot be done for anyone.
 *
 * It is a browser round trip that ends in a terminal, so the most this window can do is open that
 * terminal with the command already running and say what to expect. Sign-in state is Claude Code's
 * to keep; JobSeeker never sees the credentials and never asks for them.
 */
function showClaudeHelp() {
  state.modal = {
    help: "claude",
    title: "Sign in to Claude",
    body:
      "Claude Code arrives signed out. JobSeeker's agents run through it, so until you sign in " +
      "once, every run will stop at the first step. It is a one-off.",
    steps: [
      "Press Open sign-in below. A terminal window opens with Claude already running.",
      "Choose your login method. Claude opens your browser to finish it.",
      "When the browser says you are signed in, close the terminal. Nothing else to do.",
    ],
    images: [],
    path: "",
  };
  push();
}

/**
 * Open a real console with `claude` running in it.
 *
 * A console, not a hidden process: the sign-in is a conversation with the user -- it prints a URL,
 * waits, and asks which account. Anything without a visible window would hang forever on a prompt
 * nobody can see.
 */
function openClaudeSignin() {
  const bin = platform.resolveBin("claude");
  if (!bin) {
    state.modal = {
      title: "Claude Code is not on PATH",
      body:
        "It cannot be started from here. Install it first — the row above does that — then try " +
        "this again.",
      path: "",
    };
    push();
    return;
  }
  log(`opening a terminal for: ${bin}`);
  try {
    if (platform.IS_WIN) {
      // `start` needs the empty title argument, or it takes the quoted path as the window title.
      spawn("cmd", ["/c", "start", "", "cmd", "/k", bin], { cwd: REPO, detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("open", ["-a", "Terminal", bin], { cwd: REPO, stdio: "ignore" }).unref();
    }
  } catch (e) {
    log(`could not open a terminal: ${e.message}`);
  }
  state.modal = {
    help: "claude",
    title: "Finish in the terminal",
    body:
      "A terminal window is open with Claude running. Follow what it asks — it will open your " +
      "browser — then close it and come back here.",
    steps: [],
    images: [],
    path: "",
  };
  push();
}

/**
 * Everything that might explain a failure, in one zip, in Downloads, with a button that opens the
 * folder it is in.
 *
 * A path printed on screen is not a deliverable. The person reading it is already stuck, and asking
 * them to find a folder by transcribing a path is asking for one more thing to go wrong -- so the
 * window opens it for them, with the file selected.
 *
 * Two kinds of thing go in: the redacted summary diagnose.mjs writes, and the raw logs themselves,
 * which is what actually gets read when the summary is not enough. The zip is made by the OS's own
 * tool: Compress-Archive on Windows, ditto on macOS. Nothing here ships a zip library.
 */
let lastLogZip = "";

function collectLogs() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const downloads = path.join(os.homedir(), "Downloads");
  const stage = path.join(os.tmpdir(), `jobseeker-logs-${stamp}`);
  const zip = path.join(downloads, `jobseeker-logs-${stamp}.zip`);
  state.modal = { title: "Collecting\u2026", body: "Reading the logs.", path: "" };
  push();

  const fail = (why) => {
    log(`collecting logs failed: ${String(why).trim().slice(0, 200)}`);
    state.modal = {
      title: "Could not collect the logs",
      body: String(why).trim().slice(0, 300) || "The collector did not finish.",
      path: "",
    };
    push();
  };

  try {
    fs.mkdirSync(stage, { recursive: true });
    fs.mkdirSync(downloads, { recursive: true });
  } catch (e) {
    return fail(e.message);
  }

  // The raw logs, alongside the summary. Names are flattened so the zip is a flat, readable list.
  const copies = [
    [path.join(WORK, "setup.log"), "setup.log"],
    [path.join(WORK, "step.log"), "step.log"],
    [path.join(WORK, "server.log"), "dashboard-stdout.log"],
    [path.join(WORK, "server.err.log"), "dashboard-stderr.log"],
    [path.join(WORK, "whatsapp-server.log"), "whatsapp-server.log"],
    [path.join(WORK, "whatsapp-server.err.log"), "whatsapp-server.err.log"],
    [path.join(WORK, "bridge.err.log"), "bridge.err.log"],
    [path.join(os.tmpdir(), "jobseeker-install.log"), "installer.log"],
    [path.join(os.homedir(), ".whatsapp-channel", "pairing.log"), "whatsapp-pairing.log"],
  ];

  const c = platform.nodeCommand("scripts/diagnose.mjs", ["--out", path.join(stage, "diagnostics.txt")]);
  const p = spawn(c.cmd, c.args, { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  p.on("exit", () => {
    // A diagnose that failed is not a reason to hand over nothing: the raw logs are the half that
    // usually answers the question anyway.
    for (const [from, to] of copies) {
      try {
        // Shared read: these files are being written by processes that are still running, and a
        // plain copy of a live log fails on Windows.
        const fd = fs.openSync(from, "r");
        try {
          fs.writeFileSync(path.join(stage, to), fs.readFileSync(fd));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* absent or unreadable; its absence from the zip is itself informative */
      }
    }
    zipUp(stage, zip, (why) => {
      if (why) return fail(why);
      lastLogZip = zip;
      log(`logs collected to ${zip}`);
      state.modal = {
        title: "Logs saved",
        body:
          "Everything that might explain this is in one zip in your Downloads folder. Tokens, keys " +
          "and phone numbers are replaced in the summary. Send it on to whoever is helping.",
        path: zip,
        reveal: true,
      };
      push();
    });
  });
}

/** The OS's own zip tool. Windows: Compress-Archive. macOS: ditto. */
function zipUp(dir, out, done) {
  try {
    fs.rmSync(out, { force: true });
  } catch {
    /* nothing there */
  }
  const cmd = platform.IS_WIN
    ? {
        file: platform.resolveBin("powershell"),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${out.replace(/'/g, "''")}' -Force`,
        ],
      }
    : { file: "ditto", args: ["-c", "-k", "--sequesterRsrc", dir, out] };
  let err = "";
  const p = spawn(cmd.file, cmd.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", (d) => (err += d));
  p.on("error", (e) => done(e.message));
  p.on("exit", (code) => {
    if (code === 0 && fs.existsSync(out)) return done("");
    done(err.trim() || `the zip tool exited ${code}`);
  });
}

/** Open the folder holding a file, with the file selected. */
function revealInFolder(target) {
  if (!target) return;
  log(`opening the folder holding ${target}`);
  try {
    if (platform.IS_WIN) {
      // explorer returns a non-zero exit code even when it works; nothing here reads it.
      spawn("explorer.exe", [`/select,${target}`], { windowsHide: false, detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("open", ["-R", target], { stdio: "ignore", detached: true }).unref();
    }
  } catch (e) {
    log(`could not open the folder: ${e.message}`);
  }
}

function showPlan() {
  const missing = STEPS.filter((s) => s.state !== "ok");
  state.view = "plan";
  state.title = "Here is everything that will happen.";
  // Before the survey has landed, every step still reads as "not done", so the count below would
  // claim this PC has nothing. Say nothing about the count until it is known.
  const counted = phase === "ready";
  const need = missing.filter((s) => s.id !== "start" && s.id !== "configure");
  if (!counted) {
    state.subtitle =
      "Nothing is installed until you press Begin, and nothing is sent anywhere. Whatever this " +
      `${HOST_NOUN} already has is skipped.`;
  } else {
    state.subtitle = need.length
      ? `JobSeeker needs ${need.length} thing${need.length > 1 ? "s" : ""} ${HOST_NOUN} does not have ` +
        "yet. Nothing is installed until you press Begin, and nothing is sent anywhere."
      : "Almost there — just your settings and a first start.";
  }
  state.status = "Ready|— it checks first and skips whatever is already installed.";
  push();
}

/**
 * Stop a WhatsApp attempt the user has walked away from.
 *
 * Closing the window used to leave the run going: the bar kept moving and the footer kept saying
 * "Waiting for your phone" for a phone nobody was holding any more. Worse, the channel server the
 * step started outlives the step, and it holds a singleton lock -- so the abandoned attempt was
 * also what made the NEXT one refuse to start.
 *
 * Killing the step does not kill that server: it is a grandchild, started through a launcher that
 * has already exited. The lock file is how it is found, because it is the file the server writes
 * its own pid into.
 */
function stopChannelServer() {
  // Same override the step itself honours, so a scratch run never reaches for the real link.
  const waDir = process.env.JOBSEEKER_WA_DIR
    ? path.resolve(process.env.JOBSEEKER_WA_DIR)
    : path.join(os.homedir(), ".whatsapp-channel");
  const lock = path.join(waDir, ".server.lock");
  let pid = 0;
  try {
    pid = Number(String(fs.readFileSync(lock, "utf8")).trim().split(/\r?\n/)[0]);
  } catch {
    return; // no lock, nothing claiming to run
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid);
    log(`stopped the channel server the attempt left behind (pid ${pid})`);
  } catch {
    /* already gone, which is the outcome we wanted anyway */
  }
  try {
    fs.rmSync(lock, { force: true });
  } catch {
    /* the next attempt's own staleness check will deal with it */
  }
}

function cancelWhatsApp(why) {
  if (running !== "whatsapp") return false;
  log(`cancelling the WhatsApp attempt: ${why}`);
  cancelled = true;
  try {
    if (child) child.kill();
  } catch {
    /* already gone */
  }
  stopChannelServer();
  running = null;
  child = null;
  waFromModal = false;
  waCodeShown = false;
  state.busy = false;
  state.say = "";
  state.pct = 0;
  state.need = "";
  state.code = "";
  state.codeFor = "";
  const ws = stepById("whatsapp");
  // Back to "not done", not "failed": walking away is not a failure, and a red row would be a
  // verdict on something the user simply chose not to finish.
  if (ws && ws.state === "running") {
    ws.state = "todo";
    ws.detail = "";
  }
  return true;
}

// ------------------------------------------------------------------ page -> server
// The same envelope and the same dedupe as JobSeeker.js's readCommand(): the page counts its own
// commands and we ignore anything we have already seen, so a retried POST cannot run a step twice.
let lastSeq = 0;

function handleCommand(cmd) {
  if (!cmd || typeof cmd.n !== "number" || cmd.n <= lastSeq) return;
  lastSeq = cmd.n;
  // Every button press, in the log. If someone reports "I clicked Begin and nothing happened", the
  // presence or absence of this line says which half of the bridge broke.
  log(`ui: ${cmd.cmd}${cmd.id ? " " + cmd.id : ""}`);
  appendLog(FULLLOG, `${stamp()}  ui: ${cmd.cmd}${cmd.id ? " " + cmd.id : ""}\n`);

  if (cmd.cmd === "quit") {
    // Note what is NOT here: the Mac app kills the dashboard on quit, because there the window and
    // the dashboard are one thing. Quitting this wizard never touches a dashboard someone may be
    // using in another window.
    shutdown("the user quit");
    return;
  }
  if (cmd.cmd === "open") {
    openDashboard();
    return;
  }
  if (cmd.cmd === "stop") {
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  if (cmd.cmd === "wa-skip") {
    skipped.whatsapp = true;
    const ws = stepById("whatsapp");
    if (ws) {
      ws.state = "skip";
      ws.detail = "Skipped — you can set this up later.";
    }
    state.code = "";
    state.codeFor = "";
    onQueueEmpty();
    return;
  }
  // Turning the pages of the WhatsApp flow. It goes through the server rather than staying in the
  // page because the page is redrawn from this state on every push; a page number the server did
  // not know about would be undone by the next log line.
  if (cmd.cmd === "wa-page") {
    if (state.modal && state.modal.flow === "whatsapp") {
      // Turning back off the code page abandons the code on it; the attempt goes with it.
      if (cmd.id !== "code") cancelWhatsApp(`the user went back to ${cmd.id || "intro"}`);
      state.modal.page = cmd.id || "intro";
      if (cmd.id === "number") state.modal.err = "";
      push();
    }
    return;
  }
  if (cmd.cmd === "wa-start") {
    // One step at a time. The extension step waits fifteen minutes for a human, and starting
    // WhatsApp on top of it would replace the child this window is reading from -- the extension
    // would go silent, and its pairing code would keep arriving into a window about a phone.
    if (running) {
      log(`refused wa-start: ${running} is still running`);
      if (state.modal && state.modal.flow === "whatsapp") {
        state.modal.page = "number";
        state.modal.err =
          "Something else is still running in this window. Let it finish, or close it, then try again.";
        push();
      }
      return;
    }
    state.code = "";
    state.codeFor = "";
    state.failed = false;
    queuedTotal = 1;
    queuedDone = 0;
    if (state.modal && state.modal.flow === "whatsapp") {
      waFromModal = true;
      waCodeShown = false;
      state.modal.page = "code";
      state.modal.outcome = "";
      state.modal.err = "";
    }
    launchStep("whatsapp", cmd.v || "");
    return;
  }
  if (cmd.cmd === "continue") {
    // The plan is shown immediately, even mid-survey. It used to put up "Checking this PC / one
    // moment" instead, which made a button press feel like a queue: the survey is this program's
    // business, not something to hold a person at a blank screen for. The list of steps is known
    // without it; all the survey adds is which of them are already done, and it fills those in as
    // it lands. So: show the plan, and let it improve underneath.
    if (phase !== "ready") wantPlan = true;
    showPlan();
    return;
  }
  if (cmd.cmd === "help") {
    if (cmd.id === "extension") showExtensionHelp();
    if (cmd.id === "whatsapp") showWhatsAppHelp();
    if (cmd.id === "claude") showClaudeHelp();
    return;
  }
  if (cmd.cmd === "claude-signin") {
    openClaudeSignin();
    return;
  }
  if (cmd.cmd === "reveal-logs") {
    revealInFolder(lastLogZip);
    return;
  }
  if (cmd.cmd === "collect-logs") {
    collectLogs();
    return;
  }
  if (cmd.cmd === "dismiss-modal") {
    // Closing the WhatsApp window ends the attempt behind it. Leaving it running was how the bar
    // went on saying "Waiting for your phone" after the phone had been put down.
    const wasWa = state.modal && state.modal.flow === "whatsapp";
    state.modal = null;
    if (wasWa) cancelWhatsApp("the user closed the window");
    push();
    return;
  }
  if (cmd.cmd === "back") {
    state.view = "welcome";
    push();
    return;
  }
  if (cmd.cmd === "begin") {
    state.failed = false;
    // Someone can read the plan and press Begin faster than the survey finishes. Running now would
    // reinstall things this PC already has -- harmless, since every step checks first, but slow and
    // alarming to watch. A second or two of "checking" is the honest wait, and it is a wait the
    // user asked for by pressing the button.
    if (phase !== "ready") {
      wantBegin = true;
      state.busy = true;
      state.say = "Checking what is already installed";
      push();
      return;
    }
    enqueueAll();
    startNext();
    return;
  }
  if (cmd.cmd === "skip") {
    skipped[cmd.id] = true;
    const sk = stepById(cmd.id);
    if (sk) {
      sk.state = "skip";
      sk.detail = "Skipped — you can add this later.";
    }
    state.failed = false;
    startNext();
    return;
  }
  if (cmd.cmd === "run") {
    state.failed = false;
    const one = stepById(cmd.id);
    if (one) one.detail = "";
    queue.unshift(cmd.id);
    startNext();
  }
}

// ------------------------------------------------------------------ the logo
// ui.html asks for logo-128.png by name (that is the filename the Mac bundle gets from
// scripts/build-app.sh, which converts whatever master it finds). There is no conversion step here,
// so we serve the best master we have under its real content type and let the browser decide -- a
// webp answered as image/webp renders perfectly behind a .png URL.
//
// Order is about the artwork, not the format: public/logo-128.webp is matted onto BLACK (build-app.sh
// says so, and prefers the transparent master over it for the same reason), which reads as a black
// tile on the light scheme. The transparent PNGs go first.
const LOGO_CANDIDATES = [
  ["public/logo.png", "image/png"],
  ["public/logo-mark.png", "image/png"],
  ["public/logo-128.webp", "image/webp"],
  ["public/favicon-48.png", "image/png"],
];

function findLogo() {
  for (const [rel, type] of LOGO_CANDIDATES) {
    const p = path.join(REPO, rel);
    try {
      if (fs.statSync(p).isFile()) return { p, type };
    } catch {
      /* next */
    }
  }
  return null;
}

// ------------------------------------------------------------------ HTTP
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    const html = readFileSafe(UI);
    if (!html) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("installer/ui.html is missing");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
    return;
  }

  // The same two pictures the dashboard shows in Settings. A person who has never loaded an
  // unpacked extension needs to see the switch and the button, not read about them.
  if (req.method === "GET" && (url === "/help-chrome-extensions.png" || url === "/help-chrome-details.png")) {
    const f = path.join(REPO, "public", url.slice(1));
    if (!fs.existsSync(f)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    fs.createReadStream(f).pipe(res);
    return;
  }

  if (req.method === "GET" && url === "/logo-128.png") {
    const found = findLogo();
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": found.type, "cache-control": "no-store" });
    fs.createReadStream(found.p).pipe(res);
    return;
  }

  if (req.method === "GET" && url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // The state as it stands right now, so a reload or a reconnect draws the correct screen rather
    // than an empty one waiting for the next change.
    syncSteps();
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res);
    log(`page connected (${clients.size} open)`);
    onClientArrived();
    req.on("close", () => {
      clients.delete(res);
      if (clients.size === 0) clientsLeftAt = Date.now();
    });
    return;
  }

  if (req.method === "POST" && url === "/cmd") {
    let cmd = null;
    try {
      cmd = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("bad command");
      return;
    }
    res.writeHead(204).end();
    // After the reply, so a step that runs for a minute does not hold the request open.
    onClientArrived();
    try {
      handleCommand(cmd);
    } catch (e) {
      log(`command failed: ${e.message}`);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

// The Mac app starts the survey once the page has finished loading (phase 'wait-ui' -> 'survey').
// The equivalent signal here is the page actually being there: the first SSE connection, or the
// first command if a browser somehow beats its own EventSource to it.
function onClientArrived() {
  if (phase !== "boot") return;
  phase = "survey";
  log("page is up, surveying what is installed");
  watchStarted();
  appendLog(FULLLOG, `${stamp()}  ui loaded\n`);
  if (!launchStep("check-all", null)) {
    phase = "ready";
    decideWhatToDo();
    push();
  }
}

// ------------------------------------------------------------------ opening the window
// An "app window": a browser with no tabs, no address bar and no browser chrome, which is as close
// to a native window as Windows gives us for free. Edge first because it is on every Windows 10 and
// 11; Chrome second; and if neither can be found, the ordinary browser, which is a normal-looking
// window with the right page in it rather than no window at all.
function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Mirrors findChromeExe() in scripts/browser/extension.mjs: the App Paths registry key first, then
// the standard install directories.
async function findExe(exe, vendorDirs) {
  const reg = await platform.run(
    "reg",
    ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"],
    { timeout: 10_000 }
  );
  if (reg.ok) {
    // "    (Default)    REG_SZ    C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    const m = /REG_SZ\s+(.+\S)\s*$/m.exec(reg.out);
    if (m && existsFile(m[1].trim())) return m[1].trim();
  }
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LocalAppData];
  for (const root of roots) {
    if (!root) continue;
    const p = path.join(root, ...vendorDirs, exe);
    if (existsFile(p)) return p;
  }
  return null;
}

async function openWindow(url) {
  if (!platform.IS_WIN) {
    // On a Mac this server exists only to be tested, so the ordinary browser is exactly right.
    platform.openUrl(url);
    return;
  }
  const edge = await findExe("msedge.exe", ["Microsoft", "Edge", "Application"]);
  const chrome = edge ? null : await findExe("chrome.exe", ["Google", "Chrome", "Application"]);
  const exe = edge || chrome;
  if (!exe) {
    log("neither Edge nor Chrome found; opening in the default browser");
    platform.openUrl(url);
    return;
  }
  log(`opening the window with ${exe}`);
  const win = spawn(exe, [`--app=${url}`, "--window-size=880,760"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  win.unref();
}

// ------------------------------------------------------------------ shutdown
let shuttingDown = false;
function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`exiting: ${why}`);
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* going anyway */
    }
  }
  clients.clear();
  try {
    server.close();
  } catch {
    /* going anyway */
  }
  // Never wait on a step: a spawned installer is the OS's problem now, and holding the event loop
  // open for it would leave a wizard the user has closed still running.
  setTimeout(() => process.exit(0), 150).unref();
}

// Nothing renders this state any more once the window is gone. Ten seconds after the flow has
// finished is the case that matters (the page navigated to the dashboard, or the user closed a
// finished wizard); the longer fallback catches a window closed part-way through, without ever
// pulling the rug out from under an install that is still going.
setInterval(() => {
  if (shuttingDown || !clientsLeftAt || clients.size > 0) return;
  const gone = Date.now() - clientsLeftAt;
  if (flowDone && gone > 10_000) shutdown("the window is gone and setup had finished");
  else if (!running && gone > 300_000) shutdown("the window has been gone for five minutes");
}, 2000).unref();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(sig));
}

// ------------------------------------------------------------------ main
const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const port = portArg !== -1 ? Number(argv[portArg + 1]) || 0 : 0;
const wantOpen = !argv.includes("--no-open");

fs.mkdirSync(WORK, { recursive: true });

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`setup window server on ${url}`);
  appendLog(FULLLOG, `${stamp()}  setup server listening on ${url}\n`);
  if (wantOpen) openWindow(url);
  else log("--no-open: waiting for a browser to connect");
});

server.on("error", (e) => {
  log(`could not listen: ${e.message}`);
  process.exit(1);
});
