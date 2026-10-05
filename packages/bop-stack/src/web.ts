import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function buildBopWeb(bopRoot: string, apiUrl: string, outDir: string): Promise<string> {
  const webDir = join(bopRoot, 'apps', 'web');
  const vite = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) throw new Error(`project 05 web dependencies are not installed (${vite})`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: webDir,
      env: { ...process.env, VITE_API_URL: apiUrl, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) =>
      code === 0 && existsSync(join(outDir, 'index.html'))
        ? resolvePromise(out)
        : reject(new Error(`project 05 web build failed (${code}): ${out.slice(-2000)}`)),
    );
  });
}

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

export interface StaticOptions {
  corsPrefixes?: string[];
  noStore?: string[];
}

export function serveStatic(dir: string, port: number, options: StaticOptions = {}): Promise<StaticServer> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(pathname) !== '') {
        res.writeHead(404);
        res.end();
        return;
      }
      file = join(root, 'index.html');
    }
    const headers: Record<string, string> = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': (options.noStore ?? []).includes(pathname) ? 'no-store' : 'no-cache',
    };
    if ((options.corsPrefixes ?? []).some((p) => pathname.startsWith(p))) headers['access-control-allow-origin'] = '*';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
}
