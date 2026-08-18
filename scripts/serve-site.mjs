// Local preview server for site/.
//
// Exists because python3 -m http.server sends no cache headers at all, so Chrome falls back to
// heuristic caching and will happily serve a style.css from minutes ago through a full reload --
// which looks exactly like "the CSS change did nothing" and costs an afternoon. Every response
// here is explicitly uncacheable, so a reload always shows what is on disk.
//
//   node scripts/serve-site.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../site/', import.meta.url).pathname;
const PORT = Number(process.argv[2]) || 4320;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  // Strip the query and refuse to climb out of site/ -- this serves a directory, not a filesystem.
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const full = join(ROOT, normalize(path));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('404');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`site preview → http://localhost:${PORT}/  (nothing is cached)`);
});
