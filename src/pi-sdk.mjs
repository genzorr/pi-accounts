import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AccountError } from './accounts.mjs';

export function assertSupportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new AccountError('pi-accounts requires Node.js >=22.19.0, matching the reviewed Pi runtime');
  }
}

async function packageFromPath() {
  let executable;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const candidate = resolve(directory || '.', 'pi');
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      executable = await realpath(candidate);
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  if (!executable) throw new AccountError('Pi command not found on PATH; install Pi 1.3.0 or set PI_PACKAGE_DIR to its package directory');
  let root = dirname(executable);
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') return root;
    } catch {}
    const parent = dirname(root);
    if (parent === root) throw new AccountError('Pi command does not resolve inside its npm package; set PI_PACKAGE_DIR to the Pi 1.3.0 package directory');
    root = parent;
  }
}

export async function loadPi() {
  assertSupportedNode();
  const root = process.env.PI_PACKAGE_DIR ? resolve(process.env.PI_PACKAGE_DIR) : await packageFromPath();
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || pkg.version !== '1.3.0') {
    throw new AccountError('This account tool requires reviewed Pi 1.3.0; revalidate refresh locking before upgrading');
  }
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  let aiRoot;
  for (const directory of createRequire(join(root, 'package.json')).resolve.paths('@earendil-works/pi-ai') || []) {
    const candidate = join(directory, '@earendil-works/pi-ai');
    let dependency;
    try { dependency = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    if (dependency.name !== '@earendil-works/pi-ai' || dependency.version !== '1.3.0') throw new AccountError('This account tool requires Pi with its reviewed pi-ai 1.3.0 dependency');
    aiRoot = candidate;
    break;
  }
  if (!aiRoot) throw new AccountError('Pi OAuth dependency not found; repair the Pi 1.3.0 installation');
  const { FileAuthStorageBackend, AuthStorage } = await load('dist/core/auth-storage.js');
  const { resolvePath } = await load('dist/utils/paths.js');
  const { openaiCodexOAuth } = await import(pathToFileURL(join(aiRoot, 'dist/auth/oauth/openai-codex.js')).href);
  return { FileAuthStorageBackend, AuthStorage, oauth: openaiCodexOAuth, resolvePath, root, aiRoot };
}
