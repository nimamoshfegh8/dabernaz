export async function onRequestGet({ env }) {
  let databaseReady = false;
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      databaseReady = Number(row?.ok) === 1;
    } catch (_) {
      databaseReady = false;
    }
  }
  const configured = !!env.DB;
  const body = {
    ok: databaseReady,
    service: 'dabernaz',
    backend: 'cloudflare-pages-functions',
    database: databaseReady ? 'D1' : configured ? 'unreachable' : 'missing',
    binding: configured ? 'bound' : 'missing',
    mode: databaseReady ? 'ready' : configured ? 'degraded' : 'misconfigured'
  };
  return new Response(JSON.stringify(body), {
    status: databaseReady ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'x-content-type-options': 'nosniff'
    }
  });
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { allow: 'GET, OPTIONS', 'cache-control': 'no-store' } });
}
