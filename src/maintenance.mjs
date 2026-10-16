import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const owner = 'pi-accounts-maintenance-v1';
const label = 'io.github.genzorr.pi-accounts';
const service = 'pi-accounts-maintenance.service';
const timer = 'pi-accounts-maintenance.timer';
const help = `pi-accounts maintenance install [--dry-run]  Install hourly user-service files, initially paused
pi-accounts maintenance enable             Enable hourly refresh
pi-accounts maintenance status             Inspect installation, pause and running state
pi-accounts maintenance disable            Pause scheduling without killing an active refresh
pi-accounts maintenance uninstall [--dry-run] Remove unchanged owned service files; preserve accounts

Linux uses systemd --user; macOS uses a user LaunchAgent. No sudo is needed.
Install Pi 1.3.0 separately. PI_PACKAGE_DIR and PI_CODING_AGENT_DIR are retained at install.
Before npm update/uninstall: disable maintenance, wait for any running refresh, then uninstall maintenance.`;

function fail(message) { throw new Error(message); }
function parse(argv) {
  const [command = 'help', ...flags] = argv;
  if ((['help', '--help', '-h'].includes(command) && !flags.length) || (['install', 'enable', 'status', 'disable', 'uninstall', 'run'].includes(command) && flags.length === 1 && ['--help', '-h'].includes(flags[0]))) return { command: 'help' };
  if (!['install', 'enable', 'status', 'disable', 'uninstall', 'run'].includes(command) || flags.length > 1 || (flags.length && (!['install', 'uninstall'].includes(command) || flags[0] !== '--dry-run'))) fail('Invalid maintenance command or option; run pi-accounts maintenance help');
  return { command, dryRun: flags[0] === '--dry-run' };
}
function regular(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) fail(`Maintenance path is not a regular file: ${path}`);
    return { data: readFileSync(path), mode: info.mode & 0o777 };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function safe(path) {
  for (let current = path; ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) fail(`Maintenance path contains a symlink: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) return path;
  }
}
function signature(value) { return value ? `${value.mode.toString(8)}:${createHash('sha256').update(value.data).digest('hex')}` : null; }
function atomic(path, data, mode = 0o600) {
  safe(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, data, { mode, flag: 'wx' }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function quote(value) {
  if (/[\x00-\x1f\x7f]/.test(value)) fail('Maintenance paths cannot contain control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
}
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function render(platform, home, runtime) {
  const args = [runtime.node, runtime.cli, 'maintenance', 'run'];
  if (platform === 'linux') return {
    [service]: `[Unit]\nDescription=Maintain saved Pi accounts without changing selection\n\n[Service]\nType=oneshot\nExecStart=${args.map(quote).join(' ')}\nEnvironment=${quote(`HOME=${home}`).replaceAll('$$', '$')}\nUMask=0077\n`,
    [timer]: `[Unit]\nDescription=Hourly Pi account maintenance\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=1h\nRandomizedDelaySec=2min\nUnit=${service}\n\n[Install]\nWantedBy=timers.target\n`,
  };
  const logs = join(home, 'Library/Logs/pi-accounts');
  return { [`${label}.plist`]: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string></dict>\n<key>StartInterval</key><integer>3600</integer>\n<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xml(join(logs, 'maintenance.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(logs, 'maintenance.error.log'))}</string>\n</dict></plist>\n` };
}
function native(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  if (result.error) fail(`Cannot run ${command}; check the user service manager`);
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function checked(run, command, args) {
  const result = run(command, args);
  if (result.code !== 0) fail(`${command} ${args.join(' ')} failed; inspect the dedicated user service`);
  return result;
}
function refresh(runtime) {
  return new Promise((done, reject) => {
    const child = spawn(runtime.node, [runtime.cli, 'refresh', '--json'], { stdio: 'inherit', env: { ...process.env, PI_PACKAGE_DIR: runtime.piPackageDir, PI_CODING_AGENT_DIR: runtime.agentDir } });
    child.once('error', reject);
    child.once('exit', code => done(code ?? 1));
  });
}

export async function runMaintenance(argv, options = {}) {
  const log = options.log || console.log;
  try {
    const { command, dryRun } = parse(argv);
    if (command === 'help') { log(help); return 0; }
    const platform = options.platform || process.platform;
    if (!['linux', 'darwin'].includes(platform)) fail('Maintenance supports Linux and macOS only');
    const home = resolve(options.home || homedir());
    if (/[\x00-\x1f\x7f]/.test(home)) fail('Maintenance paths cannot contain control characters');
    const dir = platform === 'darwin' ? join(home, 'Library/Application Support/pi-accounts/maintenance') : join(home, '.local/state/pi-accounts-maintenance');
    const statePath = safe(join(dir, 'state.json'));
    const paused = safe(join(dir, 'paused'));
    const running = safe(join(dir, 'running'));
    const unitDir = platform === 'darwin' ? join(home, 'Library/LaunchAgents') : join(home, '.config/systemd/user');
    const names = platform === 'darwin' ? [`${label}.plist`] : [service, timer];
    const run = options.run || native;
    const domain = `gui/${options.uid ?? process.getuid()}`;
    const target = `${domain}/${label}`;
    const raw = regular(statePath);
    let state = raw ? JSON.parse(raw.data) : null;
    if (state) {
      if (typeof state.installed !== 'boolean' || state.owner !== owner || state.platform !== platform || state.home !== home || !state.files || Object.keys(state.files).some(name => !names.includes(name)) || names.some(name => !Array.isArray(state.files[name]) || !state.files[name].length || state.files[name].some(sig => typeof sig !== 'string' || !/^[0-7]{3}:[a-f0-9]{64}$/.test(sig)))) fail('Invalid or foreign maintenance ownership state');
      if (!state.runtime || Object.keys(state.runtime).sort().join(',') !== 'agentDir,cli,node,piPackageDir' || Object.values(state.runtime).some(value => typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))) fail('Invalid maintenance runtime paths');
    }
    const readUnits = () => Object.fromEntries(names.map(name => [name, regular(safe(join(unitDir, name)))]));
    const owned = () => {
      const current = readUnits();
      for (const name of names) if (current[name] && (!state || !state.files[name].includes(signature(current[name])))) fail(`Foreign or modified maintenance file preserved: ${join(unitDir, name)}`);
      return current;
    };
    const idle = () => {
      if (existsSync(running)) fail(`Maintenance refresh may still be running; wait and retry. If interrupted, inspect ${join(running, 'pid')} privately and verify the process is gone before removing only that stale running directory`);
    };
    const unload = () => {
      atomic(paused, 'paused\n');
      if (platform === 'linux') checked(run, 'systemctl', ['--user', 'disable', '--now', timer]);
      else checked(run, 'launchctl', ['disable', target]);
      idle();
      if (platform === 'darwin') {
        const loaded = run('launchctl', ['print', target]);
        if (loaded.code === 0) {
          if (/\bpid\s*=\s*[1-9][0-9]*/.test(loaded.stdout)) fail('LaunchAgent is still running; keep it paused and retry after it exits');
          checked(run, 'launchctl', ['bootout', target]);
        } else if (loaded.code !== 113 && !/could not find service/i.test(loaded.stderr)) fail('Cannot determine LaunchAgent state; inspect launchctl before retrying');
      }
    };
    if (command === 'status') {
      log(`Maintenance: ${state?.installed ? 'installed' : 'not installed'}; scheduling ${existsSync(paused) ? 'paused' : 'not paused'}; runner ${existsSync(running) ? 'active or stale marker (inspect before removal)' : 'idle'}`);
      if (state) {
        owned();
        const result = platform === 'linux' ? run('systemctl', ['--user', 'show', service, '--property=ActiveState', '--property=Result', '--property=ExecMainStatus']) : run('launchctl', ['print', target]);
        if (result.code === 0) {
          if (platform === 'linux') log(result.stdout.split('\n').filter(line => /^(ActiveState|Result|ExecMainStatus)=/.test(line)).join('\n'));
          else log(/\bpid\s*=\s*[1-9][0-9]*/.test(result.stdout) ? 'LaunchAgent running' : 'LaunchAgent loaded, idle');
        } else log('User job is not loaded or service manager is unavailable; inspect native service status');
      }
      return 0;
    }
    if (command === 'run') {
      if (!state?.installed || existsSync(paused)) return 0;
      owned();
      try { mkdirSync(running, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') { log('Maintenance already running or stale marker requires inspection'); return 1; } throw error; }
      try {
        writeFileSync(join(running, 'pid'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        if (options.afterLock) await options.afterLock();
        if (existsSync(paused)) return 0;
        return await (options.refresh || refresh)(state.runtime);
      } finally { rmSync(running, { recursive: true }); }
    }
    const current = owned();
    if (command === 'install') {
      let runtime = options.runtime;
      if (!runtime) {
        const { loadPi } = await import('./pi-sdk.mjs');
        const sdk = await loadPi();
        runtime = { node: realpathSync(process.execPath), cli: realpathSync(fileURLToPath(new URL('./cli.mjs', import.meta.url))), piPackageDir: sdk.root, agentDir: sdk.resolvePath(process.env.PI_CODING_AGENT_DIR || join(home, '.pi/agent')) };
      }
      runtime = Object.fromEntries(Object.entries(runtime).map(([key, value]) => [key, resolve(value)]));
      if (Object.keys(runtime).sort().join(',') !== 'agentDir,cli,node,piPackageDir' || Object.values(runtime).some(value => /[\x00-\x1f\x7f]/.test(value))) fail('Invalid maintenance runtime paths');
      const desired = render(platform, home, runtime);
      if (state?.installed && !existsSync(paused)) fail('Disable maintenance and wait for its runner before updating service files');
      idle();
      if (!state && (existsSync(paused) || existsSync(running))) fail('Unowned maintenance control files exist; preserve and inspect them');
      if (dryRun) { log(`Would install ${names.join(', ')}; initially paused; accounts unchanged`); return 0; }
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const files = Object.fromEntries(names.map(name => [name, [...new Set([signature(current[name]), signature({ data: Buffer.from(desired[name]), mode: 0o600 })].filter(Boolean))]]));
      state = { owner, platform, home, runtime, files, installed: false };
      atomic(statePath, JSON.stringify(state, null, 2) + '\n');
      atomic(paused, 'paused\n');
      for (const name of names) atomic(join(unitDir, name), desired[name]);
      state.files = Object.fromEntries(names.map(name => [name, [signature(regular(join(unitDir, name)))]]));
      state.installed = true;
      atomic(statePath, JSON.stringify(state, null, 2) + '\n');
      if (platform === 'darwin') mkdirSync(safe(join(home, 'Library/Logs/pi-accounts')), { recursive: true, mode: 0o700 });
      log('Maintenance files installed, paused. Run pi-accounts maintenance enable.');
      return 0;
    }
    if (!state) { if (command === 'uninstall' || command === 'disable') { log('No owned maintenance installation'); return 0; } fail('Install maintenance first'); }
    if (dryRun) { log('Would pause scheduling, require idle runner, and remove only unchanged owned units; private pause/ownership markers and accounts/logs stay'); return 0; }
    if (command === 'enable') {
      if (!state.installed) fail('Install maintenance first');
      idle();
      for (const name of names) if (!current[name]) fail('Maintenance unit is missing; rerun maintenance install');
      if (existsSync(paused)) unlinkSync(paused);
      try {
        if (platform === 'linux') {
          checked(run, 'systemctl', ['--user', 'daemon-reload']);
          checked(run, 'systemctl', ['--user', 'enable', '--now', timer]);
        } else {
          checked(run, 'launchctl', ['enable', target]);
          const loaded = run('launchctl', ['print', target]);
          if (loaded.code !== 0) checked(run, 'launchctl', ['bootstrap', domain, join(unitDir, names[0])]);
        }
      } catch (error) { atomic(paused, 'paused\n'); throw error; }
      log('Hourly maintenance enabled');
      return 0;
    }
    if (state.installed) unload();
    else { atomic(paused, 'paused\n'); idle(); }
    if (command === 'uninstall') {
      owned();
      for (const name of names) if (regular(join(unitDir, name))) unlinkSync(join(unitDir, name));
      state.installed = false;
      atomic(statePath, JSON.stringify(state, null, 2) + '\n');
      if (platform === 'linux') checked(run, 'systemctl', ['--user', 'daemon-reload']);
      // Retain pause marker: an already-starting old runner must not rotate after removal.
      log('Maintenance uninstalled; accounts and logs preserved. npm uninstall does not remove accounts.');
    } else log('Maintenance disabled; accounts preserved');
    return 0;
  } catch (error) {
    // Do not print native stderr, provider output, or arbitrary filesystem content.
    const message = /^(Invalid maintenance|Maintenance |Cannot |Foreign or modified|Disable maintenance|Unowned maintenance|Install maintenance|LaunchAgent )/.test(error.message) ? error.message : 'Maintenance operation failed; inspect dedicated service files, private ownership state and permissions';
    (options.error || console.error)(message);
    return 1;
  }
}
