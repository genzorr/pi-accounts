import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Accounts, atomicWrite, PROVIDER } from '../src/accounts.mjs';
import { loadPi } from '../src/pi-sdk.mjs';

const { FileAuthStorageBackend: Backend, AuthStorage, resolvePath, aiRoot } = await loadPi();
const { refreshStoredOAuthCredential } = await import(pathToFileURL(join(aiRoot, 'dist/auth/resolve.js')));
const credential = (id, expires = Date.now()) => ({ type: 'oauth', accountId: id, access: `synthetic-${id}`, refresh: `synthetic-refresh-${id}`, expires });
async function fixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'pi-accounts-test-'));
  const accounts = new Accounts({ home, resolvePath, Backend, oauth: { refresh: async c => ({ ...c, refresh: `${c.refresh}-new`, expires: Date.now() + 8 * 3600000 }) }, ...options });
  await accounts.add('a', credential('id-a'));
  await accounts.add('b', credential('id-b'));
  return { home, accounts };
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));

test('selection preserves unrelated providers; refresh never rotates selection; private files', async () => {
  const { home, accounts } = await fixture();
  await writeFile(join(home, 'auth.json'), JSON.stringify({ unrelated: { type: 'api_key', key: 'synthetic' } }));
  await accounts.select('a');
  await accounts.refresh();
  const auth = await json(accounts.authPath);
  assert.equal(auth.unrelated.key, 'synthetic');
  assert.equal(auth[PROVIDER].accountId, 'id-a');
  assert.deepEqual((await accounts.status()).map(a => a.selected), [true, false]);
  assert.equal((await stat(accounts.poolPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, 'accounts'))).mode & 0o777, 0o700);
});

test('revocation leaves selected identity and healthy accounts intact; login repairs saved account', async () => {
  const { accounts } = await fixture({ oauth: { refresh: async c => {
    if (c.accountId === 'id-a') throw new Error('secret response must stay private');
    return { ...c, expires: Date.now() + 8 * 3600000 };
  } } });
  await accounts.select('a');
  const results = await accounts.refresh();
  assert.match(results[0].status, /^failed/);
  assert.equal(results[1].status, 'refreshed');
  assert.equal(JSON.stringify(results).includes('secret response'), false);
  await accounts.add('a', credential('id-a', Date.now() + 8 * 3600000));
  assert.equal((await accounts.status())[0].needsRefresh, false);
});

test('switch recovers intent when native write failed before rename', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  accounts.write = async (path, data) => {
    if (path === accounts.authPath) throw new Error('simulated failure');
    return atomicWrite(path, data);
  };
  await assert.rejects(accounts.select('b'));
  assert.equal((await json(accounts.authPath))[PROVIDER].accountId, 'id-a');
  accounts.write = atomicWrite;
  assert.equal((await accounts.status())[1].selected, true);
  assert.equal((await json(accounts.authPath))[PROVIDER].accountId, 'id-b');
});

test('switch recovers after native commit and subsequent native token rotation', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  let writes = 0;
  accounts.write = async (path, data) => {
    if (++writes === 3) throw new Error('simulated final pool failure');
    return atomicWrite(path, data);
  };
  await assert.rejects(accounts.select('b'));
  const auth = await json(accounts.authPath);
  auth[PROVIDER].refresh = 'synthetic-native-new';
  await atomicWrite(accounts.authPath, auth);
  accounts.write = atomicWrite;
  assert.equal((await accounts.status())[1].selected, true);
  assert.equal((await json(accounts.poolPath)).accounts[1].credential.refresh, 'synthetic-native-new');
});

test('corrupt native file fails closed and preserves pool', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  const pool = await readFile(accounts.poolPath, 'utf8');
  await writeFile(accounts.authPath, '{');
  await assert.rejects(accounts.refresh());
  assert.equal(await readFile(accounts.poolPath, 'utf8'), pool);
});

