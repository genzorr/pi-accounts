import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectMaintenance, runMaintenance } from '../src/maintenance.mjs';

const supportedTest = ['linux', 'darwin'].includes(process.platform) ? test : test.skip;

function fixture(t, platform = 'linux') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pi-maintenance ')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls = [], messages = [], errors = [];
  let loaded = false;
  const runtime = { node: '/node path/node', cli: '/npm path/pi-accounts/src/cli.mjs', piPackageDir: '/Pi package', agentDir: join(home, 'agent data') };
  const options = { home, platform, runtime, loadPi: async descriptor => ({ root: descriptor?.packageDir || '/managed active package' }), uid: 501, log: line => messages.push(line), error: line => errors.push(line), run: (command, args) => {
    calls.push([command, ...args]);
    if (command === 'launchctl') {
      if (args[0] === 'print') return { code: loaded ? 0 : 113, stdout: loaded ? 'state = waiting\n' : '', stderr: '' };
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
    }
    return { code: 0, stdout: 'ActiveState=inactive\nResult=success\nExecMainStatus=0\n', stderr: '' };
  } };
  const dir = platform === 'linux' ? join(home, '.local/state/pi-accounts-maintenance') : join(home, 'Library/Application Support/pi-accounts/maintenance');
  const unitDir = platform === 'linux' ? join(home, '.config/systemd/user') : join(home, 'Library/LaunchAgents');
  return { home, options, runtime, dir, unitDir, calls, messages, errors, exec: args => runMaintenance(args, options) };
}

supportedTest('help and invalid syntax have no runtime, storage or native-command effects', async t => {
  const f = fixture(t);
  for (const args of [[], ['help'], ['--help'], ['install', '--help']]) assert.equal(await f.exec(args), 0);
  for (const args of [['wat'], ['install', '--force'], ['enable', '--dry-run'], ['run', 'extra'], ['install', '--dry-run', '--dry-run']]) assert.equal(await f.exec(args), 1);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.calls, []);
});

for (const platform of ['linux', 'darwin']) supportedTest(`${platform} preview/install/reinstall/enable/disable/uninstall preserves accounts and supports reinstall`, async t => {
  const f = fixture(t, platform);
  const authDir = join(f.home, 'agent data/accounts');
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, 'pool.json'), '{"synthetic":"preserve"}');
  assert.equal(await f.exec(['install', '--dry-run']), 0);
  assert.equal(existsSync(f.dir), false);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.exec(['install']), 0, f.errors.join('\n'));
  const first = readdirSync(f.unitDir).map(name => [name, readFileSync(join(f.unitDir, name), 'utf8')]);
  assert.equal(await f.exec(['install']), 0);
  assert.deepEqual(readdirSync(f.unitDir).map(name => [name, readFileSync(join(f.unitDir, name), 'utf8')]), first);
  assert.equal(await f.exec(['enable']), 0, f.errors.join('\n'));
  assert.equal(await f.exec(['status']), 0);
  assert.equal(await f.exec(['install']), 1, 'enabled maintenance must be paused before source changes');
  assert.equal(await f.exec(['disable']), 0, f.errors.join('\n'));
  const before = f.calls.length;
  assert.equal(await f.exec(['uninstall', '--dry-run']), 0);
  assert.equal(f.calls.length, before);
  assert.equal(await f.exec(['uninstall']), 0, f.errors.join('\n'));
  assert.deepEqual(readdirSync(f.unitDir), []);
  assert.equal(readFileSync(join(authDir, 'pool.json'), 'utf8'), '{"synthetic":"preserve"}');
  assert.equal(await f.exec(['run']), 0);
  assert.equal(await f.exec(['install']), 0, 'retained pause/ownership tombstone must permit reinstall');
  assert.equal(f.calls.some(call => call.includes('kill') || call.includes('stop')), false);
  if (platform === 'linux') {
    const text = first.find(([name]) => name.endsWith('.service'))[1];
    assert.match(text, /ExecStart="\/node path\/node" "\/npm path\/pi-accounts\/src\/cli.mjs" "maintenance" "run"/);
    assert.match(first.find(([name]) => name.endsWith('.timer'))[1], /OnUnitActiveSec=1h/);
  } else {
    const text = first[0][1];
    assert.match(text, /<key>StartInterval<\/key><integer>3600<\/integer>/);
    assert.match(text, /<string>\/node path\/node<\/string>/);
  }
});

