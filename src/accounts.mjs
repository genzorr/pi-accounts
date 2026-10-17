import { mkdir, open, rename, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROVIDER = 'openai-codex';
export const REFRESH_BEFORE_MS = 75 * 60 * 1000;

export class AccountError extends Error {}

export function validateLabel(label) {
  if (typeof label !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(label)) throw new AccountError('Use a short label starting with a letter or digit (1–64 letters, digits, dots, underscores or hyphens), for example personal; do not use an email address');
}

export function displayText(value, limit = 254) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function displayEmail(value) {
  const email = displayText(value);
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}

function credentialEmail(credential) {
  let claims;
  const parts = credential.access.split('.');
  if (parts.length === 3 && parts[1].length <= 16384) {
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch {}
  }
  // Unverified JWT claims are display hints, never account identity or authorization.
  return displayEmail(credential.email) || displayEmail(claims?.email) || displayEmail(claims?.['https://api.openai.com/profile']?.email);
}

export function validCredential(value) {
  return value?.type === 'oauth' && typeof value.access === 'string' && value.access.length > 0 && typeof value.refresh === 'string' && value.refresh.length > 0 && Number.isFinite(value.expires) && typeof value.accountId === 'string' && value.accountId.length > 0;
}

export async function atomicWrite(path, data) {
  const temp = `${path}.recovery-${randomUUID()}`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await file.sync();
  } finally { await file.close(); }
  // Keep a private recovery file if rename fails after a server rotated a token.
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function parseObject(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new AccountError('Invalid credential store JSON; stop native writers and follow the private recovery procedure before retrying'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AccountError('Invalid credential store; restore it before retrying');
  return data;
}

async function renewCredential(oauth, account) {
  let credential;
  try {
    credential = await oauth.refresh(account.credential, AbortSignal.timeout(15000));
    if (!validCredential(credential) || credential.accountId !== account.credential.accountId) throw new Error('Invalid refreshed identity');
  } catch {
    throw new AccountError('Token refresh failed; check connectivity or log in to this account again');
  }
  account.credential = credential;
  account.email = credentialEmail(credential) || displayEmail(account.email);
}

export class Accounts {
  constructor({ home, resolvePath, Backend, oauth, write = atomicWrite, now = Date.now }) {
    this.home = resolvePath(home);
    this.poolPath = join(this.home, 'accounts', 'pool.json');
    this.authPath = join(this.home, 'auth.json');
    this.Backend = Backend;
    this.oauth = oauth;
    this.write = write;
    this.now = now;
  }

  async locked(fn) {
    await mkdir(join(this.home, 'accounts'), { recursive: true, mode: 0o700 });
    const poolBackend = new this.Backend(this.poolPath);
    const authBackend = new this.Backend(this.authPath);
    // Pool-before-native lock order lets Pi/subagents share auth.json without acquiring the pool lock.
    return poolBackend.withLockAsync(async (poolText) => ({ result: await authBackend.withLockAsync(async (authText) => {
      for (const path of [this.poolPath, this.authPath]) {
        const names = await readdir(dirname(path));
        if (names.some(name => name.startsWith(`${basename(path)}.recovery-`))) throw new AccountError('Private recovery files need operator review before retrying; a token may already have rotated');
      }
      const pool = parseObject(poolText || '{}');
      if (Object.keys(pool).length === 0) Object.assign(pool, { version: 1, selected: null, accounts: [] });
      if (pool.version !== 1 || !Array.isArray(pool.accounts) || pool.accounts.some(a => !a || typeof a.label !== 'string' || !validCredential(a.credential))) throw new AccountError('Invalid account pool; restore it before retrying');
      const auth = parseObject(authText || '{}');
      const current = auth[PROVIDER];
      if (pool.pending) {
        const { from, to } = pool.pending;
        const target = pool.accounts.find(a => a.label === to);
        const previous = pool.accounts.find(a => a.label === from);
        if (!target) throw new AccountError('Invalid pending selection');
        if (validCredential(current) && current.accountId === target.credential.accountId) {
          target.credential = current;
        } else if ((!from && current === undefined) || (previous && validCredential(current) && current.accountId === previous.credential.accountId)) {
          if (previous) previous.credential = current;
          // Native may have rotated the previous account since the original intent.
          // Preserve that token durably before replacing its only authoritative copy.
          await this.write(this.poolPath, pool);
          auth[PROVIDER] = target.credential;
          await this.write(this.authPath, auth);
        } else throw new AccountError('Native login changed during selection recovery; resolve the pending selection before retrying');
        pool.selected = to;
        delete pool.pending;
        await this.write(this.poolPath, pool);
      }
      // Native auth owns the selected credential; pool snapshots must not replay an older refresh token.
      if (pool.selected) {
        const selected = pool.accounts.find(a => a.label === pool.selected);
        if (!selected || !validCredential(auth[PROVIDER]) || selected.credential.accountId !== auth[PROVIDER].accountId) throw new AccountError('Native Pi login differs from selected account; restore the selected login or resolve the pool before retrying');
        selected.credential = auth[PROVIDER];
        selected.email = credentialEmail(selected.credential) || displayEmail(selected.email);
      } else if (auth[PROVIDER] !== undefined) {
        throw new AccountError('Existing unmanaged Pi login: account tool will not import or overwrite it');
      }
      return { result: await fn(pool, auth) };
    }) }));
  }

  async add(label, credential) {
    validateLabel(label);
    if (!validCredential(credential)) throw new AccountError('Pi returned an invalid credential');
    return this.locked(async (pool, auth) => {
      const existing = pool.accounts.find(a => a.label === label);
      if (pool.accounts.some(a => a.label !== label && a.credential.accountId === credential.accountId) || (existing && existing.credential.accountId !== credential.accountId)) throw new AccountError('Label or account already saved; use a different account');
      if (existing) {
        existing.credential = credential;
        existing.email = credentialEmail(credential) || displayEmail(existing.email);
        if (pool.selected === label) {
          auth[PROVIDER] = credential;
          await this.write(this.authPath, auth);
        }
      } else pool.accounts.push({ label, credential, email: credentialEmail(credential) });
      await this.write(this.poolPath, pool);
    });
  }

  async select(label) {
    return this.locked(async (pool, auth) => {
      const target = pool.accounts.find(a => a.label === label);
      if (!target) throw new AccountError('Unknown account label; run pi-accounts list');
      await renewCredential(this.oauth, target);
      if (pool.selected === label) {
        // Native auth remains authoritative if the pool commit is interrupted.
        auth[PROVIDER] = target.credential;
        await this.write(this.authPath, auth);
        await this.write(this.poolPath, pool);
        return;
      }
      // The durable intent preserves both accounts across a crash between file renames.
      pool.pending = { from: pool.selected, to: label };
      await this.write(this.poolPath, pool);
      auth[PROVIDER] = target.credential;
      await this.write(this.authPath, auth);
      pool.selected = label;
      delete pool.pending;
      await this.write(this.poolPath, pool);
    });
  }

  async rename(oldLabel, newLabel) {
    validateLabel(oldLabel);
    validateLabel(newLabel);
    return this.locked(async pool => {
      const account = pool.accounts.find(a => a.label === oldLabel);
      if (!account) throw new AccountError('Unknown account label; run pi-accounts list');
      if (oldLabel === newLabel) return false;
      if (pool.accounts.some(a => a.label === newLabel)) throw new AccountError('Label already exists; choose an unused short label');
      account.label = newLabel;
      if (pool.selected === oldLabel) pool.selected = newLabel;
      await this.write(this.poolPath, pool);
      return true;
    });
  }

  async status() {
    return this.locked(async pool => {
      const now = this.now();
      return pool.accounts.map(a => ({ label: a.label, email: credentialEmail(a.credential) || displayEmail(a.email), selected: a.label === pool.selected, accountId: a.credential.accountId, expires: new Date(a.credential.expires).toISOString(), needsRefresh: a.credential.expires <= now + REFRESH_BEFORE_MS, localHealth: a.credential.expires <= now ? 'expired' : a.credential.expires <= now + REFRESH_BEFORE_MS ? 'refresh-due' : 'current' }));
    });
  }

  async refresh(label, { force = false } = {}) {
    return this.locked(async (pool, auth) => {
      const target = label ?? (force ? pool.selected : undefined);
      if (force && !target) throw new AccountError('Select an account or provide a label before forcing refresh');
      const accounts = target === undefined ? pool.accounts : pool.accounts.filter(account => account.label === target);
      if (target !== undefined && !accounts.length) throw new AccountError('Unknown account label; run pi-accounts list');
      const results = [];
      for (const account of accounts) {
        if (!force && account.credential.expires > this.now() + REFRESH_BEFORE_MS) { results.push({ label: account.label, status: 'current' }); continue; }
        try {
          await renewCredential(this.oauth, account);
        } catch {
          // Provider errors may include token responses. Never print their messages.
          results.push({ label: account.label, status: 'failed; check connectivity or login again; inspect private recovery files after disk errors' });
          continue;
        }
        if (account.label === pool.selected) {
          auth[PROVIDER] = account.credential;
          await this.write(this.authPath, auth);
        }
        await this.write(this.poolPath, pool);
        results.push({ label: account.label, status: account.credential.expires > this.now() + REFRESH_BEFORE_MS ? 'refreshed' : 'expires-too-soon' });
      }
      return results;
    });
  }

  async usage(label, fetchUsage = fetch) {
    return this.locked(async pool => {
      const account = pool.accounts.find(a => a.label === (label || pool.selected));
      if (!account) throw new AccountError('Select an account or provide its label');
      const response = await fetchUsage('https://chatgpt.com/backend-api/wham/usage', { headers: { Authorization: `Bearer ${account.credential.access}`, 'ChatGPT-Account-Id': account.credential.accountId }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new AccountError(response.status === 401 ? 'Usage unavailable (HTTP 401); run pi-accounts refresh LABEL --force for this account, then retry' : `Usage unavailable (HTTP ${response.status}); run refresh or login again`);
      const data = await response.json();
      const number = value => Number.isFinite(value) ? value : undefined;
      const bool = value => typeof value === 'boolean' ? value : undefined;
      const window = value => value && ({ usedPercent: number(value.used_percent), resetAt: number(value.reset_at) });
      return { label: account.label, allowed: bool(data.rate_limit?.allowed), limitReached: bool(data.rate_limit?.limit_reached), primary: window(data.rate_limit?.primary_window), secondary: window(data.rate_limit?.secondary_window) };
    });
  }
}
