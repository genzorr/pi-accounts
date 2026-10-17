import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runUpdate } from '../src/update.mjs';
import { runMaintenance } from '../src/maintenance.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
function tar(files) {
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write('package/' + name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function nativeNpm(t) {
  const executable = (process.env.PATH || '').split(delimiter).map(dir => join(dir, 'npm')).find(path => existsSync(path));
  if (!executable) { t.skip('native npm is unavailable'); return; }
  const cli = realpathSync(executable);
  if (!cli.endsWith('/npm/bin/npm-cli.js')) { t.skip('native npm CLI is unavailable'); return; }
  return cli;
}
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pi-update-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const prefix = join(home, 'nondefault npm prefix'), root = join(prefix, 'lib/node_modules/pi-accounts');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(source, 'src'), join(root, 'src'), { recursive: true });
  const pkg = { name: 'pi-accounts', version: '0.1.1', type: 'module', files: ['src/accounts.mjs', 'src/cli.mjs', 'src/maintenance.mjs', 'src/pi-sdk.mjs', 'src/update.mjs'], bin: { 'pi-accounts': 'src/cli.mjs' } };
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  symlinkSync('../lib/node_modules/pi-accounts/src/cli.mjs', join(prefix, 'bin/pi-accounts'));
  const next = Object.fromEntries(['accounts.mjs', 'cli.mjs', 'maintenance.mjs', 'pi-sdk.mjs', 'update.mjs'].map(name => ['src/' + name, readFileSync(join(root, 'src', name))]));
  next['package.json'] = JSON.stringify({ ...pkg, version: '0.1.2' });
  let archive = tar(next);
  let release = { tag_name: 'v0.1.2', draft: false, prerelease: false, assets: [{ name: 'pi-accounts-0.1.2.tgz', browser_download_url: 'https://github.com/genzorr/pi-accounts/releases/download/v0.1.2/pi-accounts-0.1.2.tgz', size: archive.length }] };
  const calls = [], messages = [], errors = [], downloads = [];
  const runtime = { node: realpathSync(process.execPath), cli: join(root, 'src/cli.mjs'), piPackageDir: join(home, 'missing-pi'), agentDir: join(home, 'bound-agent') };
  mkdirSync(runtime.agentDir); writeFileSync(join(runtime.agentDir, 'auth.json'), 'synthetic-preserve');
  const maintenance = { home, platform: 'linux', runtime, log: () => {}, error: message => errors.push(message), run: (command, args) => { calls.push([command, ...args]); return { code: 0, stdout: '', stderr: '' }; } };
  const installCalls = [];
  const options = { packageRoot: root, npm: [process.execPath, '/synthetic/npm-cli.js'], maintenance, log: message => messages.push(message), error: message => errors.push(message), fetch: async url => { downloads.push(url); return new Response(url.includes('api.github.com') ? JSON.stringify(release) : archive); }, install: async (command, args) => {
    installCalls.push([command, ...args]);
    const path = args.at(-1);
    if (path.endsWith('.tgz')) { for (const [name, content] of Object.entries(next)) writeFileSync(join(root, name), content); }
    else { rmSync(root, { recursive: true }); cpSync(path, root, { recursive: true }); }
    return true;
  } };
  return { home, prefix, root, runtime, maintenance, options, calls, installCalls, messages, errors, next, downloads, get release() { return release; }, set release(value) { release = value; }, set archive(value) { archive = value; release.assets[0].size = value.length; }, dir: join(home, '.local/state/pi-accounts-maintenance'), exec: () => runUpdate([], options) };
}

