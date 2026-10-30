import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve('out');
const basePath = process.env.DOCS_BASE_PATH ?? '';
const port = Number(process.env.PORT ?? 3000);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (basePath && pathname === '/') { res.writeHead(302, { Location: `${basePath}/` }).end(); return; }
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) { res.writeHead(404).end(); return; }
    let file = resolve(root, pathname.slice(basePath.length).replace(/^\/+/, ''));
    const rel = relative(root, file);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) { res.writeHead(403).end(); return; }
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`Documentation preview: http://127.0.0.1:${port}${basePath}/`));