test('atomic rename failure keeps old destination and private recovery material', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-accounts-atomic-'));
  const destination = join(home, 'destination');
  await mkdir(destination);
  await assert.rejects(atomicWrite(destination, { synthetic: true }));
  const recovery = (await readdir(home)).find(name => name.startsWith('destination.recovery-'));
  assert.deepEqual(await json(join(home, recovery)), { synthetic: true });
  assert.equal((await stat(join(home, recovery))).mode & 0o777, 0o600);
});

test('two native Pi/subagent processes with stale snapshots cannot undo a manual switch', async () => {
  const { home, accounts } = await fixture();
  await accounts.select('a');
  const go = join(home, 'go');
  const workers = [0, 1].map(index => {
    const ready = join(home, `ready-${index}`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./native-worker.mjs', import.meta.url)), home, ready, go], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Native synthetic worker exited ${code}`)));
    });
    return { ready, done };
  });
  for (const worker of workers) {
    for (let attempts = 0; ; attempts++) {
      try { await stat(worker.ready); break; } catch { if (attempts > 500) throw new Error('worker startup timeout'); await setTimeout(10); }
    }
  }
  await accounts.select('b');
  await writeFile(go, 'go');
  await Promise.all([...workers.map(w => w.done), accounts.refresh()]);
  const auth = await json(accounts.authPath);
  assert.equal(auth[PROVIDER].accountId, 'id-b');
  assert.match(auth[PROVIDER].refresh, /^synthetic-refresh-id-b-(new|native)$/);
  assert.equal((await accounts.status())[1].selected, true);
  const pool = await json(accounts.poolPath);
  assert.equal(pool.accounts[0].credential.accountId, 'id-a');
  assert.equal(pool.accounts[1].credential.refresh, auth[PROVIDER].refresh);
});

test('usage projects only quota fields and never prints arbitrary server values', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  const result = await accounts.usage(undefined, async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'id-a');
    return { ok: true, json: async () => ({ access_token: 'never-print', rate_limit: { allowed: true, primary_window: { used_percent: 42, reset_at: 123 } } }) };
  });
  assert.equal(result.primary.usedPercent, 42);
  assert.equal(JSON.stringify(result).includes('never-print'), false);
});

test('refresh uses the inclusive 75-minute threshold and stops after persistence failure', async () => {
  let calls = 0;
  const now = Date.now();
  const { accounts } = await fixture({ now: () => now, oauth: { refresh: async c => {
    calls++;
    return { ...c, expires: now + 8 * 3600000 };
  } } });
  await accounts.add('a', credential('id-a', now + 4500000));
  await accounts.add('b', credential('id-b', now + 4500001));
  assert.deepEqual((await accounts.refresh()).map(r => r.status), ['refreshed', 'current']);
  assert.equal(calls, 1);
  await accounts.add('a', credential('id-a', now));
  await accounts.add('b', credential('id-b', now));
  accounts.write = async () => { throw new Error('simulated disk full'); };
  await assert.rejects(accounts.refresh());
  assert.equal(calls, 2);
});

test('recovery material blocks subsequent refresh rather than reusing an obsolete token', async () => {
  const { accounts } = await fixture();
  await writeFile(`${accounts.poolPath}.recovery-synthetic`, '{}', { mode: 0o600 });
  await assert.rejects(accounts.refresh(), /Private recovery files/);
});

test('selection waits for a native refresh already in flight and saves its rotated token', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  const storage = AuthStorage.create(accounts.authPath);
  let started;
  let finish;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const refresh = refreshStoredOAuthCredential(storage, PROVIDER, { refresh: async current => {
    started();
    await gate;
    return { ...current, refresh: 'synthetic-inflight-new', expires: Date.now() + 8 * 3600000 };
  } }, () => true, new AbortController().signal);
  await ready;
  const selection = accounts.select('b');
  finish();
  await Promise.all([selection, refresh]);
  assert.equal((await json(accounts.authPath))[PROVIDER].accountId, 'id-b');
  assert.equal((await json(accounts.poolPath)).accounts[0].credential.refresh, 'synthetic-inflight-new');
  // The same already-created native storage sees atomic file replacement.
  assert.equal((await storage.read(PROVIDER)).accountId, 'id-b');
});