for (const intent of ['absent', 'paused', 'enabled', 'uninstalled']) test(`update preserves ${intent} maintenance, bound runtime and account data without Pi discovery`, async t => {
  const f = fixture(t);
  if (intent !== 'absent') {
    assert.equal(await runMaintenance(['install'], f.maintenance), 0);
    if (intent === 'enabled') assert.equal(await runMaintenance(['enable'], f.maintenance), 0);
    if (intent === 'uninstalled') assert.equal(await runMaintenance(['uninstall'], f.maintenance), 0);
  }
  assert.equal(await f.exec(), 0, f.errors.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '0.1.2');
  assert.equal(readFileSync(join(f.runtime.agentDir, 'auth.json'), 'utf8'), 'synthetic-preserve');
  assert.equal(f.installCalls.length, 1);
  assert.equal(f.installCalls[0][f.installCalls[0].indexOf('--prefix') + 1], f.prefix);
  assert.equal(existsSync(join(f.prefix, 'lib/node_modules/.pi-accounts-update')), false);
  if (intent === 'absent') assert.equal(existsSync(f.dir), false);
  else {
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'))).runtime, f.runtime);
    assert.equal(existsSync(join(f.dir, 'paused')), intent !== 'enabled');
  }
  assert.equal(f.calls.some(call => call.includes('stop') || call.includes('kill')), false);
});

test('current or older release performs no scheduler or npm mutation', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance); f.calls.length = 0;
  f.release = { ...f.release, tag_name: 'v0.1.1', assets: [{ name: 'pi-accounts-0.1.1.tgz', browser_download_url: 'https://github.com/genzorr/pi-accounts/releases/download/v0.1.1/pi-accounts-0.1.1.tgz', size: 1 }] };
  assert.equal(await f.exec(), 0, f.errors.join('\n'));
  assert.equal(f.downloads.length, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []);
  assert.equal(existsSync(join(f.dir, 'paused')), false);
});

for (const problem of ['metadata', 'identity', 'missing-runtime', 'traversal', 'truncated']) test(`invalid ${problem} release fails before pausing maintenance`, async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance); f.calls.length = 0;
  if (problem === 'metadata') f.release.assets[0].browser_download_url = 'https://attacker.invalid/archive';
  if (problem === 'identity') f.archive = tar({ ...f.next, 'package.json': JSON.stringify({ name: 'other', version: '0.1.2' }) });
  if (problem === 'missing-runtime') { delete f.next['src/accounts.mjs']; f.archive = tar(f.next); }
  if (problem === 'traversal') f.archive = tar({ ...f.next, '../outside': 'bad' });
  if (problem === 'truncated') f.archive = Buffer.from('bad archive');
  assert.equal(await f.exec(), 1);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []); assert.equal(existsSync(join(f.dir, 'paused')), false);
});

test('active refresh blocks update without killing or replacing its package, then retry preserves enabled intent', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance);
  mkdirSync(join(f.dir, 'running')); writeFileSync(join(f.dir, 'running/pid'), 'synthetic-running');
  assert.equal(await f.exec(), 1);
  assert.equal(existsSync(join(f.dir, 'running/pid')), true); assert.equal(existsSync(join(f.dir, 'paused')), false); assert.equal(f.installCalls.length, 0);
  rmSync(join(f.dir, 'running'), { recursive: true });
  assert.equal(await f.exec(), 0, f.errors.join('\n'));
  assert.equal(existsSync(join(f.dir, 'paused')), false, 'retry preserves original enabled intent');
});

for (const restorationFails of [false, true]) test(`npm failure ${restorationFails ? 'retains recovery after failed rollback' : 'restores package and enabled maintenance'}`, async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance);
  const baseInstall = f.options.install;
  f.options.install = async (command, args) => {
    if (args.at(-1).endsWith('.tgz')) { writeFileSync(join(f.root, 'package.json'), '{}'); return false; }
    if (restorationFails) return false;
    return baseInstall(command, args);
  };
  assert.equal(await f.exec(), 1);
  const lock = join(f.prefix, 'lib/node_modules/.pi-accounts-update');
  assert.equal(existsSync(lock), restorationFails);
  assert.equal(existsSync(join(f.dir, 'paused')), restorationFails);
  if (restorationFails) { assert.ok(existsSync(join(lock, 'previous/package.json'))); assert.match(f.errors.at(-1), /recovery.json preserved/); }
  else { assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '0.1.1'); assert.match(f.errors.at(-1), /previous package and maintenance intent restored/); }
});

