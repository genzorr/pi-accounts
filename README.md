# pi-accounts

Save Pi logins, switch accounts manually, check quota, and optionally refresh tokens hourly. Requires Node.js **>=22.19.0** and a [supported native Pi installation](docs/accounts.md#runtime-and-installation).

## Install or update

**Already installed?** On 0.2.x or later, run:

```bash
pi-accounts update
```

For **0.1.x**, follow the [maintenance-safe upgrade procedure](docs/accounts.md#maintenance-updates-and-removal) before replacing the package. Updates use the existing installation's npm prefix and preserve maintenance intent.

For a **fresh installation**:

```bash
npm install --global --ignore-scripts --engine-strict 'https://github.com/genzorr/pi-accounts/releases/download/v0.2.2/pi-accounts-0.2.2.tgz'
pi-accounts --help
```

## Accounts

```bash
pi-accounts login personal
pi-accounts select personal
pi-accounts list
pi-accounts usage
pi-accounts rename personal primary
```

Browser login is the default and supports a pasted callback remotely; `login work --device` optionally uses device-code login. Login saves without selecting. Use short labels such as `personal` or `work`; email is optional display metadata. Select at idle, then restart/resume Pi or T3 for a clean account boundary.

`list` and `status` check local expiry; quota from `usage` is best effort. Run `refresh` to renew accounts due within 75 minutes. If Pi rejects a token despite a future expiry, run `pi-accounts refresh --force` to renew the selected account, then `pi-accounts usage` to check server acceptance. `refresh LABEL --force` targets another saved account without switching. Add `--json` to list, status, usage or refresh for scripts.

## Optional hourly maintenance

```bash
pi-accounts maintenance install
pi-accounts maintenance enable
pi-accounts maintenance status
```

Uses systemd on Linux or launchd on macOS. `maintenance disable` pauses future work without killing an active refresh. A sleeping or logged-out laptop cannot refresh. Actual macOS execution remains unverified.

See the reference for [discovery and compatibility](docs/accounts.md#runtime-and-installation), [safe upgrades and removal](docs/accounts.md#maintenance-updates-and-removal), and [private recovery](docs/accounts.md#failure-and-recovery).

[MIT license](LICENSE) · [Provenance](NOTICE.md)
