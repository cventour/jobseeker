#!/usr/bin/env node
// Say what is actually wrong with a CV PDF, without ever quoting what is in it.
//
//   node scripts/cv-probe.mjs [path/to/cv.pdf]
//
// It exists because "Nothing could be read from your-cv.pdf" is a guess. The message blames the
// file — "it is probably a scan" — but the parse fails identically when the file is fine and the
// Claude CLI never ran, when the PDF is password-protected, and when the PDF is a scan. Those need
// three different answers and the log cannot tell them apart. This opens the file and says which.
//
// It reads BYTES and reports SHAPE: how many pages, whether there is a font, whether there are
// text-drawing operators, whether it is encrypted, how many characters a naive extractor would
// find. It never prints the extracted text, so the output is safe to send to someone else.

import { promises as fs } from "fs";
import zlib from "zlib";
import path from "path";

const out = [];
const say = (s = "") => out.push(s);

async function newestCV() {
  const dir = path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), "templates", "cv");
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (!files.length) return "";
  const stats = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
  stats.sort((a, b) => b.t - a.t);
  return path.join(dir, stats[0].f);
}

// Inflate every FlateDecode stream we can. A PDF that fails here is either damaged or encrypted;
// both are worth knowing, so a stream that will not inflate is counted rather than thrown.
function inflateStreams(buf) {
  let ok = 0, failed = 0, text = "";
  let i = 0;
  for (;;) {
    const s = buf.indexOf("stream", i);
    if (s === -1) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf("endstream", start);
    if (e === -1) break;
    const chunk = buf.subarray(start, e);
    i = e + 9;
    if (!chunk.length) continue;
    try {
      text += zlib.inflateSync(chunk).toString("latin1");
      ok++;
    } catch {
      try {
        text += zlib.inflateRawSync(chunk).toString("latin1");
        ok++;
      } catch {
        failed++;
      }
    }
    if (text.length > 8_000_000) break;
  }
  return { ok, failed, text };
}

// Count the operators that actually paint glyphs, and roughly how many characters they carry. The
// count is the only number that separates "a scan" from "a text PDF" — a scan has pages, fonts in
// name only, and zero Tj.
function textOperators(content) {
  // Only inside BT/ET. Counting parenthesised strings across the whole file counts object names
  // and metadata too, and a scan with a big XMP block would look like it had text in it.
  let tj = 0, chars = 0;
  for (const blk of content.matchAll(/BT\b([\s\S]{0,200000}?)\bET\b/g)) {
    const b = blk[1];
    tj += (b.match(/\)\s*Tj/g) || []).length + (b.match(/\]\s*TJ/g) || []).length;
    for (const m of b.matchAll(/\((?:\\.|[^\\()])*\)/g)) chars += m[0].length - 2;
  }
  return { tj, chars };
}

async function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : await newestCV();
  say("--- CV file probe ---");
  if (!target) {
    say("No PDF found in templates/cv/ — there is nothing for the parser to read.");
    return console.log(out.join("\n"));
  }

  let buf;
  try {
    buf = await fs.readFile(target);
  } catch (e) {
    say(`file      ${path.basename(target)}`);
    say(`UNREADABLE: ${e.code || e.message} — the parser cannot open it either.`);
    return console.log(out.join("\n"));
  }
  const st = await fs.stat(target);
  const head = buf.subarray(0, 8).toString("latin1");
  const raw = buf.toString("latin1");

  say(`file      ${path.basename(target)}`);
  say(`size      ${(st.size / 1024).toFixed(1)} KB`);
  say(`modified  ${st.mtime.toISOString()}`);
  say(`header    ${JSON.stringify(head)}`);

  if (!head.startsWith("%PDF-")) {
    say("VERDICT   Not a PDF. The name ends in .pdf but the bytes are something else — most often a");
    say("          Pages/Word file renamed, or a download that saved an HTML error page.");
    return console.log(out.join("\n"));
  }

  const encrypted = /\/Encrypt[\s\d<]/.test(raw);
  const pagesDeclared = (() => {
    const m = [...raw.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((x) => Number(x[1]));
    return m.length ? Math.max(...m) : (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  })();
  const fonts = (raw.match(/\/Type\s*\/Font/g) || []).length;
  const images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
  const xfa = /\/XFA/.test(raw);
  const producer = (/\/Producer\s*\((?:\\.|[^\\()])*\)/.exec(raw) || [""])[0].slice(0, 120);
  const creator = (/\/Creator\s*\((?:\\.|[^\\()])*\)/.exec(raw) || [""])[0].slice(0, 120);

  const { ok, failed, text } = inflateStreams(buf);
  const { tj, chars } = textOperators(text + raw);

  say(`pages     ~${pagesDeclared}`);
  say(`fonts     ${fonts}   images ${images}`);
  say(`streams   ${ok} inflated, ${failed} could not be inflated`);
  say(`text ops  ${tj} glyph-painting operators, ~${chars} characters behind them`);
  say(`encrypted ${encrypted ? "YES" : "no"}`);
  if (xfa) say("forms     XFA (LiveCycle) — a form container, not a normal PDF page");
  if (producer) say(`producer  ${producer}`);
  if (creator) say(`creator   ${creator}`);

  say("");
  if (encrypted) {
    say("VERDICT   Password- or permission-protected. Even with no open password, a PDF with");
    say("          copy/extract restrictions reads as empty. Re-export it without protection.");
  } else if (failed > 0 && ok === 0) {
    say("VERDICT   Damaged or unsupported compression — no stream in it could be decompressed.");
  } else if (tj === 0 && images > 0) {
    say("VERDICT   A scan. The pages are pictures of a CV, with no text layer. Exporting again");
    say("          from Word, Pages or Google Docs (not 'print to image') fixes it.");
  } else if (tj === 0) {
    say("VERDICT   No text layer found, and no images either — the file is probably truncated.");
  } else {
    say("VERDICT   This is a normal text PDF with a readable text layer.");
    say("          The file is NOT the problem — look at the parse log above this section for why");
    say("          the run failed (an 'Unknown command' or a missing claude CLI both land here).");
  }
  console.log(out.join("\n"));
}

main().catch((e) => {
  console.log("--- CV file probe ---");
  console.log("probe failed: " + e.message);
});
