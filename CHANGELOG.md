# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-23

### Added

- **Obsidian Secret Storage** support (Obsidian 1.11.4+): store API tokens outside `data.json`, with a one-click **Move to Secrets** button for existing tokens and automatic fallback on older Obsidian versions.
- **Periodic Notes** plugin support for daily note detection alongside Obsidian's core Daily notes plugin.
- **Meta Ads click metric** setting: defaults to **Link clicks** (`inline_link_clicks`) so CTR/CPC compare cleanly with Google Ads, with an option to switch back to **All clicks**.
- **Live block options**: `account`, `filter`, `sort` (`spend`, `cpa`, `roas`, `conversions`, `clicks`, `impressions`, `ctr`, `cpc`), `currency`, `target_cpa` and `limit`, plus a **Copy** button to copy the rendered Markdown table.
- **ROAS period-over-period delta** (`▲`/`▼`) in the report summary line.
- **Wasted spend flag**: campaigns spending above Target CPA with `0` conversions now receive a 🔴 flag.
- **Extended daily note properties**: added `ads_impressions`, `ads_value`, `ads_google_spend` and `ads_meta_spend`.
- **Mixed currency warning** when accounts return different currency codes.
- **Per-account resilience**: if one ad account fails in a multi-account setup, working accounts still render alongside a warning.

### Fixed

- Typing in settings no longer fires live API requests on every keystroke; text inputs are debounced and live block redraws guard against out-of-order renders and unloaded components.
- Cached Google OAuth access tokens are now cleared immediately whenever settings change.
- Google Sheet mode now handles locale-formatted dates (`MM/DD/YYYY`, `DD.MM.YYYY`, ISO timestamps), currency/thousands-formatted numbers (`$1,234.56`, `1.234,56`, `1 234,56`), caches the CSV across current + previous period requests, and validates `https://` URLs.
- Updated `scripts/google-ads-to-sheet.js` to export 90 days including today, keep 0-impression conversions, and format the date column as plain text (`@`) so Google Sheets never rewrites dates.
- Google Ads API GAQL query no longer filters `metrics.impressions > 0`, preserving delayed conversions and adjustments.
- `replaceSection` now supports headings at `###` or deeper (platform subheadings scale dynamically), ignores headings inside fenced code blocks, and supports optional `<!-- ad-recap:start -->` / `<!-- ad-recap:end -->` markers.
- Multi-account campaigns with identical names (e.g. "Brand") are disambiguated as `Campaign (Account)` instead of silently merging.
- Meta Ads access token is now sent via `Authorization: Bearer` header instead of the URL query string.
- Automatic daily note insertion skips notes whose Ads section is already populated (preventing sync conflicts across devices), cleans up pending timers on unload, and never writes demo or partial-failure totals into note frontmatter.
- Stale `ads_roas` frontmatter is now cleared to `null` when a period has no ROAS, and negative currency values format as `-$12.50` instead of `$-12.50`.
- Release workflow now runs all syntax, manifest and unit tests before publishing and will not overwrite an existing release tag.

### Changed

- Default Meta Marketing API version updated to `v27.0` (API versions are also auto-normalised, e.g. `27` → `v27.0`).

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

[1.1.0]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.1.0
[1.0.3]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.3
[1.0.2]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.2
[1.0.1]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.1
[1.0.0]: https://github.com/chi-li-peppers/obsidian-ad-recap/releases/tag/1.0.0
