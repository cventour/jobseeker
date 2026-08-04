#!/usr/bin/env node
// One-off migration: bring existing task details under the 200-character cap.
//
// Nothing is discarded. The full original text is written to data/notes/<task_id>.md and the table
// keeps a short, actionable line plus a pointer, so Today becomes readable without losing the
// research that was dumped into it.
//
//   node scripts/shorten-task-details.mjs --dry-run
//   node scripts/shorten-task-details.mjs

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TASKS = path.join(ROOT, "data", "tasks.md");
const NOTES = path.join(ROOT, "data", "notes");
const MAX = 200;
const DRY = process.argv.includes("--dry-run");

// Prefer a clean sentence or clause boundary so the kept line still reads as a sentence.
function shorten(text, budget) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= budget) return flat;
  const window = flat.slice(0, budget);
  for (const sep of [". ", " — ", "; ", ", "]) {
    const at = window.lastIndexOf(sep);
    if (at > budget * 0.4) return window.slice(0, at).trim();
  }
  const sp = window.lastIndexOf(" ");
  return (sp > budget * 0.4 ? window.slice(0, sp) : window).trim();
}

const raw = await fs.readFile(TASKS, "utf8");
const lines = raw.split("\n");
let changed = 0;

for (let i = 0; i < lines.length; i++) {
  if (!/^\|\s*task_/.test(lines[i])) continue;
  const cells = lines[i].split("|");
  if (cells.length < 9) continue;
  const id = cells[1].trim();
  const detail = cells[7].trim();
  if (detail.length <= MAX) continue;

  const noteRel = path.join("notes", `${id}.md`);
  const pointer = ` · full note: ${noteRel}`;
  const kept = shorten(detail, MAX - pointer.length);
  const replacement = kept + pointer;

  console.log(`  ${id}: ${detail.length} -> ${replacement.length} chars`);
  if (!DRY) {
    await fs.mkdir(NOTES, { recursive: true });
    await fs.writeFile(
      path.join(NOTES, `${id}.md`),
      `# ${id}\n\nFull detail moved out of data/tasks.md so the Today page stays readable.\n` +
        `Original length: ${detail.length} characters.\n\n${detail}\n`
    );
    cells[7] = ` ${replacement} `;
    lines[i] = cells.join("|");
  }
  changed++;
}

if (!DRY && changed) await fs.writeFile(TASKS, lines.join("\n"));
console.log(`\n${changed} task(s) ${DRY ? "would be" : ""} shortened${DRY ? " (dry run)" : ""}.`);
