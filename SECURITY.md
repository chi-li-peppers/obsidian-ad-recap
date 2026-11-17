# Security policy

## Supported versions

Only the latest release receives fixes.

## How Ad Recap handles your data

- The plugin sends requests only to `oauth2.googleapis.com`, `googleads.googleapis.com`, `graph.facebook.com` and the Google Sheet link you configure.
- No analytics, telemetry or third-party servers are involved.
- API tokens are stored in `.obsidian/plugins/ad-recap/data.json` inside your vault. Anyone with access to your vault files can read them, so be careful with shared or public vaults, and exclude this file from public Git repositories.
- Use read-only credentials where possible: a Meta system user token with only `ads_read`, and a Google account with read access to the ad accounts.

## Verifying release files

Every release file is attested by GitHub Actions. To check that a downloaded `main.js` was built from this repository:

```bash
gh attestation verify main.js --repo chi-li-peppers/obsidian-ad-recap
```

## Reporting a vulnerability

Please do not open a public issue for security problems. Use [GitHub private vulnerability reporting](https://github.com/chi-li-peppers/obsidian-ad-recap/security/advisories/new) instead. You should get a reply within 7 days.
