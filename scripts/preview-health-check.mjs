import process from 'node:process';

const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL || !baseURL.startsWith('https://')) {
  throw new Error('PLAYWRIGHT_BASE_URL must be an HTTPS Preview URL.');
}

const healthURL = new URL('/api/health', baseURL);
const clientId = process.env.CF_ACCESS_CLIENT_ID || '';
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET || '';
const accessConfigured = Boolean(clientId && clientSecret);

const headers = { accept: 'application/json' };
if (accessConfigured) {
  headers['CF-Access-Client-Id'] = clientId;
  headers['CF-Access-Client-Secret'] = clientSecret;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeLocation(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value, healthURL);
    return parsed.origin + parsed.pathname;
  } catch {
    return '[invalid Location header]';
  }
}

function classify(status, contentType, location, cfMitigated, body) {
  const locationPath = String(location || '').toLowerCase();
  const sample = String(body || '').slice(0, 1000).toLowerCase();

  if (locationPath.includes('/cdn-cgi/access/login') ||
      locationPath.includes('.cloudflareaccess.com')) {
    return 'Cloudflare Access login redirect';
  }
  if (String(cfMitigated || '').toLowerCase() === 'challenge' ||
      sample.includes('/cdn-cgi/challenge-platform/') ||
      sample.includes('window._cf_chl_opt') ||
      sample.includes('cf-chl-')) {
    return 'Cloudflare WAF/Bot challenge evidence';
  }
  if (status >= 300 && status < 400) return 'Unexpected HTTP redirect';
  if (!String(contentType || '').toLowerCase().includes('application/json')) {
    if (sample.trimStart().startsWith('(function')) {
      return 'Unexpected JavaScript response instead of JSON; cause not proven';
    }
    return 'Non-JSON response; inspect Pages Function, middleware, or edge response';
  }
  return 'Preview health response failed one or more readiness checks';
}

function reportFailure(diag, detail) {
  console.error('PREVIEW READINESS BLOCKED: ' + detail);
  console.error(JSON.stringify(diag, null, 2));
  if (detail.includes('Access')) {
    if (!accessConfigured) {
      console.error('Create a Cloudflare Access Service Token and Service Auth policy, then add repository Actions secrets CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.');
    } else {
      console.error('The configured CI Service Token was not accepted. Verify its Service Auth policy on the existing Preview Access application.');
    }
  }
  process.exit(1);
}

const deadline = Date.now() + 240_000;
let attempt = 0;

while (Date.now() <= deadline) {
  attempt += 1;
  let response;
  let body = '';
  try {
    response = await fetch(healthURL, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    body = await response.text();
  } catch (error) {
    if (Date.now() + 2_000 > deadline) {
      reportFailure({ url: healthURL.origin + healthURL.pathname, attempt, networkError: String(error) },
        'Preview endpoint could not be reached.');
    }
    await sleep(2_000);
    continue;
  }

  const status = response.status;
  const contentType = response.headers.get('content-type') || '';
  const locationHeader = response.headers.get('location');
  const location = safeLocation(locationHeader);
  const cfRay = response.headers.get('cf-ray');
  const cfMitigated = response.headers.get('cf-mitigated');
  const prefix = body.slice(0, 180).replace(/[\r\n\t]+/g, ' ');

  const diag = {
    url: healthURL.origin + healthURL.pathname,
    attempt,
    httpStatus: status,
    contentType,
    location,
    cfRay,
    cfMitigated,
    bodyPrefix: prefix,
    accessServiceTokenConfigured: accessConfigured,
  };

  const cause = classify(status, contentType, location, cfMitigated, body);
  if (cause === 'Cloudflare Access login redirect' ||
      cause === 'Cloudflare WAF/Bot challenge evidence' ||
      cause === 'Unexpected HTTP redirect' ||
      cause.startsWith('Unexpected JavaScript') ||
      cause.startsWith('Non-JSON')) {
    reportFailure(diag, cause + '.');
  }

  let health = null;
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      health = JSON.parse(body);
    } catch {
      reportFailure(diag, 'Content-Type is JSON but the response body is not valid JSON.');
    }
  }

  const unavailableFeatures = Array.isArray(health?.unavailableFeatures)
    ? health.unavailableFeatures
    : [];
  const requireRoomCoordinator = process.env.REQUIRE_ROOM_COORDINATOR === '1';
  const expectedPaidRoomsDegraded = !requireRoomCoordinator && health?.readiness === 'degraded' &&
    health?.ok === true &&
    health?.roomCoordinator?.bindingAvailable === false &&
    health?.roomCoordinator?.available === false &&
    health?.roomCoordinator?.ready === false &&
    unavailableFeatures.length === 1 &&
    unavailableFeatures[0] === 'paid_rooms';

  const checks = {
    http200: status === 200,
    contentTypeJson: contentType.toLowerCase().includes('application/json'),
    jsonParseable: Boolean(health && typeof health === 'object'),
    healthOk: health?.ok === true,
    readinessCompatible: health?.readiness === 'ready' || expectedPaidRoomsDegraded,
    schemaV4: health?.schema === 'v4',
    roomCoordinatorStateValid: typeof health?.roomCoordinator?.available === 'boolean' && typeof health?.roomCoordinator?.ready === 'boolean' && typeof health?.roomCoordinator?.bindingAvailable === 'boolean',
    roomCoordinatorReady: health?.roomCoordinator?.ready === true || expectedPaidRoomsDegraded,
    paidRoomsFailClosed: health?.roomCoordinator?.ready === true || expectedPaidRoomsDegraded,
    walletIdempotency: health?.walletRequests?.idempotency === true,
    tournamentIdempotency: health?.tournamentEntries?.idempotency === true,
  };

  if (Object.values(checks).every(Boolean)) {
    const state = expectedPaidRoomsDegraded
      ? 'safe degraded state; paid_rooms remains disabled until the Worker binding is deployed'
      : 'fully ready';
    console.log('Preview health preflight passed (' + state + ').');
    console.log(JSON.stringify({
      ...diag,
      bodyPrefix: undefined,
      checks,
      unavailableFeatures
    }, null, 2));
    process.exit(0);
  }

  reportFailure({
    ...diag,
    checks,
    healthReadiness: health?.readiness,
    schema: health?.schema,
  }, 'Preview returned a readable health payload but failed one or more mandatory core-health or fail-closed conditions.');
}

reportFailure({ url: healthURL.origin + healthURL.pathname, attempt },
  'Preview did not become ready within 240 seconds.');
