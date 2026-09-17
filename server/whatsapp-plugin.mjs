// Is the WhatsApp plugin installed under a name its marketplace no longer has?
//
// The plugin's author renamed it (whatsapp-claude-channel -> whatsapp-channel) without renaming the
// marketplace. Once Claude Code refreshes that marketplace, an install under the old name fails to
// load, every run loses its WhatsApp tool, and digests stop reaching the phone with nothing on screen
// to say why. The fix is two `claude plugin` commands, which the dashboard offers to run.
//
// Only reads files Claude Code keeps under ~/.claude/plugins, so it is cheap enough to ask on every
// page. The WhatsApp link itself lives in ~/.whatsapp-channel and both names read it, so nothing
// here touches pairing.

import { promises as fs } from "fs";
import path from "path";
import * as platform from "./platform.mjs";

const MARKETPLACE = "whatsapp-claude-plugin";
const OLD_NAME = "whatsapp-claude-channel";

const readJSON = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
};

/** { needsFix, oldKey, newKey, newInstalled } — needsFix false whenever anything is unknown. */
export async function whatsappPluginState() {
  const base = path.join(platform.homeDir(), ".claude", "plugins");
  const installed = (await readJSON(path.join(base, "installed_plugins.json")))?.plugins || {};
  const oldKey = `${OLD_NAME}@${MARKETPLACE}`;
  if (!installed[oldKey]) return { needsFix: false };
  const market = await readJSON(path.join(base, "marketplaces", MARKETPLACE, ".claude-plugin", "marketplace.json"));
  const names = (market?.plugins || []).map((p) => p?.name).filter((n) => typeof n === "string");
  // A marketplace that still lists the old name has not been refreshed, and the old install still
  // loads from it. Nothing to fix yet, and nothing to install the new name from.
  if (!names.length || names.includes(OLD_NAME)) return { needsFix: false };
  const newName = names.find((n) => n.includes("whatsapp"));
  if (!newName) return { needsFix: false };
  const newKey = `${newName}@${MARKETPLACE}`;
  return { needsFix: true, oldKey, newKey, newInstalled: Boolean(installed[newKey]) };
}

/** Run the fix: install the current name (unless it already is), then remove the old one. */
export async function fixWhatsappPlugin() {
  const st = await whatsappPluginState();
  if (!st.needsFix) return { ok: true, already: true };
  const bin = platform.resolveBin("claude");
  if (!bin) return { ok: false, why: "The Claude Code CLI could not be found on this computer." };
  const steps = [];
  if (!st.newInstalled) steps.push(["plugin", "install", st.newKey]);
  steps.push(["plugin", "uninstall", st.oldKey]);
  for (const args of steps) {
    const r = await platform.run(bin, args, { timeout: 180000 });
    if (!r.ok) {
      const said = (r.err || r.out || "").split("\n").filter(Boolean).slice(-1)[0] || `exit ${r.code}`;
      return { ok: false, why: `claude ${args.join(" ")} did not finish: ${said}` };
    }
  }
  const after = await whatsappPluginState();
  return after.needsFix ? { ok: false, why: "The commands ran, but the old plugin is still installed." } : { ok: true };
}
