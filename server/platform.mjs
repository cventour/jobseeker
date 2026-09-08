// The ONE file that knows which operating system this is.
//
// JobSeeker's core (record.mjs, md.mjs, lock.mjs, the dashboard's rendering) is plain Node and runs
// anywhere. What differs by OS is the thin edge around it: which script runner to call, how the
// daily run is scheduled (launchd on macOS, Task Scheduler on Windows), whether a browser broker
// exists (macOS only -- Windows has no TCC, so there is nothing to broker), and how to open a URL.
// Everything that used to hard-code `bash`, `launchctl` or `process.getuid()` goes through here, so
// no other module needs a `process.platform` branch.
//
// On macOS every call resolves to EXACTLY the command that was spawned before this module existed:
// `bash scripts/<name>.sh`, `launchctl print gui/<uid>/<label>`. On Windows the same name maps to
// `powershell.exe -File scripts/win/<name>.ps1`. The PowerShell twins mirror the bash scripts one
// for one (same arguments, same output shape), so callers never care which one ran.
//
// JOBSEEKER_FORCE_PLATFORM=win32|darwin overrides detection. It exists for scripts/test-platform.mjs,
// which asserts both mappings from whichever OS CI happens to be running on. Never set it in real use.

import { execFile, spawn } from "child_process";
import { promises as fs, statSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

export const PLATFORM = process.env.JOBSEEKER_FORCE_PLATFORM || process.platform;
export const IS_WIN = PLATFORM === "win32";
export const IS_MAC = PLATFORM === "darwin";

// launchd labels (macOS). Windows has one Task Scheduler task instead, named in set-schedule.ps1.
export const LAUNCHD_JOBRUN = "com.jobseeker.jobrun";
export const LAUNCHD_BROWSER = "com.jobseeker.browser";

/** Numeric user id, or null where the concept does not exist (Windows). */
export function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

export function homeDir() {
  return os.homedir();
}

// Windows PowerShell 5.1, not pwsh: the twins use WinRT toast notifications, which pwsh cannot load
// without an extra module. 5.1 ships with every Windows 10 and 11.
function powershellPath() {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function existsSync(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a binary lives, or null. "node" is always the running binary (a launchd/Task Scheduler
 * job has a minimal PATH, and the node that is executing us is by definition the right one).
 * "claude" is looked up on PATH first, then in the places its installer puts it.
 */
export function resolveBin(name) {
  if (name === "node") return process.execPath;
  if (name === "powershell") return IS_WIN ? powershellPath() : null;
  if (name === "bash") return IS_WIN ? null : "bash";

  const exts = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (name === "claude") {
    dirs.push(path.join(homeDir(), ".local", "bin"));
    if (IS_WIN && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
    if (!IS_WIN) dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  if (name === "bun") {
    dirs.push(path.join(homeDir(), ".bun", "bin"));
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The command that runs the script called `name`: scripts/<name>.sh via bash on macOS,
 * scripts/win/<name>.ps1 via Windows PowerShell on Windows. `name` may include a subdirectory
 * ("lib/claude-run") but never an extension.
 */
export function scriptCommand(name, args = []) {
  if (/\.(sh|ps1)$/.test(name)) throw new Error(`scriptCommand: pass a bare name, not ${name}`);
  if (IS_WIN) {
    return {
      cmd: powershellPath(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(ROOT, "scripts", "win", `${name}.ps1`),
        ...args.map(String),
      ],
    };
  }
  return { cmd: "bash", args: [path.join(ROOT, "scripts", `${name}.sh`), ...args.map(String)] };
}

export function nodeCommand(script, args = []) {
  const file = path.isAbsolute(script) ? script : path.join(ROOT, script);
  return { cmd: process.execPath, args: [file, ...args.map(String)] };
}

/** execFile as a promise that never rejects: { ok, out, err, code }. */
export function run(cmd, args = [], { timeout = 8000, cwd = ROOT, maxBuffer = 16 * 1024 * 1024, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer, windowsHide: true, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          out: String(stdout || "").trim(),
          err: String(stderr || err?.message || "").trim(),
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        })
    );
  });
}

export function runScript(name, args = [], opts = {}) {
  const c = scriptCommand(name, args);
  return run(c.cmd, c.args, opts);
}

export function node(args = [], opts = {}) {
  return run(process.execPath, args.map(String), opts);
}

function spawnDetached(cmd, args, { env, cwd = ROOT } = {}) {
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  child.unref();
  return child;
}

/** Fire-and-forget a script; the caller watches its status file, exactly as before. */
export function spawnScriptDetached(name, args = [], opts = {}) {
  const c = scriptCommand(name, args);
  return spawnDetached(c.cmd, c.args, opts);
}

export function spawnNodeDetached(script, args = [], opts = {}) {
  const c = nodeCommand(script, args);
  return spawnDetached(c.cmd, c.args, opts);
}

// ---------- Schedule ----------
// Both twins print the same shape: "not scheduled" | "HH:MM" | "HH:MM 1,4" (0 = Sunday).

export async function scheduleShow() {
  const r = await runScript("set-schedule", ["--show"]);
  return r.ok ? r.out : "";
}

export function scheduleSet(time, days = "") {
  const args = [time];
  if (days) args.push(days);
  return runScript("set-schedule", args, { timeout: 120_000 });
}

export function scheduleRemove() {
  return runScript("set-schedule", ["--remove"], { timeout: 120_000 });
}

/** Is the daily run installed? macOS asks launchd directly (as the dashboard always has). */
export async function isScheduled() {
  if (IS_MAC || (!IS_WIN && uid() !== null)) {
    const r = await run("launchctl", ["print", `gui/${uid()}/${LAUNCHD_JOBRUN}`]);
    return r.ok;
  }
  return /^\d\d:\d\d/.test(await scheduleShow());
}

/**
 * The launchd browser broker exists only on macOS, where Automation permission is keyed to the
 * responsible process. Windows has no such permission, so the question does not apply there and
 * the dashboard shows the Chrome extension's pairing state instead.
 */
export async function browserAgentStatus() {
  if (IS_WIN) return { applicable: false, installed: false };
  const r = await run("launchctl", ["print", `gui/${uid()}/${LAUNCHD_BROWSER}`]);
  return { applicable: true, installed: r.ok };
}

// ---------- Small OS conveniences ----------

export function openUrl(url) {
  if (IS_WIN) return spawnDetached("cmd", ["/c", "start", "", url]);
  if (IS_MAC) return spawnDetached("open", [url]);
  return spawnDetached("xdg-open", [url]);
}

/** POSIX modes mean nothing on NTFS; never let a chmod be the reason a write fails on Windows. */
export async function chmodSafe(p, mode) {
  if (IS_WIN) return;
  try {
    await fs.chmod(p, mode);
  } catch {
    /* best effort */
  }
}

export function pathList(...dirs) {
  return dirs.filter(Boolean).join(path.delimiter);
}
