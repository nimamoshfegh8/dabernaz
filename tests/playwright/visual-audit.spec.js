const { test, expect } = require('@playwright/test');

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://dabernaz.pages.dev';
const targetOrigin = new URL(baseURL).origin;

const viewports = [
  { width: 320, height: 800, label: 'mobile-320' },
  { width: 360, height: 800, label: 'mobile-360' },
  { width: 375, height: 812, label: 'mobile-375' },
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 430, height: 932, label: 'mobile-430' },
  { width: 768, height: 1024, label: 'tablet-portrait-768' },
  { width: 1024, height: 768, label: 'tablet-landscape-1024' },
  { width: 1366, height: 900, label: 'desktop-1366' },
  { width: 1920, height: 1080, label: 'desktop-1920' },
  { width: 844, height: 390, label: 'mobile-landscape-844' },
  { width: 932, height: 430, label: 'mobile-landscape-932' }
];

const colorSchemes = ['light', 'dark'];

function redactErrorMessage(message) {
  return String(message)
    .replace(/https?:\/\/[^\s)"']+/g, '[redacted-url]')
    .replace(/\b(password|token|secret|authorization|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/ig, '$1$2[REDACTED]');
}
async function observePage(page) {
  const diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    httpErrors: [],
    mutatingRequests: []
  };

  // Block same-origin write methods before they can reach the public site.
  await page.route('**/*', async route => {
    const request = route.request();
    const method = request.method().toUpperCase();
    let url;
    try { url = new URL(request.url()); } catch (_) {
      await route.continue();
      return;
    }

    if (url.origin === targetOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      diagnostics.mutatingRequests.push({ method, path: url.pathname });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  page.on('pageerror', error => {
    diagnostics.pageErrors.push({
      name: error.name || 'Error',
      message: redactErrorMessage(error.message || 'Uncaught browser exception')
    });
  });
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(redactErrorMessage(message.text()));
  });
  page.on('requestfailed', request => {
    let path = '[unavailable]';
    try { path = new URL(request.url()).pathname; } catch (_) {}
    diagnostics.failedRequests.push({
      method: request.method(),
      path,
      error: redactErrorMessage(request.failure()?.errorText || 'unknown')
    });
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      let path = '[unavailable]';
      try { path = new URL(response.url()).pathname; } catch (_) {}
      diagnostics.httpErrors.push({
        status: response.status(),
        path
      });
    }
  });

  return diagnostics;
}
async function openHome(page) {
  await page.goto('/#page=home', { waitUntil: 'domcontentloaded' });
  await page.locator('#appView').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const root = document.querySelector('#appView');
    return !!root && root.children.length > 0 && root.textContent.trim().length > 0;
  }, null, { timeout: 20_000 });
}

async function attachDiagnostics(testInfo, diagnostics, layout = null) {
  const report = { ...diagnostics, layout };
  await testInfo.attach('browser-diagnostics.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json'
  });
}

for (const colorScheme of colorSchemes) {
  for (const viewport of viewports) {
    test('homepage layout ' + colorScheme + ' ' + viewport.width + 'x' + viewport.height, async ({ page }, testInfo) => {
      const diagnostics = await observePage(page);
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openHome(page);

      const layout = await page.evaluate(() => {
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== 'none' && style.visibility !== 'hidden';
        };

        const root = document.documentElement;
        const body = document.body;
        const documentWidth = Math.max(root.scrollWidth, body.scrollWidth);
        const overflowElements = Array.from(body.querySelectorAll('*'))
          .filter(element => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.left < -1 || rect.right > window.innerWidth + 1;
          })
          .slice(0, 25)
          .map(element => ({
            tag: element.tagName.toLowerCase(),
            className: String(element.className?.baseVal || element.className || '').slice(0, 100),
            id: element.id || '',
            left: Math.round(element.getBoundingClientRect().left),
            right: Math.round(element.getBoundingClientRect().right),
            width: Math.round(element.getBoundingClientRect().width)
          }));

        const smallTargets = Array.from(document.querySelectorAll(
          'button, a, input, select, textarea, [role="button"], [role="switch"]'
        )).filter(visible).map(element => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim().slice(0, 70),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
        }).filter(target => target.width < 44 || target.height < 44).slice(0, 40);

        const smallText = Array.from(body.querySelectorAll('*'))
          .filter(element => element.children.length === 0 && visible(element))
          .map(element => ({
            tag: element.tagName.toLowerCase(),
            className: String(element.className?.baseVal || element.className || '').slice(0, 80),
            text: (element.textContent || '').trim().slice(0, 50),
            fontSize: Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10
          }))
          .filter(item => item.text && item.fontSize < 12)
          .slice(0, 40);

        return {
          viewportWidth: window.innerWidth,
          documentWidth,
          documentHeight: Math.max(root.scrollHeight, body.scrollHeight),
          hasMainContent: !!document.querySelector('main#appView') && body.innerText.trim().length > 0,
          language: root.lang,
          direction: root.dir,
          overflowElements,
          smallTargets,
          smallText
        };
      });

      const screenshotPath = testInfo.outputPath(
        'home-' + colorScheme + '-' + viewport.width + 'x' + viewport.height + '.png'
      );
      await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
      await testInfo.attach('homepage-' + colorScheme + '-' + viewport.label, {
        path: screenshotPath,
        contentType: 'image/png'
      });
      console.log('[PLAYWRIGHT_LAYOUT]', JSON.stringify({
        viewport: viewport.width + 'x' + viewport.height,
        colorScheme,
        documentWidth: layout.documentWidth,
        overflowCount: layout.overflowElements.length,
        smallTargetCount: layout.smallTargets.length,
        smallTextCount: layout.smallText.length,
        smallTargetSamples: layout.smallTargets.slice(0, 6).map(({ tag, width, height }) => ({ tag, width, height })),
        smallTextSamples: layout.smallText.slice(0, 6).map(({ tag, fontSize }) => ({ tag, fontSize }))
      }));
      await attachDiagnostics(testInfo, diagnostics, layout);

      expect(layout.hasMainContent, 'homepage must render main content').toBe(true);
      expect(layout.language, 'document language should be Persian').toBe('fa');
      expect(layout.direction, 'document direction should be RTL').toBe('rtl');
      expect(
        layout.documentWidth,
        'horizontal overflow at ' + viewport.width + 'px in ' + colorScheme + ' mode'
      ).toBeLessThanOrEqual(viewport.width + 1);
      expect(diagnostics.pageErrors, 'uncaught browser errors').toEqual([]);
      expect(diagnostics.mutatingRequests, 'this audit must not send write requests').toEqual([]);
      expect(
        diagnostics.httpErrors.filter(item => item.status >= 500),
        'server errors while loading the homepage'
      ).toEqual([]);
    });
  }
}

