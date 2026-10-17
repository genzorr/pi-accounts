import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AccountError } from './accounts.mjs';

// Bound combinations preserve native refresh locking and persistence after caller cancellation.
const REVIEWED_PI_AI_VERSIONS = { '1.1.0': ['1.1.0', '1.2.0', '1.3.0'], '1.2.0': ['1.2.0', '1.3.0'], '1.3.0': ['1.3.0'] };
const SUPPORTED_PI_VERSIONS = Object.keys(REVIEWED_PI_AI_VERSIONS);

export function assertSupportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 19)) {
    throw new AccountError('pi-accounts requires Node.js >=22.19.0, matching the reviewed Pi runtime');
  }
}

async function packageAncestor(executable) {
  let root = dirname(executable);
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') return root;
    } catch {}
    const parent = dirname(root);
    if (parent === root) return;
    root = parent;
  }
}

async function managedMarker(root) {
  let data;
  try { data = await readFile(join(root, 'managed-install.json'), 'utf8'); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
  let marker;
  try { marker = JSON.parse(data); } catch {}
  if (marker?.kind !== 'pi-managed-install' || marker.schemaVersion !== 1 || marker.layout !== 'releases-v1') {
    throw new AccountError('Invalid managed Pi installation marker; repair the official Pi installation');
  }
  return true;
}

async function managedPackage(root) {
  let version;
  try { version = (await readFile(join(root, 'current-version'), 'utf8')).split('\n')[0]; }
  catch { throw new AccountError('Cannot read managed Pi current-version; repair the official Pi installation'); }
  if (!/^[A-Za-z0-9._+-]+$/.test(version) || version === '.' || version === '..') {
    throw new AccountError('Invalid managed Pi current-version; repair the official Pi installation');
  }
  const executable = join(root, 'releases', version, 'node_modules', '.bin', 'pi');
  let packageDir;
  try {
    await access(executable, constants.X_OK);
    if ((await stat(executable)).isFile()) packageDir = await packageAncestor(await realpath(executable));
  } catch {}
  if (!packageDir) throw new AccountError('Managed Pi active release is missing its native npm package; repair the official Pi installation');
  return { root: packageDir, managedInstallRoot: root };
}

async function packageFromPath() {
  let command;
  let executable;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const candidate = resolve(directory || '.', 'pi');
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      executable = await realpath(candidate);
      command = candidate;
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  if (!executable) throw new AccountError('Pi command not found on PATH; install a supported Pi release or set PI_PACKAGE_DIR to its package directory');
  const candidates = [dirname(command)];
  if (basename(executable) === 'pi' && basename(dirname(executable)) === 'bin') candidates.push(join(dirname(dirname(executable)), 'install'));
  for (const root of candidates) if (await managedMarker(root)) return managedPackage(root);
  const root = await packageAncestor(executable);
  if (!root) throw new AccountError('Pi command is not a supported official managed installation or npm package; repair Pi or set PI_PACKAGE_DIR to its supported Pi package directory');
  return { root };
}

export async function loadPi(options = {}) {
  assertSupportedNode();
  const managed = options.managedInstallRoot !== undefined;
  const bound = options.packageDir !== undefined;
  if (managed && bound) throw new AccountError('Choose one Pi installation: managedInstallRoot or packageDir');
  if ((managed || bound) && (typeof (managed ? options.managedInstallRoot : options.packageDir) !== 'string' || !(managed ? options.managedInstallRoot : options.packageDir))) {
    throw new AccountError('Pi installation paths must be nonempty strings');
  }
  let location;
  if (managed) {
    const managedRoot = resolve(options.managedInstallRoot);
    if (!(await managedMarker(managedRoot))) throw new AccountError('Managed Pi installation marker is missing; repair the official Pi installation');
    location = await managedPackage(managedRoot);
  } else if (bound) location = { root: resolve(options.packageDir) };
  else location = process.env.PI_PACKAGE_DIR ? { root: resolve(process.env.PI_PACKAGE_DIR) } : await packageFromPath();
  const { root, managedInstallRoot } = location;
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent' || !SUPPORTED_PI_VERSIONS.includes(pkg.version)) {
    const version = typeof pkg.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version) ? pkg.version : 'an unsupported package';
    throw new AccountError(`This account tool supports reviewed Pi ${SUPPORTED_PI_VERSIONS.join(', ')}; found ${version}. Revalidate refresh locking before using another release`);
  }
  const load = (file) => import(pathToFileURL(join(root, file)).href);
  let aiRoot;
  let aiVersion;
  for (const directory of createRequire(join(root, 'package.json')).resolve.paths('@earendil-works/pi-ai') || []) {
    const candidate = join(directory, '@earendil-works/pi-ai');
    let dependency;
    try { dependency = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    if (dependency.name !== '@earendil-works/pi-ai' || !REVIEWED_PI_AI_VERSIONS[pkg.version].includes(dependency.version)) throw new AccountError('This account tool requires a reviewed Pi/pi-ai release combination');
    aiRoot = candidate;
    aiVersion = dependency.version;
    break;
  }
  if (!aiRoot) throw new AccountError('Pi OAuth dependency not found; repair the supported Pi installation');
  let FileAuthStorageBackend, AuthStorage, resolvePath, openaiCodexOAuth, refreshStoredOAuthCredential;
  try {
    ({ FileAuthStorageBackend, AuthStorage } = await load('dist/core/auth-storage.js'));
    ({ resolvePath } = await load('dist/utils/paths.js'));
    ({ openaiCodexOAuth } = await import(pathToFileURL(join(aiRoot, 'dist/auth/oauth/openai-codex.js')).href));
    ({ refreshStoredOAuthCredential } = await import(pathToFileURL(join(aiRoot, 'dist/auth/resolve.js')).href));
  } catch { throw new AccountError('Pi native auth modules are unavailable; repair the supported Pi installation before account operations'); }
  const capabilities = [FileAuthStorageBackend?.prototype?.withLock, FileAuthStorageBackend?.prototype?.withLockAsync, AuthStorage?.create, AuthStorage?.prototype?.read, AuthStorage?.prototype?.modify, resolvePath, openaiCodexOAuth?.login, openaiCodexOAuth?.refresh, refreshStoredOAuthCredential];
  if (!capabilities.every(value => typeof value === 'function')) {
    throw new AccountError('Pi native auth APIs are incompatible; lock, storage and OAuth capabilities must be present before account operations');
  }
  return { FileAuthStorageBackend, AuthStorage, oauth: openaiCodexOAuth, resolvePath, refreshStoredOAuthCredential, version: pkg.version, aiVersion, root, aiRoot, ...(managedInstallRoot ? { managedInstallRoot } : {}) };
}
