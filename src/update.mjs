import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { inspectMaintenance, runMaintenance } from './maintenance.mjs';

const repository = 'genzorr/pi-accounts';
const maxArchive = 16 * 1024 * 1024;
const maxExpanded = 64 * 1024 * 1024;
const runtimeFiles = ['src/cli.mjs', 'src/update.mjs', 'src/maintenance.mjs', 'src/accounts.mjs', 'src/pi-sdk.mjs'];
function packageFiles(pkg) {
  if (!Array.isArray(pkg.files) || pkg.files.some(path => typeof path !== 'string' || !/^(?:src\/[a-zA-Z0-9_-]+\.mjs|docs\/[a-zA-Z0-9_-]+\.md|README\.md|NOTICE\.md|LICENSE)$/.test(path))) fail('Update requires an explicit public package file list');
  return new Set(['package.json', 'README.md', 'LICENSE', ...pkg.files]);
}
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
const help = 'pi-accounts update   Install the latest public GitHub release into this npm prefix; preserve maintenance intent and accounts\npi-accounts update --help';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function fail(message) { throw new Error(message); }
function version(value) { if (!versionPattern.test(value)) fail('Update requires a stable release version'); return value.split('.').map(Number); }
function newer(candidate, installed) {
  const left = version(candidate), right = version(installed);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
function regular(path) { if (!lstatSync(path).isFile()) fail('Update installation contains an unsupported file'); return readFileSync(path); }
function installation(root) {
  root = realpathSync(root);
  if (/[\x00-\x1f\x7f]/.test(root)) fail('Update installation paths cannot contain control characters');
  const prefix = dirname(dirname(dirname(root)));
  if (root !== join(prefix, 'lib/node_modules/pi-accounts') || existsSync(join(root, '.git'))) fail('Update supports an installed global npm package only; use the documented installation command for a checkout or local install');
  const pkg = JSON.parse(regular(join(root, 'package.json')));
  if (pkg.name !== 'pi-accounts' || Object.keys(pkg.bin || {}).join(',') !== 'pi-accounts' || pkg.bin?.['pi-accounts'] !== 'src/cli.mjs') fail('Update cannot identify this npm installation');
  version(pkg.version);
  packageFiles(pkg);
  if (realpathSync(join(prefix, 'bin/pi-accounts')) !== realpathSync(join(root, 'src/cli.mjs'))) fail('Update cannot verify the npm prefix entrypoint');
  return { root, prefix, pkg };
}
function npmCommand() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    try {
      const path = realpathSync(join(dir, 'npm'));
      if (path.endsWith('/npm/bin/npm-cli.js') && lstatSync(path).isFile()) return [realpathSync(process.execPath), path];
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  fail('Update cannot locate the native npm CLI; put npm on PATH and retry');
}
async function download(url, limit, fetcher) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-accounts-update' }, redirect: 'follow' });
    if (!response.ok || !response.body) fail('Update release download failed; check public GitHub availability and retry');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) { controller.abort(); fail('Update release download exceeds the size limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timeout); }
}
function archiveFiles(compressed, expectedVersion) {
  let data;
  try { data = gunzipSync(compressed, { maxOutputLength: maxExpanded }); }
  catch { fail('Update archive is invalid or exceeds the expanded size limit'); }
  const files = new Map(); let offset = 0; let ended = false;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > data.length || !data.subarray(offset).every(byte => byte === 0)) fail('Update archive has an invalid end marker or nonzero trailing data');
      ended = true;
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const sizeText = field(124, 12).trim(), sumText = field(148, 8).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText)) fail('Update archive contains an invalid header');
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== parseInt(sumText, 8)) fail('Update archive checksum is invalid');
    const size = parseInt(sizeText, 8);
    const name = (field(345, 155) ? field(345, 155) + '/' : '') + field(0, 100);
    const type = field(156, 1);
    if (!name.startsWith('package/') || /[\\\x00-\x1f\x7f]/.test(name) || name.replace(/\/$/, '').split('/').some(part => !part || part === '..' || part === '.') || !['', '0', '5'].includes(type) || field(157, 100)) fail('Update archive contains unsupported or unsafe entries');
    if (offset + size > data.length) fail('Update archive is truncated');
    if (type !== '5') {
      const path = name.slice('package/'.length);
      if (!path || path.endsWith('/') || files.has(path)) fail('Update archive contains duplicate or invalid files');
      files.set(path, data.subarray(offset, offset + size));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) fail('Update archive is truncated');
  let pkg;
  try { pkg = JSON.parse(files.get('package.json')); } catch { fail('Update archive has no valid package manifest'); }
  if (pkg.name !== 'pi-accounts' || pkg.version !== expectedVersion || pkg.type !== 'module' || Object.keys(pkg.bin || {}).join(',') !== 'pi-accounts' || pkg.bin?.['pi-accounts'] !== 'src/cli.mjs' || pkg.man || Object.keys(pkg.scripts || {}).some(key => ['preinstall', 'install', 'postinstall', 'prepare'].includes(key)) || Object.keys(pkg.peerDependencies || {}).length || Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.optionalDependencies || {}).length || Object.keys(pkg.bundleDependencies || {}).length || Object.keys(pkg.bundledDependencies || {}).length) fail('Update archive package identity, version or dependency contract is invalid');
  const allowed = packageFiles(pkg);
  if ([...files.keys()].some(path => !allowed.has(path))) fail('Update archive contains files outside its public package file list');
  for (const path of runtimeFiles) if (!files.get(path)?.length) fail('Update archive is missing required runtime files');
  return files;
}

