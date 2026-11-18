import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const portal = await readFile(new URL('../admin/index.html', import.meta.url), 'utf8');
const redirects = await readFile(new URL('../_redirects', import.meta.url), 'utf8');
const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

assert.match(app, /rpsMatch\.awaitingNext\s*&&\s*lastRound/,
  'RPS must show the next-round button only while awaiting the player confirmation');
assert.match(app, /function nextRpsRound\(\)[\s\S]*?rpsMatch\.awaitingNext\s*=\s*false;[\s\S]*?renderRpsMatch\(rpsMatch\.last\)/,
  'RPS next-round action must transition back to enabled player choices');
assert.match(app, /async function playRps\(choice\)[\s\S]*?rpsMoveBusy/,
  'RPS must block duplicate clicks while a move is being submitted');
assert.match(app, /async function resetTicMatch\(\)[\s\S]*?\/api\/games\/abandon[\s\S]*?\/api\/games\/start/,
  'Tic reset must abandon the active match and create a new server session');
assert.match(app, /async function playTicMove\(index\)[\s\S]*?ticMoveBusy/,
  'Tic must block duplicate clicks while a move is being submitted');
assert.match(app, /else if \(action === 'tic-reset'\) resetTicMatch\(\)/,
  'Tic reset control must use its dedicated abandon-and-restart action');

const roomCopy = app.split('\n').filter(line => /اتاق|دبرنا/.test(line)).join('\n');
assert.match(roomCopy, /حداقل ۲ شرکت‌کننده/,
  'room lobby must disclose the actual two-player minimum');
assert.doesNotMatch(roomCopy, /حداقل ۵ شرکت‌کننده/,
  'room UI must not contradict the server with a five-player minimum');
assert.match(app, /room5000[\s\S]*?room10000[\s\S]*?room20000[\s\S]*?room50000/,
  'all four price-tier room IDs must remain available');
assert.match(app, /id="homePoints"/,
  'the homepage account status must expose an update target for the points counter');
assert.match(app, /function updateHomeMiniStats\(\)[\s\S]*?homeGamesPlayed[\s\S]*?homeWins[\s\S]*?homePoints/,
  'all three homepage account counters must refresh from the same authenticated stats snapshot');
assert.match(app, /queue\.status === 'finished'[\s\S]*?data-action="room-next-session"/,
  'a finished room must open the next session without buying a card');
assert.match(app, /queue\.status === 'finished'[\s\S]*?ورود رایگان به سانس بعدی/,
  'the finished-room action must be clearly described as free entry');
const purchaseAction = app.match(/const purchaseAction =([\\s\\S]*?)const waitingMessage =/)?.[1] || '';
const finishedAction = purchaseAction.match(/queue\\.status === 'finished'\\s*\\?([\\s\\S]*?)(?::\\s*joined && waiting)/)?.[1] || '';
assert.match(finishedAction,/data-action="room-next-session"/,
  'a finished room must expose the free next-session action');
assert.doesNotMatch(finishedAction,/room-join-auto/,
  'a finished room must not use the purchase endpoint to open the next session');
const nextSessionHandler = app.match(/if \(action === 'room-next-session'\) \{([\s\S]*?)\n  \}\n  if \(action === 'room-join-auto'\)/)?.[1] || '';
assert.match(nextSessionHandler, /\/api\/rooms\/\$\{activeRoomId\}\/next/,
  'opening the next session must call the no-purchase endpoint');
assert.doesNotMatch(nextSessionHandler, /\/join|cardsCount|loadAuthenticatedUser/,
  'opening the next session must not trigger card purchase or wallet refresh');
const explicitPurchaseHandler = app.match(/if \(action === 'room-join-auto'\) \{([\s\S]*?)\n  \}\n  if \(action === 'room-add-card'\)/)?.[1] || '';
assert.match(explicitPurchaseHandler, /purchaseConfirmed\s*:\s*true/,
  'a new room card may be purchased only through the explicit purchase action');
