# Provenance

pi-accounts is a custom, minimal Pi-only account pool, manual switch and maintenance CLI. It began as account-setup work in genzorr/agents; this repository is its canonical source. Agents owns its separate permission and instruction assets and does not maintain a second auth implementation.

The package uses the separately installed `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.3.0 OAuth, path and credential-storage primitives. Those packages are runtime dependencies supplied by the user's Pi installation; their source and licenses are not bundled into this package. See [Pi](https://github.com/earendil-works/pi) for the upstream implementation and licensing.

codex-multi-auth 2.19.0's MIT-licensed identity/display source was inspected as a user-interface reference. No nontrivial CMA code, identity algorithm, schema, refresh-token fallback, dependencies or state ownership were adopted. pi-accounts is not built on CMA. Account/workspace ID remains the native identity; optional email is display metadata. The parser, display and small pool logic use custom standard-library code around Pi's primitives.
