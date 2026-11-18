function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'x-content-type-options': 'nosniff'
    }
  });
}

export async function onRequestGet({ env }) {
  if (!env.DB) {
    return jsonResponse({
      ok: false,
      service: 'dabernaz',
      backend: 'cloudflare-pages-functions',
      database: 'missing',
      schema: 'unknown',
      roomCoordinator: { available: false },
      walletRequests: { idempotency: false },
      tournamentEntries: { idempotency: false },
      readiness: 'misconfigured',
      mode: 'misconfigured'
    }, 503);
  }

  try {
    const ping = await env.DB.prepare('SELECT 1 AS ok').first();
    if (Number(ping?.ok) !== 1) throw new Error('D1 health query returned an unexpected result.');

    const migration = await env.DB.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations'
    ).first();
    const schemaVersion = Number(migration?.version);
    const required = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN " +
      "('users','auth_sessions','transactions','room_rounds','room_purchases','room_outbox','financial_ledger','referral_reward_claims','wallet_adjustment_requests','tournament_entry_idempotency')"
    ).first();
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 3 || Number(required?.total) !== 10) {
      return jsonResponse({
        ok: false,
        service: 'dabernaz',
        backend: 'cloudflare-pages-functions',
        database: 'D1',
        schema: 'unready',
        roomCoordinator: { available: typeof env.ROOM_COORDINATOR?.fetch === 'function' },
        walletRequests: { idempotency: false },
        tournamentEntries: { idempotency: false },
        readiness: 'degraded',
        mode: 'degraded',
        error: 'نسخه Migration یا جدول‌های ضروری D1 آماده نیست.'
      }, 503);
    }

    let walletIdempotencyAvailable = false;
    let tournamentIdempotencyAvailable = false;
    try {
      await env.DB.prepare('SELECT 1 FROM wallet_request_idempotency LIMIT 1').first();
      walletIdempotencyAvailable = true;
    } catch (_) {}
    try {
      await env.DB.prepare('SELECT 1 FROM tournament_entry_idempotency LIMIT 1').first();
      tournamentIdempotencyAvailable = true;
    } catch (_) {}

    const roomCoordinatorAvailable = typeof env.ROOM_COORDINATOR?.fetch === 'function';
    const unavailableFeatures = [];
    if (!roomCoordinatorAvailable) unavailableFeatures.push('paid_rooms');
    if (!walletIdempotencyAvailable) unavailableFeatures.push('wallet_request_submission');
    if (!tournamentIdempotencyAvailable) unavailableFeatures.push('tournament_entry_idempotency');
    const readiness = unavailableFeatures.length === 0 ? 'ready' : 'degraded';

    return jsonResponse({
      ok: true,
      service: 'dabernaz',
      backend: 'cloudflare-pages-functions',
      database: 'D1',
      schema: 'v' + schemaVersion,
      binding: 'bound',
      roomCoordinator: {
        available: roomCoordinatorAvailable,
        binding: 'ROOM_COORDINATOR'
      },
      walletRequests: {
        idempotency: walletIdempotencyAvailable,
        migration: walletIdempotencyAvailable ? 2 : null
      },
      tournamentEntries: {
        idempotency: tournamentIdempotencyAvailable,
        migration: tournamentIdempotencyAvailable ? 3 : null
      },
      readiness,
      mode: readiness,
      unavailableFeatures
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      service: 'dabernaz',
      backend: 'cloudflare-pages-functions',
      database: 'unreachable_or_unready',
      schema: 'unknown',
      roomCoordinator: { available: typeof env.ROOM_COORDINATOR?.fetch === 'function' },
      walletRequests: { idempotency: false },
      tournamentEntries: { idempotency: false },
      readiness: 'degraded',
      mode: 'degraded',
      error: 'D1 در دسترس نیست یا ساختار موردنیاز آماده نشده است.'
    }, 503);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { allow: 'GET, OPTIONS', 'cache-control': 'no-store' }
  });
}
