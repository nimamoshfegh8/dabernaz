# Dabernaz Playwright audit

This branch contains a **read-only Chromium UI and route audit** for the code checked out from `test/playwright-audit`.

## Target and safety boundary

GitHub Actions starts the repository's Node fallback server locally at `http://127.0.0.1:8788`. Its JSON store is placed under the GitHub runner's temporary directory (`DABERNAZ_DATA_DIR`) and is discarded with the job. The workflow does not contact `dabernaz.pages.dev`, deploy a preview, or modify the production site.

Browser visits and navigation are used only to render pages. The Playwright request guard blocks same-origin methods other than `GET`, `HEAD`, and `OPTIONS` before they reach the local server. The audit does not create accounts, submit forms, buy cards, enter tournaments, change wallet balances, or call administrative write APIs. Server startup initializes only an empty temporary local data store.

Authenticated-only admin pages and workflows that require a test account are deliberately excluded. The local Node fallback is used for UI rendering and route checks; this suite is not a substitute for Cloudflare Pages/D1 integration tests.

## What is covered

- Home-page layout at 320, 360, 375, 390, 430, 768, 1024, 1366, and 1920 CSS-pixel widths.
- Additional mobile landscape sizes (844x390 and 932x430).
- Light and dark browser color-scheme emulation.
- RTL and Persian document metadata, main landmark, and bottom navigation.
- Public SPA routes: home, game lobby, four room-price pages, room game view, tournament pages, invite, wallet, account, settings, and support.
- Bottom navigation route changes.
- PWA install placement and short-landscape navigation geometry at 320x720, 360x800, 375x812, 390x844, 430x932, 768x1024, 844x390, and 932x430.
- Screenshots and diagnostics for horizontal overflow, small touch targets, small text, browser exceptions, failed requests, HTTP errors, and unexpected write-method requests.

The touch-target and small-text measurements are diagnostic heuristics, not a formal WCAG conformance claim. A screenshot is evidence of the rendered state, not proof that every backend workflow works.

## Run locally

Use Node.js 22 or later. Start the isolated local server in one terminal:

```bash
mkdir -p /tmp/dabernaz-playwright-data
NODE_ENV=test COOKIE_SECURE=false HOST=127.0.0.1 PORT=8788 \
  DABERNAZ_DATA_DIR=/tmp/dabernaz-playwright-data node server.js
```

In a second terminal, install and run Playwright against that local server:

```bash
npm install --no-save --package-lock=false @playwright/test@1.65.1
npx playwright install chromium
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8788 npx playwright test --config=playwright.config.js
```

Use a disposable data directory. Do not point mutation tests at production.

## Output

- `playwright-report/`: browsable HTML report.
- `test-results/`: screenshots, traces on failure, and test attachments/diagnostics.

The GitHub Actions workflow uploads these as the `dabernaz-playwright-audit` artifact for 14 days.

## Current execution status

The workflow and test definitions are committed on the separate audit branch. Test results are **not claimed until the GitHub Actions run completes**. A green result means only that the defined local, read-only browser checks passed for the checked target and run; it is not a full security audit, load test, financial-flow test, or authenticated end-to-end test.
