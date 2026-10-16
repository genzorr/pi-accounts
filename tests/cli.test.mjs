import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, cp, chmod, symlink, rename } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSupportedNode } from '../src/pi-sdk.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const jwt = payload => `synthetic.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-auth-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'fake-pi');
  const home = join(root, 'agent');
  const trace = join(root, 'trace');
  const save = async (path, text) => { await mkdir(join(sdk, path, '..'), { recursive: true }); await writeFile(join(sdk, path), text); };
  await save('package.json', JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0', type: 'module' }));
  const marker = `import { appendFileSync } from 'node:fs'; const mark = text => appendFileSync(process.env.PI_AUDIT_TRACE, text + '\\n');`;
  await save('dist/core/auth-storage.js', `${marker}\nimport { readFile } from 'node:fs/promises';\nmark('sdk:auth');\nexport class FileAuthStorageBackend { constructor(path) { this.path = path; mark('storage:construct'); } async withLockAsync(fn) { mark('storage:read'); let data = ''; try { data = await readFile(this.path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; } return (await fn(data)).result; } }\nexport class AuthStorage {}\n`);
  await save('dist/utils/paths.js', `${marker}\nimport { resolve } from 'node:path'; mark('sdk:paths'); export const resolvePath = resolve;\n`);
  await save('node_modules/@earendil-works/pi-ai/package.json', '{"name":"@earendil-works/pi-ai","version":"1.3.0","type":"module"}');
  await save('node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js', `${marker}\nmark('sdk:oauth');\nfunction credential() { return { type: 'oauth', access: process.env.PI_SYNTHETIC_ACCESS || 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 8 * 3600000, accountId: process.env.PI_SYNTHETIC_ID || 'synthetic-account' }; }\nexport const openaiCodexOAuth = { async login(interaction) { mark('provider:login'); if (process.env.PI_SYNTHETIC_LOGIN_ERROR) throw new Error('synthetic-private-provider-error'); mark('method:' + await interaction.prompt({ type: 'select' })); return credential(); }, async refresh() { mark('provider:refresh'); return credential(); } };\n`);
  await save('fetch.mjs', `${marker}\nglobalThis.fetch = async () => { mark('provider:usage'); return { ok: true, json: async () => ({ access_token: 'synthetic-private-response', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 42, reset_at: 2000000000 } } }) }; };\n`);
  const env = { ...process.env, PI_PACKAGE_DIR: sdk, PI_CODING_AGENT_DIR: home, PI_AUDIT_TRACE: trace };
  const run = (args, extra = {}) => spawnSync(process.execPath, ['--import', join(sdk, 'fetch.mjs'), cli, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const calls = async () => { try { return await readFile(trace, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
  return { root, sdk, home, trace, env, run, calls };
}

for (const [name, args, success] of [
  ['invalid login label', ['login', 'person@example.com'], false],
  ['refresh help', ['refresh', '--help'], true],
  ['refresh extra argument', ['refresh', 'unexpected'], false],
]) {
  test(`audit regression: ${name} has no SDK, storage or provider effects`, async t => {
    const f = await fixture(t);
    const result = f.run(args);
    assert.equal(result.status === 0, success, result.stderr);
    assert.equal(await f.calls(), '');
    assert.deepEqual((await readdir(f.root)).sort(), ['fake-pi']);
  });
}

test('help and invalid syntax never initialize the SDK, storage or OAuth', async t => {
  const f = await fixture(t);
  const help = [[], ['help'], ['--help'], ['-h'], ['help', 'refresh'], ['login', 'personal', '--device', '--help'], ['refresh', '--json', '--help'], ['rename', 'personal', 'work', '--help'], ...['login', 'add', 'select', 'rename', 'list', 'status', 'usage', 'refresh'].flatMap(command => [[command, '--help'], [command, '-h']])];
  for (const args of help) {
    const result = f.run(args);
    assert.equal(result.status, 0, `${args}: ${result.stderr}`);
    assert.match(result.stdout, /pi-accounts/);
    assert.equal(result.stderr, '');
  }
  const invalid = [
    ['login', 'person@example.com'], ['login', 'person@example.com', '--help'], ['add', 'person@example.com'], ['login'], ['select'], ['select', 'person@example.com'], ['usage', 'person@example.com'],
    ['refresh', 'unexpected'], ['status', 'unexpected'], ['list', 'unexpected'], ['usage', 'a', 'b'], ['login', 'a', 'b'], ['select', 'a', 'b'],
    ['login', 'a', '--unknown'], ['login', 'a', '--device', '--device'], ['refresh', '--device'], ['status', '--device'], ['select', 'a', '--json'], ['login', 'a', '--json'],
    ['refresh', '--json', '--json'], ['help', 'unknown'], ['unknown'], ['--help', 'unexpected'], ['refresh', 'unexpected', '--help'], ['login', 'a'.repeat(65)], ['login', '-a'], ['rename'], ['rename', 'a'], ['rename', 'a', 'b', 'c'], ['rename', 'a', 'email@example.test'], ['rename', 'email@example.test', 'a'], ['rename', 'a', 'b', '--json'], ['rename', 'a', 'b', '--device'],
  ];
  for (const args of invalid) {
    const result = f.run(args);
    assert.notEqual(result.status, 0, `accepted invalid args: ${args}`);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.length > 0);
  }
  assert.equal(await f.calls(), '');
  assert.deepEqual((await readdir(f.root)).sort(), ['fake-pi']);
});

test('short-label login keeps browser default, device stays optional, and human status differs from JSON', async t => {
  const f = await fixture(t);
  const access = jwt({ 'https://api.openai.com/profile': { email: 'person@example.test' } });
  let result = f.run(['login', 'personal'], { PI_SYNTHETIC_ACCESS: access });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved personal/);
  assert.match(await f.calls(), /method:browser/);
  result = f.run(['login', '--device', 'work'], { PI_SYNTHETIC_ID: 'second-workspace', PI_SYNTHETIC_ACCESS: access });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await f.calls(), /method:device_code/);
  result = f.run(['select', 'personal']);
  assert.equal(result.status, 0, result.stderr);
  result = f.run(['status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /personal/);
  assert.match(result.stdout, /person@example.test/);
  assert.match(result.stdout, /current/);
  assert.match(result.stdout, /local/i);
  assert.equal(result.stdout.includes(access), false);
  assert.equal(result.stdout.includes('synthetic-refresh'), false);
  result = f.run(['list', '--json']);
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(rows.map(row => row.label), ['personal', 'work']);
  assert.deepEqual(rows.map(row => row.selected), [true, false]);
  assert.equal(rows[0].email, 'person@example.test');
  assert.equal(rows[0].localHealth, 'current');
  assert.equal(rows[1].email, rows[0].email);
  assert.notEqual(rows[0].accountId, rows[1].accountId);
  result = f.run(['usage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /42% used/);
  assert.equal(result.stdout.includes('synthetic-private-response'), false);
  result = f.run(['usage', '--json']);
  assert.equal(JSON.parse(result.stdout).primary.usedPercent, 42);
  result = f.run(['refresh', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(row => row.status), ['current', 'current']);
});

test('CLI rename preserves active credentials and performs no provider operation', async t => {
  const f = await fixture(t);
  assert.equal(f.run(['login', 'personal']).status, 0);
  assert.equal(f.run(['select', 'personal']).status, 0);
  const authBefore = await readFile(join(f.home, 'auth.json'), 'utf8');
  await writeFile(f.trace, '');
  let result = f.run(['rename', 'personal', 'work']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Renamed personal to work/);
  assert.equal(await readFile(join(f.home, 'auth.json'), 'utf8'), authBefore);
  assert.equal((await f.calls()).includes('provider:'), false);
  const rows = JSON.parse(f.run(['status', '--json']).stdout);
  assert.equal(rows[0].label, 'work');
  assert.equal(rows[0].selected, true);
  result = f.run(['rename', 'work', 'work']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already named work/);
  assert.notEqual(f.run(['rename', 'missing', 'missing']).status, 0);
});

test('CLI errors provide recovery guidance without provider responses or corrupt store snippets', async t => {
  const f = await fixture(t);
  let result = f.run(['login', 'personal'], { PI_SYNTHETIC_LOGIN_ERROR: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pi login failed or cancelled/);
  assert.equal(result.stderr.includes('synthetic-private-provider-error'), false);
  await mkdir(f.home, { recursive: true });
  await writeFile(join(f.home, 'auth.json'), '{synthetic-private-corrupt-token');
  result = f.run(['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid credential store JSON/);
  assert.equal(result.stderr.includes('synthetic-private-corrupt-token'), false);
});

async function installedCli(root) {
  const directory = join(root, 'tool-prefix', 'lib', 'node_modules', 'pi-accounts', 'src');
  await mkdir(directory, { recursive: true });
  for (const name of ['accounts.mjs', 'cli.mjs', 'pi-sdk.mjs']) await copyFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), join(directory, name));
  return join(directory, 'cli.mjs');
}

for (const layout of ['nested', 'hoisted']) {
  test(`relocated CLI discovers Pi through npm PATH symlink with ${layout} pi-ai dependency`, async t => {
    const f = await fixture(t);
    const command = await installedCli(f.root);
    const prefix = join(f.root, 'pi-prefix');
    const piPackage = join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
    await cp(f.sdk, piPackage, { recursive: true });
    if (layout === 'hoisted') await rename(join(piPackage, 'node_modules', '@earendil-works', 'pi-ai'), join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-ai'));
    await writeFile(join(piPackage, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
    await chmod(join(piPackage, 'dist', 'cli.js'), 0o755);
    const bin = join(prefix, 'bin');
    await mkdir(bin);
    await symlink('../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', join(bin, 'pi'));
    const blocked = join(f.root, 'nonexecutable-bin');
    await mkdir(blocked);
    await writeFile(join(blocked, 'pi'), 'not executable', { mode: 0o600 });
    const env = { ...f.env, HOME: join(f.root, 'isolated-home'), PI_PACKAGE_DIR: '', PATH: `${blocked}${delimiter}${bin}` };
    let result = spawnSync(process.execPath, [command, 'status', '--json'], { cwd: f.root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.match(await f.calls(), /sdk:oauth/);
    // A package override works even when PATH cannot find any Pi executable.
    result = spawnSync(process.execPath, [command, 'status', '--json'], { cwd: f.root, env: { ...env, PATH: '', PI_PACKAGE_DIR: piPackage }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });
}

async function managedFixture(f, command) {
  const agent = join(f.root, 'custom-managed-home');
  const root = join(agent, 'install');
  const packageDir = join(root, 'releases', '1.3.0', 'node_modules', '@earendil-works', 'pi-coding-agent');
  await cp(f.sdk, packageDir, { recursive: true });
  await writeFile(join(packageDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await chmod(join(packageDir, 'dist', 'cli.js'), 0o755);
  const releaseBin = join(root, 'releases', '1.3.0', 'node_modules', '.bin');
  await mkdir(releaseBin);
  await symlink('../@earendil-works/pi-coding-agent/dist/cli.js', join(releaseBin, 'pi'));
  await writeFile(join(root, 'managed-install.json'), JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: '/unused/stale-entrypoint' } }));
  await writeFile(join(root, 'current-version'), '1.3.0\n');
  const launcher = join(agent, 'bin', 'pi');
  await mkdir(join(agent, 'bin'));
  // Synthetic official managed layout; SDK discovery must not execute this launcher.
  await writeFile(launcher, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const bin = join(f.root, 'path-bin');
  await mkdir(bin);
  await symlink(launcher, join(bin, 'pi'));
  const env = { ...f.env, HOME: join(f.root, 'isolated-home'), PATH: bin, PI_PACKAGE_DIR: '', PI_MANAGED_INSTALL_ROOT: '/unused/ambient-root' };
  const run = (args, extra = {}) => spawnSync(process.execPath, [command, ...args], { cwd: f.root, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, packageDir, launcher, bin, run };
}

test('official managed PATH launcher resolves its active native package without a global npm Pi or override', async t => {
  const f = await fixture(t);
  const command = await installedCli(f.root);
  const managed = await managedFixture(f, command);
  let result = managed.run(['status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.match(await f.calls(), /sdk:auth/);
  result = managed.run(['refresh', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.equal((await f.calls()).includes('provider:'), false);
});

test('managed discovery follows current-version updates and rejects an incompatible active release before SDK imports', async t => {
  const f = await fixture(t);
  const command = await installedCli(f.root);
  const managed = await managedFixture(f, command);
  const newer = join(managed.root, 'releases', '1.4.0');
  await cp(join(managed.root, 'releases', '1.3.0'), newer, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(newer, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), '{"name":"@earendil-works/pi-coding-agent","version":"1.4.0","type":"module"}');
  await writeFile(join(managed.root, 'current-version'), '1.4.0\n');
  const result = managed.run(['status', '--json']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed Pi 1.3.0; found 1.4.0/);
  assert.equal(await f.calls(), '');
});

test('managed descriptor failures do not skip to another npm Pi or access account stores', async t => {
  const f = await fixture(t);
  const command = await installedCli(f.root);
  const managed = await managedFixture(f, command);
  await writeFile(join(f.sdk, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  await chmod(join(f.sdk, 'dist', 'cli.js'), 0o755);
  const npmBin = join(f.root, 'fallback-npm-bin');
  await mkdir(npmBin);
  await symlink(join(f.sdk, 'dist', 'cli.js'), join(npmBin, 'pi'));
  const path = `${managed.bin}${delimiter}${npmBin}`;
  for (const version of ['', '.', '..', '../1.3.0', '1.3.0/extra', '1.3.0\r', ' 1.3.0', '1.3.0 ', 'missing']) {
    await writeFile(join(managed.root, 'current-version'), version + '\n');
    const result = managed.run(['status'], { PATH: path });
    assert.notEqual(result.status, 0, version);
    assert.match(result.stderr, /managed Pi|Managed Pi/);
    assert.equal(await f.calls(), '');
  }
  await writeFile(join(managed.root, 'managed-install.json'), '{"kind":"foreign","schemaVersion":1,"layout":"releases-v1"}');
  const result = managed.run(['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid managed Pi installation marker/);
  assert.equal(await f.calls(), '');
});

test('managed marker beside the PATH command is supported without trusting marker entrypoint metadata', async t => {
  const f = await fixture(t);
  const command = await installedCli(f.root);
  const managed = await managedFixture(f, command);
  await copyFile(join(managed.launcher), join(managed.root, 'pi'));
  await chmod(join(managed.root, 'pi'), 0o755);
  const result = managed.run(['status', '--json'], { PATH: managed.root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('explicit SDK discovery options override ambient package settings and reject ambiguous roots', async t => {
  const f = await fixture(t);
  const command = await installedCli(f.root);
  const managed = await managedFixture(f, command);
  const sdkModule = new URL('../src/pi-sdk.mjs', import.meta.url).href;
  const probe = `import { loadPi } from ${JSON.stringify(sdkModule)};
const sdk = await loadPi(JSON.parse(process.argv[1]));
console.log(JSON.stringify({ root: sdk.root, managedInstallRoot: sdk.managedInstallRoot }));`;
  const run = options => spawnSync(process.execPath, ['--input-type=module', '-e', probe, JSON.stringify(options)], { env: { ...f.env, PI_PACKAGE_DIR: '/unused/ambient-package', PATH: '', PI_MANAGED_INSTALL_ROOT: '/unused/ambient-managed' }, encoding: 'utf8' });
  let result = run({ managedInstallRoot: managed.root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { root: managed.packageDir, managedInstallRoot: managed.root });
  result = run({ packageDir: f.sdk });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { root: f.sdk });
  await writeFile(f.trace, '');
  for (const options of [{ managedInstallRoot: managed.root, packageDir: f.sdk }, { managedInstallRoot: '' }, { packageDir: null }, { managedInstallRoot: join(f.root, 'missing-managed') }]) {
    result = run(options);
    assert.notEqual(result.status, 0);
    assert.equal(await f.calls(), '');
  }
});

test('incompatible Pi dependencies and an unsupported PATH wrapper fail before SDK imports', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sdk, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), '{"name":"@earendil-works/pi-ai","version":"1.4.0","type":"module"}');
  let result = f.run(['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed pi-ai 1.3.0/);
  assert.equal(await f.calls(), '');
  await writeFile(join(f.sdk, 'package.json'), '{"name":"@earendil-works/pi-coding-agent","version":"1.4.0","type":"module"}');
  result = f.run(['status']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed Pi 1.3.0/);
  assert.equal(await f.calls(), '');
  const bin = join(f.root, 'wrapper-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  result = f.run(['status'], { PATH: bin, PI_PACKAGE_DIR: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /set PI_PACKAGE_DIR/);
  assert.equal(await f.calls(), '');
});

test('Node requirement matches Pi minimum without weakening help or prevalidation', () => {
  for (const version of ['22.19.0', '22.23.2', '24.0.0']) assert.doesNotThrow(() => assertSupportedNode(version));
  for (const version of ['21.99.0', '22.18.9', '20.0.0', 'invalid']) assert.throws(() => assertSupportedNode(version), /Node.js >=22.19.0/);
});

test('maintenance dispatch is lazy and preserves arguments and the module exit code', async t => {
  const f = await fixture(t);
  const command = await installedCli(f.root);
  await writeFile(join(command, '..', 'maintenance.mjs'), `import { appendFileSync } from 'node:fs';\nconst mark = text => appendFileSync(process.env.PI_AUDIT_TRACE, text + '\\n');\nmark('maintenance:loaded');\nexport async function runMaintenance(argv) { mark('maintenance:args:' + JSON.stringify(argv)); if (argv.includes('--help')) { console.log('synthetic maintenance help'); return 0; } return 7; }\n`);
  const run = args => spawnSync(process.execPath, [command, ...args], { env: f.env, encoding: 'utf8' });
  for (const args of [[], ['--help'], ['help', 'maintenance'], ['login', 'email@example.test'], ['refresh', 'unexpected']]) {
    const result = run(args);
    assert.equal(result.status, ['login', 'refresh'].includes(args[0]) ? 1 : 0, result.stderr);
  }
  assert.equal(await f.calls(), '');
  let result = run(['maintenance', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic maintenance help/);
  result = run(['maintenance', 'run', '--json']);
  assert.equal(result.status, 7, result.stderr);
  assert.match(await f.calls(), /maintenance:args:\["run","--json"\]/);
  assert.equal((await f.calls()).includes('sdk:'), false);
  assert.equal((await f.calls()).includes('provider:'), false);
});
