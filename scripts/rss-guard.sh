#!/usr/bin/env bash
# Memory watchdog for a job-run (or any Claude Code session).
#
# Why this exists: on 2026-07-29 an interactive run fanned out 7 subagents at once. Three extra
# `claude` processes appeared alongside the session and grew at a steady ~14.5 MB/s each — with
# essentially no CPU (2 threads, ~0.002s CPU in a 10-sample spin), so they were not doing model or
# tool work. Within 17 minutes they held 15.9 GB, 12.0 GB and 6.1 GB. Total resident memory across
# the machine hit 48.9 GB on a 16 GB M1; WindowServer's watchdog timed out, the kernel's jetsam
# killer fired, and the whole laptop froze. The session itself was a healthy 458 MB the entire time,
# and nothing in this repo leaks (every helper is bounded) — so this guard does not try to fix the
# leak, it just makes sure a leaking child can never take the machine down again.
#
# What it does: every INTERVAL seconds it walks the process tree under ROOT_PID and
#   * SIGTERMs (then SIGKILLs) any single descendant over MAX_RSS_MB,
#   * if the tree total still exceeds TOTAL_RSS_MB, SIGTERMs ROOT_PID itself so the run aborts
#     cleanly (job-run.sh will retry) instead of the kernel taking the desktop with it.
# It never touches a process outside ROOT_PID's tree, so other Claude Code sessions are safe.
#
# Usage:
#   scripts/rss-guard.sh <root-pid>            # watch that pid's descendants until it exits
#   GUARD_ABORT_ROOT=0 scripts/rss-guard.sh $$ # log only, never kill the root
#
# Tunables (environment):
#   GUARD_MAX_RSS_MB     per-process kill threshold   (default 4096)
#   GUARD_TOTAL_RSS_MB   whole-tree abort threshold   (default 12288)
#   GUARD_INTERVAL_SECS  poll interval                (default 15)
#   GUARD_ABORT_ROOT     1 = abort the run at the tree ceiling, 0 = log only (default 1)
#
# Caveat: this samples `ps` RSS, which counts resident pages only — memory the kernel has already
# compressed does not appear. That makes it an UNDER-estimate under pressure, which is the safe
# direction: at the observed ~14.5 MB/s a leaker trips the 4 GB threshold in under 5 minutes, long
# before the compressor is doing meaningful work.
set -uo pipefail

ROOT_PID="${1:-}"
if [ -z "$ROOT_PID" ]; then
  echo "usage: rss-guard.sh <root-pid>" >&2
  exit 2
fi

MAX_RSS_MB="${GUARD_MAX_RSS_MB:-4096}"
TOTAL_RSS_MB="${GUARD_TOTAL_RSS_MB:-12288}"
INTERVAL="${GUARD_INTERVAL_SECS:-15}"
ABORT_ROOT="${GUARD_ABORT_ROOT:-1}"

say() { echo "[rss-guard $(date '+%H:%M:%S')] $*"; }

# Emit "<pid> <rss_kb> <command>" for every descendant of ROOT_PID (the root itself excluded).
# One ps call per tick; the transitive closure is computed in awk to a fixpoint, because a leaking
# process is typically a grandchild (claude -> zsh -> claude), not a direct child.
snapshot() {
  ps -axo pid=,ppid=,rss=,comm= | awk -v root="$ROOT_PID" '
    {
      pid = $1; pp = $2; rss = $3
      cmd = $4; for (i = 5; i <= NF; i++) cmd = cmd " " $i   # paths contain spaces
      PP[pid] = pp; RSS[pid] = rss; CMD[pid] = cmd; LIST[n++] = pid
    }
    END {
      IN[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (i = 0; i < n; i++) {
          p = LIST[i]
          if (!(p in IN) && (PP[p] in IN)) { IN[p] = 1; changed = 1 }
        }
      }
      for (i = 0; i < n; i++) {
        p = LIST[i]
        if ((p in IN) && p != root) print p, RSS[p], CMD[p]
      }
    }'
}

rss_kb_of() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' '; }

# SIGTERM, give it 10s to unwind, then SIGKILL.
reap() { # pid, why
  say "KILL pid=$1 — $2"
  kill -TERM "$1" 2>/dev/null
  ( sleep 10; kill -KILL "$1" 2>/dev/null ) &
}

say "watching pid $ROOT_PID (per-process ${MAX_RSS_MB}MB, tree ${TOTAL_RSS_MB}MB, every ${INTERVAL}s)"

while kill -0 "$ROOT_PID" 2>/dev/null; do
  total_kb="$(rss_kb_of "$ROOT_PID")"; total_kb="${total_kb:-0}"

  while read -r pid rss_kb cmd; do
    [ -n "${pid:-}" ] || continue
    total_kb=$(( total_kb + rss_kb ))
    if [ "$rss_kb" -gt $(( MAX_RSS_MB * 1024 )) ]; then
      reap "$pid" "$(( rss_kb / 1024 ))MB > ${MAX_RSS_MB}MB cap :: ${cmd}"
      total_kb=$(( total_kb - rss_kb ))
    fi
  done < <(snapshot)

  total_mb=$(( total_kb / 1024 ))
  if [ "$total_mb" -gt "$TOTAL_RSS_MB" ]; then
    if [ "$ABORT_ROOT" = "1" ]; then
      say "ABORT — tree at ${total_mb}MB > ${TOTAL_RSS_MB}MB ceiling; terminating root pid $ROOT_PID"
      kill -TERM "$ROOT_PID" 2>/dev/null
      exit 1
    fi
    say "WARN — tree at ${total_mb}MB > ${TOTAL_RSS_MB}MB ceiling (GUARD_ABORT_ROOT=0, not killing)"
  fi

  sleep "$INTERVAL"
done

say "root pid $ROOT_PID exited; guard done"
