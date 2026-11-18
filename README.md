# Web reader for DeepSeek Harness

The `@yu1745/dsh-web-reader` bundle provides `web_reader` for sites that require a real browser. It renders with Playwright Chromium, waits for readable content, and returns Markdown, text, an accessibility snapshot, or HTML. Calls can target a CSS selector, wait for a selector, or include a screenshot. Login, bot-verification, and error pages are reported separately from readable content. PDFs and downloads require a document extraction tool.

## Install

Requires DSH 0.2.2-rc.3 or a compatible 0.2.x release, Node.js 22 or newer, and Playwright Chromium. For a source checkout, run `npm ci`, then `npm run check`. Install Chromium with `npx playwright install chromium` if needed, then add the built directory through **Plugins → Add plugin**. Chromium's operating-system dependencies may also be required on Linux.

## Migrate from DSH Extensions

1. Disable the legacy `yu-web-reader` row (`@yu1745/dsh-extensions/web-reader`) before enabling the standalone bundle. If you still use other DSH Extensions plugins, keep their bundle installed. Both reader implementations register the `web_reader` tool name.
2. Add or enable `@yu1745/dsh-web-reader`. Its row ID is `yu-standalone-web-reader`. If you set `classifier.provider` or `classifier.model` on the old row, copy those values to the new row. Existing classifier settings in `$DSH_HOME/extensions/yu1745/settings.json` and DSH credentials are reused. Explicit row settings take precedence.
3. Open a new session and ask to run `web_reader` on an ordinary HTTPS page. Recheck tool visibility in any preset with custom restrictions. The standalone bundle registers at host level, so it can be inherited by presets without the old `yu-web-tools` glue. The built-in search and fetch configuration stays under the host or legacy bundle's control.
4. To revert, disable the standalone bundle, then re-enable the legacy `yu-web-reader` row.

The browser environment variables remain supported under `DSH_WEBREADER_`, including `LOCALE`, `CDP`, `GPU`, `MAXURL`, and `DEBUG`. The reader still works without a configured Jev classifier by using its local readiness checks. Inline screenshots require a Host attachment service.

## Verify a build

Run `npm run check` to rebuild the shipping artifact and exercise rendering, consent handling, readiness classification, local HTTP browser fixtures, and Host registration. Run `npm pack --dry-run` to review the distributed files.