test('API health accurately reports D1 schema and room coordinator readiness', async ({ page }, testInfo) => {
  const diagnostics = await observePage(page);
  const response = await page.goto('/api/health', { waitUntil: 'domcontentloaded' });
  expect(response, 'API health navigation should return a response').not.toBeNull();
  const body = JSON.parse((await page.locator('body').textContent()) || '{}');
  await testInfo.attach('api-health.json', {
    body: Buffer.from(JSON.stringify({ status: response.status(), body }, null, 2)),
    contentType: 'application/json'
  });

  expect(response.status(), 'API health endpoint should be observable').toBeLessThan(500);
  expect(body.service).toBe('dabernaz');
  if (body.backend === 'cloudflare-pages-functions') {
    expect(body.database).toBe('D1');
    expect(body.schema).toBe('v1');
    expect(typeof body.roomCoordinator?.available).toBe('boolean');
    expect(typeof body.walletRequests?.idempotency).toBe('boolean');
    expect(['ready', 'degraded']).toContain(body.readiness);
    if (!body.roomCoordinator.available) {
      expect(body.readiness).toBe('degraded');
      expect(body.unavailableFeatures).toContain('paid_rooms');
    }
    if (!body.walletRequests.idempotency) {
      expect(body.readiness).toBe('degraded');
      expect(body.unavailableFeatures).toContain('wallet_request_submission');
    }
  } else {
    expect(body.backend).toBe('node');
    expect(body.mode).toBe('isolated-test-only');
  }
  await attachDiagnostics(testInfo, diagnostics);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.mutatingRequests).toEqual([]);
});

test('public pages render without submitting forms or changing account state', async ({ page }, testInfo) => {
  const diagnostics = await observePage(page);
  const routes = [
    { id: 'home', hash: '/#page=home' },
    { id: 'games', hash: '/#page=games' },
    { id: 'room5000', hash: '/#page=room5000' },
    { id: 'room10000', hash: '/#page=room10000' },
    { id: 'room20000', hash: '/#page=room20000' },
    { id: 'room50000', hash: '/#page=room50000' },
    { id: 'roomGame', hash: '/#page=roomGame&room=room5000' },
    { id: 'tournaments', hash: '/#page=tournaments' },
    { id: 'tournamentRoom', hash: '/#page=tournamentRoom' },
    { id: 'bingoTournament', hash: '/#page=bingoTournament' },
    { id: 'invite', hash: '/#page=invite' },
    { id: 'wallet', hash: '/#page=wallet' },
    { id: 'account', hash: '/#page=account' },
    { id: 'settings', hash: '/#page=settings' },
    { id: 'support', hash: '/#page=support' }
  ];

  await page.setViewportSize({ width: 390, height: 844 });
  const routeResults = [];

  for (const route of routes) {
    await page.goto(route.hash, { waitUntil: 'domcontentloaded' });
    await page.locator('#appView').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const root = document.querySelector('#appView');
      return !!root && root.children.length > 0 && root.textContent.trim().length > 0;
    }, null, { timeout: 20_000 });

    const state = await page.evaluate(() => ({
      page: new URLSearchParams(location.hash.replace(/^#/, '')).get('page'),
      textLength: (document.querySelector('#appView')?.innerText || '').trim().length,
      title: document.title
    }));

    routeResults.push({ route: route.id, ...state });
    const screenshotPath = testInfo.outputPath('route-' + route.id + '.png');
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
    await testInfo.attach('route-' + route.id, { path: screenshotPath, contentType: 'image/png' });

    expect(state.page, 'requested route should remain selected: ' + route.id).toBe(route.id);
    expect(state.textLength, 'route should render visible content: ' + route.id).toBeGreaterThan(0);
  }

  await attachDiagnostics(testInfo, { ...diagnostics, routeResults });
  expect(diagnostics.pageErrors, 'uncaught browser errors while visiting public routes').toEqual([]);
  expect(diagnostics.mutatingRequests, 'page visits must not send write requests').toEqual([]);
  expect(
    diagnostics.httpErrors.filter(item => item.status >= 500),
    'server errors while visiting public routes'
  ).toEqual([]);
});

