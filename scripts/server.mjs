import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(process.env.STATIC_ROOT || fileURLToPath(new URL('../public/', import.meta.url)));
const prefix = '/channel-one-clock';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  if (process.env.REQUEST_LOG) res.on('finish', () => console.log(`${res.statusCode} ${req.method} ${req.url}`));
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === prefix) { res.writeHead(301, { Location: prefix + '/' + url.search }); res.end(); return; }
    if (pathname.startsWith(prefix + '/')) pathname = pathname.slice(prefix.length);
    const path = await realpath(resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname)));
    // Resolve symlinks before applying the boundary check.
    if (!path.startsWith(resolve(root) + sep)) throw new Error('Outside public');
    const file = await stat(path); if (!file.isFile()) throw new Error('Not a file');
    const headers = { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    let start = 0, end = file.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); res.end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(path, { start, end });
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => {
  console.log(`Channel One clock: http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`);
});
