import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPi } from '../src/pi-sdk.mjs';

async function fixture(t, piVersion = '1.3.0', aiVersion = piVersion, missing) {
  const root = await mkdtemp(join(tmpdir(), 'pi-sdk-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'effects');
  const mark = `import { appendFileSync } from 'node:fs'; const mark = value => appendFileSync(${JSON.stringify(trace)}, value + '\\n'); mark('import');`;
  const save = async (file, body) => { const path = join(root, file); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body); };
  await save('package.json', JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: piVersion, type: 'module' }));
  const backend = `export class FileAuthStorageBackend { constructor() { mark('store'); } withLock() {} withLockAsync() {} }`;
  const storage = `export class AuthStorage { static create() { mark('store'); } read() {} modify() {} }`;
  await save('dist/core/auth-storage.js', mark + backend + storage.replace(missing === 'modify' ? 'modify() {}' : '__unchanged__', ''));
  if (missing === 'lock') await save('dist/core/auth-storage.js', mark + backend.replace('withLockAsync() {}', '') + storage);
  await save('dist/utils/paths.js', `${mark} export const resolvePath = ${missing === 'paths' ? 'null' : 'value => value'};`);
  await save('node_modules/@earendil-works/pi-ai/package.json', JSON.stringify({ name: '@earendil-works/pi-ai', version: aiVersion, type: 'module' }));
  await save('node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js', `${mark} export const openaiCodexOAuth = { login() { mark('provider'); }, ${missing === 'oauth' ? '' : "refresh() { mark('provider'); }"} };`);
  if (missing !== 'module') await save('node_modules/@earendil-works/pi-ai/dist/auth/resolve.js', `${mark} export const refreshStoredOAuthCredential = ${missing === 'refresh' ? 'null' : "() => mark('provider')"};`);
  const effects = async () => { try { return await readFile(trace, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
  return { root, effects };
}

test('reviewed stable SDK releases initialize capabilities without touching stores or providers', async t => {
  for (const [version, aiVersion] of [['1.1.0', '1.1.0'], ['1.1.0', '1.2.0'], ['1.1.0', '1.3.0'], ['1.2.0', '1.2.0'], ['1.2.0', '1.3.0'], ['1.3.0', '1.3.0']]) {
    const f = await fixture(t, version, aiVersion);
    const sdk = await loadPi({ packageDir: f.root });
    assert.equal(sdk.version, version);
    assert.equal(sdk.aiVersion, aiVersion);
    assert.equal(typeof sdk.refreshStoredOAuthCredential, 'function');
    assert.doesNotMatch(await f.effects(), /store|provider/);
  }
});

test('old, future and prerelease SDKs fail before native imports or account effects', async t => {
  for (const version of ['0.87.1', '1.0.0', '1.0.4', '1.4.0', '2.0.0', '1.3.1', '1.3.0-beta.1']) {
    const f = await fixture(t, version);
    await assert.rejects(loadPi({ packageDir: f.root }), /supports reviewed Pi/);
    assert.equal(await f.effects(), '');
  }
});

test('unreviewed dependency combinations fail before native imports or account effects', async t => {
  for (const [version, aiVersion] of [['1.3.0', '1.4.0'], ['1.3.0', '1.2.0'], ['1.2.0', '1.1.0'], ['1.1.0', '1.0.0'], ['1.1.0', '1.3.1']]) {
    const f = await fixture(t, version, aiVersion);
    await assert.rejects(loadPi({ packageDir: f.root }), /reviewed Pi\/pi-ai release combination/);
    assert.equal(await f.effects(), '');
  }
});

test('missing native lock, storage, path, OAuth or durable-refresh APIs fail before account effects', async t => {
  for (const missing of ['lock', 'modify', 'paths', 'oauth', 'refresh', 'module']) {
    const f = await fixture(t, '1.3.0', '1.3.0', missing);
    await assert.rejects(loadPi({ packageDir: f.root }), /Pi native auth/);
    assert.doesNotMatch(await f.effects(), /store|provider/);
  }
});