supportedTest('foreign and modified unit files are preserved before native effects', async t => {
  const f = fixture(t);
  mkdirSync(f.unitDir, { recursive: true });
  const path = join(f.unitDir, 'pi-accounts-maintenance.service');
  writeFileSync(path, 'foreign');
  assert.equal(await f.exec(['install']), 1);
  assert.equal(readFileSync(path, 'utf8'), 'foreign');
  assert.equal(existsSync(f.dir), false);
  assert.deepEqual(f.calls, []);
  rmSync(path);
  assert.equal(await f.exec(['install']), 0);
  writeFileSync(path, 'modified');
  assert.equal(await f.exec(['uninstall']), 1);
  assert.equal(readFileSync(path, 'utf8'), 'modified');
  assert.deepEqual(f.calls, []);
});

supportedTest('legacy Agents units are neither adopted nor overwritten', async t => {
  const f = fixture(t);
  mkdirSync(f.unitDir, { recursive: true });
  writeFileSync(join(f.unitDir, 'pi-accounts-refresh.service'), 'legacy service');
  writeFileSync(join(f.unitDir, 'pi-accounts-refresh.timer'), 'legacy timer');
  assert.equal(await f.exec(['install']), 0);
  assert.equal(await f.exec(['uninstall']), 0);
  assert.equal(readFileSync(join(f.unitDir, 'pi-accounts-refresh.service'), 'utf8'), 'legacy service');
  assert.equal(readFileSync(join(f.unitDir, 'pi-accounts-refresh.timer'), 'utf8'), 'legacy timer');
});

supportedTest('pause acquired between runner lock and refresh prevents refresh and unload', async t => {
  const f = fixture(t, 'darwin');
  assert.equal(await f.exec(['install']), 0);
  assert.equal(await f.exec(['enable']), 0);
  let refreshed = false;
  f.options.refresh = async () => { refreshed = true; return 0; };
  f.options.afterLock = async () => {
    assert.equal(await f.exec(['disable']), 1, 'running marker must prevent bootout');
    assert.equal(f.calls.some(call => call[1] === 'bootout'), false);
  };
  assert.equal(await f.exec(['run']), 0);
  assert.equal(refreshed, false, 'pause must be rechecked under the acquired marker');
  assert.equal(await f.exec(['disable']), 0);
  assert.equal(f.calls.some(call => call[1] === 'bootout'), true);
});

supportedTest('active runner is never unloaded and duplicate scheduled run cannot refresh', async t => {
  const f = fixture(t, 'darwin');
  await f.exec(['install']); await f.exec(['enable']);
  let finish;
  f.options.refresh = () => new Promise(done => { finish = done; });
  const active = f.exec(['run']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.exec(['run']), 1);
  assert.equal(await f.exec(['uninstall']), 1);
  assert.equal(f.calls.some(call => call[1] === 'bootout'), false);
  finish(0);
  assert.equal(await active, 0);
  assert.equal(await f.exec(['uninstall']), 0);
});

supportedTest('installed runtime roots retained by scheduled runner and refresh exit is propagated', async t => {
  const f = fixture(t);
  await f.exec(['install']); await f.exec(['enable']);
  f.options.refresh = async runtime => {
    assert.deepEqual(runtime, f.runtime);
    assert.equal(existsSync(join(f.dir, 'running/pid')), true);
    return 1;
  };
  assert.equal(await f.exec(['run']), 1);
  assert.equal(existsSync(join(f.dir, 'running')), false);
});

supportedTest('symlinked units and invalid ownership state fail closed', async t => {
  const f = fixture(t);
  mkdirSync(f.unitDir, { recursive: true });
  const outside = join(f.home, 'foreign');
  writeFileSync(outside, 'foreign');
  symlinkSync(outside, join(f.unitDir, 'pi-accounts-maintenance.service'));
  assert.equal(await f.exec(['install']), 1);
  assert.equal(readFileSync(outside, 'utf8'), 'foreign');
  rmSync(join(f.unitDir, 'pi-accounts-maintenance.service'));
  await f.exec(['install']);
  const state = JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8'));
  state.files['foreign.service'] = ['600:' + 'a'.repeat(64)];
  writeFileSync(join(f.dir, 'state.json'), JSON.stringify(state));
  assert.equal(await f.exec(['uninstall']), 1);
  assert.deepEqual(f.calls, []);
});

supportedTest('enable failure re-pauses and stale runner markers require explicit inspection', async t => {
  const f = fixture(t);
  await f.exec(['install']);
  f.options.run = () => ({ code: 1, stdout: '', stderr: 'synthetic private error, never print' });
  assert.equal(await f.exec(['enable']), 1);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
  assert.equal(f.errors.some(message => message.includes('synthetic private error')), false);
  mkdirSync(join(f.dir, 'running'));
  writeFileSync(join(f.dir, 'running/pid'), '999999');
  assert.equal(await f.exec(['install']), 1);
  assert.equal(existsSync(join(f.dir, 'running/pid')), true);
});