test('concurrent updater exits without touching the first updater lock or scheduler', async t => {
  const f = fixture(t);
  let resume, entered;
  const ready = new Promise(done => { entered = done; });
  const baseFetch = f.options.fetch;
  let firstRequest = true;
  f.options.fetch = async url => { if (firstRequest) { firstRequest = false; entered(); await new Promise(done => { resume = done; }); } return baseFetch(url); };
  const first = f.exec(); await ready;
  assert.equal(await f.exec(), 1); assert.deepEqual(f.calls, []); assert.equal(f.installCalls.length, 0);
  f.options.fetch = baseFetch;
  resume(); assert.equal(await first, 0, f.errors.join('\n'));
});

test('help, invalid syntax and checkout fail before networking, scheduler or npm', async t => {
  const f = fixture(t);
  assert.equal(await runUpdate(['--help'], f.options), 0);
  assert.equal(await runUpdate(['--force'], f.options), 1);
  assert.equal(await runUpdate([], { ...f.options, packageRoot: source }), 1);
  assert.deepEqual(f.downloads, []); assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []);
});

test('public CLI update help and syntax bypass a broken Pi SDK and leave no account state', t => {
  const f = fixture(t);
  for (const args of [['update', '--help'], ['help', 'update'], ['update', '--bogus']]) {
    const result = spawnSync(process.execPath, [join(f.root, 'src/cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, PI_PACKAGE_DIR: join(f.home, 'broken-pi'), PI_CODING_AGENT_DIR: join(f.home, 'unused-agent') } });
    assert.equal(result.status, args.includes('--bogus') ? 1 : 0, result.stderr);
    assert.equal(existsSync(join(f.home, 'unused-agent')), false);
  }
});

for (const intent of ['absent', 'paused', 'enabled']) test(`public CLI installs via native npm and scheduler shims with ${intent} maintenance and broken Pi`, async t => {
  const f = fixture(t);
  if (intent !== 'absent') await runMaintenance(['install'], f.maintenance);
  if (intent === 'enabled') await runMaintenance(['enable'], f.maintenance);
  const shimBin = join(f.home, 'shims'), npmPath = join(f.home, 'npm/bin/npm-cli.js');
  mkdirSync(shimBin); mkdirSync(join(npmPath, '..'), { recursive: true });
  symlinkSync(npmPath, join(shimBin, 'npm'));
  const prepared = join(f.home, 'next'); mkdirSync(prepared);
  for (const [path, content] of Object.entries(f.next)) { mkdirSync(join(prepared, path, '..'), { recursive: true }); writeFileSync(join(prepared, path), content); }
  const archivePath = join(f.home, 'release.tgz'); writeFileSync(archivePath, tar(f.next));
  const releasePath = join(f.home, 'release.json');
  writeFileSync(releasePath, JSON.stringify({ ...f.release, assets: [{ ...f.release.assets[0], size: readFileSync(archivePath).length }] }));
  const trace = join(f.home, 'public-trace.jsonl');
  writeFileSync(npmPath, `import { appendFileSync, cpSync, rmSync } from 'node:fs';\nconst args = process.argv.slice(2); appendFileSync(${JSON.stringify(trace)}, JSON.stringify(['npm', ...args]) + '\\n');\nconst prefix = args[args.indexOf('--prefix') + 1]; if (prefix !== ${JSON.stringify(f.prefix)}) process.exit(88);\nconst root = prefix + '/lib/node_modules/pi-accounts'; rmSync(root, { recursive: true }); cpSync(${JSON.stringify(prepared)}, root, { recursive: true });\n`);
  writeFileSync(join(shimBin, 'systemctl'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)}, JSON.stringify(['systemctl', ...process.argv.slice(2)]) + '\\n');\n`, { mode: 0o755 });
  const preload = join(f.home, 'github-shim.mjs');
  writeFileSync(preload, `import { readFileSync, appendFileSync } from 'node:fs'; globalThis.fetch = async url => { appendFileSync(${JSON.stringify(trace)}, JSON.stringify(['github', url]) + '\\n'); return new Response(readFileSync(url.includes('api.github.com') ? ${JSON.stringify(releasePath)} : ${JSON.stringify(archivePath)})); };`);
  const result = spawnSync(process.execPath, ['--import', preload, join(f.root, 'src/cli.mjs'), 'update'], { encoding: 'utf8', env: { ...process.env, HOME: f.home, PATH: shimBin, PI_PACKAGE_DIR: join(f.home, 'broken-pi'), PI_CODING_AGENT_DIR: join(f.home, 'wrong-agent') } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Updated pi-accounts 0.1.1 → 0.1.2/);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '0.1.2');
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event[0] === 'npm').length, 1);
  assert.equal(events.filter(event => event[0] === 'github').length, 2);
  assert.equal(events.some(event => event[0] === 'systemctl'), intent !== 'absent');
  if (intent !== 'absent') { assert.equal(existsSync(join(f.dir, 'paused')), intent === 'paused'); assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'))).runtime, f.runtime); }
  assert.equal(readFileSync(join(f.runtime.agentDir, 'auth.json'), 'utf8'), 'synthetic-preserve');
  assert.equal(existsSync(join(f.home, 'wrong-agent')), false);
});

test('foreign maintenance units fail before npm or scheduler mutation', async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, '.config/systemd/user'), { recursive: true });
  const unit = join(f.home, '.config/systemd/user/pi-accounts-maintenance.service');
  writeFileSync(unit, 'foreign owner');
  assert.equal(await f.exec(), 1);
  assert.equal(readFileSync(unit, 'utf8'), 'foreign owner');
  assert.deepEqual(f.installCalls, []); assert.deepEqual(f.calls, []);
});

test('failed re-enable pauses and rolls back before restoring prior enabled intent', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance);
  const native = f.maintenance.run;
  let failEnable = true;
  f.maintenance.run = (command, args) => {
    if (failEnable && args.includes('enable')) { failEnable = false; return { code: 1, stdout: '', stderr: 'synthetic private scheduler failure' }; }
    return native(command, args);
  };
  assert.equal(await f.exec(), 1);
  assert.equal(f.installCalls.length, 2);
  assert.equal(existsSync(join(f.dir, 'paused')), false);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '0.1.1');
  assert.match(f.errors.at(-1), /previous package and maintenance intent restored/);
  assert.equal(f.errors.some(message => message.includes('synthetic private')), false);
});

test('runner starting during failed re-enable prevents rollback replacement and preserves backup', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance);
  const native = f.maintenance.run;
  f.maintenance.run = (command, args) => {
    if (args.includes('enable')) { mkdirSync(join(f.dir, 'running')); return { code: 1, stdout: '', stderr: '' }; }
    return native(command, args);
  };
  assert.equal(await f.exec(), 1);
  assert.equal(f.installCalls.length, 1, 'active refresh must prevent rollback npm replacement');
  assert.equal(existsSync(join(f.prefix, 'lib/node_modules/.pi-accounts-update/previous/package.json')), true);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
});

test('installed maintenance commands cannot enable scheduling across an active update lock', t => {
  const f = fixture(t);
  mkdirSync(join(f.prefix, 'lib/node_modules/.pi-accounts-update'));
  for (const command of ['enable', 'install', 'disable', 'uninstall']) {
    const result = spawnSync(process.execPath, [join(f.root, 'src/cli.mjs'), 'maintenance', command], { encoding: 'utf8', env: { ...process.env, HOME: f.home, PI_PACKAGE_DIR: '/missing-pi' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Maintenance update is active or requires recovery/);
  }
  assert.equal(existsSync(f.dir), false);
});

test('uninstalled maintenance tombstone from an old missing CLI is preserved without blocking update', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['uninstall'], f.maintenance);
  const statePath = join(f.dir, 'state.json');
  const state = JSON.parse(readFileSync(statePath)); state.runtime.cli = join(f.home, 'removed-prefix/src/cli.mjs');
  writeFileSync(statePath, JSON.stringify(state));
  const before = readFileSync(statePath);
  assert.equal(await f.exec(), 0, f.errors.join('\n'));
  assert.deepEqual(readFileSync(statePath), before);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
});

test('installed maintenance owned by another CLI fails before any scheduler or npm mutation', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance);
  const statePath = join(f.dir, 'state.json');
  const state = JSON.parse(readFileSync(statePath)); state.runtime.cli = join(f.home, 'foreign-cli.mjs');
  writeFileSync(state.runtime.cli, 'foreign-cli'); writeFileSync(statePath, JSON.stringify(state));
  assert.equal(await f.exec(), 1);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []);
});

test('GitHub digest mismatch is rejected before scheduler or npm mutation', async t => {
  const f = fixture(t);
  f.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
  assert.equal(await f.exec(), 1);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []);

});

test('native npm rejects an unsupported release Node requirement and restores the previous scratch installation', async t => {
  const f = fixture(t);
  const npmCli = nativeNpm(t);
  if (!npmCli) return;
  f.options.npm = [process.execPath, npmCli];
  f.next['package.json'] = JSON.stringify({ ...JSON.parse(f.next['package.json']), engines: { node: '>=999.0.0' } });
  f.archive = tar(f.next);
  let installs = 0;
  f.options.install = (command, args) => {
    installs++;
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, cwd: f.home, env: { ...process.env, HOME: f.home, npm_config_cache: join(f.home, 'npm-cache') } });
    return !result.error && result.status === 0;
  };
  assert.equal(await f.exec(), 1);
  assert.equal(installs, 2);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, '0.1.1');
  assert.equal(existsSync(join(f.prefix, 'lib/node_modules/.pi-accounts-update')), false);
  assert.match(f.errors.at(-1), /previous package and maintenance intent restored/);
});

test('partial rollback cannot claim restoration or re-enable maintenance', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance);
  const baseInstall = f.options.install;
  f.options.install = async (command, args) => {
    if (args.at(-1).endsWith('.tgz')) return false;
    await baseInstall(command, args);
    rmSync(join(f.root, 'src/pi-sdk.mjs'));
    return true;
  };
  assert.equal(await f.exec(), 1);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
  assert.equal(existsSync(join(f.prefix, 'lib/node_modules/.pi-accounts-update/previous/src/pi-sdk.mjs')), true);
  assert.match(f.errors.at(-1), /recovery requires inspection/);
});

test('native npm tar sees entries after a single zero block, but updater rejects them before pausing', async t => {
  const f = fixture(t);
  const npmCli = nativeNpm(t);
  if (!npmCli) return;
  const nativeTar = createRequire(npmCli)('tar');
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance); f.calls.length = 0;
  const archive = gzipSync(Buffer.concat([gunzipSync(tar(f.next)).subarray(0, -512), gunzipSync(tar({ 'docs/hidden.md': 'unlisted public payload' }))]));
  const archivePath = join(f.home, 'single-zero-hidden.tgz'); writeFileSync(archivePath, archive);
  const parsed = [];
  nativeTar.t({ file: archivePath, sync: true, onReadEntry: entry => parsed.push(entry.path) });
  assert.equal(parsed.includes('package/docs/hidden.md'), true, 'regression must exercise native npm tar reading the hidden entry');
  f.archive = archive;
  assert.equal(await f.exec(), 1);
  assert.match(f.errors.at(-1), /invalid end marker or nonzero trailing data/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []);
  assert.equal(existsSync(join(f.dir, 'paused')), false);
});

for (const ending of ['one zero block', 'nonzero block after EOF', 'nonzero byte after EOF']) test(`archive with ${ending} fails before scheduler or npm effects`, async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance); f.calls.length = 0;
  const data = gunzipSync(tar(f.next));
  f.archive = gzipSync(ending === 'one zero block' ? data.subarray(0, -512) : Buffer.concat([data, ending === 'nonzero block after EOF' ? Buffer.alloc(512, 1) : Buffer.from([1])]));
  assert.equal(await f.exec(), 1);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.installCalls, []);
  assert.equal(existsSync(join(f.dir, 'paused')), false);
});

test('real npm pack archive with canonical EOF and zero padding remains supported', async t => {
  const f = fixture(t);
  const npmCli = nativeNpm(t);
  if (!npmCli) return;
  const prepared = join(f.home, 'pack-source'); mkdirSync(prepared);
  for (const [path, data] of Object.entries(f.next)) { mkdirSync(join(prepared, path, '..'), { recursive: true }); writeFileSync(join(prepared, path), data); }
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--offline', '--pack-destination', f.home], { encoding: 'utf8', timeout: 15000, cwd: prepared, env: { ...process.env, HOME: f.home, npm_config_cache: join(f.home, 'npm-cache') } });
  assert.equal(packed.status, 0, packed.stderr);
  f.archive = readFileSync(join(f.home, 'pi-accounts-0.1.2.tgz'));
  assert.equal(await f.exec(), 0, f.errors.join('\n'));
  assert.equal(f.installCalls.length, 1);
});

test('refresh racing after inspection retains original enabled recovery and blocks misleading retry until explicit idle recovery', async t => {
  const f = fixture(t);
  await runMaintenance(['install'], f.maintenance); await runMaintenance(['enable'], f.maintenance);
  const native = f.maintenance.run;
  let race = true;
  f.maintenance.run = (command, args) => {
    if (race && args.includes('disable')) { race = false; mkdirSync(join(f.dir, 'running')); writeFileSync(join(f.dir, 'running/pid'), 'synthetic-active-refresh'); }
    return native(command, args);
  };
  assert.equal(await f.exec(), 1);
  const lock = join(f.prefix, 'lib/node_modules/.pi-accounts-update');
  const recovery = JSON.parse(readFileSync(join(lock, 'recovery.json')));
  assert.equal(recovery.paused, false);
  assert.equal(recovery.installed, true);
  assert.deepEqual(recovery.runtime, f.runtime);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
  assert.equal(readFileSync(join(f.dir, 'running/pid'), 'utf8'), 'synthetic-active-refresh');
  assert.equal(existsSync(join(lock, 'previous/src/cli.mjs')), true);
  assert.equal(f.installCalls.length, 0);
  assert.match(f.errors.at(-1), /Do not retry update/);
  assert.match(f.errors.at(-1), /install --reuse-runtime/);
  const callsBeforeRetry = f.calls.length, downloadsBeforeRetry = f.downloads.length;
  assert.equal(await f.exec(), 1);
  assert.match(f.errors.at(-1), /already running or was interrupted/);
  assert.equal(f.calls.length, callsBeforeRetry); assert.equal(f.downloads.length, downloadsBeforeRetry);
  assert.equal(f.installCalls.length, 0);
  assert.equal(f.calls.some(call => call.includes('kill') || call.includes('stop')), false);
  rmSync(join(f.dir, 'running'), { recursive: true });
  const publicState = readFileSync(join(f.dir, 'state.json'));
  const savedBackup = join(f.home, 'retained-public-backup');
  cpSync(join(lock, 'previous'), savedBackup, { recursive: true });
  assert.deepEqual(readFileSync(join(savedBackup, 'src/cli.mjs')), readFileSync(join(f.root, 'src/cli.mjs')));
  rmSync(lock, { recursive: true });
  const retainedRecovery = JSON.parse(publicState).runtime;
  assert.deepEqual(retainedRecovery, recovery.runtime);
  const options = { ...f.maintenance, runtime: { ...f.runtime, agentDir: '/wrong-agent' }, loadPi: () => { throw new Error('synthetic broken current SDK'); } };
  assert.equal(await runMaintenance(['install', '--reuse-runtime'], options), 0, f.errors.join('\n'));
  if (!recovery.paused) assert.equal(await runMaintenance(['enable'], options), 0, f.errors.join('\n'));
  assert.equal(existsSync(join(f.dir, 'paused')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'))).runtime, recovery.runtime);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'))).version, recovery.previousVersion);
  assert.equal(await f.exec(), 0, f.errors.join('\n'));
  assert.equal(existsSync(join(f.dir, 'paused')), false);
});
