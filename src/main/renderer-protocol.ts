import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const rendererPageUrl = 'actl://app/index.html';

protocol.registerSchemesAsPrivileged([
  { scheme: 'actl', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export function registerRendererProtocol(rendererDirectory: string): void {
  protocol.handle('actl', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || url.port || url.username || url.password || !['GET', 'HEAD'].includes(request.method)) {
        return new Response('Forbidden', { status: 403 });
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) return new Response('Forbidden', { status: 403 });
      const asset = path.resolve(rendererDirectory, `.${pathname}`);
      const relative = path.relative(rendererDirectory, asset);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
      const bytes = await readFile(asset);
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: {
          'Content-Type': contentTypes[path.extname(asset)] ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