assert.match(app, /getWalletRequestIdempotencyKey\(\)/,
  'wallet request forms must retain a stable idempotency key for retries');
assert.match(app, /Idempotency-Key['"]\s*:\s*idempotencyKey/,
  'wallet requests must send their idempotency key to the backend');
assert.match(app, /clearWalletRequestIdempotencyKey\(\)/,
  'wallet request idempotency state must clear after success or changed input');
assert.match(app,/getTournamentEntryIdempotencyKey\(tournamentType\)/,'tournament registration must reuse a stable idempotency key after a lost response');
assert.match(app,/headers:\{'Idempotency-Key':idempotencyKey\}/,'tournament registration must send its idempotency key to the server');
assert.match(app,/clearTournamentEntryIdempotencyKey\(tournamentType\)/,'successful tournament registration must clear its pending idempotency key');
assert.match(api,/FROM tournament_entry_idempotency WHERE user_id=\? AND idempotency_key=\?/,'tournament registration must resolve prior requests by user and idempotency key');
assert.match(api,/NOT EXISTS \(SELECT 1 FROM tournament_entry_idempotency WHERE user_id=\? AND idempotency_key=\?\)/,'concurrent tournament retries must claim the key before charging another event');
assert.match(api,/tournament_line_win/,'official tournament line winners must receive a BingoCoin ledger credit');
assert.match(api,/tournament_full_win/,'official tournament full-card winners must receive a BingoCoin ledger credit');
assert.match(api,/String\(round\.id\) \+ ':line'/,'line bonus idempotency must be scoped to a specific round');
assert.match(api,/String\(round\.id\) \+ ':full'/,'full bonus idempotency must be scoped to a specific round');

assert.match(app,/supportAdmin:renderSupportAdmin/,'the administrator support inbox must remain a registered app page');
assert.match(app,/walletAdmin:renderWalletAdmin/,'the finance admin panel must remain a registered app page');
assert.doesNotMatch(app,/data-page="supportAdmin"/,'the public support page must not expose an admin-entry button');
assert.doesNotMatch(app,/data-page="walletAdmin"/,'the public wallet page must not expose an admin-entry button');
assert.match(app,/supportAdminReplyForm/,'administrators must be able to reply from the ticket thread');
assert.match(app,/supportReplyForm/,'customers must be able to continue an open ticket');
assert.match(app,/support-admin-status/,'administrators must be able to change ticket status');
assert.ok(app.includes('/api/admin/support'),'admin inbox must use protected server API routes');
assert.ok(portal.includes('href="/#page=walletAdmin"'),'the standalone portal must link to the finance admin panel');
assert.ok(portal.includes('href="/#page=supportAdmin"'),'the standalone portal must link to the support admin panel');
assert.ok(redirects.includes('/admin /admin/ 301'),'the clean /admin route must redirect to the portal directory');
assert.ok(!redirects.includes('/admin/index.html 200'),'the portal route must not rewrite back to index.html and risk a directory redirect loop');
assert.ok(portal.includes('<title>درگاه مدیریت | Dabernaz</title>'),'the portal directory must contain its own static index page');
assert.ok(worker.includes("url.pathname === '/admin'"),'the service worker must not replace the portal with the SPA shell');
assert.ok(api.includes('if (!isWalletAdmin) throw new HttpError(403'),'finance APIs must continue to enforce the server-side admin allowlist');
assert.ok(api.includes('if(!isSupportAdmin) throw new HttpError(403'),'support APIs must continue to enforce the server-side admin allowlist');
assert.ok(app.includes('walletRequestForm') && app.includes('wallet-request-type-grid'),'the customer wallet must provide one unified deposit/withdraw request form');
assert.ok(app.includes('walletWithdrawFields') && app.includes('walletRequestMinHelp'),'the request form must show withdrawal-only fields and its dynamic minimum amount');
assert.ok(app.includes('payment-instructions') && app.includes('wallet-upload-receipt'),'deposit requests must expose private request-scoped payment instructions and receipt upload');
assert.ok(!app.includes('wallet-chat-panel') && !app.includes('walletUserChatForm'),'the customer wallet must no longer render the finance chat');
assert.ok(!app.includes('wallet-admin-chat-panel') && !app.includes('walletAdminChatForm'),'the finance admin page must process requests through its inbox, not a chat panel');
assert.ok(!app.includes('/api/wallet/payment-info'),'the public app must not request payment card details');
assert.ok(!api.includes("path === '/api/wallet/payment-info'"),'the public payment-info endpoint must not exist');
assert.ok(api.includes('CREATE TABLE IF NOT EXISTS wallet_messages'),'legacy finance messages remain stored without being rendered as the wallet workflow');
assert.ok(api.includes("requestType === 'deposit' ? 105 : 205"),'the API must enforce the 105-toman deposit and 205-toman withdrawal minimums');
assert.ok(api.includes('payment_card_number') && api.includes('payment-instructions'),'deposit payment details must be snapshotted and scoped to an owned request');
assert.ok(api.includes("r.user_note"),'the finance admin inbox must receive the customer request note');
assert.ok(api.includes("VALUES(?,'user',?,?)"),'customer messages must be stored as customer messages');
assert.ok(api.includes("VALUES(?,'admin',?,?)"),'admin replies must be stored as admin messages');
assert.ok(!api.includes('SELECT id,request_type,amount,status,receipt_mime,card_number,card_holder,bank_name'),'user wallet requests must not return card details');
assert.match(app,/JSON\.stringify\(\{ settings: \{ \.\.\.state\.settings \} \}\)/,'browser storage must persist only non-sensitive user preferences');
assert.match(app,/localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(\{ settings \}\)\)/,'legacy localStorage records must be sanitized immediately on startup');
assert.doesNotMatch(app,/JSON\.stringify\(\{ \.\.\.state/,'account state must never be serialized wholesale into browser storage');
assert.doesNotMatch(app,/شارژ آنلاین و برداشت پول تا اتصال درگاه پرداخت غیرفعال است|شارژ و برداشت واقعی کیف پول تا اتصال درگاه پرداخت فعال نیست/,'help text must not contradict the manual wallet request workflow');
assert.match(app,/واریز و برداشت تومانی کیف پول به‌صورت دستی و با بررسی مدیریت انجام می‌شود/,'help text must describe the current manual deposit and withdrawal process');
console.log('Game-room, mini-game, support, admin portal and wallet request center UI smoke tests passed.');


assert.match(app, /id="roomWinnerBannerMount" aria-live="polite" aria-atomic="true"/,
  'winner announcements must have a focused live region');
assert.match(app, /id="roomLatestNumber" aria-live="polite" aria-atomic="true"/,
  'the live number must be announced without making the full page a live region');
assert.match(app, /if \(document\.hidden \|\| navigator\.onLine === false \|\|/,
  'tournament refreshes must pause while the app is hidden or offline');
assert.match(app, /!document\.hidden && navigator\.onLine !== false && currentUser/,
  'room polling must pause while the app is hidden or offline');
assert.match(app, /!currentUser \|\| document\.hidden \|\| navigator\.onLine === false/,
  'support and wallet refresh polling must pause while hidden or offline');
assert.match(worker, /\.catch\(\(\) => cached \|\| Response\.error\(\)\)/,
  'failed background image/font refreshes must not become unhandled promise rejections');


assert.match(app, /const roomMarkupCache = new WeakMap\(\)/,
  'room polling must cache the previous markup per live DOM element');
assert.match(app, /function setHtmlIfChanged\(element, markup\)/,
  'unchanged room markup must not recreate all card elements');
assert.match(app, /setHtmlIfChanged\(list, roomAllCardsMarkup\(\)\)/,
  'shared room tickets must update only when their rendered markup changes');
assert.match(app, /setTextIfChanged\(\$\('#roomLatestNumber'\)/,
  'the latest draw number should not trigger redundant text mutations');
