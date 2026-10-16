# Pi accounts

`pi-accounts` is a standalone Pi-only account CLI. It uses the installed Pi 1.3.0 OpenAI OAuth implementation, keeps the canonical `openai-codex` provider, and leaves model, effort, sessions, settings, Codex and CMA unchanged. Each saved account needs its own Pi-owned login. It refuses an existing unmanaged native Pi credential instead of importing shared refresh tokens. There is no automatic account rotation or inference proxy.

## Commands

```bash
pi-accounts login personal             # browser URL and optional pasted callback
pi-accounts login work --device        # optional device-code flow
pi-accounts list                       # readable label/email/active/expiry/local-health table
pi-accounts status                     # same local check; no network call
pi-accounts select personal
pi-accounts rename personal primary    # rename the label; credentials and selection stay intact
pi-accounts usage                      # selected account's quota
pi-accounts usage work                 # explicitly named account's quota
pi-accounts refresh                    # refresh every saved account due within 75 minutes
pi-accounts status --json              # machine-readable local status
pi-accounts refresh --json             # machine-readable maintenance output
pi-accounts refresh --help             # help only; no SDK, storage or refresh effects
```

`add` aliases `login`. Login saves without selecting; select explicitly after the first login. Repeat `login LABEL` for the same account to repair a revoked login; a label cannot silently become a different account, and one account cannot have multiple saved labels. Labels begin with a letter or digit and contain 1–64 letters, digits, dots, underscores or hyphens; short names such as `personal` and `work` are intended, and `@` remains unsupported. Account command syntax and labels are validated before loading the Pi SDK, accessing storage or beginning OAuth. Extra arguments and unsupported or repeated flags fail before effects. Login only prints the OAuth URL or short-lived device code needed for the human interaction; access and refresh tokens and provider error bodies are never printed. Complete the human login directly in a terminal, rather than collecting its output in a shared log.

Browser login is the default and works over SSH: native Pi uses a localhost:1455 callback when available or accepts a pasted authorization code/redirect URL. `--device` explicitly chooses Pi's device-code flow and polling; it is often convenient remotely, but is not required for SSH or scheduled maintenance. The wrapper does not detect SSH. Keep a working saved login; changing login flow does not require logging in again.

`rename OLD NEW` changes a saved label under the existing account locks, without OAuth or refresh calls. The active account retains its credentials and remains active under the new label; other saved accounts are unchanged. A known account renamed to the same label is a no-op; an unknown old label or an occupied new label is an error. Any pending switch is recovered under the existing authority before a valid rename proceeds. Invalid labels are rejected before storage access.

`list` and `status` default to a readable table with the short label, optional email, active marker, UTC expiry and local health (`current`, `refresh-due` or `expired`). Local health describes only token expiry and the 75-minute renewal threshold, not whether the provider has revoked a login. `usage` and `refresh` also default to readable summaries. Add `--json` to `list`, `status`, `usage` or `refresh` for scripts; it is not accepted for interactive login, select or rename. Status JSON retains `label`, `selected`, `accountId`, `expires` and `needsRefresh`, adds `localHealth`, and includes `email` when available. Empty status JSON is `[]`.

Email is optional, unverified display metadata obtained from a native credential email field or an access-token `email` / `https://api.openai.com/profile.email` claim when present. Native Pi requests `openid profile email offline_access` but its 1.3.0 credential result contains only type/access/refresh/expires/accountId, so email is not guaranteed. Opaque tokens and missing or malformed claims remain usable without an email. Display values are bounded and stripped of terminal/control formatting; provider response bodies and token values are never printed. Saved email hints can survive token refreshes that omit them. Account/workspace ID remains the identity and deduplication boundary; two saved accounts may show the same email. The private pool remains schema version 1 with an optional email field; no credential import or CMA backend is introduced.

`usage` sends one authenticated GET to the existing ChatGPT `/backend-api/wham/usage` endpoint and projects only numeric quota windows and boolean availability fields. This private endpoint is best effort, not a guaranteed public API; it makes no inference request. A failed usage request does not switch accounts. Run `refresh` or log in again when necessary. Usage does not refresh automatically.

## Runtime and installation

See the [README](../README.md) for package installation, maintenance activation and rollback. The package exposes `src/cli.mjs` as `pi-accounts` and carries its sibling modules together; it has no additional npm runtime dependencies. Node.js >=22.19.0, Pi `@earendil-works/pi-coding-agent` 1.3.0 and its matching `@earendil-works/pi-ai` 1.3.0 are required. The SDK checks versions before importing native Pi primitives; these versions remain pinned until refresh-lock semantics and internal module paths are reviewed again.

The tool searches `PATH` for the first executable `pi`, follows its executable symlink and ascends to the Pi npm package. This supports normal Linux and macOS npm bin-to-package layouts without a particular home prefix. Set `PI_PACKAGE_DIR` to the package directory when `pi` is a shell wrapper or is absent from `PATH`; the override takes precedence. Pi's OAuth dependency follows Node's package search order from that package, supporting both nested and hoisted npm dependencies. Discovery does not execute `pi`. Synthetic tests qualify relocated CLI/npm layouts on Linux; actual macOS execution remains unverified.

