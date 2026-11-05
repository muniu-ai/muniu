// SPDX-License-Identifier: Apache-2.0
import { constants, lstatSync, realpathSync, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EnterpriseError } from '@mn/enterprise-services';

const media: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const policy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const missing = () => new EnterpriseError('ROUTE_NOT_FOUND', 404);
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;

export function createEnterpriseWeb(root: string): (request: Request) => Promise<Response> {
  let directory: string, rootStat: Stats;
  try {
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw new Error();
    const configured = resolve(root), stat = lstatSync(configured);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error();
    directory = realpathSync(configured); rootStat = lstatSync(directory);
  } catch { throw new EnterpriseError('WEB_ROOT_INVALID', 503); }
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) throw missing();
    const path = new URL(request.url).pathname;
    let parts: string[], contentType: string;
    if (path === '/') { parts = ['index.html']; contentType = 'text/html; charset=utf-8'; }
    else {
      if (!path.startsWith('/assets/') || /%2f|%5c/iu.test(path)) throw missing();
      let decoded: string;
      try { decoded = decodeURIComponent(path); } catch { throw missing(); }
      parts = decoded.slice(1).split('/');
      if (parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(part))) throw missing();
      contentType = media[extname(parts.at(-1)!).toLowerCase()]!;
      if (!contentType) throw missing();
    }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const currentRoot = await lstat(directory);
      if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory() || !sameFile(currentRoot, rootStat)) throw missing();
      const parents: { path: string; stat: Stats }[] = [{ path: directory, stat: currentRoot }];
      let candidate = directory, expected: Stats | undefined;
      for (let index = 0; index < parts.length; index++) {
        candidate = join(candidate, parts[index]!);
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw missing();
        if (index < parts.length - 1) parents.push({ path: candidate, stat });
        else expected = stat;
      }
      const resolved = await realpath(candidate), inside = relative(directory, resolved);
      if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw missing();
      file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (!before.isFile() || !expected || !sameFile(before, expected)) throw missing();
      if (before.size > 8 * 1024 * 1024) throw new EnterpriseError('REQUEST_TOO_LARGE', 413);
      const checkParents = async () => {
        for (const parent of parents) {
          const stat = await lstat(parent.path);
          if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFile(stat, parent.stat)) throw missing();
        }
      };
      await checkParents();
      const bytes = request.method === 'HEAD' ? undefined : await file.readFile();
      const after = await file.stat();
      await checkParents();
      if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (bytes && bytes.byteLength !== after.size)) throw missing();
      return new Response(bytes ?? null, { headers: { 'Content-Type': contentType, 'Content-Length': String(after.size), 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': policy } });
    } catch (error) {
      if (error instanceof EnterpriseError) throw error;
      if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES'].includes(String(error.code))) throw missing();
      throw error;
    } finally { await file?.close(); }
  };
}
