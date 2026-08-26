#!/usr/bin/env node
// A CLICKABLE PROTOTYPE of the setup window and the welcome wizard. Nothing here is wired to
// anything: it reads no files, writes no files, spends no money, and knows nothing about your job
// search. Every value on screen is invented. It exists so the flow can be walked through and
// argued with before any of it is built for real.
//
//   npm run mock:wizard        -> http://localhost:4318
//
// Deliberately a separate file from server/dashboard.mjs. A prototype that shares code with the
// product is a prototype that can break the product, and one that reads data/ is one click away
// from writing it.
//
// Zero dependencies, one file, same as everything else here.

import http from "http";

const PORT = Number(process.env.PORT || 4318);

// ---------------------------------------------------------------------------------------------
// The visual language is the dashboard's own — the tokens below are copied from
// server/dashboard.mjs so the prototype looks like the product it is proposing a change to, in
// both themes. Copied rather than imported: see the note above about sharing code.
// ---------------------------------------------------------------------------------------------
const CSS = `
:root{--bg:#f6f7fb;--card:#fff;--line:#e3e6f0;--fg:#1a1c28;--mut:#5b6178;--acc:#2563eb;
  --ok-bg:rgba(46,160,67,.14);--ok-fg:#1f7a45;--warn-bg:rgba(214,138,0,.14);--warn-fg:#9a6400;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f1220;--card:#181c2f;--line:#2a2f48;--fg:#e7e9f3;--mut:#9aa0bd;--acc:#6ea8fe;
  --ok-bg:rgba(46,160,67,.16);--ok-fg:#3fb950;--warn-bg:rgba(214,138,0,.16);--warn-fg:#d68a00}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.mockbar{background:#111;color:#e7e9f3;font:600 11.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;
  padding:7px 14px;display:flex;gap:14px;align-items:center;justify-content:space-between}
.mockbar a{color:#8ea8ff;text-decoration:none;font-weight:500;text-transform:none;letter-spacing:0;font-size:12px}
.mockbar a:hover{text-decoration:underline}
.shell{max-width:820px;margin:0 auto;padding:26px 22px 60px}
.hd{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:14px;
  border-bottom:1px solid var(--line);margin-bottom:18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;letter-spacing:-.01em}
.mark{width:26px;height:26px;border-radius:7px;background:linear-gradient(140deg,var(--acc),#8b5cf6);flex:0 0 auto}
h1{font-size:21px;font-weight:700;letter-spacing:-.015em;margin:0 0 4px;text-wrap:balance}
h2{font-size:15px;margin:0 0 10px}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 16px;max-width:62ch}
.muted{color:var(--mut)}.tiny{font-size:11.5px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 17px}
.stack{display:flex;flex-direction:column;gap:13px}
.row{display:flex;align-items:flex-start;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row.pick{cursor:pointer;border-radius:9px;padding:11px 10px;margin:0 -10px}
.row.pick:hover{background:var(--bg)}
.grow{flex:1;min-width:0}
.lbl{display:block;font-size:12px;color:var(--mut);margin-bottom:5px}
.field{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;
  color:var(--fg);font:inherit;font-size:13.5px}
.field:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:transparent}
select.field{appearance:none;cursor:pointer;padding-right:30px;
  background-image:linear-gradient(45deg,transparent 50%,var(--mut) 50%),linear-gradient(135deg,var(--mut) 50%,transparent 50%);
  background-position:calc(100% - 15px) 16px,calc(100% - 10px) 16px;background-size:5px 5px;background-repeat:no-repeat}
select.field:has(option[value=""]:checked){color:var(--mut)}
textarea.field{min-height:76px;line-height:1.55;resize:vertical}
.two{display:flex;gap:13px;flex-wrap:wrap}.two>*{flex:1;min-width:190px}
button{font:inherit}
.btn{display:inline-flex;align-items:center;gap:7px;background:var(--acc);color:#fff;border:0;border-radius:8px;
  padding:9px 15px;font-size:13.5px;font-weight:600;cursor:pointer}
.btn:hover{filter:brightness(1.08)}
.btn.sec{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
.btn.sec:hover{background:var(--line);filter:none}
.btn.ghost{background:transparent;color:var(--mut);border:1px solid var(--line);font-size:12.5px;padding:7px 12px;font-weight:500}
.btn.ghost:hover{color:var(--fg);background:var(--line)}
.btn[disabled]{opacity:.4;cursor:not-allowed;filter:none}
.btn:focus-visible,a:focus-visible,.field:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:17px}
.spacer{flex:1}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;white-space:nowrap}
.ok{background:var(--ok-bg);color:var(--ok-fg)}.warn{background:var(--warn-bg);color:var(--warn-fg)}
.neutral{background:var(--line);color:var(--mut)}
.alert{border-radius:10px;padding:12px 14px;font-size:13px;border:1px solid;margin-bottom:15px}
.alert.g{border-color:color-mix(in oklab,var(--ok-fg) 40%,transparent);background:var(--ok-bg)}
.alert.w{border-color:color-mix(in oklab,var(--warn-fg) 45%,transparent);background:var(--warn-bg)}
.alert.i{border-color:var(--line);background:var(--card)}
ol.steps2{margin:7px 0 0;padding-left:20px;font-size:13px;color:var(--mut)}ol.steps2 li{margin-bottom:4px}
/* stepper */
.steps{display:flex;align-items:center;flex-wrap:wrap;margin-bottom:20px}
.steps .s{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--mut);white-space:nowrap}
.steps .s .n{width:20px;height:20px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;
  font:700 10.5px/1 var(--mono)}
.steps .s.on{color:var(--fg);font-weight:600}
.steps .s.on .n{background:var(--acc);border-color:var(--acc);color:#fff}
.steps .s.past .n{background:var(--line);color:var(--fg)}
.steps .s.skip .n{border-style:dashed}
.steps .bar{width:18px;height:1px;background:var(--line);margin:0 7px;flex:0 0 auto}
@media (max-width:660px){.steps .s .t{display:none}.steps .bar{width:9px;margin:0 4px}}
/* chips */
.chipbox{display:flex;flex-wrap:wrap;gap:6px;padding:7px 8px;border:1px solid var(--line);border-radius:8px;
  background:var(--bg);min-height:40px;align-items:center}
.chipbox:focus-within{border-color:var(--acc)}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--card);border:1px solid var(--line);
  border-radius:99px;padding:3px 10px;font-size:12.5px;cursor:pointer}
.chip.sug{border-style:dashed;color:var(--mut);background:transparent}
.chip i{font-style:normal;color:var(--mut);font-size:13px;line-height:1}
.chip:hover{border-color:var(--acc)}
.chipin{border:0;background:transparent;color:var(--fg);font:inherit;font-size:12.5px;padding:3px 4px;min-width:130px;flex:1}
.chipin:focus{outline:0}
/* Today */
.tabrow{display:flex;gap:7px;flex-wrap:wrap;margin:-4px 0 18px}
.tab{font-size:12.5px;color:var(--mut);border:1px solid var(--line);border-radius:8px;padding:6px 11px}
.tab.on{color:var(--fg);border-color:var(--acc);font-weight:600}
.tab b{font-weight:600;opacity:.7}
.card.ask{border-color:var(--acc)}
.tblock .th{font-size:12.5px;font-weight:700;margin:0 0 9px}
.runbtns{display:flex;gap:8px;flex-wrap:wrap}
/* CV extraction */
.cvf{margin-top:11px;display:flex;flex-direction:column;gap:7px}
.cvrow{display:flex;gap:12px;align-items:baseline;font-size:13px}
.cvrow .k{width:88px;flex:0 0 auto;color:var(--mut);font-size:12px}
.cvrow .v{flex:1;min-width:0}
.cvrow.pend .v{opacity:.6}
.skel{display:block;height:9px;border-radius:99px;background:var(--line);width:min(320px,72%);
  animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:.9}}
@media (prefers-reduced-motion:reduce){.skel{animation:none}}
/* schedule picker */
.sched{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.days{display:flex;flex-wrap:wrap;gap:6px}
.day{border:1px solid var(--line);background:var(--bg);color:var(--mut);border-radius:8px;
  padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;min-width:48px}
.day:hover{border-color:var(--acc);color:var(--fg)}
.day.on{background:var(--acc);border-color:var(--acc);color:#fff}
.day:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.warnline{color:var(--warn-fg)}
/* drop zone */
.drop{border:1.6px dashed var(--line);border-radius:12px;padding:32px 18px;text-align:center;background:var(--card);cursor:pointer}
.drop:hover{border-color:var(--acc)}
.drop .big{font-size:15px;font-weight:600;margin-bottom:5px}
/* checklist */
.chk{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}
.chk:last-child{border-bottom:0}
.chk .ic{width:21px;height:21px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;
  font-size:11px;font-weight:700;margin-top:1px}
.chk .ic.y{background:var(--ok-bg);color:var(--ok-fg)}
.chk .ic.n{background:var(--warn-bg);color:var(--warn-fg)}
.chk .ic.w{background:var(--line);color:var(--mut)}
.chk .t{flex:1;min-width:0;font-size:13.5px}
.chk .t em{font-style:normal;color:var(--mut);font-size:12.5px;display:block;margin-top:3px}
.prog{height:5px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:9px}
.prog i{display:block;height:100%;background:var(--acc);border-radius:99px;transition:width .35s ease}
/* modal */
.veil{position:fixed;inset:0;background:rgba(8,10,20,.55);display:grid;place-items:center;padding:20px;z-index:50}
.veil[hidden]{display:none}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;max-width:480px;
  box-shadow:0 24px 60px -20px rgba(0,0,0,.5)}
.modal h2{margin-bottom:8px;font-size:17px}
.modal p{color:var(--mut);font-size:13.5px;margin:0 0 12px}
.modal ul.impact{margin:0 0 14px;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.modal ul.impact li{position:relative;padding-left:20px;font-size:13.5px;color:var(--fg)}
.modal ul.impact li::before{content:"";position:absolute;left:4px;top:8px;width:5px;height:5px;
  border-radius:50%;background:var(--warn-fg)}
code{font:500 .88em/1 var(--mono);background:var(--line);padding:2px 6px;border-radius:4px;color:var(--fg)}
.index{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:20px}
.index a{display:block;text-decoration:none;color:inherit;background:var(--card);border:1px solid var(--line);
  border-radius:12px;padding:17px 18px}
.index a:hover{border-color:var(--acc)}
.index b{display:block;font-size:15px;margin-bottom:5px}
.index span{color:var(--mut);font-size:13px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const page = (title, body, script = "", bar = true) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style></head><body>
${bar ? `<div class="mockbar"><span>Mock — nothing is saved, nothing is sent</span>
  <span><a href="/">all screens</a> · <a href="/setup">setup</a> · <a href="/welcome">wizard</a> · <a href="/today">today</a> · <a href="/settings">settings</a></span></div>` : ""}
${body}
<script>${script}</script></body></html>`;

