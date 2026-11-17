# Contributing

Thanks for helping improve Ad Recap.

## Reporting bugs and ideas

Open an [issue](https://github.com/chi-li-peppers/obsidian-ad-recap/issues/new/choose) and pick the bug or feature template. For bugs, include your Obsidian version, platform, which ad platform you use and the exact error message. Never paste tokens or account IDs.

## Development

The plugin is plain JavaScript with no build step and no dependencies.

1. Clone the repository into `<vault>/.obsidian/plugins/ad-recap/` of a test vault.
2. Enable **Ad Recap** in Settings → Community plugins. Turn on **Demo mode** to work without real accounts.
3. After editing `main.js` or `styles.css`, reload Obsidian (or use the Hot Reload plugin).
4. Run the tests before opening a pull request:

   ```bash
   node tests/run.js
   ```

## Pull requests

- Keep changes focused, one feature or fix per pull request.
- Add or update tests in `tests/run.js` when you change data parsing, date ranges or report output.
- Update `CHANGELOG.md` under an "Unreleased" heading.
- Follow the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).

## Releases

Bump `version` in `manifest.json`, add the same version to `versions.json` with the minimum Obsidian version, and push to `main`. The release workflow publishes `main.js`, `manifest.json` and `styles.css` automatically.