supportedTest('managed install capture and status retain stable root with strict optional path validation', async t => {
  const f = fixture(t);
  delete f.options.runtime;
  f.options.loadPi = async descriptor => {
    assert.equal(descriptor, undefined);
    return { root: '/managed/install/releases/1.3.0/node_modules/pi', managedInstallRoot: '/managed/install', resolvePath: value => join(f.home, value) };
  };
  assert.equal(await f.exec(['install']), 0, f.errors.join('\n'));
  const statePath = join(f.dir, 'state.json');
  const state = JSON.parse(readFileSync(statePath));
  assert.equal(state.runtime.managedInstallRoot, '/managed/install');
  assert.equal(state.runtime.piPackageDir, '/managed/install/releases/1.3.0/node_modules/pi');
  assert.equal(await f.exec(['status']), 0);
  assert.ok(f.messages.some(message => message.includes('Pi source: managed /managed/install')));
  state.runtime.managedInstallRoot = 'relative/install';
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal(await f.exec(['run']), 1);
});

supportedTest('managed scheduled refresh rechecks active source and never falls back to retained release or ambient override', async t => {
  const f = fixture(t);
  f.options.runtime = { ...f.runtime, managedInstallRoot: '/managed/install' };
  assert.equal(await f.exec(['install']), 0);
  assert.equal(await f.exec(['enable']), 0);
  let active = '/managed/install/releases/current/node_modules/pi';
  let supported = true;
  let refreshes = 0;
  f.options.loadPi = async descriptor => {
    assert.deepEqual(descriptor, { managedInstallRoot: '/managed/install' });
    if (!supported) throw new Error('unsupported active version; retained reviewed release still exists');
    return { root: active };
  };
  f.options.refresh = async runtime => { refreshes++; assert.equal(runtime.piPackageDir, active); return 0; };
  const original = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = '/wrong/ambient/package';
  try {
    assert.equal(await f.exec(['run']), 0);
    active = '/managed/install/releases/switched/node_modules/pi';
    assert.equal(await f.exec(['run']), 0);
    supported = false;
    assert.equal(await f.exec(['run']), 1);
    assert.equal(refreshes, 2, 'unsupported active release must stop before spawning refresh');
    assert.equal(existsSync(join(f.dir, 'running')), false);
  } finally {
    if (original === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = original;
  }
});

supportedTest('legacy four-field maintenance state remains fixed-package intent and fails before refresh on SDK error', async t => {
  const f = fixture(t);
  await f.exec(['install']); await f.exec(['enable']);
  let refreshes = 0;
  f.options.loadPi = async descriptor => {
    assert.deepEqual(descriptor, { packageDir: f.runtime.piPackageDir });
    throw new Error('captured package unavailable');
  };
  f.options.refresh = async () => { refreshes++; return 0; };
  assert.equal(await f.exec(['run']), 1);
  assert.equal(refreshes, 0);
  assert.equal(await f.exec(['status']), 0);
  assert.ok(f.messages.some(message => message.includes('Pi source: fixed package')));
});

supportedTest('structured inspection validates ownership without SDK or native status calls', async t => {
  const f = fixture(t);
  let snapshot = await inspectMaintenance(f.options);
  assert.equal(snapshot.state, null);
  assert.equal(snapshot.paused, false);
  assert.equal(snapshot.running, false);
  assert.deepEqual(f.calls, []);
  await f.exec(['install']);
  snapshot = await inspectMaintenance({ ...f.options, loadPi: () => { throw new Error('SDK must remain unloaded'); } });
  assert.equal(snapshot.state.installed, true);
  assert.deepEqual(snapshot.state.runtime, f.runtime);
  assert.equal(snapshot.paused, true);
  assert.deepEqual(f.calls, []);
  writeFileSync(join(f.unitDir, 'pi-accounts-maintenance.service'), 'foreign');
  await assert.rejects(inspectMaintenance(f.options), /Foreign or modified/);
  assert.deepEqual(f.calls, []);
});

for (const platform of ['linux', 'darwin']) for (const managed of [false, true]) for (const tombstone of [false, true]) supportedTest(`${platform} reuse-runtime retains ${managed ? 'managed' : 'fixed'} custom identity from ${tombstone ? 'uninstalled' : 'installed'} state despite broken discovery`, async t => {
  const f = fixture(t, platform);
  const retained = { ...f.runtime, ...(managed ? { managedInstallRoot: join(f.home, 'custom managed root') } : {}) };
  f.options.runtime = retained;
  assert.equal(await f.exec(['install']), 0);
  if (tombstone) assert.equal(await f.exec(['uninstall']), 0);
  const currentState = readFileSync(join(f.dir, 'state.json'));
  const previousCalls = f.calls.length;
  let discoveries = 0;
  f.options.runtime = { node: '/wrong-node', cli: '/wrong-cli', piPackageDir: '/wrong-pi', agentDir: '/wrong-agent' };
  f.options.loadPi = () => { discoveries++; throw new Error('synthetic current SDK unavailable; private details'); };
  assert.equal(await f.exec(['install', '--reuse-runtime', '--dry-run']), 0, f.errors.join('\n'));
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), currentState);
  assert.equal(f.calls.length, previousCalls);
  assert.equal(await f.exec(['install', '--reuse-runtime']), 0, f.errors.join('\n'));
  const installed = JSON.parse(readFileSync(join(f.dir, 'state.json')));
  assert.deepEqual(installed.runtime, retained);
  assert.equal(installed.installed, true);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
  assert.equal(discoveries, 0);
  for (const name of readdirSync(f.unitDir)) {
    const contents = readFileSync(join(f.unitDir, name), 'utf8');
    assert.equal(contents.includes('/wrong-'), false);
    if (!name.endsWith('.timer')) assert.equal(contents.includes(retained.cli), true);
  }
});