// =============================================================================================
// INDEX
// =============================================================================================
const INDEX = page(
  "JobSeeker prototype",
  `<div class="shell">
    <div class="hd"><span class="brand"><span class="mark"></span>JobSeeker — clickable prototype</span></div>
    <h1>Three screens to walk through</h1>
    <p class="sub">Nothing here touches your data. Buttons move you through the flow, chips add and
      remove, progress bars run on a timer — all of it invented, so you can judge the shape before
      it is built.</p>
    <div class="index">
      <a href="/setup"><b>The setup window</b><span>What opens when you double-click
        <code>JobSeeker Setup.command</code>. Downloads and installs what is missing, then checks it.</span></a>
      <a href="/welcome"><b>The welcome wizard</b><span>Seven steps. CV, markets and the answer
        library are all skippable; cancelling anywhere tells you how to pick it up later.</span></a>
      <a href="/today"><b>Today</b><span>Where the wizard lets you out — and where it asks, once,
        whether to research the markets you picked.</span></a>
      <a href="/settings"><b>Settings</b><span>Where the skipped steps live afterwards — the CV
        wizard and the markets wizard, each on its own.</span></a>
    </div>
  </div>`
);

// =============================================================================================
// SETUP WINDOW
// =============================================================================================
const SETUP_BODY = `<div class="shell" id="root"></div>
<div class="veil" id="veil" hidden><div class="modal" role="dialog" aria-modal="true">
  <h2 id="mh"></h2><div id="mb"></div>
  <div class="acts"><button class="btn" id="mok">OK</button></div></div></div>`;

const SETUP_JS = `
// The setup window is a sequence of four states. In the real thing each row is a probe or an
// installer; here they are timers, so the shape can be judged without installing anything.
var el = function(id){ return document.getElementById(id); };
var state = 0;
var pct = 0, timer = null;

function modal(title, html){
  el('mh').textContent = title; el('mb').innerHTML = html; el('veil').hidden = false;
}
el('mok').onclick = function(){ el('veil').hidden = true; };

function head(sub, pill){
  return '<div class="hd"><span class="brand"><span class="mark"></span>' + sub + '</span>' +
    (pill || '') + '</div>';
}

var VIEWS = [
// ---- 0. checking + installing -----------------------------------------------------------------
function(){ return head('Setting up JobSeeker', '<span class="pill neutral">working</span>') +
  '<h1>Getting your Mac ready</h1>' +
  '<p class="sub">JobSeeker needs four things. It downloads and installs whatever is missing, then ' +
  'checks that each one actually works rather than assuming it did.</p>' +
  '<div class="card">' +
    row('y','Node 20 or newer','Downloaded and installed v22.14 — 41 MB.') +
    row('y','Google Chrome','Already here. JobSeeker reads WhatsApp Web and LinkedIn in the Chrome you use, logged in as you.') +
    row('w','Claude Code','Installing — this is the engine that reads and writes for you.', pct) +
    row('.','Browser agent','Waiting for Claude Code.') +
  '</div>' +
  '<div class="acts"><span class="tiny">No account and no sign-in for JobSeeker itself — it uses the Claude Code you already have.</span>' +
  '<span class="spacer"></span><button class="btn" disabled>Open JobSeeker</button></div>'; },
// ---- 1. blocked on the user --------------------------------------------------------------------
function(){ return head('Two things only you can click', '<span class="pill warn">3 of 5 done</span>') +
  '<h1>macOS will not let an installer grant these</h1>' +
  '<p class="sub">That is exactly why they exist. Here they are in order — and JobSeeker re-checks ' +
  'rather than taking your word for it.</p>' +
  '<div class="card">' +
    '<div class="chk"><span class="ic n">1</span><span class="t">Let Chrome be read' +
      '<ol class="steps2"><li>Open Chrome</li><li>Menu bar ▸ View ▸ Developer</li>' +
      '<li>Click <b>Allow JavaScript from Apple Events</b></li></ol>' +
      '<em>Automating this would need Accessibility permission — control of your whole screen. JobSeeker never asks for that.</em></span></div>' +
    '<div class="chk"><span class="ic n">2</span><span class="t">Tick Chrome under Automation' +
      '<ol class="steps2"><li>Open System Settings</li><li>Privacy &amp; Security ▸ Automation</li>' +
      '<li>Tick <b>Google Chrome</b> under Claude</li></ol></span></div>' +
  '</div>' +
  '<div class="acts"><button class="btn sec" data-go="2">Re-check</button>' +
    '<span class="tiny">Last checked 14:02 — still blocked</span><span class="spacer"></span>' +
    '<button class="btn ghost" data-go="3">Continue without them</button></div>'; },
// ---- 2. re-check passed --------------------------------------------------------------------
function(){ return head('Ready', '<span class="pill ok">everything checks out</span>') +
  '<div class="alert g"><strong>Your Mac is set up.</strong> Chrome can be read, the browser agent ' +
  'is installed, and Claude Code is on the path.</div>' +
  '<h1>Next: tell JobSeeker what you are looking for</h1>' +
  '<p class="sub">About four minutes, and you can skip any part of it. JobSeeker opens in its own ' +
  'window — no address bar, no tabs, no bookmarks. It behaves like an app because it is one.</p>' +
  '<div class="acts"><a class="btn" href="/welcome">Open JobSeeker</a>' +
    '<button class="btn ghost" data-modal="installed">What did it install?</button></div>'; },
// ---- 3. continued while blocked ----------------------------------------------------------------
function(){ return head('Ready, with one thing missing', '<span class="pill warn">WhatsApp and LinkedIn cannot be read</span>') +
  '<div class="alert w"><strong>Everything works except reading your chats.</strong> Email, calendar, ' +
  'role hunting and the daily digest are all fine. WhatsApp Web and LinkedIn stay dark until those ' +
  'two clicks are done — Settings will keep offering them.</div>' +
  '<div class="acts"><a class="btn" href="/welcome">Open JobSeeker</a>' +
    '<button class="btn ghost" data-go="1">Go back and fix it</button></div>'; }
];

function row(kind, title, sub, progress){
  var ic = kind === 'y' ? '<span class="ic y">✓</span>' : kind === 'w' ? '<span class="ic w">…</span>' :
           kind === 'n' ? '<span class="ic n">!</span>' : '<span class="ic w">·</span>';
  var p = (typeof progress === 'number') ? '<div class="prog"><i style="width:' + progress + '%"></i></div>' : '';
  return '<div class="chk">' + ic + '<span class="t' + (kind === '.' ? ' muted' : '') + '">' + title +
    '<em>' + sub + '</em>' + p + '</span></div>';
}

function render(){
  el('root').innerHTML = VIEWS[state]();
  el('root').querySelectorAll('[data-go]').forEach(function(b){
    b.onclick = function(){ state = Number(b.dataset.go); pct = 0; render(); };
  });
  el('root').querySelectorAll('[data-modal]').forEach(function(b){
    b.onclick = function(){
      modal('Installed on this Mac', '<p>Node 22.14 · Claude Code 2.0.31 · the JobSeeker browser agent. ' +
        'Chrome was already here and was left alone.</p><p>All of it under your home folder. ' +
        'Nothing was installed system-wide and nothing asked for your password.</p>');
    };
  });
  if (state === 0){
    clearInterval(timer);
    timer = setInterval(function(){
      pct += 9;
      if (pct >= 100){ clearInterval(timer); state = 1; pct = 0; render(); return; }
      var bar = el('root').querySelector('.prog i');
      if (bar) bar.style.width = pct + '%';
    }, 320);
  } else { clearInterval(timer); }
}
render();
`;