`PI_CODING_AGENT_DIR` selects Pi's agent home, default `~/.pi/agent`. The CLI resolves it once through Pi's native `resolvePath`: `~` and `~/...` expand to the user home, `file://` URLs become filesystem paths, and relative paths resolve from the current working directory. The resulting absolute path is shared by reads, locks and writes; paths are not trimmed or canonicalized through symlinks. Set the same home for Pi, its subagents and this CLI. Native credentials remain in `auth.json`; saved accounts live in `accounts/pool.json`. New private directories use mode 0700 and private files use mode 0600. Existing parent-directory permissions and ACLs remain operator-owned. Installation must not copy credentials. Source-only scratch checks use:

```bash
node --test tests/accounts.test.mjs tests/cli.test.mjs
PI_CODING_AGENT_DIR="$(mktemp -d)" node src/cli.mjs status
node src/cli.mjs help
```

Use `pi-accounts maintenance --help` and the [README](../README.md) for the native scheduler setup. Scheduled maintenance invokes the machine-readable refresh path hourly, with a boot delay and small jitter where the scheduler supports them. The fixed 75-minute threshold gives fifteen minutes of headroom beyond the hourly interval. A successful command reports each account as current or refreshed; any provider failure or unexpectedly short-lived replacement makes the command exit nonzero. Provider failures leave that account saved and continue to healthy accounts. Storage failures stop immediately. Check the service's exit status and journal after a failure. The maintenance module and README own the precise activation and rollback commands.

## Concurrency and session behavior

The selected credential in native `auth.json` is authoritative; pool snapshots of it are reconciled before every CLI operation. Nonselected credentials belong exclusively to the pool. The CLI serializes pool operations, then acquires Pi's existing `auth.json.lock` through `FileAuthStorageBackend.withLockAsync`; it never holds the locks in the opposite order. Pi and native subagents acquire only the native auth lock. Maintenance holds both locks while refreshing each account, and gives each network refresh fifteen seconds. Long maintenance runs can make native synchronous reloads temporarily retain their previous in-memory snapshot or make asynchronous readers wait; use an idle maintenance window if this matters.

Pi 1.3.0 `pi-ai/dist/auth/resolve.js` rechecks the current stored credential inside `AuthStorage.modify`, refreshes under the native lock, and persists before releasing the lock. A stale process therefore refreshes the currently selected account, rather than writing its old snapshot over a manual switch. If native refresh already owns the lock, selection waits, saves the refreshed previous account, then switches. Synthetic tests run two real native AuthStorage processes with stale snapshots concurrently with CLI maintenance after a switch and verify the selected identity and one refresh of the selected credential.

Native `AuthStorage.readLatestData` detects changes by device/inode/size/mtime/ctime; `Models` resolves auth through that store. Subsequent native resolution can see a switch without restarting. An already-started request or connection may continue using credentials already resolved, so selection does not interrupt active work or promise a mid-turn account boundary. Stop work at idle, select, then restart/resume the Pi or T3 session for a clean boundary. Native session files are unchanged. The source and storage tests establish rereading and refresh behavior; live T3 WebSocket/session behavior and paid inference have not been tested.

## Failure and recovery

CLI file updates use a private temporary file, fsync, atomic rename and directory fsync under the shared lock. Selection first saves a pending intent in the pool, writes native auth, then finalizes selection in the pool. On the next CLI operation, recovery either finishes the pending switch or recognizes that native auth already contains the target; a newer native refresh of that target is preserved. Before recovery replaces the previous account in native auth, it checkpoints that account's latest credential in the pool with the pending intent intact. A second interruption after native replacement therefore preserves a token rotated between the original interruption and recovery. A native login to an unrelated identity during interrupted selection is a conflict, not permission to overwrite it. Avoid Pi's `/login` and `/logout` while using this managed pool; use this CLI for account changes.

If a write fails, private `auth.json.recovery-*` or `accounts/pool.json.recovery-*` files may remain. Every later CLI operation refuses to proceed while these files exist, because one may contain the only rotated refresh token. Stop the timer and idle/stop Pi processes before recovery. Do not print, attach, or commit these files. Privately validate complete JSON, identity, expiry and pending selection against the destination; a complete recovery file from the failed write may replace its matching destination with mode 0600. Do not replay a stale recovery file over a newer healthy native credential. Preserve ambiguous material securely and perform a fresh Pi-owned login when the correct token cannot be established. Remove reviewed recovery files only after resolving their contents; then run `status` and `refresh` before restarting maintenance. A disk-full failure before any complete token file can be written may require login again; no local transaction can recover a token the provider rotated but the filesystem never accepted.

Pi itself writes `auth.json` in place with `writeFileSync`; only this CLI's writes are atomic. A crash or disk failure during native Pi persistence can leave corrupt native auth. The CLI fails closed on corrupt JSON and preserves the pool rather than assuming its selected snapshot is current. Stop native writers, restore a verified current native backup or perform a new login, and resolve the selected account's pool snapshot privately. The pool may hold an older selected refresh token, so blindly copying it back is unsafe. This accepted upstream limitation is not repaired by the CLI.

For a revoked selected login with structurally valid native auth, `pi-accounts login LABEL` repairs that same identity. For corrupt native auth, recovery requires restoring valid JSON before the normal CLI can run; avoid editing unrelated provider credentials. An unmanaged native login is deliberately refused and requires an operator-owned migration or removal decision, since copied Codex/CMA refresh credentials cannot safely gain a second refresh owner.

Removing the CLI or disabling its timer does not log out Pi or delete saved credentials. Retain the private pool until account recovery and rollback are complete; package removal must never prune runtime credentials.
