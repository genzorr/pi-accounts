# pi-accounts

Save Pi logins, check account status and quota, select an account manually, and refresh saved accounts hourly. This standalone CLI uses Pi's own OpenAI OAuth implementation and native `openai-codex` provider. It preserves Pi's selected model, effort, sessions and unrelated providers; it does not modify Codex or CMA. There is no automatic account rotation, inference proxy or credential helper on each model request.

## Install on a Mac or Linux laptop

Install **Node 22.19.0 or newer**, then install the reviewed Pi version independently:

```bash
node --version
npm install --global @earendil-works/pi-coding-agent@1.3.0
npm install --global 'https://github.com/genzorr/pi-accounts/releases/download/v0.1.0/pi-accounts-0.1.0.tgz'
pi-accounts --help
```

The release archive is installed through native npm; this package has no npm dependencies or install hooks. It is distributed through GitHub, with `private: true` preventing npm registry publication. If you prefer a pinned Git install and have Git available:

```bash
npm install --global 'git+https://github.com/genzorr/pi-accounts.git#v0.1.0'
```

Use your normal user-owned npm prefix; these commands should not need `sudo`. Pi 1.3.0 is deliberately required because its internal OAuth and lock APIs are reviewed together with this tool. A future Pi version requires requalification. Pi is found from the first `pi` executable on `PATH` and its real package location, or explicit `PI_PACKAGE_DIR`; see the [account contract](docs/accounts.md). The package does not bundle Pi or manage its installation.

## Add accounts and choose one

```bash
pi-accounts login personal
pi-accounts login work --device
pi-accounts list
pi-accounts select personal
pi-accounts status
pi-accounts rename personal primary
pi-accounts usage
pi-accounts usage work
```

Browser login is the default, including over SSH; paste the callback when a local callback is inconvenient. `--device` explicitly selects device-code login. Each label needs a Pi-owned login; do not import refresh tokens maintained independently by another tool. Login saves an account without selecting it. After selection, restart/resume an idle Pi/T3 session for a clean account boundary; active requests are not interrupted. OAuth login and a live T3 session remain human verification steps, not package-install side effects.

Status shows the active marker, label, optional email, UTC expiry and local health. Quota checks are best effort against the existing ChatGPT usage endpoint and do not run inference. Email may be unavailable. Use short labels such as `personal` and `work`; an email address is display metadata rather than the label or identity boundary. Add `--json` to status/list/usage/refresh for scripts. Full storage, concurrency and recovery details are in [docs/accounts.md](docs/accounts.md).

`PI_CODING_AGENT_DIR` selects the same agent home for Pi and this CLI; it defaults to `~/.pi/agent`. Credentials remain in `auth.json` and `accounts/pool.json`. Installation, updates, maintenance removal and npm uninstall do not delete them or change manual selection.

## Hourly maintenance

Preview and install the dedicated user-service files, then enable them explicitly:

```bash
pi-accounts maintenance install --dry-run
pi-accounts maintenance install
pi-accounts maintenance enable
pi-accounts maintenance status
```

Installation starts paused and performs no OAuth or refresh. The installed job retains the exact absolute Node executable, npm-installed CLI path, discovered Pi package root and selected agent directory. Reinstall maintenance after moving Node, Pi, the npm prefix, or the intended agent home. Its hourly wrapper calls `refresh --json` once per scheduled run, refreshing accounts due within 75 minutes without rotating selection. A failed account refresh exits nonzero; native logs contain only the CLI's projected results and safe errors, never credentials or provider error bodies.

Linux uses `systemd --user` with `pi-accounts-maintenance.service` and `.timer`, five minutes of boot delay and up to two minutes of jitter. It leaves earlier Agents-owned `pi-accounts-refresh` units alone. Inspect native state with:

```bash
systemctl --user list-timers pi-accounts-maintenance.timer
systemctl --user status pi-accounts-maintenance.service
journalctl --user -u pi-accounts-maintenance.service --since today
```

macOS uses `~/Library/LaunchAgents/io.github.genzorr.pi-accounts.plist`, a 3600-second interval and a run at load. It runs in your GUI login session; logs are `~/Library/Logs/pi-accounts/maintenance.log` and `maintenance.error.log`. Apple documents user LaunchAgents and timed jobs in [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and [Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html). This uses native `launchctl` enable/bootstrap/disable/bootout; templates and lifecycle are tested with stubs on Linux, but **actual macOS execution is unverified**.

```bash
launchctl print "gui/$(id -u)/io.github.genzorr.pi-accounts"
tail -n 30 "$HOME/Library/Logs/pi-accounts/maintenance.error.log"
```

A laptop cannot refresh while asleep or logged out, and this tool does not enable lingering or wake the computer. After a long sleep, inspect status and run `pi-accounts refresh` if necessary; an expired login may need a fresh Pi-owned login.

## Pause, update and uninstall

Disable scheduling before replacing code. If a refresh is running, disable returns nonzero after pausing future work; let it finish, then repeat disable. It never sends a kill or stop signal to an active refresh:

```bash
pi-accounts maintenance disable
pi-accounts maintenance status
# Continue after the maintenance runner is idle and disable succeeds:
pi-accounts maintenance uninstall
npm install --global 'https://github.com/genzorr/pi-accounts/releases/download/v0.1.0/pi-accounts-0.1.0.tgz'
pi-accounts maintenance install --dry-run
pi-accounts maintenance install
pi-accounts maintenance enable
```

For removal, disable and wait as above, then:

```bash
pi-accounts maintenance uninstall --dry-run
pi-accounts maintenance uninstall
npm uninstall --global pi-accounts
```

Maintenance ownership covers only its finite dedicated unit files. Modified or foreign files, including unowned old Agents units, are preserved; conflicts stop installation/removal rather than forcing changes. Uninstall preserves credentials, selection, logs and a small private pause/ownership tombstone so a concurrently starting old runner cannot refresh after removal. Reinstallation recognizes that record and starts paused. Linux state is `~/.local/state/pi-accounts-maintenance`; Mac state is `~/Library/Application Support/pi-accounts/maintenance`.

The scheduled wrapper atomically acquires a private `running` directory and rechecks the pause marker before starting refresh. Disable creates pause before inspecting that running marker, preventing a fresh launch from racing an unload. If a process crashes, a stale `running/pid` marker blocks maintenance changes. Inspect that PID and native service state, verify no associated refresh is alive, and only then remove that stale running directory manually. Do not remove the marker during token rotation. A failed unit-file update retains ownership intent for both old and new unchanged bytes, so retrying install or uninstall can reconcile a partial write. Run setup commands sequentially; simultaneous maintenance setup commands are not supported.

Keep account recovery files private. Never attach credentials, pools, auth files, logs containing OAuth URLs, or provider responses to an issue. This repository and release archive contain source and documentation only. See [NOTICE.md](NOTICE.md) for provenance and [LICENSE](LICENSE) for licensing.