// =============================================================================================
// THE WIZARD
// =============================================================================================
const WELCOME_BODY = `<div class="shell" id="root"></div>
<div class="veil" id="veil" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
  <h2 id="mh"></h2><div id="mb"></div>
  <div class="acts" id="macts"></div></div></div>`;

const WELCOME_JS = String.raw`
var el = function(id){ return document.getElementById(id); };

// Eight steps. Three of them can be skipped outright — the wizard's job is to get you to a working
// Today, not to collect a complete record before it will let you in.
var STEPS = [
  { key:'start',    label:'Start' },
  { key:'cv',       label:'CV',        skippable:true },
  { key:'targets',  label:'Targets' },
  { key:'markets',  label:'Markets',   skippable:true },
  { key:'answers',  label:'Answers',   skippable:true },
  { key:'channels', label:'Channels' },
  { key:'schedule', label:'Schedule' }
];

var S = {
  i: 0,
  skipped: {},
  cv: null,          // null until a file is dropped
  // Reading a CV is two jobs with very different costs, and the screen says so rather than hiding
  // both behind one spinner:
  //   'reading' — pulling the text out of the PDF. Local, instant, free.
  //   'parsing' — working out what it MEANS (role, seniority, years, skills). A Claude call:
  //               twenty to forty seconds, and a few cents.
  // Only the second one is slow, and it is the only one that ever needs to block anything —
  // which is why it does not. You can walk on while it finishes.
  cvPhase: null,     // null | 'reading' | 'parsing' | 'done' | 'failed'
  cvFound: [],       // fields land one at a time, so progress is visible rather than asserted
  markets:  ['Cybersecurity'],
  marketSug:['Fintech','Cloud infrastructure','Defence tech'],
  roles:    ['Solution Architect','Pre-sales Manager'],
  roleSug:  ['Product Management','Technical Account Manager'],
  places:   ['Dubai / UAE','Remote'],
  placeSug: ['Abu Dhabi','Riyadh'],
  senior:   ['Senior','Principal'],
  seniorSug:['Director'],
  ignored:  ['Family','Football'],
  // The answer library. Everything here is a short, closed answer that the same handful of forms
  // ask over and over — so everything here is a list to pick from, except the two that are yours
  // alone: what you want to be paid, and how you describe yourself.
  ans: { visa:'', notice:'', relocate:'', heard:'LinkedIn', salary:'', pitch:'' },
  other: {},
  schedule: 'manual',
  days: [1,2,3,4,5],       // Mon–Fri, 0 = Sunday. launchd takes a weekday per calendar entry.
  time: '08:00',
  channels: { gmail:true, whatsapp:true, linkedin:'blocked', digest:false }
};

/* ---------- small builders ---------- */
function chips(listKey, sugKey, placeholder){
  var out = S[listKey].map(function(c,ix){
    return '<span class="chip" data-drop="'+listKey+'" data-ix="'+ix+'" title="Remove"><b>'+esc(c)+'</b> <i>×</i></span>';
  }).join('');
  if (sugKey) out += (S[sugKey]||[]).map(function(c,ix){
    return '<span class="chip sug" data-add="'+listKey+'" data-from="'+sugKey+'" data-ix="'+ix+'" title="Add"><b>'+esc(c)+'</b> <i>+</i></span>';
  }).join('');
  out += '<input class="chipin" data-new="'+listKey+'" placeholder="'+esc(placeholder||'type to add…')+'" aria-label="'+esc(placeholder||'add')+'">';
  return '<div class="chipbox">'+out+'</div>';
}
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

function stepper(){
  return '<div class="steps">' + STEPS.map(function(s,ix){
    var cls = ix === S.i ? 'on' : ix < S.i ? (S.skipped[s.key] ? 'past skip' : 'past') : '';
    var n = ix < S.i ? (S.skipped[s.key] ? '–' : '✓') : String(ix+1);
    return '<span class="s '+cls+'"><span class="n">'+n+'</span><span class="t">'+s.label+'</span></span>';
  }).join('<span class="bar"></span>') + '</div>';
}

// Every step ends the same way: continue, go back, skip if it may be skipped, and leave. "Leave"
// is always available and never punished — it is the difference between a wizard and a gate.
function foot(nextLabel, opts){
  opts = opts || {};
  var s = STEPS[S.i];
  return '<div class="acts">' +
    '<button class="btn" data-next="1"'+(opts.disableNext ? ' disabled title="'+esc(opts.disableWhy || '')+'"' : '')+'>'+esc(nextLabel || 'Continue')+'</button>' +
    (S.i > 0 ? '<button class="btn ghost" data-back="1">Back</button>' : '') +
    (s.skippable ? '<button class="btn ghost" data-skip="1">'+esc(opts.skipLabel || 'Skip for now')+'</button>' : '') +
    '<span class="spacer"></span>' +
    '<button class="btn ghost" data-cancel="1">Leave setup</button></div>' +
    (s.skippable ? '<p class="tiny" style="margin-top:9px">'+esc(opts.skipNote || '')+'</p>' : '');
}

/* ---------- the steps ---------- */
var VIEW = {
start: function(){ return '<h1>JobSeeker remembers your job search.</h1>' +
  '<p class="sub">It reads the channels you already use, keeps one honest picture of where everything ' +
  'stands, and each morning tells you the few things that need you. Three things it will never do:</p>' +
  '<div class="card">' +
    '<div class="row"><span class="pill ok">never</span><span class="grow">Acts for you. It finds, tracks and reminds — applying is yours, and always will be your decision to make.</span></div>' +
    '<div class="row"><span class="pill ok">never</span><span class="grow">Sends a message — email, LinkedIn or WhatsApp — without you approving that exact message.</span></div>' +
    '<div class="row"><span class="pill ok">never</span><span class="grow">Opens an unread chat, or logs a conversation that has nothing to do with your job search.</span></div>' +
  '</div>' +
  '<p class="sub" style="margin-top:14px">Everything it learns is kept in plain text files on this Mac — ' +
  'no JobSeeker account, no JobSeeker server, delete the folder and it is gone. The reading and the ' +
  'judgement are done by Claude, so what it reads — your CV, your job-related mail and messages — goes ' +
  'to Claude, and nowhere else.</p>' +
  '<div class="acts"><button class="btn" data-next="1">Start — about 4 minutes</button>' +
  '<button class="btn ghost" data-advanced="1">I would rather use the terminal</button>' +
  '<span class="spacer"></span><button class="btn ghost" data-cancel="1">Leave setup</button></div>'; },

cv: function(){
  if (!S.cv) return '<h1>Your CV</h1>' +
    '<p class="sub">Everything else here can be filled in from it — so this is the one step worth doing now. ' +
    'The file is saved on this Mac; Claude reads it to work out what it says.</p>' +
    '<div class="drop" data-upload="1"><div class="big">Drop your CV here</div>' +
    '<div class="tiny">PDF · or click to choose a file</div></div>' +
    foot('Continue', { disableNext: true, disableWhy: 'Drop a CV in first, or skip this step',
      skipLabel:'Skip — I will add it later',
      skipNote:'Without a CV, roles cannot be scored against your experience and the answers below stay empty. ' +
               'You can add it any time: Settings ▸ Your CV walks through this same step on its own.' });

  if (S.cvPhase === 'failed') return '<h1>That file could not be read</h1>' +
    '<div class="alert w"><strong>The PDF has no text in it</strong> — it looks like a scan, so there is ' +
    'nothing to extract. A CV exported from Word, Pages or Google Docs will work.</div>' +
    '<div class="acts"><button class="btn" data-reupload="1">Try another file</button>' +
    '<button class="btn ghost" data-skip="1">Carry on without it</button></div>';

  var done = S.cvPhase === 'done';
  return '<h1>' + (done ? 'Is this right?' : 'Reading your CV') + '</h1>' +
    '<p class="sub">' + (done
      ? 'This drives how every role is scored from now on, so it is worth ten seconds.'
      : 'Saving it is instant. Understanding it is a Claude call — that is the part worth waiting on.') + '</p>' +
    '<div class="card" id="cvzone">' + cvRows() + '</div>' +
    (done
      ? '<p class="tiny" style="margin-top:9px">Wrong? <a href="#" data-reupload="1">Use a different file</a> — ' +
        'or fix any line of it in Settings later.</p>' +
        '<div class="acts"><button class="btn" data-next="1">That is right</button>' +
        '<button class="btn ghost" data-back="1">Back</button><span class="spacer"></span>' +
        '<button class="btn ghost" data-cancel="1">Leave setup</button></div>'
      : '<div class="acts"><button class="btn sec" data-next="1">Continue — finish this in the background</button>' +
        '<span class="spacer"></span><button class="btn ghost" data-cancel="1">Leave setup</button></div>' +
        '<p class="tiny" style="margin-top:9px">Nothing here needs you. Walk on and it will be waiting, ' +
        'already filled in, by the time you reach the questions that use it.</p>');
},

targets: function(){ return '<h1>What are you looking for?</h1>' +
  '<p class="sub">' + (S.cvPhase === 'done' ? 'Filled in from your CV. ' : S.cvPhase === 'parsing' ? 'Your CV is still being read — these fill in when it lands. ' : 'Nothing to pre-fill without a CV, so this one is on you. ') +
  'Solid chips are yours; dotted ones are suggestions — click to keep or drop either.</p>' +
  '<div class="card stack">' +
    '<div><span class="lbl">Roles</span>' + chips('roles','roleSug','add a role…') + '</div>' +
    '<div><span class="lbl">Locations</span>' + chips('places','placeSug','add a location…') + '</div>' +
    '<div><span class="lbl">Seniority</span>' + chips('senior','seniorSug','add a level…') + '</div>' +
  '</div>' +
  '<p class="tiny" style="margin-top:9px">How roles get scored — market 0.40, role 0.35, CV match 0.25. ' +
  'Sensible defaults; change them in Settings once you have seen a few.</p>' +
  foot(); },

markets: function(){ return '<h1>Which markets should it hunt in?</h1>' +
  '<p class="sub">A market is an industry to research. JobSeeker builds a ranked list of the companies ' +
  'in it that are worth your time, then watches their careers pages.</p>' +
  '<div class="card stack">' +
    '<div><span class="lbl">Markets</span>' + chips('markets','marketSug','add a market…') + '</div>' +
  '</div>' +
  '<p class="tiny" style="margin-top:10px">Adding a market costs nothing. Researching it — ranking the ' +
  'companies in it — is a few minutes of work, so JobSeeker asks you about that once you are inside, ' +
  'rather than holding up setup for it.</p>' +
  foot('Continue', { skipLabel:'Skip markets entirely',
    skipNote:'Skipping means no company list yet, so role hunting has nowhere to look — Today will be ' +
             'empty until you add one. Settings ▸ Markets runs this same step whenever you are ready.' }); },

answers: function(){
  var A = S.ans;
  // JobSeeker does not fill forms or apply for anyone. What this step buys is that the answers are
  // written down once, in one place, instead of being re-derived at 1am in front of a form — and
  // that JobSeeker can hand them to you when you are working on an application.
  return '<h1>The questions every application form asks</h1>' +
  '<p class="sub">Write them down once, and stop looking them up. They are kept with everything else ' +
  'on this Mac, and JobSeeker brings them out when you are working on an application.</p>' +
  '<div class="card stack">' +
    '<div class="two">' +
      '<div>' + pick('visa', 'Work authorisation', VISA) + '</div>' +
      '<div>' + pick('notice', 'Notice period', NOTICE) + '</div>' +
    '</div>' +
    '<div class="two">' +
      '<div>' + pick('relocate', 'Willing to relocate', RELOCATE) + '</div>' +
      '<div>' + pick('heard', 'How did you hear about us', HEARD) + '</div>' +
    '</div>' +
    // Salary is the one answer nobody else can shape for you, and a list of bands would either
    // anchor you low or make you pick a number you have not decided on. It stays a blank line.
    '<div><span class="lbl">Salary expectation</span>' +
      '<input class="field" data-ans="salary" value="' + esc(A.salary) + '" ' +
      'placeholder="open — happy to discuss">' +
      '<p class="tiny" style="margin-top:5px">In your own words. Leaving it open is a perfectly good answer, ' +
      'and the one most people give.</p></div>' +
    '<div><span class="lbl">Two lines about you — for when a form wants a summary</span>' +
      '<textarea class="field" data-ans="pitch">' + esc(A.pitch || (S.cvPhase === 'done' ?
        'Solution architect with 14 years in cybersecurity pre-sales, most recently leading technical wins across the GCC. I work best where a hard technical story has to land with a business audience.' : '')) + '</textarea>' +
      (S.cvPhase === 'done'
        ? '<p class="tiny" style="margin-top:6px">Drafted from your CV. Rewrite it in your own words — it goes out under your name.</p>'
        : S.cvPhase === 'parsing'
          ? '<p class="tiny" style="margin-top:6px">A draft will appear here the moment your CV is read.</p>'
          : '<p class="tiny" style="margin-top:6px">No CV, so nothing to draft from — this one is on you.</p>') +
    '</div>' +
  '</div>' +
  foot('Continue', { skipLabel:'Skip for now',
    skipNote:'Nothing else depends on these — skipping costs you nothing but the looking-up. ' +
             'Settings keeps the same list whenever you want to fill it in.' });
},

channels: function(){ return '<h1>What may it read?</h1>' +
  '<p class="sub">Each of these is off until you turn it on, and each can be turned off again in Settings.</p>' +
  '<div class="card">' +
    '<div class="row pick" data-ch="gmail"><span class="pill ' + (S.channels.gmail ? 'ok">on' : 'neutral">off') + '</span>' +
      '<span class="grow"><b>Gmail &amp; Calendar</b><div class="tiny">Recruiter mail, ATS updates, ' +
      'interview invitations. Read-only, through Claude Code\'s own connector.</div></span></div>' +
    '<div class="row pick" data-ch="whatsapp"><span class="pill ' + (S.channels.whatsapp ? 'ok">on' : 'neutral">off') + '</span>' +
      '<span class="grow"><b>WhatsApp Web</b><div class="tiny">Only threads with a job-search signal are ' +
      'recorded. Unread chats are never opened — opening one marks it read and destroys your own sense ' +
      'of what still needs you.</div>' +
      (S.channels.whatsapp ? '<div style="margin-top:9px"><span class="lbl">Never log these chats</span>' + chips('ignored', null, 'chat name…') + '</div>' : '') +
      '</span></div>' +
    '<div class="row"><span class="pill warn">blocked</span><span class="grow"><b>LinkedIn</b>' +
      '<div class="tiny">Chrome cannot be read yet — two setup steps are outstanding. Everything else ' +
      'works; this stays dark until they are done. <a href="/setup">Show me the steps</a></div></span></div>' +
    '<div class="row pick" data-ch="digest"><span class="pill ' + (S.channels.digest ? 'ok">on' : 'neutral">off') + '</span>' +
      '<span class="grow"><b>Send the morning digest to my phone</b><div class="tiny">Needs the WhatsApp ' +
      'plugin. Without it, the digest waits for you on Today.</div></span></div>' +
  '</div>' + foot(); },

schedule: function(){
  var daily = S.schedule === 'daily';
  var noDays = daily && S.days.length === 0;
  return '<h1>When should it run?</h1>' +
  '<p class="sub">A run is a Claude session, so it costs real money — usually a few dollars a day.</p>' +
  '<div class="card stack">' +
    '<div class="row pick" data-sched="manual"><span class="pill ' + (!daily ? 'ok">chosen' : 'neutral">or') + '</span>' +
      '<span class="grow"><b>Only when I ask</b><div class="tiny">Nothing runs on its own; you press ' +
      '<b>Run now</b> on Today. Start here, and add a schedule once it has earned some trust.</div></span></div>' +
    '<div class="row pick" data-sched="daily" style="border-bottom:0"><span class="pill ' + (daily ? 'ok">chosen' : 'neutral">or') + '</span>' +
      '<span class="grow"><b>On a schedule</b><div class="tiny">Reads your channels while you are ' +
      'elsewhere, with the summary waiting when you get back. Needs one more macOS permission, which ' +
      'JobSeeker will ask for.</div>' +
      (daily ? schedPicker() : '') +
      '</span></div>' +
  '</div>' +
  '<p class="tiny" style="margin-top:11px">Sensible spending limits are already in place, and every run ' +
  'is checked against them before it starts. You can see what runs have actually cost, and change the ' +
  'limits, in <b>Settings ▸ Advanced</b> — once you have a few real runs to judge by.</p>' +
  foot('Finish — take me to Today', { disableNext: noDays, disableWhy: 'Pick at least one day first' });
},

};




/* The schedule picker. Days are chips you toggle, because a schedule is a shape you recognise at a
   glance — five lit weekdays reads faster than any dropdown of the same information. The two
   presets exist because "weekdays" and "every day" are what almost everyone actually wants, and
   clicking five chips to say so is a small tax on the common case.

   The sentence underneath is the point of the whole control: it says back what will happen, in the
   words you would use, so nobody has to decode their own chip pattern. */
var DAYS = [['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6],['Sun',0]];

function schedPicker(){
  var chips = DAYS.map(function(d){
    var on = S.days.indexOf(d[1]) !== -1;
    return '<button type="button" class="day' + (on ? ' on' : '') + '" data-day="' + d[1] + '" ' +
      'aria-pressed="' + on + '">' + d[0] + '</button>';
  }).join('');
  var preset = function(key, label){
    return '<button type="button" class="btn ghost" data-preset="' + key + '">' + label + '</button>';
  };
  return '<div class="sched" onclick="event.stopPropagation()">' +
    '<div class="two" style="align-items:flex-end">' +
      '<div><span class="lbl">Which days</span><div class="days">' + chips + '</div></div>' +
      '<div style="max-width:160px"><span class="lbl">At what time</span>' +
        '<input class="field" type="time" data-time="1" value="' + S.time + '"></div>' +
    '</div>' +
    '<div class="acts" style="margin-top:10px;gap:7px">' + preset('week','Weekdays') +
      preset('all','Every day') + preset('end','Weekends') + '</div>' +
    (S.days.length
      ? '<p class="tiny" style="margin-top:10px">Runs <b>' + schedWords() + '</b>. ' +
        'The digest lands a few minutes later.</p>'
      : '<p class="tiny warnline" style="margin-top:10px">No days picked, so nothing would ever run. ' +
        'Choose at least one, or go back to <b>Only when I ask</b>.</p>') +
  '</div>';
}

// Says the schedule in the words a person would use. Anything that is not a recognisable pattern
// gets listed day by day, in week order, rather than forced into a phrase that does not fit.
function schedWords(){
  var d = S.days.slice().sort(function(a,b){ return a - b; }).join(',');
  var t = S.time;
  if (d === '0,1,2,3,4,5,6') return 'every day at ' + t;
  if (d === '1,2,3,4,5')     return 'every weekday at ' + t;
  if (d === '0,6')           return 'at weekends, ' + t;
  var names = DAYS.filter(function(x){ return S.days.indexOf(x[1]) !== -1; }).map(function(x){ return x[0]; });
  var last = names.pop();
  return (names.length ? names.join(', ') + ' and ' + last : last) + ' at ' + t;
}


/* What the CV screen shows while it works.
   The first row is done before the spinner has finished its first turn — text extraction is local
   and instant — and saying so is the difference between "something is happening" and "this thing
   is reading my CV". The rest arrive one at a time, so the wait is evidence rather than a bar. */
var CV_FIELDS = [
  ['Now',        'Senior Solution Architect, cybersecurity vendor · Dubai'],
  ['Experience', '14 years · pre-sales, solution architecture, product'],
  ['Seniority',  'Senior to principal — used to score every role it finds'],
  ['Strengths',  'Cybersecurity · Pre-sales · Solution architecture · Cloud security']
];

function cvRows(){
  var out = '<div class="chk"><span class="ic y">✓</span><span class="t">Saved to this Mac' +
    '<em>templates/cv/Christos-Ventouris-CV.pdf · 3 pages. The file itself stays here.</em></span></div>';
  var parsing = S.cvPhase === 'parsing';
  out += '<div class="chk"><span class="ic ' + (parsing ? 'w">…' : 'y">✓') + '</span><span class="t">' +
    (parsing ? 'Claude is reading it' : 'Read by Claude') +
    '<em>' + (parsing ? 'Half a minute and a few cents. This is the one step that leaves your Mac — ' +
                        'your CV is sent to Claude to be understood, the same way everything else here works.' :
                        'Read by Claude, stored on this Mac. You can change any of it later.') + '</em>' +
    '<div class="cvf">' + CV_FIELDS.map(function(f, ix){
      var have = S.cvFound.indexOf(ix) !== -1;
      return '<div class="cvrow' + (have ? '' : ' pend') + '"><span class="k">' + f[0] + '</span>' +
        '<span class="v">' + (have ? f[1] : '<span class="skel"></span>') + '</span></div>';
    }).join('') + '</div></span></div>';
  return out;
}

// The background ribbon. Whether you waited or walked on, the answer to "did it read my CV?" is on
// screen — a parse that finishes silently two steps later is indistinguishable from one that died.
function cvRibbon(){
  if (S.i === 1) return '';
  if (S.cvPhase === 'parsing') return '<div class="alert i"><b>Claude is still reading your CV.</b> ' +
    'The questions further on fill themselves in the moment it lands.</div>';
  if (S.cvPhase === 'done' && !S.cvSeen) return '<div class="alert g"><b>Your CV is read.</b> ' +
    'Roles will be scored against it, and the summary further on is drafted from it.</div>';
  if (S.cvPhase === 'failed') return '<div class="alert w"><b>Your CV could not be read</b> — it looks ' +
    'like a scan. Nothing is scored against your experience until you add a text PDF in Settings.</div>';
  return '';
}


/* The answer library, as lists.
   These are not free-text questions — a form asks them from a fixed set and the same five answers
   cover almost everyone. Typing them out invites typos an agent then has to interpret, and a blank
   box gives no clue what shape of answer is wanted. Every list ends in "Something else", which
   opens a plain field: closed lists that cannot be escaped are how software tells people their
   situation is invalid. */
var VISA = ['Citizen — no sponsorship needed','Permanent resident','Residence visa — transferable',
            'Residence visa — not transferable','Would need sponsorship','Student or graduate visa'];
var NOTICE = ['Available immediately','2 weeks','1 month','2 months','3 months','Longer — negotiable'];
var RELOCATE = ['Yes — anywhere','Yes — within the region','Yes, for the right role','No — remote or local only'];
var HEARD = ['LinkedIn','The company website','A referral','A job board','A recruiter'];

function pick(key, label, opts){
  var v = S.ans[key];
  var isOther = v === '__other';
  var sel = '<select class="field" data-pick="' + key + '">' +
    '<option value=""' + (v ? '' : ' selected') + '>Choose…</option>' +
    opts.map(function(o){
      return '<option' + (v === o ? ' selected' : '') + '>' + esc(o) + '</option>';
    }).join('') +
    '<option value="__other"' + (isOther ? ' selected' : '') + '>Something else…</option></select>';
  return '<span class="lbl">' + esc(label) + '</span>' + sel +
    (isOther ? '<input class="field" style="margin-top:7px" data-other="' + key + '" ' +
       'value="' + esc(S.other[key] || '') + '" placeholder="In your own words" autofocus>' : '');
}

/* ---------- modals ---------- */
function modal(title, html, acts){
  el('mh').textContent = title; el('mb').innerHTML = html;
  el('macts').innerHTML = acts;
  el('veil').hidden = false;
  el('macts').querySelectorAll('[data-close]').forEach(function(b){
    b.onclick = function(){ el('veil').hidden = true; };
  });
}


/* Skipping the CV is the one skip with consequences you cannot see from the step you are on: every
   effect lands later, on screens the person has not reached yet. So it is spelled out before the
   skip, in the app's own modal — not a browser confirm() dialog, which cannot carry a list, cannot
   be styled, and reads like the page is broken.

   The bullets are the real losses, in the first person, each one short enough to take in at a
   glance. The primary button is the one that keeps the CV: this is a confirmation, not a nudge —
   Skip anyway is right there and needs no second thought. */
function cvSkipConfirm(){
  modal('Skip your CV?',
    '<p>Without it, here is what I will not be able to do:</p>' +
    '<ul class="impact">' +
      '<li>Judge how well a posting matches your experience. Roles are still found and ranked, ' +
        'but on the job title alone, so the ranking is blunter.</li>' +
      '<li>Tell you why a role fits, or where the gap is — the part worth reading before you spend an evening on it.</li>' +
      '<li>Draft the "two lines about you" that most forms ask for.</li>' +
      '<li>Keep your CV to hand, so it is one click away when you sit down to apply.</li>' +
      '<li>Weigh a company against your background when ranking a market — it will have only your criteria to go on.</li>' +
    '</ul>' +
    '<p>It takes half a minute, and you can add it later from <b>Settings ▸ Your CV</b>.</p>',
    '<button class="btn" data-close="1">Add my CV</button>' +
    '<button class="btn ghost" data-doskip="1">Skip anyway</button>');
  el('macts').querySelectorAll('[data-doskip]').forEach(function(b){
    b.onclick = function(){ el('veil').hidden = true; S.skipped.cv = true; move(1); };
  });
}

function cancelModal(){
  modal('Leave setup?',
    '<p>Nothing is lost — what you have answered so far is already saved.</p>' +
    '<p>You can finish this any time from <b>Settings</b>, which runs the same steps one at a time. ' +
    'Or, if you prefer the terminal: open Claude Code in the JobSeeker folder and run ' +
    '<code>/onboard</code> — it asks the same questions in chat.</p>',
    '<button class="btn sec" data-close="1">Stay here</button>' +
    '<a class="btn" href="/today">Leave setup</a>');
}

function advancedModal(){
  modal('Set up in the terminal instead',
    '<p>Open Claude Code in the JobSeeker folder and run <code>/onboard</code>. It asks the same ' +
    'questions in chat and writes the same files, so you can switch between the two freely.</p>' +
    '<p class="tiny">The wizard is the supported path and will stay the default. <code>/onboard</code> ' +
    'remains for people who would rather type.</p>',
    '<button class="btn sec" data-close="1">Back to the wizard</button>' +
    '<a class="btn" href="/today">I will use /onboard</a>');
}

/* ---------- render + events ---------- */
var runTimer = null;
var cvTimer = null;

// Deliberately NOT cleared by render(): the parse keeps running when you walk on to the next step,
// which is the whole point of being able to walk on.
function startCV(){
  S.cv = true; S.cvPhase = 'reading'; S.cvFound = []; S.cvSeen = false;
  render();
  clearInterval(cvTimer);
  var t = 0;
  cvTimer = setInterval(function(){
    t += 1;
    if (t === 2){ S.cvPhase = 'parsing'; }
    else if (t > 2 && t <= 6){ S.cvFound.push(t - 3); }
    if (t === 6){ S.cvPhase = 'done'; clearInterval(cvTimer); }
    // Repaint the CV card in place when you are watching it; otherwise repaint only the ribbon, so
    // a background parse can never wipe out what you are typing two steps later.
    if (S.i === 1) render();
    else {
      var rb = document.getElementById('ribbon');
      if (rb) rb.innerHTML = cvRibbon();
    }
  }, 700);
}

function render(){
  clearInterval(runTimer);
  var key = STEPS[S.i].key;
  el('root').innerHTML = stepper() + '<div id="ribbon">' + cvRibbon() + '</div>' + VIEW[key]();
  if (S.cvPhase === 'done' && S.i > 1) S.cvSeen = true;   // the good news is shown once, then gets out of the way
  var r = el('root');

  r.querySelectorAll('[data-next]').forEach(function(b){ b.onclick = function(){ S.skipped[key] = false; move(1); }; });
  r.querySelectorAll('[data-back]').forEach(function(b){ b.onclick = function(){ move(-1); }; });
  r.querySelectorAll('[data-skip]').forEach(function(b){ b.onclick = function(){
    if (key === 'cv' && !S.cv) return cvSkipConfirm();
    S.skipped[key] = true; move(1); }; });
  r.querySelectorAll('[data-cancel]').forEach(function(b){ b.onclick = cancelModal; });
  r.querySelectorAll('[data-advanced]').forEach(function(b){ b.onclick = advancedModal; });
  r.querySelectorAll('[data-upload]').forEach(function(b){ b.onclick = function(){ startCV(); }; });
  r.querySelectorAll('[data-reupload]').forEach(function(a){ a.onclick = function(e){
    e.preventDefault(); S.cv = null; S.cvPhase = null; S.cvFound = []; clearInterval(cvTimer); render(); }; });
  r.querySelectorAll('[data-toggle]').forEach(function(x){ x.onclick = function(){ S[x.dataset.toggle] = !S[x.dataset.toggle]; render(); }; });
  r.querySelectorAll('[data-ch]').forEach(function(x){ x.onclick = function(){
    var k = x.dataset.ch; S.channels[k] = !S.channels[k]; render(); }; });
  r.querySelectorAll('[data-sched]').forEach(function(x){ x.onclick = function(){ S.schedule = x.dataset.sched; render(); }; });
  // Free text goes into state as it is typed. Picking from a list re-renders the step (to open or
  // close the "Something else" field), and anything living only in the DOM would be wiped by it.
  r.querySelectorAll('[data-ans]').forEach(function(inp){
    inp.oninput = function(){ S.ans[inp.dataset.ans] = inp.value; }; });
  r.querySelectorAll('[data-other]').forEach(function(inp){
    inp.oninput = function(){ S.other[inp.dataset.other] = inp.value; }; });
  r.querySelectorAll('[data-pick]').forEach(function(sel){
    sel.onchange = function(){
      var was = S.ans[sel.dataset.pick];
      S.ans[sel.dataset.pick] = sel.value;
      // Only repaint when the shape of the step changes — otherwise the select keeps its own state
      // and a repaint would just cost the user their place.
      if (was === '__other' || sel.value === '__other') render();
    }; });
  // Toggling a day must not also toggle the row it sits in — the row is itself a "choose this
  // option" target, and without stopPropagation every day click would re-pick the option.
  r.querySelectorAll('[data-day]').forEach(function(b){ b.onclick = function(e){
    e.stopPropagation();
    var d = Number(b.dataset.day), ix = S.days.indexOf(d);
    if (ix === -1) S.days.push(d); else S.days.splice(ix, 1);
    render(); }; });
  r.querySelectorAll('[data-preset]').forEach(function(b){ b.onclick = function(e){
    e.stopPropagation();
    S.days = b.dataset.preset === 'week' ? [1,2,3,4,5] : b.dataset.preset === 'all' ? [0,1,2,3,4,5,6] : [0,6];
    render(); }; });
  r.querySelectorAll('[data-time]').forEach(function(inp){
    inp.onclick = function(e){ e.stopPropagation(); };
    inp.onchange = function(){ S.time = inp.value || '08:00'; render(); }; });

  r.querySelectorAll('[data-drop]').forEach(function(c){ c.onclick = function(){
    S[c.dataset.drop].splice(Number(c.dataset.ix), 1); render(); }; });
  r.querySelectorAll('[data-add]').forEach(function(c){ c.onclick = function(){
    var from = c.dataset.from, ix = Number(c.dataset.ix);
    S[c.dataset.add].push(S[from][ix]); S[from].splice(ix, 1); render(); }; });
  r.querySelectorAll('[data-new]').forEach(function(inp){ inp.onkeydown = function(e){
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var v = inp.value.trim(); if (!v) return;
    S[inp.dataset.new].push(v); render();
    var again = el('root').querySelector('[data-new="' + inp.dataset.new + '"]'); if (again) again.focus();
  }; });

  window.scrollTo(0, 0);
}

function move(d){
  // Past the last step there is no ninth screen congratulating you — there is the product, with
  // one question waiting on it. Anything the wizard could say here, Today can say better, because
  // Today is where the answer has consequences.
  if (d > 0 && S.i === STEPS.length - 1){ window.location = '/today?from=wizard'; return; }
  S.i = Math.max(0, Math.min(STEPS.length - 1, S.i + d));
  render();
}
render();
`;


