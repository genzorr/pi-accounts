#!/usr/bin/env node
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadPi } from './pi-sdk.mjs';
import { Accounts, AccountError, validateLabel, displayText } from './accounts.mjs';

const commands = ['login', 'add', 'list', 'status', 'select', 'rename', 'usage', 'refresh', 'maintenance', 'update'];
const help = `pi-accounts login|add LABEL [--device]   Save a Pi-owned login; browser flow is the default
pi-accounts list|status [--json]         Show saved accounts and local expiry health
pi-accounts select LABEL                Force-refresh and choose the active account
pi-accounts rename OLD NEW              Rename a saved label without changing credentials
pi-accounts usage [LABEL] [--json]       Check quota for an account (default: active)
pi-accounts refresh [LABEL] [--force] [--json]  Refresh due accounts; --force defaults to active only
pi-accounts maintenance ...             Install, inspect or remove scheduled maintenance
pi-accounts update                      Update this global installation from GitHub releases
pi-accounts COMMAND --help              Show help without accessing the SDK or stores

Use a short label such as personal or work, not an email address.
Browser login works remotely with a pasted callback; --device optionally uses device-code login.
Use --json for scripts and maintenance. Local health does not verify server acceptance.
If Pi rejects a locally current token, use refresh --force; it does not switch accounts.`;

function parse(args) {
  const [command = 'help', ...rest] = args;
  if (command === 'help') {
    if (rest.length > 1 || (rest.length === 1 && !commands.includes(rest[0]))) throw new AccountError('Invalid help target; run pi-accounts help');
    return { help: true };
  }
  if (['--help', '-h'].includes(command) && rest.length === 0) return { help: true };
  if (!commands.includes(command)) throw new AccountError('Unknown command; run pi-accounts help');
  const options = new Set();
  const labels = [];
  for (const argument of rest) {
    if (!argument.startsWith('-')) { labels.push(argument); continue; }
    const option = argument === '-h' ? '--help' : argument;
    const allowed = option === '--help' || (option === '--device' && ['login', 'add'].includes(command)) || (option === '--force' && command === 'refresh') || (option === '--json' && ['list', 'status', 'usage', 'refresh'].includes(command));
    if (!allowed || options.has(option)) throw new AccountError('Invalid or repeated option; run pi-accounts help');
    options.add(option);
  }
  const requiredLabels = command === 'rename' ? 2 : ['login', 'add', 'select'].includes(command) ? 1 : 0;
  const maximumLabels = ['usage', 'refresh'].includes(command) ? 1 : requiredLabels;
  if (labels.length > maximumLabels) throw new AccountError('Invalid extra argument; run pi-accounts help');
  for (const label of labels) validateLabel(label);
  if (!options.has('--help') && labels.length < requiredLabels) throw new AccountError(command === 'rename' ? 'Use pi-accounts rename OLD NEW with two short labels' : 'Use a short account label; for example pi-accounts login personal');
  return { command, label: labels[0], newLabel: labels[1], help: options.has('--help'), device: options.has('--device'), force: options.has('--force'), json: options.has('--json') };
}

function printStatus(rows) {
  if (!rows.length) { console.log('No saved Pi accounts. Run pi-accounts login personal, then pi-accounts select personal.'); return; }
  const cells = [['ACTIVE', 'LABEL', 'EMAIL', 'EXPIRES (UTC)', 'LOCAL HEALTH'], ...rows.map(row => [row.selected ? '*' : '', row.label, row.email || 'unavailable', row.expires, row.localHealth])].map(row => row.map(value => displayText(value, 60)));
  const widths = cells[0].map((_, index) => Math.max(...cells.map(row => row[index].length)));
  for (const row of cells) console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd());
  console.log('Local health checks expiry only. Usage checks provider quota; refresh renews due tokens.');
}

function printUsage(result) {
  console.log(`Usage for ${displayText(result.label)}: allowed ${result.allowed ?? 'unknown'}; limit reached ${result.limitReached ?? 'unknown'}`);
  for (const key of ['primary', 'secondary']) {
    const window = result[key];
    const reset = Number.isFinite(window?.resetAt) ? new Date(window.resetAt * 1000) : undefined;
    const resetText = reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : 'unknown';
    console.log(`${key}: ${window?.usedPercent ?? 'unknown'}% used; resets ${resetText}`);
  }
}

async function main() {
  if (process.argv[2] === 'update') {
    const { runUpdate } = await import('./update.mjs');
    process.exitCode = await runUpdate(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'maintenance') {
    const { runMaintenance } = await import('./maintenance.mjs');
    const code = await runMaintenance(process.argv.slice(3));
    if (Number.isInteger(code)) process.exitCode = code;
    return;
  }
  const options = parse(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const { command, label } = options;
  const { FileAuthStorageBackend, oauth, resolvePath } = await loadPi();
  const accounts = new Accounts({ home: process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), resolvePath, Backend: FileAuthStorageBackend, oauth });
  if (command === 'login' || command === 'add') {
    await accounts.status();
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let credential;
    try {
      credential = await oauth.login({ signal: AbortSignal.timeout(15 * 60000), notify: event => {
        if (event.type === 'auth_url') console.log(`Open in your browser: ${event.url}`);
        if (event.type === 'device_code') console.log(`Open ${event.verificationUri} and enter ${event.userCode}`);
      }, prompt: async prompt => prompt.type === 'select' ? (options.device ? 'device_code' : 'browser') : terminal.question(`${prompt.message}\n`) });
    } catch { throw new AccountError('Pi login failed or cancelled; retry pi-accounts login with the same label'); }
    finally { terminal.close(); }
    await accounts.add(label, credential);
    console.log(`Saved ${label}. Run pi-accounts select ${label} to use it.`);
  } else if (command === 'select') {
    await accounts.select(label);
    console.log(`Refreshed and selected ${label}. Restart/resume idle Pi or T3 sessions for a clean account boundary.`);
  } else if (command === 'rename') {
    const changed = await accounts.rename(label, options.newLabel);
    console.log(changed ? `Renamed ${label} to ${options.newLabel}.` : `Account is already named ${label}.`);
  } else {
    const result = command === 'refresh' ? await accounts.refresh(label, { force: options.force }) : command === 'usage' ? await accounts.usage(label) : await accounts.status();
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (command === 'usage') printUsage(result);
    else if (command === 'refresh') {
      if (!result.length) console.log('No saved Pi accounts to refresh. Run pi-accounts login personal to add one.');
      for (const row of result) console.log(`${displayText(row.label)}: ${row.status}`);
    } else printStatus(result);
    if (command === 'refresh' && result.some(a => !['current', 'refreshed'].includes(a.status))) process.exitCode = 1;
  }
}

main().catch(error => {
  // Filesystem and provider exceptions can contain credential data or response bodies.
  if (error instanceof AccountError) console.error(error.message);
  else if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error.code)) console.error('Account storage is not writable; check private store permissions and free space. Review private recovery files before retrying.');
  else if (error.code === 'ELOCKED') console.error('Account store is busy; wait for the active login or maintenance operation, then retry.');
  else console.error('Account operation failed; check the supported Pi installation, network connectivity, private store permissions and recovery files. Provider responses and credentials were not printed.');
  process.exitCode = 1;
});
