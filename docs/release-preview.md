# Release Preview deployment contract

This release branch is deployed only to the Cloudflare Pages **Preview** environment.

## Resource boundaries

- Pages Preview uses the `DB` binding to the isolated `dabernaz-preview` D1 database.
- The private Pages Service Binding is named `ROOM_COORDINATOR` and targets the `dabernaz-room-coordinator-preview` Worker.
- The Worker uses the same Preview D1 database through its `DB` binding and the SQLite Durable Object class `RoomCoordinator`.
- The Worker has no public `workers.dev` hostname. Pages Functions call it through the private service binding.
- The Worker reconciles active rooms once per minute and uses Durable Object alarms for per-room deadlines and draws.

## Readiness contract

A Preview deployment is not considered ready for paid rooms unless `GET /api/health` returns HTTP 200 with:

- `readiness: "ready"`
- `schema: "v4"`
- `roomCoordinator.available: true`
- `roomCoordinator.ready: true`
- `roomCoordinator.durableObject.ready: true`
- `roomCoordinator.transactionRoundLink: true`
- `walletRequests.idempotency: true`
- `tournamentEntries.idempotency: true`

Read-only checks may then request `GET /api/rooms/room5000` to verify the Pages-to-Worker route without creating a user, joining a room, charging a wallet, or changing room state.

## D1 migration tracking

- `schema_migrations` is the application's schema-version contract; the current Preview version is 4.
- `d1_migrations` is Wrangler's migration-file tracker. It records `0000_core_schema.sql` through `0004_transaction_round_link.sql`.
- Both `wrangler.pages.ci.toml` and `workers/room-coordinator/wrangler.toml` explicitly point to the repository-level migrations directory and the `d1_migrations` tracker.
- Do not run remote migrations against Production as part of this mission.

## Production safety

- `main` remains the Pages production branch.
- Production Pages retains its existing `DB` binding and environment variables.
- Do not apply the release migrations to Production as part of Preview validation.
- Do not test with real payments or real user accounts.
- Keep this PR unmerged until the Preview health and read-only service-binding checks pass and the repository's main-branch protection is enabled.