test('bottom navigation opens the expected public sections', async ({ page }, testInfo) => {
  const diagnostics = await observePage(page);
  const navPages = ['home', 'games', 'tournaments', 'support', 'invite', 'wallet', 'account', 'settings'];
  await page.setViewportSize({ width: 390, height: 844 });
  await openHome(page);

  const visited = [];
  for (const route of navPages) {
    await page.locator('.bottom-nav [data-page="' + route + '"]').click();
    await expect.poll(async () => page.evaluate(() => (
      new URLSearchParams(location.hash.replace(/^#/, '')).get('page')
    ))).toBe(route);
    await expect(page.locator('#appView')).not.toBeEmpty();
    visited.push(route);
  }

  await attachDiagnostics(testInfo, { ...diagnostics, visited });
  expect(diagnostics.pageErrors, 'navigation must not produce uncaught browser errors').toEqual([]);
  expect(diagnostics.mutatingRequests, 'navigation must not send write requests').toEqual([]);
});


test('PWA install action and short-landscape navigation do not cover page content', async ({ page }, testInfo) => {
  const diagnostics = await observePage(page);
  await page.emulateMedia({ colorScheme: 'dark' });

  const viewports = [
    { width: 320, height: 720 },
    { width: 360, height: 800 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
    { width: 932, height: 430 }
  ];
  const checks = [];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await openHome(page);

    const layout = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      const install = document.querySelector('.pwa-install-entry');
      const main = document.querySelector('main#appView');
      const nav = document.querySelector('nav.bottom-nav');
      const box = element => {
        const rect = element.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
      };
      const installStyle = install ? getComputedStyle(install) : null;
      const navStyle = nav ? getComputedStyle(nav) : null;
      const mainStyle = main ? getComputedStyle(main) : null;
      const installBox = install ? box(install) : null;
      const mainBox = main ? box(main) : null;
      const navBox = nav ? box(nav) : null;
      const shortLandscape = matchMedia('(orientation: landscape) and (max-height: 520px)').matches;

      return {
        installVisible: !!install && installBox.height > 0 && installStyle.display !== 'none',
        installPosition: installStyle?.position || null,
        installAfterHeader: !!topbar && topbar.nextElementSibling === install,
        installBeforeMain: !!installBox && !!mainBox && installBox.bottom <= mainBox.top + 1,
        navPosition: navStyle?.position || null,
        navAfterMain: !!navBox && !!mainBox && navBox.top >= mainBox.bottom - 1,
        navHeight: navBox?.height || 0,
        mainBottomPadding: mainStyle ? parseFloat(mainStyle.paddingBottom) : 0,
        shortLandscape
      };
    });

    checks.push({ viewport: viewport.width + 'x' + viewport.height, ...layout });
    expect(layout.installVisible, 'install action visible at ' + viewport.width + 'x' + viewport.height).toBe(true);
    expect(layout.installPosition, 'install action remains in normal flow').toBe('relative');
    expect(layout.installAfterHeader, 'install action follows the header').toBe(true);
    expect(layout.installBeforeMain, 'install action must not overlap main content').toBe(true);

    if (layout.shortLandscape) {
      expect(layout.navPosition, 'short-landscape navigation must be in normal flow').toBe('static');
      expect(layout.navAfterMain, 'short-landscape navigation must follow the page content').toBe(true);
    } else {
      expect(layout.navPosition, 'portrait navigation remains fixed').toBe('fixed');
      expect(
        layout.mainBottomPadding,
        'main content reserves enough space for bottom navigation'
      ).toBeGreaterThanOrEqual(layout.navHeight);
    }
  }

  await attachDiagnostics(testInfo, { ...diagnostics, layoutChecks: checks });
  expect(diagnostics.pageErrors, 'layout checks must not create browser exceptions').toEqual([]);
  expect(diagnostics.mutatingRequests, 'layout checks must not send write requests').toEqual([]);
});

test('document exposes Persian RTL and primary navigation landmarks', async ({ page }) => {
  await openHome(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('main#appView')).toBeVisible();
  await expect(page.locator('nav.bottom-nav')).toHaveAttribute('aria-label', /ناوبری اصلی/);
  await expect(page.locator('.bottom-nav button[data-page="home"]')).toBeVisible();
});