test('a second interrupted selection recovery preserves a native-rotated previous credential', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  accounts.write = async (path, data) => {
    if (path === accounts.authPath) throw new Error('first interruption before native replacement');
    return atomicWrite(path, data);
  };
  await assert.rejects(accounts.select('b'));
  const native = AuthStorage.create(accounts.authPath);
  await native.modify(PROVIDER, current => ({ ...current, refresh: 'synthetic-a1-rotated', expires: Date.now() + 8 * 3600000 }));
  let nativeCommitted = false;
  accounts.write = async (path, data) => {
    if (path === accounts.poolPath && nativeCommitted) throw new Error('second interruption after native replacement');
    await atomicWrite(path, data);
    if (path === accounts.authPath) nativeCommitted = true;
  };
  await assert.rejects(accounts.status(), /second interruption after native replacement/);
  assert.equal((await json(accounts.authPath))[PROVIDER].accountId, 'id-b');
  accounts.write = atomicWrite;
  assert.equal((await accounts.status())[1].selected, true);
  await accounts.select('a');
  assert.equal((await json(accounts.authPath))[PROVIDER].refresh, 'synthetic-a1-rotated');
});

test('native supported agent-home spellings use one store for reads, locks and writes', async () => {
  const { home, accounts } = await fixture();
  await accounts.select('a');
  const spellings = [home, pathToFileURL(home).href, relative(process.cwd(), home), `~/${relative(homedir(), home)}`];
  for (const spelling of spellings) {
    const locks = [];
    const writes = [];
    class RecordingBackend extends Backend {
      async withLockAsync(fn, options) {
        locks.push(this.authPath);
        return super.withLockAsync(fn, options);
      }
    }
    const same = new Accounts({ home: spelling, resolvePath, Backend: RecordingBackend, oauth: {}, write: async (path, data) => {
      writes.push(path);
      return atomicWrite(path, data);
    } });
    assert.deepEqual((await same.status()).map(a => a.label), ['a', 'b']);
    await same.select('b');
    await same.select('a');
    assert.deepEqual(new Set(locks), new Set([accounts.poolPath, accounts.authPath]));
    assert.deepEqual(new Set(writes), new Set([accounts.poolPath, accounts.authPath]));
    assert.equal((await json(accounts.authPath))[PROVIDER].accountId, 'id-a');
  }
});