// =============================================================================================
// TODAY — where the wizard lets you out, and where the one question it deferred gets asked
// =============================================================================================
const TODAY_BODY = `<div class="shell" id="root"></div>
<div class="veil" id="veil" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
  <h2 id="mh"></h2><div id="mb"></div><div class="acts" id="macts"></div></div></div>`;

const TODAY_JS = String.raw`
var el = function(id){ return document.getElementById(id); };
var fromWizard = location.search.indexOf('from=wizard') !== -1;

// 'ask' -> 'running' -> 'done' -> 'later'. The question is asked once, on the screen where saying
// yes has a visible consequence, and it never comes back as a nag: "not now" turns it into a quiet
// line you can act on whenever.
var M = { state: 'ask', pct: 0, spend: 0.08, ranked: 0, timer: null };

var TABS = ['Today','Jobs','Pipeline','People','Activity'];

function chrome(){
  return '<div class="hd"><span class="brand"><span class="mark"></span>JobSeeker</span>' +
    '<a class="btn ghost" href="/settings">Settings</a></div>' +
    '<div class="tabrow">' + TABS.map(function(t, i){
      return '<span class="tab' + (i === 0 ? ' on' : '') + '">' + t + (i === 0 ? '' : ' <b>0</b>') + '</span>';
    }).join('') + '</div>';
}

function marketCard(){
  if (M.state === 'running') return '<div class="card">' +
    '<div class="chk"><span class="ic w">…</span><span class="t">Researching Cybersecurity' +
      '<em id="mkr">' + M.ranked + ' companies ranked so far</em>' +
      '<div class="prog"><i id="mkp" style="width:' + M.pct + '%"></i></div></span></div>' +
    '<p class="tiny" style="margin-top:11px">You can carry on — this keeps going. ' +
    '<span id="mks">spent so far: $' + M.spend.toFixed(2) + '</span></p></div>';

  if (M.state === 'done') return '<div class="alert g"><strong>34 companies ranked in Cybersecurity.</strong> ' +
    'Their careers pages are now watched, and the next hunt has somewhere to look.</div>' +
    '<div class="acts" style="margin-top:0"><button class="btn" data-hunt="1">Find roles now</button>' +
    '<span class="tiny">Or leave it — the next run does it.</span></div>';

  if (M.state === 'later') return '<div class="alert w"><strong>Cybersecurity has not been researched.</strong> ' +
    'Until it is, there are no companies to watch and no roles to find. ' +
    '<a href="#" data-ask="1">Research it now</a> — a few minutes, about a dollar.</div>';

  // the ask itself
  return '<div class="card ask">' +
    '<p class="th">One thing before you start</p>' +
    '<h4 style="margin-bottom:6px">Shall I research Cybersecurity now?</h4>' +
    '<p class="sub" style="margin-bottom:12px">You picked it as a market during setup, but nothing has ' +
    'been looked at yet. Researching it means finding the companies in it, ranking them against what ' +
    'you are after, and starting to watch their careers pages. Until that happens there is nothing ' +
    'for JobSeeker to hunt through — this screen stays empty.</p>' +
    '<div class="acts" style="margin-top:0">' +
      '<button class="btn" data-go="1">Yes — research it now</button>' +
      '<button class="btn sec" data-later="1">Not now</button></div>' +
    '<p class="tiny" style="margin-top:10px">A few minutes and about a dollar. Not now is fine: it ' +
    'happens on your first scheduled run, or whenever you press <b>Run now</b> below.</p>' +
  '</div>';
}

function render(){
  var empty = M.state !== 'done';
  el('root').innerHTML = chrome() +
    (fromWizard && M.state === 'ask'
      ? '<div class="alert g"><strong>You are set up.</strong> Everything you told the wizard is saved. ' +
        'Nothing has run yet and nothing has been spent.</div>'
      : '') +
    marketCard() +
    '<div class="tblock" style="margin-top:22px">' +
      '<p class="th">Needs you today</p>' +
      (M.state === 'done'
        ? '<div class="chk"><span class="ic y">✓</span><span class="t">11 roles found, best match first' +
          '<em>Waiting on the Jobs tab for you to look through.</em></span></div>'
        : '<p class="empty" style="font-size:13.5px;color:var(--mut);font-style:italic;margin:6px 0">' +
          'Nothing yet. Things appear here as JobSeeker finds them — a role worth a look, a reply that ' +
          'needs answering, a follow-up falling due.</p>') +
    '</div>' +
    '<div class="tblock" style="margin-top:20px">' +
      '<p class="th">Run now <span class="muted">— nothing here applies or sends; it queues anything that needs you</span></p>' +
      '<div class="runbtns">' +
        '<button class="btn sec" data-run="track">Read my channels</button>' +
        '<button class="btn sec" data-run="curate">Find new roles</button>' +
        '<button class="btn sec" data-run="followup">Draft follow-ups</button>' +
        '<button class="btn ghost" data-run="job-run">Everything</button>' +
      '</div>' +
      '<p class="tiny" style="margin-top:9px">These are the buttons that already exist in the dashboard today.</p>' +
    '</div>';

  var r = el('root');
  r.querySelectorAll('[data-go]').forEach(function(b){ b.onclick = startResearch; });
  r.querySelectorAll('[data-ask]').forEach(function(a){ a.onclick = function(e){ e.preventDefault(); startResearch(); }; });
  r.querySelectorAll('[data-later]').forEach(function(b){ b.onclick = function(){ M.state = 'later'; render(); }; });
  r.querySelectorAll('[data-hunt]').forEach(function(b){ b.onclick = function(){
    modal('Not in this prototype', '<p>This is where a role hunt would start — the same background run ' +
      'as the buttons below.</p>', '<button class="btn" data-close="1">OK</button>'); }; });
  r.querySelectorAll('[data-run]').forEach(function(b){ b.onclick = function(){
    modal('Not in this prototype', '<p>These buttons are real and already built — this mock does not ' +
      'wire them up, because pressing one spends money and drives Chrome.</p>',
      '<button class="btn" data-close="1">OK</button>'); }; });
}

function startResearch(){
  M.state = 'running'; M.pct = 3; M.ranked = 0; render();
  clearInterval(M.timer);
  M.timer = setInterval(function(){
    M.pct = Math.min(100, M.pct + 10); M.ranked += 4; M.spend += 0.07;
    var p = el('mkp'); if (!p){ clearInterval(M.timer); return; }
    p.style.width = M.pct + '%';
    el('mkr').textContent = M.ranked + ' companies ranked so far';
    el('mks').textContent = 'spent so far: $' + M.spend.toFixed(2);
    if (M.pct >= 100){ clearInterval(M.timer); M.state = 'done'; render(); }
  }, 620);
}

function modal(title, html, acts){
  el('mh').textContent = title; el('mb').innerHTML = html; el('macts').innerHTML = acts;
  el('veil').hidden = false;
  el('macts').querySelectorAll('[data-close]').forEach(function(b){ b.onclick = function(){ el('veil').hidden = true; }; });
}
render();
`;

