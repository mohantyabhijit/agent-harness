import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const data = await readFile(new URL('../data/fastapi-recent-mrs.json', import.meta.url), 'utf8');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer(async (request, response) => {
  if (request.url === '/api/demo') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(data);
    return;
  }
  const requested = request.url === '/' ? '/index.html' : normalize(request.url.split('?')[0]);
  const path = join(root, requested);
  if (!path.startsWith(root)) { response.writeHead(400); response.end('Bad request'); return; }
  try {
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end('Not found'); }
}).listen(8790, '127.0.0.1', () => console.log('OpenQuest demo listening at http://localhost:8790'));
