export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    ok: !!env.DB,
    service: 'dabernaz',
    backend: 'cloudflare-pages-functions',
    database: env.DB ? 'D1' : 'missing',
    binding: env.DB ? 'bound' : 'missing',
    mode: env.DB ? 'ready' : 'misconfigured'
  }), {
    status: env.DB ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { allow: 'GET, OPTIONS', 'cache-control': 'no-store' } });
}