// =============================================================================================
// SETTINGS — where the skipped steps go to live
// =============================================================================================
const SETTINGS_BODY = `<div class="shell" id="root"></div>
<div class="veil" id="veil" hidden><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
  <h2 id="mh"></h2><div id="mb"></div><div class="acts" id="macts"></div></div></div>`;

const SETTINGS_JS = String.raw`
var el = function(id){ return document.getElementById(id); };
var view = 'home', step = 0, timer = null;

var HOME = function(){ return '<div class="hd"><span class="brand"><span class="mark"></span>Settings</span>' +
  '<a class="btn ghost" href="/welcome">Re-run full setup</a></div>' +
  '<h1>Unfinished business</h1>' +
  '<p class="sub">Anything skipped during setup waits here. Each one is the same step from the wizard, ' +
  'on its own — not a form you have to work out how to fill in.</p>' +
  '<div class="card">' +
    '<div class="row"><span class="pill warn">missing</span><span class="grow"><b>Your CV</b>' +
      '<div class="tiny">Roles cannot be scored against your experience without it, and the summary ' +
      'JobSeeker drafts for you stays empty.</div></span>' +
      '<button class="btn sec" data-open="cv">Add my CV</button></div>' +
    '<div class="row"><span class="pill warn">none yet</span><span class="grow"><b>Markets</b>' +
      '<div class="tiny">A market is an industry to research. Without one there is nowhere to hunt, and ' +
      'Today stays empty.</div></span>' +
      '<button class="btn sec" data-open="markets">Add a market</button></div>' +
    '<div class="row"><span class="pill ok">done</span><span class="grow"><b>Roles, locations, seniority</b>' +
      '<div class="tiny">Solution Architect, Pre-sales Manager · Dubai / UAE, Remote · Senior, Principal</div></span>' +
      '<button class="btn ghost" data-open="none">Edit</button></div>' +
    '<div class="row"><span class="pill neutral">skipped</span><span class="grow"><b>Application answers</b>' +
      '<div class="tiny">Applying will pause and ask you each question instead.</div></span>' +
      '<button class="btn ghost" data-open="none">Fill them in</button></div>' +
  '</div>' +
  '<h2 style="margin:26px 0 10px">Advanced</h2>' +
  '<div class="card">' +
    '<div class="row"><span class="pill neutral">$4.12</span><span class="grow"><b>Spending</b>' +
      '<div class="tiny">Spent this month across 3 runs. Limits: $5.00 a run, no monthly ceiling — ' +
      'both checked before a run starts.</div></span>' +
      '<button class="btn ghost" data-open="none">Change limits</button></div>' +
    '<div class="row"><span class="pill ok">on</span><span class="grow"><b>How roles are scored</b>' +
      '<div class="tiny">Market 0.40 · role 0.35 · CV match 0.25.</div></span>' +
      '<button class="btn ghost" data-open="none">Adjust</button></div>' +
  '</div>' +
  '<p class="tiny" style="margin-top:14px">Prefer the terminal? <code>/onboard</code> in Claude Code asks ' +
  'the same questions and writes the same files.</p>'; };

// The CV wizard: the wizard's step 2, standing alone. Same screen, same copy, its own way in and out.
var CV = [
  function(){ return '<h1>Add your CV</h1><p class="sub">The file is saved on this Mac; Claude reads it ' +
    'to work out what it says. Half a minute, a few cents.</p>' +
    '<div class="drop" data-up="1"><div class="big">Drop your CV here</div>' +
    '<div class="tiny">PDF · or click to choose a file</div></div>' +
    '<div class="acts"><button class="btn ghost" data-home="1">Cancel</button></div>'; },
  function(){ return '<h1>Is this right?</h1>' +
    '<p class="sub">Claude read <b>Christos-Ventouris-CV.pdf</b>. It drives how every role is scored, so it is worth ten seconds.</p>' +
    '<div class="card">' +
      '<div class="row"><span class="lbl" style="width:106px;flex:0 0 auto;margin:0">Now</span><span class="grow">Senior Solution Architect, cybersecurity vendor · Dubai</span></div>' +
      '<div class="row"><span class="lbl" style="width:106px;flex:0 0 auto;margin:0">Experience</span><span class="grow">14 years · pre-sales, solution architecture, product</span></div>' +
    '</div>' +
    '<div class="acts"><button class="btn" data-done="cv">That is right</button>' +
    '<button class="btn ghost" data-step="0">Use a different file</button></div>'; },
  function(){ return '<div class="alert g"><strong>Saved.</strong> Roles found from now on are scored against it, ' +
    'and the two-line summary further on has been drafted from it — worth a read before you use it.</div>' +
    '<div class="acts"><button class="btn" data-home="1">Back to Settings</button></div>'; }
];

// The markets wizard: the wizard's step 4, standing alone, including the research it kicks off.
var MK = [
  function(){ return '<h1>Add a market</h1>' +
    '<p class="sub">An industry for JobSeeker to research. It builds a ranked list of the companies in it ' +
    'worth your time, then watches their careers pages.</p>' +
    '<div class="card"><span class="lbl">Market</span>' +
    '<input class="field" id="mkname" placeholder="Cybersecurity" value="Cybersecurity">' +
    '<p class="tiny" style="margin-top:10px">Researching one market takes a few minutes and costs about a ' +
    'dollar. You can add it now and let tonight\'s run do the research instead.</p></div>' +
    '<div class="acts"><button class="btn" data-step="1">Add and research now</button>' +
    '<button class="btn sec" data-done="mk">Add it, research later</button>' +
    '<button class="btn ghost" data-home="1">Cancel</button></div>'; },
  function(){ return '<h1>Researching Cybersecurity</h1>' +
    '<p class="sub">You can leave this page — it keeps going.</p>' +
    '<div class="card"><div class="chk"><span class="ic w">…</span><span class="t">Finding and ranking companies' +
    '<em id="mkr">starting…</em><div class="prog"><i id="mkp" style="width:3%"></i></div></span></div></div>' +
    '<div class="acts"><button class="btn ghost" data-home="1">Leave it running</button>' +
    '<span class="spacer"></span><span class="tiny" id="mks">spent so far: $0.08</span></div>'; },
  function(){ return '<div class="alert g"><strong>34 companies ranked.</strong> Their careers pages are now ' +
    'watched, and the next role hunt has somewhere to look.</div>' +
    '<div class="acts"><button class="btn" data-home="1">Back to Settings</button>' +
    '<button class="btn ghost" data-step="0">Add another market</button></div>'; },
  function(){ return '<div class="alert i"><strong>Cybersecurity added — not researched yet.</strong> ' +
    'It has no company list, so nothing will be found in it until the research runs. The next ' +
    'scheduled run picks it up; or research it now, which takes a few minutes.</div>' +
    '<div class="acts"><button class="btn" data-step="1">Research it now</button>' +
    '<button class="btn ghost" data-home="1">Back to Settings</button></div>'; }
];

function render(){
  clearInterval(timer);
  var html;
  if (view === 'home') html = HOME();
  else {
    var set = view === 'cv' ? CV : MK;
    html = '<div class="hd"><span class="brand"><span class="mark"></span>' +
      (view === 'cv' ? 'Your CV' : 'Markets') + '</span>' +
      '<button class="btn ghost" data-home="1">Settings</button></div>' + set[step]();
  }
  el('root').innerHTML = html;
  var r = el('root');
  r.querySelectorAll('[data-open]').forEach(function(b){ b.onclick = function(){
    var k = b.dataset.open;
    if (k === 'none'){ modal('Not in this prototype',
      '<p>Only the CV and markets wizards are drawn here — those are the two the full setup lets you skip.</p>',
      '<button class="btn" data-close="1">OK</button>'); return; }
    view = k; step = 0; render(); }; });
  r.querySelectorAll('[data-home]').forEach(function(b){ b.onclick = function(){ view = 'home'; step = 0; render(); }; });
  r.querySelectorAll('[data-step]').forEach(function(b){ b.onclick = function(){ step = Number(b.dataset.step); render(); }; });
  // "Add it, research later" lands on its own screen (index 3), not on the researched one — a
  // confirmation that claims work nobody did is how a tool stops being believed.
  r.querySelectorAll('[data-done]').forEach(function(b){ b.onclick = function(){
    step = b.dataset.done === 'cv' ? 2 : 3; render(); }; });
  r.querySelectorAll('[data-up]').forEach(function(b){ b.onclick = function(){
    b.innerHTML = '<div class="big">Reading…</div><div class="prog"><i style="width:25%"></i></div>';
    var i = 25, t = setInterval(function(){ i += 25;
      var bar = b.querySelector('.prog i'); if (bar) bar.style.width = i + '%';
      if (i >= 100){ clearInterval(t); step = 1; render(); } }, 230); }; });

  if (view === 'mk' && step === 1) fakeResearch();
  window.scrollTo(0, 0);
}

function fakeResearch(){
  var t = 0, spend = 0.08;
  timer = setInterval(function(){
    t += 1; var p = el('mkp'); if (!p){ clearInterval(timer); return; }
    spend += 0.07;
    el('mks').textContent = 'spent so far: $' + spend.toFixed(2);
    p.style.width = Math.min(100, t * 10) + '%';
    el('mkr').textContent = (t * 4) + ' companies ranked so far';
    if (t >= 10){ clearInterval(timer); step = 2; render(); }
  }, 640);
}

function modal(title, html, acts){
  el('mh').textContent = title; el('mb').innerHTML = html; el('macts').innerHTML = acts;
  el('veil').hidden = false;
  el('macts').querySelectorAll('[data-close]').forEach(function(b){ b.onclick = function(){ el('veil').hidden = true; }; });
}
render();
`;

// =============================================================================================
const ROUTES = new Map([
  ["/", () => INDEX],
  ["/setup", () => page("JobSeeker Setup", SETUP_BODY, SETUP_JS)],
  ["/welcome", () => page("Welcome to JobSeeker", WELCOME_BODY, WELCOME_JS)],
  ["/today", () => page("JobSeeker — Today", TODAY_BODY, TODAY_JS)],
  ["/settings", () => page("JobSeeker Settings", SETTINGS_BODY, SETTINGS_JS)],
]);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const route = ROUTES.get(pathname);
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found. Try / , /setup , /welcome or /settings");
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(route());
});

// Loopback only, like the dashboard. It serves nothing private, but a prototype that binds every
// interface is a habit worth not forming.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nMock wizard on http://localhost:${PORT}`);
  console.log("  /setup     the .command setup window");
  console.log("  /welcome   the eight-step wizard");
  console.log("  /today     where the wizard lets you out");
  console.log("  /settings  where skipped steps live afterwards");
  console.log("\nIt reads and writes nothing. Ctrl-C to stop.\n");
});
