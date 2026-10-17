import { writeFile, access } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { loadPi } from '../src/pi-sdk.mjs';

const [home, ready, go] = process.argv.slice(2);
const { AuthStorage, refreshStoredOAuthCredential } = await loadPi();
const storage = AuthStorage.create(join(home, 'auth.json'));
await storage.read('openai-codex');
await writeFile(ready, 'ready');
while (true) {
  try { await access(go); break; } catch { await setTimeout(10); }
}
await refreshStoredOAuthCredential(storage, 'openai-codex', { refresh: async current => {
  await setTimeout(40);
  return { ...current, access: 'synthetic-rotated', refresh: `${current.refresh}-native`, expires: Date.now() + 8 * 3600000 };
} }, current => current.expires < Date.now() + 4500000, new AbortController().signal);
