#!/usr/bin/env node
// Send one WhatsApp message to the user's own number, to prove the link works.
//
//   node scripts/wa-test-message.mjs ["some text"]
//
// A green row saying "connected" is a claim about a handshake. This is the only thing that answers
// the question the user actually has, which is whether a message will arrive on their phone.
//
// How it talks to WhatsApp: the channel plugin is an MCP server on stdin/stdout, so this starts it
// the same way the setup step does and then speaks MCP to it directly -- initialize, then one
// tools/call to `reply`. No IPC token, no second protocol, nothing the plugin does not already do
// for Claude Code. The channel is stopped again afterwards, because it holds a singleton lock that
// a Claude Code session needs to be able to take.
//
// Exit 0 and prints "sent"; anything else is a failure with the reason on stderr.

import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import * as platform from "../server/platform.mjs";

const TEXT = process.argv[2] || "Hi! This is JobSeeker.";
const WA_DIR = process.env.JOBSEEKER_WA_DIR
  ? path.resolve(process.env.JOBSEEKER_WA_DIR)
  : path.join(os.homedir(), ".whatsapp-channel");
const TIMEOUT_MS = 90_000;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * The user's own JID, from the credentials the link wrote.
 *
 * Baileys stores it with a device suffix -- 971...:49@s.whatsapp.net -- which is this device, not
 * the account. Sending to it would be sending to one linked device rather than to the person, so
 * the suffix comes off.
 */
async function ownJid() {
  const file = path.join(WA_DIR, ".baileys_auth", "creds.json");
  let creds;
  try {
    creds = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    die(`no WhatsApp credentials to send with (${e.code || e.message})`);
  }
  const id = creds && creds.me && creds.me.id;
  if (!id) die("the credentials name no account; WhatsApp is not linked");
  return String(id).replace(/:\d+(?=@)/, "");
}

function bunBin() {
  return platform.resolveBin("bun") || (platform.IS_WIN ? null : "bun");
}

async function pluginDir() {
  const base = path.join(os.homedir(), ".claude", "plugins", "marketplaces");
  const market = path.join(base, "whatsapp-claude-plugin");
  try {
    await fs.access(path.join(market, "server.ts"));
    return market;
  } catch {
    die("the WhatsApp plugin is not installed");
  }
}

async function main() {
  const jid = await ownJid();
  const bun = bunBin();
  if (!bun) die("bun is not installed; the WhatsApp channel runs on it");
  const dir = await pluginDir();

  const child = spawn(bun, ["run", "--cwd", dir, "--shell=bun", "--silent", "start"], {
    cwd: dir,
    windowsHide: true,
    // stdin is the request channel AND what keeps the server alive: it shuts down on stdin EOF.
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  let buf = "";
  const waiting = new Map(); // id -> resolve
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // the channel also prints notifications; anything unparsable is not ours
      }
      const r = msg && msg.id !== undefined && waiting.get(msg.id);
      if (r) {
        waiting.delete(msg.id);
        r(msg);
      }
    }
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} did not answer`));
      }, 30_000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  const stop = () => {
    try {
      child.stdin.end(); // EOF is how this server is asked to stop
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 4000).unref();
  };

  const giveUp = setTimeout(() => {
    stop();
    die("the WhatsApp channel did not send within 90s");
  }, TIMEOUT_MS);

  try {
    await call(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jobseeker-setup", version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // The channel needs to be connected to WhatsApp before it can send, and it connects a second or
    // two after starting. Rather than guess at how long, ask until it stops saying it cannot.
    let last = "";
    for (let i = 0; i < 30; i++) {
      const res = await call(100 + i, "tools/call", {
        name: "reply",
        arguments: { chat_id: jid, text: TEXT },
      });
      const err = res.error || (res.result && res.result.isError ? res.result : null);
      if (!err) {
        clearTimeout(giveUp);
        stop();
        console.log("sent");
        process.exit(0);
      }
      last = JSON.stringify(err).slice(0, 300);
      if (!/not connected|starting|reconnect/i.test(last)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    clearTimeout(giveUp);
    stop();
    die(`the channel refused to send: ${last || "no reason given"}`);
  } catch (e) {
    clearTimeout(giveUp);
    stop();
    die(`${e.message}${stderr ? ` — ${stderr.trim().slice(-300)}` : ""}`);
  }
}

main().catch((e) => die(e.message));