const jwt = claims => `synthetic.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;

test('email is optional display metadata; native selected authority and workspace identity survive refresh', async () => {
  const { accounts } = await fixture();
  const access = jwt({ 'https://api.openai.com/profile': { email: 'shared@example.test' } });
  await accounts.add('a', { ...credential('id-a'), access });
  await accounts.add('b', { ...credential('id-b'), access });
  await accounts.select('a');
  const native = AuthStorage.create(accounts.authPath);
  await native.modify(PROVIDER, current => ({ ...current, access: jwt({ email: 'native@example.test' }), refresh: 'synthetic-native-current' }));
  const before = await accounts.status();
  assert.equal(before[0].email, 'native@example.test');
  assert.equal(before[1].email, 'shared@example.test');
  accounts.oauth.refresh = async current => ({ ...current, access: 'opaque-refreshed', refresh: `${current.refresh}-new`, expires: Date.now() + 8 * 3600000 });
  await accounts.refresh();
  await accounts.select('b');
  await accounts.select('a');
  const after = await accounts.status();
  assert.equal(after[0].email, 'native@example.test');
  assert.equal(after[0].accountId, 'id-a');
  assert.equal(after[1].accountId, 'id-b');
  assert.equal((await json(accounts.authPath))[PROVIDER].refresh, 'synthetic-native-current-new');
  await assert.rejects(accounts.add('a', { ...credential('id-other'), access }), /Label or account/);
  await assert.rejects(accounts.add('other', { ...credential('id-a'), access }), /Label or account/);
});

test('display metadata tolerates opaque tokens and rejects control-bearing email hints', async () => {
  const { accounts } = await fixture();
  await accounts.add('a', { ...credential('id-a'), access: jwt({ email: 'person\u001b[31m@example.test\nATTACK' }) });
  await accounts.add('b', { ...credential('id-b'), access: 'opaque-synthetic-token' });
  const result = await accounts.status();
  assert.equal(result[0].email, undefined);
  assert.equal(result[1].email, undefined);
  assert.equal(JSON.stringify(result).includes('opaque-synthetic-token'), false);
  assert.equal(JSON.stringify(result).includes('ATTACK'), false);
});

test('local health distinguishes expiry from proactive renewal without a provider probe', async () => {
  const now = Date.now();
  const { accounts } = await fixture({ now: () => now });
  await accounts.add('a', credential('id-a', now));
  await accounts.add('b', credential('id-b', now + 4500000));
  assert.deepEqual((await accounts.status()).map(a => a.localHealth), ['expired', 'refresh-due']);
  await accounts.add('b', credential('id-b', now + 4500001));
  assert.equal((await accounts.status())[1].localHealth, 'current');
});

test('rename changes selected and nonselected labels without touching native auth or credentials', async () => {
  let providerCalls = 0;
  const { accounts } = await fixture({ oauth: { refresh: async () => { providerCalls++; throw new Error('must not refresh'); } } });
  await accounts.select('a');
  const nativeBefore = await readFile(accounts.authPath, 'utf8');
  const credentialsBefore = (await json(accounts.poolPath)).accounts.map(a => a.credential);
  assert.equal(await accounts.rename('a', 'personal'), true);
  assert.equal(await accounts.rename('b', 'work'), true);
  assert.deepEqual((await accounts.status()).map(a => [a.label, a.selected]), [['personal', true], ['work', false]]);
  assert.equal(await readFile(accounts.authPath, 'utf8'), nativeBefore);
  assert.deepEqual((await json(accounts.poolPath)).accounts.map(a => a.credential), credentialsBefore);
  assert.equal(providerCalls, 0);
  const poolBefore = await readFile(accounts.poolPath, 'utf8');
  assert.equal(await accounts.rename('personal', 'personal'), false);
  for (const [oldLabel, newLabel] of [['missing', 'new'], ['missing', 'missing'], ['personal', 'work'], ['personal', 'email@example.test'], ['email@example.test', 'new']]) {
    await assert.rejects(accounts.rename(oldLabel, newLabel));
    assert.equal(await readFile(accounts.poolPath, 'utf8'), poolBefore);
    assert.equal(await readFile(accounts.authPath, 'utf8'), nativeBefore);
  }
});

test('rename completes pending recovery and checkpoints a native-rotated previous credential', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  accounts.write = async (path, data) => {
    if (path === accounts.authPath) throw new Error('interrupted switch');
    return atomicWrite(path, data);
  };
  await assert.rejects(accounts.select('b'));
  const native = AuthStorage.create(accounts.authPath);
  await native.modify(PROVIDER, current => ({ ...current, refresh: 'synthetic-rotated-before-rename' }));
  accounts.write = atomicWrite;
  await accounts.rename('b', 'work');
  assert.deepEqual((await accounts.status()).map(a => [a.label, a.selected]), [['a', false], ['work', true]]);
  assert.equal((await json(accounts.authPath))[PROVIDER].accountId, 'id-b');
  await accounts.select('a');
  assert.equal((await json(accounts.authPath))[PROVIDER].refresh, 'synthetic-rotated-before-rename');
});

test('failed rename persistence preserves the active credentials and releases its locks for retry', async () => {
  const { accounts } = await fixture();
  await accounts.select('a');
  const authBefore = await readFile(accounts.authPath, 'utf8');
  const poolBefore = await readFile(accounts.poolPath, 'utf8');
  accounts.write = async () => { throw new Error('simulated pool persistence failure'); };
  await assert.rejects(accounts.rename('a', 'personal'));
  assert.equal(await readFile(accounts.authPath, 'utf8'), authBefore);
  assert.equal(await readFile(accounts.poolPath, 'utf8'), poolBefore);
  accounts.write = atomicWrite;
  await accounts.rename('a', 'personal');
  assert.equal((await accounts.status())[0].selected, true);
  assert.equal(await readFile(accounts.authPath, 'utf8'), authBefore);
});
