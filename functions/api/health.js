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

async function probeRoomCoordinator(env) {
  const bindingAvailable = typeof env.ROOM_COORDINATOR?.fetch === 'function';
  if (!bindingAvailable) {
    return {
      available: false,
      ready: false,
      bindingAvailable: false,
      binding: 'ROOM_COORDINATOR'
    };
  }
  try {
    const response = await env.ROOM_COORDINATOR.fetch(new Request(
      'https://dabernaz-room-coordinator.internal/health',
      { method: 'GET' }
    ));
    const body = await response.json().catch(() => null);
    const schemaVersion = Number(String(body?.schema || '').replace(/^v/, ''));
    const ready = response.ok && body?.ok === true && body?.ready === true &&
      schemaVersion >= 4 && body?.durableObject?.ready === true &&
      body?.transactionRoundLink === true;
    return {
      available: true,
      ready,
      bindingAvailable: true,
      binding: 'ROOM_COORDINATOR',
      schema: body?.schema || null,
      durableObject: body?.durableObject || { available: false, ready: false },
      transactionRoundLink: body?.transactionRoundLink === true
    };
  } catch (_) {
    return {
      available: true,
      ready: false,
      bindingAvailable: true,
      binding: 'ROOM_COORDINATOR'
    };
  }
}

export async function onRequestGet({ env }) {
  const bindingAvailable = typeof env.ROOM_COORDINATOR?.fetch === 'function';
  if (!env.DB) {
    return jsonResponse({
      ok: false,
      service: 'dabernaz',
      backend: 'cloudflare-pages-functions',
      database: 'missing',
      schema: 'unknown',
      roomCoordinator: {
        available: false,
        ready: false,
        bindingAvailable,
        binding: 'ROOM_COORDINATOR'
      },
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
      "('users','auth_sessions','transactions','room_rounds','room_purchases','room_outbox','financial_ledger','referral_reward_claims','wallet_adjustment_requests','wallet_request_idempotency','tournament_entry_idempotency')"
    ).first();
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 4 || Number(required?.total) !== 11) {
      return jsonResponse({
        ok: false,
        service: 'dabernaz',
        backend: 'cloudflare-pages-functions',
        database: 'D1',
        schema: 'unready',
        roomCoordinator: {
          available: bindingAvailable,
          ready: false,
          bindingAvailable,
          binding: 'ROOM_COORDINATOR'
        },
        walletRequests: { idempotency: false },
        tournamentEntries: { idempotency: false },
        readiness: 'degraded',
        mode: 'degraded',
        error: 'نسخه Schema v4 یا جدول‌های ضروری D1 آماده نیست.'
      }, 503);
    }

    // Fail closed until every new room transaction can be associated with its round.
    await env.DB.prepare('SELECT round_id FROM transactions LIMIT 0').all();

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

    const roomCoordinator = await probeRoomCoordinator(env);
    const unavailableFeatures = [];
    if (!roomCoordinator.ready) unavailableFeatures.push('paid_rooms');
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
      roomCoordinator,
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
  } catch (_) {
    return jsonResponse({
      ok: false,
      service: 'dabernaz',
      backend: 'cloudflare-pages-functions',
      database: 'unreachable_or_unready',
      schema: 'unknown',
      roomCoordinator: {
        available: bindingAvailable,
        ready: false,
        bindingAvailable,
        binding: 'ROOM_COORDINATOR'
      },
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
