# Pi accounts

See the [README](../README.md) for installation, account commands and optional hourly refresh.

## Runtime and installation

Requires Node.js >=22.19.0. Supported native versions:

| Pi | pi-ai |
| --- | --- |
| 1.1.0 | 1.1.0, 1.2.0, 1.3.0 |
| 1.2.0 | 1.2.0, 1.3.0 |
| 1.3.0 | 1.3.0 |

Future, prerelease, incompatible or missing native APIs fail closed. For discovery errors, check `command -v pi`, `pi --version`, and any `PI_PACKAGE_DIR` override. The first executable Pi on `PATH` determines the installation; npm symlinks and the official curl-managed launcher are supported. Managed discovery follows its active release, including custom roots; an invalid managed installation fails rather than falling back to another Pi. Do not relogin or downgrade merely to repair discovery.

`PI_PACKAGE_DIR` intentionally overrides discovery with a native package directory. `PI_CODING_AGENT_DIR` selects the agent home, default `~/.pi/agent`; use the same home for Pi, subagents and this CLI. Native credentials live in `auth.json`, saved accounts in `accounts/pool.json`. Maintenance captures its Node, Pi installation and agent home; subsequent shell overrides do not redirect it. Managed maintenance revalidates the active release each run.

## Maintenance updates and removal

For current installations, `pi-accounts update` updates this tool in its actual global npm prefix, preserves absent/paused/enabled maintenance and its runtime binding, and works even when Pi discovery fails. It does not update Pi. Keep installation work serial; it cannot coordinate arbitrary manual npm operations.

### Upgrade from 0.1.x

Before manual replacement, resolve the existing prefix rather than assuming the current npm default:

```bash
PI_ACCOUNTS_PREFIX="$(node -p "require('node:path').resolve(require('node:path').dirname(require('node:fs').realpathSync(process.argv[1])), '../../../..')" "$(command -v pi-accounts)")"
```

If maintenance is installed, record whether it is enabled or paused, then run:

```bash
pi-accounts maintenance status
pi-accounts maintenance disable
pi-accounts maintenance status
```

Continue only after disable succeeds and the runner is idle. If active, let it finish and rerun disable; never kill token rotation. Then remove the owned service files:

```bash
pi-accounts maintenance uninstall
```

After successful uninstall, replace the package in the resolved prefix. If maintenance was absent, skip its commands and start here:

```bash
npm install --global --prefix "$PI_ACCOUNTS_PREFIX" --ignore-scripts --engine-strict https://github.com/genzorr/pi-accounts/releases/download/v0.2.2/pi-accounts-0.2.2.tgz
```

For previously installed maintenance, restore its retained runtime without discovering from the current shell:

```bash
pi-accounts maintenance install --reuse-runtime
```

Installation is paused. Run `pi-accounts maintenance enable` only if previously enabled, then check `maintenance status`. Subsequent upgrades use `pi-accounts update`. To deliberately change the captured Pi/agent-home binding, pause and wait as above, then use ordinary `maintenance install` with the intended environment instead of `--reuse-runtime`.

### Interrupted updates

An already-running refresh blocks update without changes: wait and retry. If a refresh races with pause, or automatic rollback cannot finish, the update lock retains public package backups and `recovery.json` with the original maintenance intent. Follow the printed recovery instructions. Verify the updater PID and every refresh are idle before removing a lock or replacing code; preserve the backup until recovery is verified. Restore the recorded runtime with `maintenance install --reuse-runtime` and its original enabled/paused intent before retrying.

### Removal

Resolve the prefix as above. If maintenance is installed, disable it, wait for an idle runner, then uninstall its service files before removing the package:

```bash
pi-accounts maintenance uninstall --dry-run
pi-accounts maintenance uninstall
```

After successful maintenance uninstall (or if maintenance was absent):

```bash
npm uninstall --global --prefix "$PI_ACCOUNTS_PREFIX" pi-accounts
```

Removal preserves credentials, selection, logs and the private ownership/pause record; it does not log out Pi. Foreign or modified service files remain conflicts. Maintenance state is under `~/.local/state/pi-accounts-maintenance` on Linux or `~/Library/Application Support/pi-accounts/maintenance` on macOS. For a stale `running/pid` marker, inspect the PID and native service state and verify no associated refresh is alive before resolving the marker manually.

## Concurrency and session behavior

Selection does not interrupt credentials already used by an active request. Switch at idle, then restart/resume Pi or T3 for a clean boundary. Use this CLI for managed account changes; avoid Pi's `/login` and `/logout` against the same pool. Existing unmanaged native logins are refused and require a separate operator-owned migration/removal decision; do not copy Codex/CMA refresh credentials into the pool.

## Failure and recovery

Local expiry does not prove server acceptance. If Pi reports an expired token while `status` says current, run `pi-accounts refresh --force`, then `pi-accounts usage`. Force refresh targets only the selected account unless a label is supplied; ordinary refresh and hourly maintenance keep the 75-minute threshold. A successful refresh means credentials were renewed and saved, not that every API request will succeed. If renewal fails or the server still rejects the credential, `pi-accounts login LABEL` repairs that same saved identity. Optional email is not an identity key.

Private `auth.json.recovery-*` or `accounts/pool.json.recovery-*` files may contain the only rotated refresh token and block further account operations. Disable maintenance and wait for refreshes and native writers to stop before recovery. Never print, attach or commit credential files. Privately compare complete JSON, identity, expiry and pending selection against the destination; only a verified current recovery file may replace its matching destination, with mode 0600. Never replay an older file over newer native auth. Preserve ambiguous material securely; if the current token cannot be established, a fresh Pi-owned login may be necessary.

Pi writes native `auth.json` in place, so a crash or disk failure can corrupt it. The CLI fails closed; its selected pool snapshot may contain an older token and must not be copied back blindly. Restore verified current native JSON before normal CLI operations can repair a login, preserving unrelated provider entries. If the provider rotated a token before the filesystem accepted any complete copy, local recovery may be impossible.

Remove reviewed recovery files only after resolving their contents, then run `pi-accounts status` and `pi-accounts refresh` before restoring maintenance's previous intent. Keep the private pool until recovery and rollback are complete; package removal must never prune credentials.
