# Pi accounts

`pi-accounts` is a standalone Pi-only account CLI. It uses the supported installed Pi native auth storage and OpenAI OAuth implementation, keeps the canonical `openai-codex` provider, and leaves model, effort, sessions, settings, Codex and CMA unchanged. Each saved account needs its own Pi-owned login. It refuses an existing unmanaged native Pi credential instead of importing shared refresh tokens. There is no automatic account rotation or inference proxy.

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

See the [README](../README.md) for package installation and maintenance activation; update and removal commands are below. The package exposes `src/cli.mjs` as `pi-accounts` and carries its sibling modules together; it has no additional npm runtime dependencies. Node.js >=22.19.0 is required. Qualified native combinations are Pi 1.1.0 with pi-ai 1.1.0/1.2.0/1.3.0, Pi 1.2.0 with pi-ai 1.2.0/1.3.0, and Pi 1.3.0 with pi-ai 1.3.0. These include native hoisted dependencies. Version and required-capability checks run before account operations; future, prerelease, incompatible or missing APIs fail closed. Real released artifacts passed native concurrency, recovery and cancellation-durability tests for every combination. Pi 1.0.0 lacks the required cancellation-durable refresh contract and is rejected.

The tool searches `PATH` for the first executable `pi`, follows executable symlinks, and supports both npm installations and the [current official curl installer](https://pi.dev/install.sh)'s managed launcher. For the managed launcher, it validates `install/managed-install.json`, reads the active `install/current-version`, and follows that release's native `node_modules/.bin/pi` to its package. Custom installation roots and symlinked launchers work; discovery derives the installation from the actual command, not ambient `PI_CODING_AGENT_DIR` or `PI_MANAGED_INSTALL_ROOT`. A valid managed marker beside the command is also supported. Marker `entrypoint.path` metadata is not the active-release authority. Invalid markers, unsafe version names or a missing active release fail without selecting another Pi later on `PATH`.

This supports normal Linux and macOS managed/npm layouts without a particular home prefix. `PI_PACKAGE_DIR` remains an optional intentional package binding and takes precedence over `PATH`; normal official managed discovery does not require it. Pi's OAuth dependency follows Node's package search order from the selected package, supporting both nested and hoisted npm dependencies. Discovery does not execute the launcher, run OAuth, download dependencies or change the installation. The active package and its pi-ai dependency must form a qualified combination above. A newer installed Pi produces a compatibility error with the detected version; do not downgrade or relogin merely to repair discovery. The user's installed version cannot be inferred from the latest installer release. Synthetic tests qualify custom managed layouts and relocated npm layouts on Linux. An isolated Linux trial using the official 1.3.0 installer package/lock, its downloaded native dependencies and the exact managed launcher passed local status, empty refresh and help without a package override. Actual macOS execution remains unverified.

Maintenance installed against a managed launcher records its durable managed root and resolves `current-version` afresh for each scheduled refresh. It refuses an unsupported newly active version instead of refreshing through a retained old release. Existing maintenance records and installations created with `PI_PACKAGE_DIR` remain intentionally bound to that package. Pause maintenance, wait for an active runner to finish, remove the intentional override if appropriate, and reinstall its configuration through the update procedure below to capture the managed root. Normal npm replacement does not reactivate maintenance automatically; the update command below preserves its prior intent.

`PI_CODING_AGENT_DIR` selects Pi's agent home, default `~/.pi/agent`. The CLI resolves it once through Pi's native `resolvePath`: `~` and `~/...` expand to the user home, `file://` URLs become filesystem paths, and relative paths resolve from the current working directory. The resulting absolute path is shared by reads, locks and writes; paths are not trimmed or canonicalized through symlinks. Set the same home for Pi, its subagents and this CLI. Native credentials remain in `auth.json`; saved accounts live in `accounts/pool.json`. New private directories use mode 0700 and private files use mode 0600. Existing parent-directory permissions and ACLs remain operator-owned. Installation must not copy credentials. Source-only scratch checks use:

```bash
node --test tests/accounts.test.mjs tests/cli.test.mjs
PI_CODING_AGENT_DIR="$(mktemp -d)" node src/cli.mjs status
node src/cli.mjs help
```

Use `pi-accounts maintenance --help` and the [README](../README.md) for the native scheduler setup. Scheduled maintenance invokes the machine-readable refresh path hourly, with a boot delay and small jitter where the scheduler supports them. The fixed 75-minute threshold gives fifteen minutes of headroom beyond the hourly interval. A successful command reports each account as current or refreshed; any provider failure or unexpectedly short-lived replacement makes the command exit nonzero. Provider failures leave that account saved and continue to healthy accounts. Storage failures stop immediately. Check the service's exit status and journal after a failure. The README covers activation; the update and removal procedure below preserves account data.

## Maintenance updates and removal

`pi-accounts update` resolves the latest stable public GitHub release, validates its archive, and installs it into this command's actual global npm prefix. It works without loading Pi, even when native discovery or compatibility checks currently fail. It preserves absent, paused or enabled maintenance, its captured Pi/agent-home identity, credentials and manual selection. It does not update Pi or its plugins.

Updates serialize beside the installed package. An active/stale refresh returns retry guidance without killing it; finish the refresh and retry. If a refresh races with pause, scheduling stays paused and the update directory retains its original intent. After the updater and refresh are verified idle, follow the reported recovery instructions to restore that intent before retrying; a new update cannot silently adopt the temporary pause. npm failure attempts to restore the previous public package and maintenance intent. If recovery cannot finish, the private update directory retains only public tool files and recovery metadata; inspect the reported paths and instructions before retrying. Do not remove an update lock until its PID and any refresh are verified idle. The command does not coordinate arbitrary manual npm operations; keep installation work serial.

For an initial upgrade from 0.1.x, or manual recovery, identify the existing global prefix (do not assume the current npm default):

```bash
PI_ACCOUNTS_PREFIX="$(node -p "require('node:path').resolve(require('node:path').dirname(require('node:fs').realpathSync(process.argv[1])), '../../../..')" "$(command -v pi-accounts)")"
```

If maintenance is installed, pause it and wait for an idle runner; never kill token rotation. Then remove its files before a manual npm replacement. Its retained ownership record keeps the captured Node, Pi installation and agent home; `--reuse-runtime` restores that validated binding without rediscovering from the current shell. Record whether scheduling was enabled or paused, and restore that intent afterward. Use the prefix resolved above:

```bash
pi-accounts maintenance disable
pi-accounts maintenance status
pi-accounts maintenance uninstall
npm install --global --prefix "$PI_ACCOUNTS_PREFIX" --ignore-scripts --engine-strict https://github.com/genzorr/pi-accounts/releases/download/v0.2.0/pi-accounts-0.2.0.tgz
pi-accounts maintenance install --reuse-runtime
# Enable only if it was enabled before:
pi-accounts maintenance enable
pi-accounts maintenance status
```

If maintenance was absent, skip its commands; if paused, leave it paused. Subsequent updates need only `pi-accounts update`. When deliberately changing Pi installation identity, use the manual pause/wait/uninstall/reinstall path so maintenance captures that new binding rather than silently redirecting it.

For removal, disable and wait as above, then run:

```bash
pi-accounts maintenance uninstall --dry-run
pi-accounts maintenance uninstall
npm uninstall --global --prefix "$PI_ACCOUNTS_PREFIX" pi-accounts
```

Maintenance removal preserves credentials, selection, logs and its private pause/ownership tombstone. Modified or foreign service files remain conflicts. A stale `running/pid` marker blocks changes after a crash: inspect the PID and native service state, verify no associated refresh remains alive, then resolve that marker manually. Never remove it during token rotation. Run setup commands sequentially. Linux maintenance state lives under `~/.local/state/pi-accounts-maintenance`; macOS state lives under `~/Library/Application Support/pi-accounts/maintenance`. A sleeping or logged-out laptop cannot refresh; no wake or lingering configuration is added.

## Concurrency and session behavior

The selected credential in native `auth.json` is authoritative; pool snapshots of it are reconciled before every CLI operation. Nonselected credentials belong exclusively to the pool. The CLI serializes pool operations, then acquires Pi's existing `auth.json.lock` through `FileAuthStorageBackend.withLockAsync`; it never holds the locks in the opposite order. Pi and native subagents acquire only the native auth lock. Maintenance holds both locks while refreshing each account, and gives each network refresh fifteen seconds. Long maintenance runs can make native synchronous reloads temporarily retain their previous in-memory snapshot or make asynchronous readers wait; use an idle maintenance window if this matters.

The qualified native `pi-ai/dist/auth/resolve.js` rechecks the current stored credential inside `AuthStorage.modify`, refreshes under the native lock, and persists before releasing the lock. A stale process therefore refreshes the currently selected account, rather than writing its old snapshot over a manual switch. If native refresh already owns the lock, selection waits, saves the refreshed previous account, then switches. Synthetic tests run two real native AuthStorage processes with stale snapshots concurrently with CLI maintenance after a switch and verify the selected identity and one refresh of the selected credential.

Native `AuthStorage.readLatestData` detects changes by device/inode/size/mtime/ctime; `Models` resolves auth through that store. Subsequent native resolution can see a switch without restarting. An already-started request or connection may continue using credentials already resolved, so selection does not interrupt active work or promise a mid-turn account boundary. Stop work at idle, select, then restart/resume the Pi or T3 session for a clean boundary. Native session files are unchanged. The source and storage tests establish rereading and refresh behavior; live T3 WebSocket/session behavior and paid inference have not been tested.

## Failure and recovery

CLI file updates use a private temporary file, fsync, atomic rename and directory fsync under the shared lock. Selection first saves a pending intent in the pool, writes native auth, then finalizes selection in the pool. On the next CLI operation, recovery either finishes the pending switch or recognizes that native auth already contains the target; a newer native refresh of that target is preserved. Before recovery replaces the previous account in native auth, it checkpoints that account's latest credential in the pool with the pending intent intact. A second interruption after native replacement therefore preserves a token rotated between the original interruption and recovery. A native login to an unrelated identity during interrupted selection is a conflict, not permission to overwrite it. Avoid Pi's `/login` and `/logout` while using this managed pool; use this CLI for account changes.

If a write fails, private `auth.json.recovery-*` or `accounts/pool.json.recovery-*` files may remain. Every later CLI operation refuses to proceed while these files exist, because one may contain the only rotated refresh token. Stop the timer and idle/stop Pi processes before recovery. Do not print, attach, or commit these files. Privately validate complete JSON, identity, expiry and pending selection against the destination; a complete recovery file from the failed write may replace its matching destination with mode 0600. Do not replay a stale recovery file over a newer healthy native credential. Preserve ambiguous material securely and perform a fresh Pi-owned login when the correct token cannot be established. Remove reviewed recovery files only after resolving their contents; then run `status` and `refresh` before restarting maintenance. A disk-full failure before any complete token file can be written may require login again; no local transaction can recover a token the provider rotated but the filesystem never accepted.

Pi itself writes `auth.json` in place with `writeFileSync`; only this CLI's writes are atomic. A crash or disk failure during native Pi persistence can leave corrupt native auth. The CLI fails closed on corrupt JSON and preserves the pool rather than assuming its selected snapshot is current. Stop native writers, restore a verified current native backup or perform a new login, and resolve the selected account's pool snapshot privately. The pool may hold an older selected refresh token, so blindly copying it back is unsafe. This accepted upstream limitation is not repaired by the CLI.

For a revoked selected login with structurally valid native auth, `pi-accounts login LABEL` repairs that same identity. For corrupt native auth, recovery requires restoring valid JSON before the normal CLI can run; avoid editing unrelated provider credentials. An unmanaged native login is deliberately refused and requires an operator-owned migration or removal decision, since copied Codex/CMA refresh credentials cannot safely gain a second refresh owner.

Removing the CLI or disabling its timer does not log out Pi or delete saved credentials. Retain the private pool until account recovery and rollback are complete; package removal must never prune runtime credentials.