supportedTest('reuse-runtime requires validated retained ownership and rejects invalid flags without discovery or native effects', async t => {
  const f = fixture(t);
  let discoveries = 0;
  delete f.options.runtime;
  f.options.loadPi = () => { discoveries++; throw new Error('must not discover'); };
  for (const args of [['install', '--reuse-runtime'], ['install', '--reuse-runtime', '--reuse-runtime'], ['enable', '--reuse-runtime'], ['uninstall', '--reuse-runtime'], ['install', '--reuse-runtime', '--help']]) assert.equal(await f.exec(args), 1);
  assert.equal(discoveries, 0);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.calls, []);
  f.options.runtime = f.runtime;
  assert.equal(await f.exec(['install']), 0);
  const statePath = join(f.dir, 'state.json');
  const invalid = JSON.parse(readFileSync(statePath)); invalid.runtime.agentDir = 'relative-private-location';
  writeFileSync(statePath, JSON.stringify(invalid));
  const before = readFileSync(statePath);
  assert.equal(await f.exec(['install', '--reuse-runtime']), 1);
  assert.deepEqual(readFileSync(statePath), before);
  assert.equal(discoveries, 0);
  assert.deepEqual(f.calls, []);
});

supportedTest('normal install intentionally rediscovers current runtime after retained installation', async t => {
  const f = fixture(t);
  assert.equal(await f.exec(['install']), 0);
  delete f.options.runtime;
  let discoveries = 0;
  f.options.loadPi = async () => { discoveries++; return { root: '/new fixed Pi', resolvePath: () => join(f.home, 'new agent') }; };
  assert.equal(await f.exec(['install']), 0, f.errors.join('\n'));
  const state = JSON.parse(readFileSync(join(f.dir, 'state.json')));
  assert.equal(discoveries, 1);
  assert.equal(state.runtime.piPackageDir, '/new fixed Pi');
  assert.equal(state.runtime.agentDir, join(f.home, 'new agent'));
  assert.equal(existsSync(join(f.dir, 'paused')), true);
});

supportedTest('public reuse-runtime install preserves the custom tombstone identity with broken current Pi and a different shell agent home', async t => {
  const f = fixture(t, process.platform);
  f.options.runtime = { ...f.runtime, managedInstallRoot: join(f.home, 'custom managed Pi') };
  await f.exec(['install']); await f.exec(['uninstall']);
  const retained = JSON.parse(readFileSync(join(f.dir, 'state.json'))).runtime;
  const wrongHome = join(f.home, 'wrong shell agent');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'maintenance', 'install', '--reuse-runtime'], { encoding: 'utf8', env: { ...process.env, HOME: f.home, PI_PACKAGE_DIR: join(f.home, 'broken current Pi'), PI_CODING_AGENT_DIR: wrongHome } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'state.json'))).runtime, retained);
  assert.equal(existsSync(join(f.dir, 'paused')), true);
  assert.equal(existsSync(wrongHome), false);
});
