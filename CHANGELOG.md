# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.3] - 2026-11-18

### Added

- Star and feedback links at the top of the settings tab and in the README.

## [1.0.2] - 2026-11-18

### Added

- Release assets now come with GitHub artifact attestations. Verify them with `gh attestation verify main.js --repo chi-li-peppers/obsidian-ad-recap`.

## [1.0.1] - 2026-11-17

### Fixed

- Demo mode could look inverted: open live blocks kept showing results from before the toggle. Live blocks now redraw as soon as settings change, demo reports carry a "Demo data" label, and toggling shows a confirmation notice.
- "Test Google Ads" / "Test Meta Ads" no longer call the real API while demo mode is on; they explain how to test a real account instead.
- Clicking a Test button several times no longer starts parallel tests and stacked "testing…" notices. The button is disabled while a test runs.

### Changed

- Boolean settings are normalised on load, so hand-edited `data.json` values like `"false"` behave correctly.

## [1.0.0] - 2026-11-17

### Added

- Google Ads support through the Google Ads API (v26) or a Google Sheet filled by a Google Ads script, for accounts without a developer token
- Meta Ads support through the Marketing API (v26.0) with configurable conversion actions
- Campaign tables with spend, impressions, clicks, CTR, CPC, conversions, CPA and ROAS
- Comparison against the previous period of the same length
- Target CPA flags
- Daily note automation and note properties (`ads_spend`, `ads_clicks`, `ads_conversions`, `ads_cpa`, `ads_roas`)
- `ad-recap` live code block with refresh
- Demo mode with sample data
- Desktop and mobile support

[1.0.3]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.3
[1.0.2]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.2
[1.0.1]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.1
[1.0.0]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.0
