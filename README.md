# pi-accounts

Save Pi logins, see account details, select or rename accounts, check quota, and optionally refresh tokens hourly. Account switching is manual.

Requires an existing Pi **1.3.0** installation and Node.js **>=22.19.0**. Official curl-managed and npm installations are supported.

## Install or update

```bash
npm install --global 'https://github.com/genzorr/pi-accounts/releases/download/v0.1.1/pi-accounts-0.1.1.tgz'
pi-accounts --help
```

If maintenance is enabled, pause it and wait for an idle runner before updating; then reinstall maintenance. See [update and removal](docs/accounts.md#maintenance-updates-and-removal).

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
