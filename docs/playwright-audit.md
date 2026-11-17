# Dabernaz Playwright audit

This branch adds a **read-only Chromium browser audit**. It does not add account credentials, create accounts, submit forms, buy cards, enter tournaments, update wallet balances, or call admin write APIs.

## Target and safety boundary

The GitHub Actions workflow targets the public site at `https://dabernaz.pages.dev`. Browser visits and navigation are used only to render pages. The tests record same-origin requests and fail if a request other than `GET`, `HEAD`, or `OPTIONS` is attempted. No purchase, deposit, withdrawal, reward, support submission, or game move is triggered.

Authenticated-only admin pages and workflows that require a test account are deliberately excluded. They must be tested separately against an isolated test deployment and test database after those credentials and that environment are explicitly provisioned.

## What is covered

- Home-page layout at 320, 360, 375, 390, 430, 768, 1024, 1366, and 1920 CSS-pixel widths.
- Additional mobile landscape sizes (844x390 and 932x430).
- Light and dark browser color-scheme emulation.
- RTL and Persian document metadata, main landmark, and bottom navigation.
- Public SPA routes: home, game lobby, four room-price pages, room game view, tournament pages, invite, wallet, account, settings, and support.
- Bottom navigation route changes.
- Screenshots and diagnostics for horizontal overflow, small touch targets, small text, browser exceptions, failed requests, HTTP errors, and unexpected write-method requests.

The touch-target and small-text measurements are diagnostic heuristics, not a formal WCAG conformance claim. A screenshot is evidence of the rendered state, not proof that every backend workflow works.

## Run locally

Use Node.js 22 or later:

```bash
npm install --no-save --package-lock=false @playwright/test@1.65.1
npx playwright install chromium
PLAYWRIGHT_BASE_URL=https://dabernaz.pages.dev npx playwright test --config=playwright.config.js
```

For a local isolated Pages/D1 environment, set `PLAYWRIGHT_BASE_URL` to that local URL. Do not point account, wallet, card-purchase, or tournament mutation tests at production.

## Output

- `playwright-report/`: browsable HTML report.
- `test-results/`: screenshots, traces on failure, and test attachments/diagnostics.

The GitHub Actions workflow uploads these as the `dabernaz-playwright-audit` artifact for 14 days.

## Current execution status

The workflow and test definitions are committed on the separate audit branch. Test results are **not claimed until the GitHub Actions run completes**. A green result means only that the defined read-only browser checks passed for the checked target and run; it is not a full security audit, load test, financial-flow test, or authenticated end-to-end test.
