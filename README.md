# pi-accounts

Save Pi logins, see account details, select or rename accounts, check quota, and optionally refresh tokens hourly. Account switching is manual.

Requires Node.js **>=22.19.0** and a [supported native Pi installation](docs/accounts.md#runtime-and-installation). Official curl-managed and npm installations are supported.

## Install or update

```bash
npm install --global 'https://github.com/genzorr/pi-accounts/releases/download/v0.2.0/pi-accounts-0.2.0.tgz'
pi-accounts --help
```

Then use `pi-accounts update`: it installs the latest public release into the same prefix and preserves maintenance intent. For an existing 0.1.x installation, follow the one-time [upgrade procedure](docs/accounts.md#maintenance-updates-and-removal).

## Accounts

```bash
pi-accounts login personal
pi-accounts list
pi-accounts select personal
pi-accounts status
pi-accounts rename personal primary
pi-accounts usage
```

Browser login is the default; `login work --device` optionally uses device-code login, often convenient remotely. Short labels identify saved accounts; email is optional display metadata. Restart/resume an idle Pi session after selection for a clean account boundary.

## Optional hourly maintenance

```bash
pi-accounts maintenance install --dry-run
pi-accounts maintenance install
pi-accounts maintenance enable
pi-accounts maintenance status
```

Uses systemd on Linux or launchd on macOS. `maintenance disable` pauses future work without killing a running refresh. Removal preserves saved accounts.

See the [account reference](docs/accounts.md) for JSON output, quota, maintenance inspection/removal and private recovery; [installation diagnostics](docs/accounts.md#runtime-and-installation) for discovery or version errors. Actual macOS execution remains unverified.

[MIT license](LICENSE) · [Provenance](NOTICE.md)