export async function runUpdate(argv, options = {}) {
  const log = options.log || console.log;
  const error = options.error || console.error;
  let lock, retain = false;
  try {
    if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) { log(help); return 0; }
    if (argv.length) fail('Invalid update command or option; run pi-accounts update --help');
    const current = installation(options.packageRoot || fileURLToPath(new URL('..', import.meta.url)));
    const npm = options.npm || npmCommand();
    lock = join(current.prefix, 'lib/node_modules/.pi-accounts-update');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (cause) { if (cause.code === 'EEXIST') { lock = undefined; fail('Update is already running or was interrupted; inspect the .pi-accounts-update directory beside the installed package before retrying'); } throw cause; }
    writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
    const fetcher = options.fetch || fetch;
    const release = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases/latest`, 1024 * 1024, fetcher)).toString('utf8'));
    const candidate = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    version(candidate);
    if (release.draft !== false || release.prerelease !== false || release.tag_name !== `v${candidate}`) fail('Update requires a public stable GitHub release');
    const assetName = `pi-accounts-${candidate}.tgz`;
    const assets = release.assets?.filter(asset => asset.name === assetName);
    const url = `https://github.com/${repository}/releases/download/v${candidate}/${assetName}`;
    if (assets?.length !== 1 || assets[0].browser_download_url !== url || !Number.isInteger(assets[0].size) || assets[0].size < 1 || assets[0].size > maxArchive) fail('Update release has no valid package archive');
    if (!newer(candidate, current.pkg.version)) { log(`pi-accounts ${current.pkg.version} is current; maintenance and accounts unchanged`); return 0; }
    const compressed = await download(url, maxArchive, fetcher);
    if (compressed.length !== assets[0].size) fail('Update archive size does not match release metadata');
    if (assets[0].digest != null && (assets[0].digest !== `sha256:${createHash('sha256').update(compressed).digest('hex')}`)) fail('Update archive digest does not match release metadata');
    const files = archiveFiles(compressed, candidate);
    const archive = join(lock, assetName);
    writeFileSync(archive, compressed, { mode: 0o600 });
    const maintenanceOptions = { ...options.maintenance, updating: true, log: () => {}, error: message => { throw new Error(message); } };
    const before = await inspectMaintenance(maintenanceOptions);
    if (before.state?.installed && realpathSync(before.state.runtime.cli) !== realpathSync(join(current.root, 'src/cli.mjs'))) fail('Update maintenance belongs to another installation; preserve it and update its owning package');
    const backup = join(lock, 'previous');
    const previous = new Map();
    for (const path of packageFiles(current.pkg)) {
      const original = join(current.root, path);
      if (!existsSync(original)) continue;
      const data = regular(original);
      previous.set(path, data);
      mkdirSync(dirname(join(backup, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(backup, path), data, { mode: path === 'src/cli.mjs' ? 0o755 : 0o600 });
    }
    const recovery = { prefix: current.prefix, packageRoot: current.root, previousVersion: current.pkg.version, version: candidate, runtime: before.state?.runtime, installed: before.state?.installed || false, paused: before.paused };
    writeFileSync(join(lock, 'recovery.json'), JSON.stringify(recovery, null, 2) + '\n', { mode: 0o600 });
    const maintenance = async command => {
      const code = await runMaintenance([command], { ...maintenanceOptions, runtime: before.state?.runtime });
      if (code !== 0) fail('Update could not restore maintenance; inspect maintenance status and retry the recorded recovery');
    };
    const restore = async () => {
      if (!before.state?.installed) return;
      await maintenance('install');
      if (!before.paused) await maintenance('enable');
    };
    if (before.running) fail('Update found an active or stale maintenance refresh; wait for it to finish and retry. No process was stopped');
    if (before.state?.installed) {
      retain = true;
      try { await maintenance('disable'); }
      catch { fail(`Update could not confirm maintenance is idle; scheduling may remain paused. Public backup and original maintenance intent in recovery.json preserved at ${lock}. Do not retry update or replace the package while a refresh is active. After verifying the updater exited and the refresh is idle, preserve the backup and remove only this update lock, then run pi-accounts maintenance install --reuse-runtime${before.paused ? '; leave maintenance paused' : ' and pi-accounts maintenance enable to restore the original enabled intent'}`); }
    }
    const install = options.install || ((command, args) => {
      const result = spawnSync(command, args, { stdio: 'ignore', timeout: 180000 });
      return !result.error && result.status === 0;
    });
    const installPackage = path => install(npm[0], [...npm.slice(1), 'install', '--global', '--prefix', current.prefix, '--ignore-scripts', '--engine-strict', '--no-audit', '--no-fund', '--offline', '--install-links', path]);
    retain = true;
    try {
      if (!await installPackage(archive)) fail('Update npm installation failed');
      const installed = installation(current.root);
      if (installed.pkg.version !== candidate) fail('Update npm installation did not install the intended version');
      for (const [path, contents] of files) if (!regular(join(current.root, path)).equals(contents)) fail('Update installed files do not match the validated archive');
      await restore();
      retain = false;
      log(`Updated pi-accounts ${current.pkg.version} → ${candidate}; maintenance ${before.state?.installed ? before.paused ? 'remains paused' : 'enabled' : 'remains absent'}; accounts unchanged`);
      return 0;
    } catch {
      try {
        if (before.state?.installed) await maintenance('disable');
        if (!await installPackage(backup)) fail('Rollback npm installation failed');
        if (installation(current.root).pkg.version !== current.pkg.version) fail('Rollback package verification failed');
        for (const [path, contents] of previous) if (!regular(join(current.root, path)).equals(contents)) fail('Rollback installed files do not match the previous package');
        await restore();
        retain = false;
        fail('Update failed; previous package and maintenance intent restored. Retry when npm and GitHub are available');
      } catch (cause) {
        if (!retain) throw cause;
        fail(`Update failed and recovery requires inspection. Backup and recovery.json preserved at ${lock}. Keep scheduling paused and wait for any active refresh to finish. After verifying the updater exited, reinstall previous with npm install --global --prefix ${shellQuote(current.prefix)} --ignore-scripts --offline --install-links ${shellQuote(backup)}. Preserve the backup until verified, then remove only this update lock before restoring the recorded maintenance runtime and pause intent`);
      }
    }
  } catch (cause) {
    error(/^(Update |Invalid update)/.test(cause.message) ? cause.message : 'Update failed before installation; inspect npm permissions, public GitHub connectivity and maintenance ownership. Private account data was not accessed');
    return 1;
  } finally { if (lock && !retain) rmSync(lock, { recursive: true, force: true }); }
}
