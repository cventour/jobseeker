// Options page for JobSeeker Bridge. Talks only to the service worker (runtime.sendMessage) and to
// chrome.permissions; it never contacts the dashboard directly, so the pairing logic lives in one place.
"use strict";

const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
  "no-bridge": "No JobSeeker dashboard found on this computer",
  "not-paired": "Dashboard found, not paired yet",
  connected: "Connected to the dashboard",
  error: "Connected, but the last request failed",
};

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function refreshStatus() {
  const s = await send({ type: "status" });
  if (!s || s.ok === false) {
    $("dot").dataset.state = "error";
    $("statusText").textContent = "Could not reach the extension's background worker";
    $("statusDetail").textContent = (s && s.error) || "";
    return;
  }
  const state = s.state || "no-bridge";
  $("dot").dataset.state = state;
  $("statusText").textContent = STATE_TEXT[state] || state;

  const bits = [];
  if (s.port) bits.push(`port ${s.port}`);
  if (s.lastSeen) bits.push(`last contact ${fmtTime(s.lastSeen)}`);
  if (s.lastError) bits.push(s.lastError);
  if (state === "no-bridge") bits.push("Start the dashboard (npm run dashboard) and this page will notice on its own.");
  $("statusDetail").textContent = bits.join(" · ");
  $("extId").textContent = s.extensionId || chrome.runtime.id;

  $("connect").textContent = s.paired ? "Re-pair" : "Connect";
  $("forget").disabled = !s.paired;
  if (s.port && !$("port").matches(":focus")) $("port").value = String(s.port);
}

async function refreshGrant() {
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch {
    granted = false;
  }
  $("grantState").textContent = granted
    ? "Allowed: JobSeeker can read any site you open."
    : "Not allowed: only WhatsApp Web and LinkedIn can be read.";
  $("grantAll").textContent = granted ? "Stop reading careers pages" : "Also let it read careers pages";
  $("grantAll").dataset.granted = granted ? "1" : "0";
}

function note(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

$("connect").addEventListener("click", async () => {
  const code = $("code").value.replace(/\D/g, "");
  const port = Number($("port").value);
  if (code.length !== 6) return note("pairNote", "The pairing code is six digits.", "bad");
  if (!port || port < 1 || port > 65535) return note("pairNote", "The port must be a number between 1 and 65535.", "bad");

  $("connect").disabled = true;
  note("pairNote", "Connecting…");
  await send({ type: "setPort", port });
  const r = await send({ type: "pair", port, code });
  $("connect").disabled = false;
  if (r && r.ok) {
    note("pairNote", `Paired with the dashboard on port ${r.port}.`, "ok");
    $("code").value = "";
  } else {
    note("pairNote", (r && r.error) || "Pairing failed.", "bad");
  }
  refreshStatus();
});

$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("connect").click();
});

$("grantAll").addEventListener("click", async () => {
  const granted = $("grantAll").dataset.granted === "1";
  try {
    if (granted) {
      await chrome.permissions.remove({ origins: ["<all_urls>"] });
    } else {
      // Must be called from a user gesture; Chrome shows its own prompt.
      await chrome.permissions.request({ origins: ["<all_urls>"] });
    }
  } catch (e) {
    $("grantState").textContent = `Chrome said: ${String((e && e.message) || e)}`;
    return;
  }
  refreshGrant();
});

$("forget").addEventListener("click", async () => {
  const r = await send({ type: "forget" });
  note("forgetNote", r && r.ok ? "Pairing forgotten. The dashboard will need a new code." : (r && r.error) || "Could not forget.", r && r.ok ? "ok" : "bad");
  refreshStatus();
});

refreshStatus();
refreshGrant();
setInterval(refreshStatus, 3000);
