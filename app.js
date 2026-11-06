'use strict';

const STORAGE_KEY = 'dabernaz_state_v1';
const cloneData = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const defaultState = {
  username: '', memberId: '', balance: 0, joined: [], transactions: [],
  settings: { sounds: true, notifications: true, privacy: true, vibration: false },
  referralCode: '', gamesPlayed: 0, wins: 0, points: 0,
  bingoCoins: 0, coinTransactions: [], inviteCount: 0, inviteRewardMilestones: [],
  roomHistory: [], supportTickets: [], tournamentRooms: []
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return cloneData(defaultState);
    return {
      ...cloneData(defaultState), ...saved,
      balance: Number.isFinite(Number(saved.balance)) ? Math.max(0, Number(saved.balance)) : defaultState.balance,
      joined: Array.isArray(saved.joined) ? saved.joined : [],
      transactions: Array.isArray(saved.transactions) ? saved.transactions.slice(0, 30) : [],
      bingoCoins: Number.isFinite(Number(saved.bingoCoins)) ? Math.max(0, Math.floor(Number(saved.bingoCoins))) : 0,
      coinTransactions: Array.isArray(saved.coinTransactions) ? saved.coinTransactions.slice(0, 50) : [],
      inviteCount: Number.isFinite(Number(saved.inviteCount)) ? Math.max(0, Math.floor(Number(saved.inviteCount))) : 0,
      inviteRewardMilestones: Array.isArray(saved.inviteRewardMilestones) ? saved.inviteRewardMilestones : [],
      roomHistory: Array.isArray(saved.roomHistory) ? saved.roomHistory.slice(0,12) : [],
      supportTickets: Array.isArray(saved.supportTickets) ? saved.supportTickets.slice(0,20) : [],
      tournamentRooms: Array.isArray(saved.tournamentRooms) ? saved.tournamentRooms.slice(0,2) : [],
      settings: { ...defaultState.settings, ...(saved.settings || {}) }
    };
  } catch (_) { return cloneData(defaultState); }
}
let state = loadState();
// Never trust balances or guest identities left by older demo builds.
state.username=''; state.memberId=''; state.balance=0; state.bingoCoins=0;
state.gamesPlayed=0; state.wins=0; state.points=0; state.joined=[];
state.transactions=[]; state.coinTransactions=[]; state.referralCode='';
let currentUser = null;
let authReady = false;
let apiReady = false;
let apiErrorMessage = '';
let authMode = 'login';
let roomServerSnapshot = null;
let roomPollBusy = false;
let currentPage = 'home';
let toastTimer = null;
let bingoGame = null;
const ROOM_CONFIGS = [
  { id:'room5000', price:5000, label:'۵,۰۰۰', code:'DB-5000', linePrize:20000, fullPrize:115000, commissionMode:'revenue_minus_prizes' },
  { id:'room10000', price:10000, label:'۱۰,۰۰۰', code:'DB-10000', linePrize:40000, fullPrize:230000, commissionMode:'revenue_minus_prizes' },
  { id:'room20000', price:20000, label:'۲۰,۰۰۰', code:'DB-20000', linePrize:80000, fullPrize:460000, commissionMode:'revenue_minus_prizes' },
  { id:'room50000', price:50000, label:'۵۰,۰۰۰', code:'DB-50000', linePrize:200000, fullPrize:1150000, commissionMode:'revenue_minus_prizes' }
];
function currentRoomConfig() { const id = currentPage === 'roomGame' ? activeRoomId : currentPage; return ROOM_CONFIGS.find(room => room.id === id) || ROOM_CONFIGS[0]; }
const ROOM_CAPACITY = 30;
let activeRoomId = 'room5000';
let roomCards = [];
let roomCardCount = 1;
let roomCalledNumbers = [];
let roomStages = { one:false, full:false };

const $ = (selector, root = document) => root.querySelector(selector);
const money = value => Number(value).toLocaleString('en-US');
const faDigits = value => Number(value).toLocaleString('fa-IR');
const escapeHTML = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { showToast('فضای ذخیره‌سازی مرورگر در دسترس نیست'); } }
async function apiRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const requestOptions = {
    ...options,
    credentials:'same-origin',
    headers:{ 'Content-Type':'application/json', ...(options.headers||{}) },
    ...(path.startsWith('/api/') && method === 'GET' ? { cache:'no-store' } : {})
  };
  let response;
  let networkError = null;
  const attempts = path.startsWith('/api/') && method === 'GET' ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      response = await fetch(path, requestOptions);
      networkError = null;
      break;
    } catch (error) {
      networkError = error;
      if (attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
  }
  if (!response && networkError) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new Error(offline
      ? 'اتصال اینترنت دستگاه قطع است. بعد از وصل شدن اینترنت دوباره تلاش کن.'
      : 'ارتباط با سرور دابرناز موقتاً برقرار نشد. اینترنت را بررسی کن و دوباره تلاش کن.');
  }

  const contentType = response.headers.get('content-type') || '';
  // PHP fallback is only for an HTTP response indicating that the pretty API route is unavailable.
  // A transient network error must not be mislabeled as a missing PHP/Node installation.
  if (path.startsWith('/api/') && (!contentType.includes('application/json') || response.status === 404)) {
    try {
      const fallback = await fetch(`/api.php?path=${encodeURIComponent(path)}`, requestOptions);
      if ((fallback.headers.get('content-type') || '').includes('application/json')) response = fallback;
    } catch (_) { /* Preserve the primary Cloudflare/Pages response. */ }
  }
  const data = await response.json().catch(()=>({error:'پاسخ سرور قابل خواندن نیست. اتصال API دابرناز را بررسی کن.'}));
  if (!response.ok) {
    const details = [data.error || 'در ارتباط با سرور خطایی رخ داد.', `HTTP ${response.status}`, data.requestId ? `کد پیگیری: ${data.requestId}` : ''].filter(Boolean);
    throw new Error(details.join(' · '));
  }
  apiReady = true;
  apiErrorMessage = '';
  return data;
}
function applyAuthenticatedUser(user) {
  currentUser = user;
  state.username = user.name; state.memberId = user.memberId;
  state.referralCode = `DABERNAZ${user.memberId}`;
  state.balance = Math.max(0, Number(user.balance)||0); state.bingoCoins = Math.max(0, Number(user.bingoCoins)||0);
  state.coinTransactions = Array.isArray(user.coinTransactions) ? user.coinTransactions.slice(0,50) : [];
  state.gamesPlayed = Number(user.stats?.gamesPlayed)||0; state.wins = Number(user.stats?.wins)||0; state.points = Number(user.stats?.points)||0;
  state.transactions = []; state.joined = [];
  saveState(); updateHeader();
}
async function loadAuthenticatedUser() {
  // Probe the route first so a stale login cookie or account error is never shown
  // to the user as a generic "API disconnected" message.
  try {
    await apiRequest('/api/health', { method:'GET', headers:{} });
  } catch (error) {
    apiReady = false;
    apiErrorMessage = error?.message || 'ارتباط با API برقرار نشد.';
    currentUser = null;
    state = { ...cloneData(defaultState), settings:state.settings };
    authReady = true;
    saveState();
    render();
    showToast(apiErrorMessage);
    return;
  }
  try {
    const result = await apiRequest('/api/auth/me', { method:'GET', headers:{} });
    if (result.user) applyAuthenticatedUser(result.user);
    else {
      currentUser = null;
      state = { ...cloneData(defaultState), settings:state.settings };
      state.supportTickets = [];
      state.tournamentRooms = [];
    }
  } catch (error) {
    apiReady = false;
    apiErrorMessage = error?.message || 'سرور حساب کاربری در دسترس نیست.';
    currentUser = null;
    state = { ...cloneData(defaultState), settings:state.settings };
    showToast(apiErrorMessage);
  }
  authReady = true;

  // Completed room history is public; load it even for visitors who are not signed in.
  try {
    const history = await apiRequest('/api/rooms/history', { method:'GET', headers:{} });
    state.roomHistory = Array.isArray(history.rounds) ? history.rounds.slice(0,12) : [];
  } catch (_) { /* Keep the last successfully loaded history for a temporary outage. */ }

  if (currentUser) {
    const [referralResult, tournamentResult, ticketResult] = await Promise.allSettled([
      apiRequest('/api/referrals', { method:'GET', headers:{} }),
      apiRequest('/api/tournaments/me', { method:'GET', headers:{} }),
      apiRequest('/api/tickets', { method:'GET', headers:{} })
    ]);
    if (referralResult.status === 'fulfilled') {
      const referral = referralResult.value;
      state.inviteCount = Number(referral.count) || 0;
      state.referralCode = referral.referralCode || state.referralCode;
      state.inviteRewardMilestones = Array.from({length:Math.floor(state.inviteCount/5)},(_,i)=>i+1);
    }
    if (tournamentResult.status === 'fulfilled') {
      const data = tournamentResult.value;
      state.joined = (data.entries || [])
        .filter(entry => entry.status === 'registered')
        .map(entry => entry.tournament_type === 'bingo' ? 'bingoTournamentEntry' : 'simpleTournamentEntry');
      state.tournamentRooms = Array.isArray(data.rooms) ? data.rooms : [];
    }
    if (ticketResult.status === 'fulfilled') {
      state.supportTickets = Array.isArray(ticketResult.value.tickets) ? ticketResult.value.tickets : [];
    }
  }
  saveState();
  render();
}
function requireLogin() { if (currentUser) return true; authMode='login'; setPage('account'); showToast('برای ادامه ابتدا ثبت‌نام کن یا وارد حساب شو.'); return false; }
function showToast(message) {
  const toast = $('#toast'); if (!toast) return;
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function updateHeader() {
  $('#headerName').textContent = currentUser ? state.username : 'ورود / ثبت‌نام';
  $('#headerId').textContent = currentUser ? `ID: ${state.memberId}` : 'حساب کاربری';
  $('#headerBalance').textContent = money(state.balance);
  if ($('#headerBingoCoins')) $('#headerBingoCoins').textContent = `${state.bingoCoins.toLocaleString('fa-IR')} BGC`;
}
function setPage(page) {
  const allowed = ['home','games','room5000','room10000','room20000','room50000','roomGame','tournaments','tournamentRoom','bingoTournament','invite','wallet','account','settings','support'];
  if (!allowed.includes(page)) page = 'home';
  if (ROOM_CONFIGS.some(room => room.id === page)) {
    if(roomServerSnapshot && roomServerSnapshot.id!==page){roomServerSnapshot=null;roomCards=[];roomCardCount=1;roomCalledNumbers=[];roomStages={one:false,full:false};}
    activeRoomId = page; 
  }
  currentPage = page;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (ROOM_CONFIGS.some(room => room.id === page) || page === 'roomGame') pollCurrentRoom();
}
function heading(title, subtitle, label = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${label || 'DABERNAZ CLUB'}</span><h1>${title}</h1><p>${subtitle}</p></div></div>`;
}
function section(title, action = '', page = '') {
  return `<div class="section-title"><h2>${title}</h2>${action ? `<button data-page="${page}">${action}</button>` : ''}</div>`;
}
function renderHome() {
  return `${heading('خوش اومدی ' + escapeHTML(currentUser ? state.username : 'به دابرناز') + ' 👑', 'برای یک رقابت هیجان‌انگیز آماده‌ای؟', 'باشگاه بازی دابرناز')}
  <section class="hero"><div class="hero-copy"><span class="eyebrow">بازی کن · رقابت کن · بدرخش</span><h1>قهرمان بعدی<br><em>شاید تو باشی!</em></h1><p>وارد دنیای بازی‌های دابرناز شو و مهارتت رو به چالش بکش.</p><button class="btn btn-primary" data-page="games">ورود به اتاق بازی <span>‹</span></button></div><div class="hero-art"><div class="art-orb">🂡</div></div></section>
  <div class="shortcut-grid">
    <button class="shortcut" data-page="games"><span class="symbol">🎮</span><b>اتاق بازی</b><small>شروع بازی</small></button>
    <button class="shortcut" data-page="tournaments"><span class="symbol">🏆</span><b>تورنمنت</b><small>رقابت آنلاین</small></button>
    <button class="shortcut" data-page="invite"><span class="symbol">🎁</span><b>دعوت دوستان</b><small>دعوت و همراهی</small></button>
    <button class="shortcut" data-page="wallet"><span class="symbol">👛</span><b>کیف پول</b><small>موجودی سکه</small></button>
  </div>
  <div class="promo"><div class="promo-art">🎯</div><div class="promo-copy"><b>بازی‌های دابرناز</b><p>بازی مورد علاقه‌ات را انتخاب کن و مهارتت را محک بزن.</p></div><button class="btn btn-outline" data-page="games">مشاهده</button></div>
  <section class="room-teaser"><div class="room-teaser-art">🎱</div><div class="room-teaser-copy"><span>اتاق‌های آنلاین دبرنا</span><b>۴ سطح اتاق</b><small>ظرفیت ۳۰ کارت · شروع و قرعه‌کشی خودکار</small></div><button class="btn btn-gold" data-page="games">انتخاب اتاق <span>←</span></button></section>
  ${section('بازی‌های محبوب', 'همه بازی‌ها', 'games')}
  <div class="game-grid">${roomGameCard()}${gameCard('rps','✊✋✌️','سنگ، کاغذ، قیچی','مسابقه خودکار تا رسیدن یکی از طرفین به ۳ برد','بازی مهارتی · بدون شرط‌بندی','game-cover-rps')}${gameCard('tic','⭕❌','دوز حرفه‌ای','صفحه ۳×۳ با حریف هوشمند و تصمیم‌های تاکتیکی','بازی مهارتی · بدون شرط‌بندی','game-cover-tic')}</div>
  ${section('وضعیت حساب', 'حساب کاربری', 'account')}
  <div class="mini-stats"><div class="stat-card"><b id="homeGamesPlayed">${money(state.gamesPlayed)}</b><small>بازی انجام‌شده</small></div><div class="stat-card"><b id="homeWins">${money(state.wins)}</b><small>بردها</small></div><div class="stat-card"><b>${money(state.points)}</b><small>امتیاز کل</small></div></div>
  <div class="ticker"><span>⭐ وضعیت حساب</span><strong>${currentUser ? 'حساب ثبت‌شده' : 'مهمان'}</strong><span>● آماده بازی</span></div>`;
}
function gameCard(id, symbol, name, desc, price, coverClass = '') {
  return `<article class="game-card"><div class="game-cover ${coverClass}">${symbol}</div><h3>${name}</h3><p>${desc}</p><button class="btn btn-primary" data-game="${id}">ورود به بازی</button><div class="price">${price}</div></article>`;
}
function roomGameCard() {
  return `<article class="game-card"><div class="game-cover room-game-cover"><img class="game-cover-image" src="./assets/daberna-icon.jpg" alt="تصویر بازی دبرنا" loading="lazy"></div><h3>دبرنای ۹۰ توپی</h3><p>چهار سطح اتاق · ظرفیت ۳۰ کارت</p><button class="btn btn-primary" data-page="games">انتخاب اتاق</button><div class="price">شروع خودکار مسابقه</div></article>`;
}
function renderGames() {
  const tiers = ['red','silver','gold','purple'];
  const cardIcons = ['♛','♜','♕','👑'];
  return `<section class="games-page">
    <header class="games-lobby-heading">
      <div class="games-lobby-title"><span class="games-lobby-icon">🎮</span><div><h1>اتاق بازی</h1><p>وارد صف شو، بازی خودکار شروع می‌شود.</p></div></div>
      <div class="games-online-badge"><span class="online-people-icon">♟</span><div><small>اتاق‌های چندنفره</small><b>ظرفیت ۳۰ کارت</b></div><i aria-label="صف واقعی"></i></div>
    </header>

    <section class="games-lobby-hero">
      <div class="games-lobby-callout"><small>بازی گروهی ۳۰ کارتی</small><h2>شروع خودکار!</h2><p>با ورود به صف، پس از تکمیل ۳۰ کارت خریداری‌شده، قرعه‌کشی به‌صورت خودکار آغاز می‌شود.</p><button class="games-rules-button" data-action="room-show-rules">قوانین بازی <span>ⓘ</span></button></div>
      <div class="games-lobby-art"><img src="./assets/room-lobby-art.png" alt="کارت‌های دبرنا و گوی‌های شماره‌دار" loading="eager"></div>
      <div class="games-lobby-features">
        <div><span>▤</span><p>ظرفیت هر اتاق<strong>۳۰ کارت</strong></p></div>
        <div><span>◷</span><p>شروع بازی<strong>پس از تکمیل ظرفیت</strong></p></div>
        <div><span>🎲</span><p>مهره‌ها<strong>شماره‌های ۱ تا ۹۰</strong></p></div>
        <div><span>♛</span><p>شرط برنده شدن<strong>یک خط و دبرنای کامل</strong></p></div>
      </div>
    </section>

    <section class="games-purchase-section">
      <div class="games-section-heading"><div><span class="games-section-symbol">▧</span><h2>انتخاب اتاق</h2></div><p>اتاق را انتخاب کن؛ قیمت کارت، جایزه‌ها و کمیسیون در صفحه همان اتاق نمایش داده می‌شود.</p></div>
      <div class="games-price-grid">${ROOM_CONFIGS.map((room, index) => `<article class="games-price-card tier-${tiers[index]}">
        <div class="games-price-card-art" aria-hidden="true"><span class="mini-bingo-card card-a">BINGO</span><span class="mini-bingo-card card-b">BINGO</span><span class="mini-bingo-card card-c">BINGO</span><span class="mini-bingo-crown">${cardIcons[index]}</span></div>
        <b class="games-price-name">اتاق سطح ${index+1}</b>
        <button class="games-price-button" data-page="${room.id}">ورود به اتاق</button>
        <small class="games-price-caption">ظرفیت ۳۰ کارت · حداکثر ۴ کارت</small>
      </article>`).join('')}</div>
    </section>

    <section class="games-winners-section">
      <div class="games-section-heading"><div><span class="games-section-symbol">♛</span><h2>برندگان سانس‌ها</h2></div><p>نام و شناسه فقط پس از ثبت نتیجه معتبر نمایش داده می‌شود.</p></div>
      ${recentSessionWinnersMarkup()}
    </section>
  </section>`;
}
function getRoomQueueState() {
  const room = roomServerSnapshot;
  return room || { joined:false, queueCount:0, status:'waiting', myCards:[], calledNumbers:[], winners:{line:[],full:[]} };
}
function roomCardMarkup(card, index) {
  const rowsDone = card.map(row => row.filter(n => n !== null && roomCalledNumbers.includes(n)).length === 5);
  const doneRows = rowsDone.filter(Boolean).length;
  const full = doneRows === 3;
  const line = doneRows > 0;
  return `<article class="room-ticket">
    <div class="room-ticket-head"><div><b>کارت شماره ${index + 1}</b><small>شناسه کارت · DB-${String(index + 1).padStart(3,'0')}</small></div><span class="room-ticket-state ${line ? 'is-progress' : ''}">${full ? 'دبرنای کامل' : line ? 'یک خط تکمیل' : 'در حال بازی'}</span></div>
    <div class="daberna-grid" role="group" aria-label="کارت دبرنا شماره ${index + 1}">${card.map(row => row.map(number => number === null
      ? `<span class="daberna-cell empty-cell" aria-hidden="true"></span>`
      : `<span class="daberna-cell ${roomCalledNumbers.includes(number) ? 'called-cell' : ''}" data-number="${number}" aria-label="${number}${roomCalledNumbers.includes(number) ? ' اعلام شده' : ''}">${number}</span>`).join('')).join('')}</div>
    <div class="room-ticket-foot"><span>۱۵ عدد در ۳ ردیف</span><span>${full ? 'هر ۱۵ عدد اعلام شده' : line ? 'یک ردیف کامل شده' : 'منتظر اعلام شماره'}</span></div>
  </article>`;
}
function roomHasWinner(value) {
  return Array.isArray(value) ? value.length > 0 : !!value;
}
function roomStageMarkup() {
  const stages = [
    { icon:'Ⅰ', name:'یک خط', desc:'تکمیل هر ۵ عدد یکی از ردیف‌ها', done:roomStages.one },
    { icon:'♛', name:'دبرنای کامل', desc:'تکمیل هر ۱۵ عدد همان کارت', done:roomStages.full }
  ];
  return stages.map(stage => `<div class="room-stage ${stage.done ? 'stage-done' : ''}"><span class="room-stage-icon">${stage.done ? '✓' : stage.icon}</span><div><b>${stage.name}</b><small>${stage.desc}</small></div><span class="room-stage-status">${stage.done ? 'تکمیل شد' : 'در انتظار'}</span></div>`).join('');
}
function roomCalledMarkup() {
  if (!roomCalledNumbers.length) return '<div class="room-empty-balls"><span>◉</span><b>هنوز عددی اعلام نشده</b><small>با شروع خودکار سانس، شماره‌ها نمایش داده می‌شوند.</small></div>';
  return roomCalledNumbers.slice(-12).reverse().map((number, index) => `<span class="called-ball ${index === 0 ? 'latest-ball' : ''}">${number}</span>`).join('');
}
function roomQueueSlots(count) {
  return Array.from({length:ROOM_CAPACITY}, (_,i) => `<span class="queue-avatar ${i < count ? 'occupied' : ''}" title="${i < count ? 'کارت خریداری‌شده' : 'ظرفیت خالی کارت'}">${i < count ? '●' : ''}</span>`).join('');
}
function roomWinnerBanner() {
  const winners = roomServerSnapshot?.winners || {};
  const normalize = (value) => Array.isArray(value) ? value : (value ? [value] : []);
  const winnerRow = (label, value) => {
    const items = normalize(value);
    if (!items.length) return '';
    const names = items.map((item) => `${escapeHTML(item.name)} · شناسه ${escapeHTML(item.memberId)}`).join('، ');
    const plural = items.length > 1 ? ` (${faDigits(items.length)} نفر همزمان)` : '';
    return `<div class="room-winner-line"><b>${label}${plural}</b><span>${names}</span></div>`;
  };
  const rows = winnerRow('🏅 برنده یک خط', winners.line) + winnerRow('👑 برنده دبرنای کامل', winners.full);
  return rows ? `<section class="room-winner-banner"><h3>برندگان این سانس</h3>${rows}</section>` : '';
}
function recentSessionWinnersMarkup() {
  const sessions=Array.isArray(roomServerSnapshot?.recentSessions)&&roomServerSnapshot.recentSessions.length?roomServerSnapshot.recentSessions:(Array.isArray(state.roomHistory)?state.roomHistory:[]);
  if(!sessions.length) return '<div class="empty"><span>🏆</span>هنوز سانس پایان‌یافته‌ای ثبت نشده است.</div>';
  return sessions.map((session,index)=>{
    const lineList=Array.isArray(session.lineWinners)?session.lineWinners:(session.line?(Array.isArray(session.line)?session.line:[session.line]):[]);
    const fullList=Array.isArray(session.fullWinners)?session.fullWinners:(session.full?(Array.isArray(session.full)?session.full:[session.full]):[]);
    const line=lineList.length?lineList.map(x=>escapeHTML(x.name||x.memberId||'—')).join('، '):'—';
    const full=fullList.length?fullList.map(x=>escapeHTML(x.name||x.memberId||'—')).join('، '):'—';
    const finishedAt=session.finishedAt||session.finished_at;
    const date=finishedAt ? new Date(finishedAt).toLocaleString('fa-IR') : '';
    return '<div class="room-session-result"><div><b>سانس '+faDigits(sessions.length-index)+'</b><small>'+escapeHTML(date)+'</small></div><span>🏅 '+line+'</span><span>👑 '+full+'</span></div>';
  }).join('');
}
function renderRoomPurchasePage() {
  const room=currentRoomConfig(); const queue=getRoomQueueState();
  const playerCount=Number(queue.playerCount ?? queue.queueCount ?? 0);
  const cardsSold=Number(queue.cardCount || 0);
  const joined=!!queue.joined;
  const remainingCards=Math.max(0,ROOM_CAPACITY-cardsSold);
  if (Array.isArray(queue.myCards) && queue.myCards.length) { roomCards=queue.myCards; roomCardCount=queue.myCards.length; }
  const selectedCount=joined ? roomCards.length : roomCardCount;
  const waiting=queue.status==='waiting';
  const ownedCardCount=joined ? roomCards.length : 0;
  const additionalCardsAvailable=remainingCards;
  const purchaseControls=joined && waiting
    ? `<small>کارت‌های خریداری‌شده</small><div class="purchase-qty-controls"><b id="roomQty">${faDigits(ownedCardCount)} کارت</b></div>`
    : `<small>تعداد کارت برای این سانس</small><div class="purchase-qty-controls"><button data-action="room-decrease" aria-label="کاهش تعداد کارت" ${selectedCount<=1?'disabled':''}>−</button><b id="roomQty">${faDigits(selectedCount)}</b><button data-action="room-increase" aria-label="افزایش تعداد کارت" ${selectedCount>=4?'disabled':''}>+</button></div>`;
  const purchaseTotal=joined && waiting
    ? `<div class="purchase-total"><span>هزینه ۱ کارت اضافی</span><b>${faDigits(room.price)} تومان</b></div>`
    : `<div class="purchase-total"><span>هزینه کل ${faDigits(selectedCount)} کارت</span><b>${faDigits(room.price * selectedCount)} تومان</b></div>`;
  const purchaseAction=!currentUser
    ? `<button class="btn btn-primary btn-block" data-page="account">ورود / ثبت‌نام برای بازی</button>`
    : queue.status==='playing' && joined
      ? `<button class="btn btn-primary btn-block" data-action="room-open-game">ورود به بازی زنده</button>`
      : queue.status==='playing'
        ? `<button class="btn btn-muted btn-block" disabled>سانس در حال اجراست</button>`
        : joined && waiting
          ? `<button class="btn btn-primary btn-block" data-action="room-add-card" ${additionalCardsAvailable<1?'disabled':''}>${additionalCardsAvailable>0?'افزودن و خرید یک کارت':'ظرفیت اتاق تکمیل شده'}</button>`
          : `<button class="btn btn-primary btn-block purchase-join" data-action="room-join-auto">${queue.status==='finished'?'ورود به سانس بعدی':'ورود به صف واقعی'}</button>`;
  return `${heading(`اتاق دبرنا · سطح ${ROOM_CONFIGS.findIndex(x=>x.id===room.id)+1}`, 'با خرید ۳۰ کارت، بازی به‌صورت خودکار آغاز می‌شود.', 'DABERNAZ · LIVE ROOM')}
  <div id="roomWinnerBannerMount">${roomWinnerBanner()}</div>
  <section class="room-info-strip room-prize-strip"><div><b>🎟️ کارت ${faDigits(room.price)} تومان</b><small>خرید کارت تا تکمیل ظرفیت اتاق</small></div><div><b>🏅 یک خط ${faDigits(room.linePrize)} تومان</b><small>جایزه خطی</small></div><div><b>👑 کامل ${faDigits(room.fullPrize)} تومان</b><small>جایزه کامل</small></div></section>
  <section class="purchase-wait-hero"><div class="purchase-art"><img src="./assets/room-lobby-art.png" alt="کارت‌های دبرنا و گوی‌های شماره‌دار" loading="eager"></div>
    <div class="purchase-box"><div class="purchase-box-top"><span class="live-dot"></span> سالن آنلاین <b>${room.code}</b></div>
      ${purchaseControls}
      ${purchaseTotal}
      ${purchaseAction}
      <small class="purchase-disclaimer">هزینه هر کارت از کیف پول کسر می‌شود. پس از خرید، کارت‌های ثبت‌شده قابل کاهش یا لغو نیستند. هر سانس حداکثر ۳۰ کارت دارد.</small>
    </div></section>
  <section class="room-wait-panel" id="roomWaitPanel"><div class="wait-panel-heading"><div><span class="eyebrow">ONLINE WAITING ROOM</span><h2>${queue.status==='playing'?'بازی شروع شده':queue.status==='finished'?'سانس پایان یافته':joined?'در صف انتظار هستی':'منتظر بازیکنان باش'}</h2><p>${queue.status==='playing'?'قرعه‌کشی خودکار در حال اجراست.':queue.status==='finished'?'برندگان ثبت شده‌اند؛ برای سانس بعدی دوباره وارد صف شو.':`با ورود ${faDigits(remainingCards)} کارت دیگر، بازی آغاز می‌شود.`}</p></div><div class="wait-hourglass">${queue.status==='playing'?'🎱':'⌛'}</div></div>
    <div class="wait-stats"><div><b id="queuePlayers">${faDigits(playerCount)}</b><small>بازیکنان ثبت‌نام‌کرده</small></div><div><b id="queueCardCount">${faDigits(cardsSold)} / ۳۰</b><small>کارت‌های فروخته‌شده</small></div><div><b>۳۰ کارت</b><small>ظرفیت هر سانس</small></div></div>
    <div class="queue-progress"><span id="queueProgress" style="width:${cardsSold/ROOM_CAPACITY*100}%"></span></div><div class="queue-avatars" id="queueAvatars">${roomQueueSlots(cardsSold)}</div>
    <div class="queue-wait-hint">${joined?'کارت‌های تو ثبت شده‌اند و تا شروع بازی در صف باقی می‌مانند.':'تعداد بازیکنان و کارت‌های خریداری‌شده از سرور به‌روزرسانی می‌شود.'}</div>
    <p class="muted-note room-session-note">هر حساب یک جایگاه بازیکن دارد و می‌تواند حداکثر ۴ کارت بخرد. ظرفیت سانس بر اساس تعداد کارت‌ها محاسبه می‌شود.</p>
  </section>
  <section class="room-info-strip"><div><b>🏅 یک خط</b><small>اولین بازیکن با تکمیل یک ردیف</small></div><div><b>👑 دبرنای کامل</b><small>اولین بازیکن با تکمیل ۱۵ عدد</small></div><div><b>🎱 ۹۰ مهره</b><small>اعلام خودکار بدون تکرار</small></div></section>
  <section class="room-panel ticket-selection"><div class="room-panel-heading"><div><span class="eyebrow">YOUR TICKETS</span><h3>کارت‌های تو</h3><p>کارت‌ها هنگام خرید روی سرور ساخته و نگهداری می‌شوند.</p></div><span class="ticket-count-badge" id="roomTicketCount">${faDigits(selectedCount)} کارت</span></div><div class="room-tickets-list" id="roomTicketsList">${joined&&roomCards.length?roomCards.map(roomCardMarkup).join(''):'<div class="empty"><span>🎟️</span>کارت نهایی پس از ورود به صف، به‌صورت تصادفی و روی سرور ساخته می‌شود.</div>'}</div></section>`;
}
function renderRoomGame() {
  const room=currentRoomConfig();
  const isFinished=roomServerSnapshot?.status==='finished';
  return `${heading(`بازی زنده دبرنا · سطح ${ROOM_CONFIGS.findIndex(x=>x.id===room.id)+1}`, 'شماره‌ها به‌صورت خودکار اعلام و نتیجه روی سرور ثبت می‌شود.', 'LIVE DABERNA ROOM')}
    <div id="roomWinnerBannerMount">${roomWinnerBanner()}</div>
    <div class="room-game-live-banner"><span class="live-dot"></span><b>${isFinished?'سانس پایان یافته':'بازی در حال اجرا'}</b><span>${room.code}</span><strong>${isFinished?'نتیجه نهایی':'قرعه‌کشی خودکار'}</strong></div>
    <section class="room-panel live-preview-panel"><div class="room-panel-heading"><div><span class="eyebrow">LIVE DRAW</span><h3>تابلوی اعلام شماره‌ها</h3><p>هر شماره فقط یک بار و به ترتیب تصادفی اعلام می‌شود.</p></div><span class="tag">${isFinished?'پایان':'زنده'}</span></div>
      <div class="room-current-number"><div><small>آخرین شماره اعلام‌شده</small><b id="roomLatestNumber">${roomServerSnapshot?.latestNumber??'—'}</b></div><div class="room-draw-count"><strong id="roomDrawCount">${faDigits(roomServerSnapshot?.drawCount||0)} / ۹۰</strong><small>شماره اعلام‌شده</small></div></div>
      <div class="room-number-history" id="roomNumberHistory">${roomCalledMarkup()}</div>
      <small class="room-safe-caption">${isFinished?'این سانس به پایان رسیده است.':'قرعه‌کشی توسط سرور انجام می‌شود؛ نیازی به فشردن دکمه نیست.'}</small>
    </section>
    <section class="room-game-layout"><div class="room-game-ticket"><div class="room-panel-heading"><div><span class="eyebrow">MY TICKETS</span><h3>کارت‌های من</h3></div><span class="ticket-count-badge">${faDigits(roomCards.length)} کارت</span></div><div id="roomTicketsList" class="room-tickets-list">${roomCards.map(roomCardMarkup).join('')}</div></div>
      <aside class="room-panel stages-panel"><div class="room-panel-heading"><div><span class="eyebrow">WINNING PATTERNS</span><h3>برندگان سانس</h3></div><span class="trophy-mark">🏆</span></div><div class="room-stages-list" id="roomStagesList">${roomStageMarkup()}</div><div class="room-rules-tip"><b>برد هم‌زمان پشتیبانی می‌شود</b><p>یک یا چند نفر می‌توانند در یک شماره هم‌زمان برنده یک خط یا دبرنای کامل شوند؛ جایزه همان مرحله بین برندگان تقسیم می‌شود.</p></div></aside>
    </section>
    <section class="room-panel"><div class="room-panel-heading"><div><span class="eyebrow">SESSION HISTORY</span><h3>برندگان سانس‌های اخیر</h3></div><span class="trophy-mark">🏆</span></div><div id="recentSessionWinners">${recentSessionWinnersMarkup()}</div></section>
    ${isFinished?'<button class="btn btn-primary btn-block" data-action="room-back-lobby">بازگشت به اتاق‌ها</button>':''}`;
}
async function pollCurrentRoom() {
  if (!currentUser || roomPollBusy) return;
  const roomId = currentPage==='roomGame' ? activeRoomId : currentPage;
  if (!ROOM_CONFIGS.some(room=>room.id===roomId)) return;
  roomPollBusy=true;
  try {
    const result=await apiRequest(`/api/rooms/${roomId}`,{method:'GET',headers:{}});
    roomServerSnapshot=result.room;
    if(result.room.joined && Array.isArray(result.room.myCards)) roomCards=result.room.myCards;
    roomCalledNumbers=Array.isArray(result.room.allCalledNumbers)?result.room.allCalledNumbers:(result.room.calledNumbers||[]);
    roomStages={one:roomHasWinner(result.room.winners?.line),full:roomHasWinner(result.room.winners?.full)};
    if (Number.isFinite(Number(result.room.myBingoCoins))) { state.bingoCoins=Math.max(0,Number(result.room.myBingoCoins)); state.coinTransactions=Array.isArray(result.room.myCoinTransactions)?result.room.myCoinTransactions.slice(0,50):state.coinTransactions; saveState(); updateHeader(); }
    if (result.room.status==='finished' && currentUser) {
      try {
        const me=await apiRequest('/api/auth/me',{method:'GET',headers:{}});
        if(me.user) applyAuthenticatedUser(me.user);
      } catch (_) {}
    }
    if (result.room.status==='playing' && result.room.joined && currentPage===roomId) { activeRoomId=roomId; currentPage='roomGame'; render(); }
    else if (currentPage==='roomGame' && result.room.status==='finished') render();
    else if (currentPage===roomId) render();
    if (currentPage==='roomGame') {
      const mount=$('#roomWinnerBannerMount'); if(mount) mount.innerHTML=roomWinnerBanner();
      updateRoomDrawDisplay();
      const recent=$('#recentSessionWinners'); if(recent) recent.innerHTML=recentSessionWinnersMarkup();
    }
  } catch(error) { if (error.message.includes('وارد حساب')) { currentUser=null; setPage('account'); } else showToast(error.message); }
  finally { roomPollBusy=false; }
}
function updateRoomCardDisplay() {
  const list=$('#roomTicketsList');
  if(list) list.innerHTML=roomServerSnapshot?.joined && roomCards.length ? roomCards.map(roomCardMarkup).join('') : '<div class="empty"><span>🎟️</span>کارت نهایی پس از ورود به صف، به‌صورت تصادفی و روی سرور ساخته می‌شود.</div>';
  if($('#roomQty')) $('#roomQty').textContent=faDigits(roomCardCount);
  if($('#roomTicketCount')) $('#roomTicketCount').textContent=`${faDigits(roomServerSnapshot?.joined ? roomCards.length : roomCardCount)} کارت`;
  detectRoomStages();
}
function detectRoomStages() {
  const winners=roomServerSnapshot?.winners||{};
  roomStages={one:roomHasWinner(winners.line),full:roomHasWinner(winners.full)};
  const stages=$('#roomStagesList'); if(stages) stages.innerHTML=roomStageMarkup();
}
function updateRoomDrawDisplay() {
  const room=roomServerSnapshot||{}; const last=room.latestNumber;
  if($('#roomLatestNumber')) $('#roomLatestNumber').textContent=last?faDigits(last):'—';
  if($('#roomDrawCount')) $('#roomDrawCount').textContent=`${faDigits(room.drawCount||0)} / ۹۰`;
  if($('#roomNumberHistory')) $('#roomNumberHistory').innerHTML=roomCalledMarkup();
  updateRoomCardDisplay();
}
function showRoomQuickRules() {
  openModal('راهنمای سریع دبرنا', `<div class="room-quick-rules"><p><b>۱. ساختار کارت:</b> هر کارت ۳ ردیف و ۹ ستون دارد و در هر ردیف دقیقاً ۵ عدد قرار می‌گیرد.</p><p><b>۲. اعلام شماره:</b> مهره‌ها از ۱ تا ۹۰ و بدون تکرار اعلام می‌شوند.</p><p><b>۳. یک خط:</b> تمام ۵ عدد یکی از ردیف‌های افقی کامل شود.</p><p><b>۴. دبرنای کامل:</b> هر ۱۵ عدد یک کارت علامت خورده باشد.</p><p class="muted-note">شرایط برد این اتاق شامل یک خط و دبرنای کامل است.</p></div>`);
}


const tournaments = [
  { id:'t1', name:'تورنمنت آزاد دابرناز', kind:'عمومی', prize:'۵,۰۰۰', players:'۱۲۸', time:'امروز · ۲۰:۳۰', icon:'🏆' },
  { id:'t2', name:'جام طلایی VIP', kind:'ویژه', prize:'۱۲,۰۰۰', players:'۶۴', time:'فردا · ۱۹:۰۰', icon:'👑' },
  { id:'t3', name:'چالش قهرمانان', kind:'مهارتی', prize:'۲,۵۰۰', players:'۳۲', time:'شنبه · ۱۸:۰۰', icon:'🥇' }
];
function renderTournaments() {
  const queueCount = type => Number((state.tournamentRooms||[]).find(item=>item.tournament_type===type)?.registered_count)||0;
  const simpleCount=queueCount('simple'), bingoCount=queueCount('bingo');
  return `${heading('تورنومنت', 'صف ثبت‌نام رقابت‌ها را مشاهده و به‌صورت سروری ثبت‌نام کن.', 'TOURNAMENTS')}
  <div class="tournament-subpage-grid">
    <button class="tournament-subpage-card" data-page="tournamentRoom"><span>🏆</span><b>اتاق تورنومنت</b><small>${faDigits(simpleCount)} / ۳۰ ثبت‌نام · ورود ۲۰ BGC</small><em>مشاهده اتاق ←</em></button>
    <button class="tournament-subpage-card" data-page="bingoTournament"><span>🎱</span><b>اتاق بینگو تورنومنت</b><small>${faDigits(bingoCount)} / ۳۰ ثبت‌نام · ورود ۱۰۰ BGC</small><em>مشاهده اتاق ←</em></button>
  </div>
  <p class="muted-note">ثبت‌نام، شمارش ظرفیت و کسر بینگوکوین روی سرور انجام می‌شود. رسیدن به ظرفیت، صف را می‌بندد؛ اجرای خود مسابقه و تعیین جایزه به قوانین نهایی تورنمنت نیاز دارد.</p>`;
}
function renderTournamentDetail(bingo=false) {
  const title = bingo ? 'اتاق بینگو تورنومنت' : 'اتاق تورنومنت';
  const id = bingo ? 'bingoTournamentEntry' : 'simpleTournamentEntry';
  const type = bingo ? 'bingo' : 'simple';
  const cost = bingo ? 100 : 20;
  const room = (state.tournamentRooms || []).find(item => item.tournament_type === type) || {};
  const capacity = Number(room.capacity) || 30;
  const registered = Math.min(capacity, Number(room.registered_count) || 0);
  const full = room.status === 'full' || registered >= capacity;
  const entered = state.joined.includes(id);
  const statusText = entered ? 'ثبت‌نام شد' : full ? 'ظرفیت تکمیل' : 'در صف ثبت‌نام';
  return `${heading(title, 'ثبت‌نام با بینگوکوین در صف سروری انجام می‌شود.', 'TOURNAMENT ROOM')}
  <section class="room-panel tournament-room-detail"><div class="tournament-emblem">${bingo ? '🎱' : '🏆'}</div><h2>${title}</h2>
    <p>ظرفیت صف ${faDigits(capacity)} نفر است. با تکمیل ظرفیت، ثبت‌نام بسته می‌شود.</p>
    <div class="coin-entry-cost"><img class="bingocoin-icon-img" src="./assets/bingocoin.svg" alt="سکه بینگوکوین"><b>${cost.toLocaleString('fa-IR')} بینگوکوین</b><small>هزینه ورود</small></div>
    <div class="wait-stats"><div><b>${faDigits(registered)} / ${faDigits(capacity)}</b><small>ثبت‌نام‌شده</small></div><div><b>${state.bingoCoins.toLocaleString('fa-IR')}</b><small>موجودی بینگوکوین تو</small></div><div><b>${statusText}</b><small>وضعیت</small></div></div>
    <button class="btn btn-primary btn-block" data-action="join-tournament" data-tournament="${type}" ${entered||full?'disabled':''}>${entered?'ثبت‌نام شد':full?'ظرفیت تکمیل شده':'ثبت‌نام با بینگوکوین'}</button>
    <small class="room-safe-caption">هزینه ورود فقط یک بار کسر می‌شود. پس از پر شدن صف، ثبت‌نام جدید پذیرفته نمی‌شود.</small>
    ${full?'<p class="muted-note">ظرفیت تکمیل شده است؛ وضعیت بعدی مسابقه پس از تعیین برنامه اجرای تورنمنت اعلام می‌شود.</p>':''}
  </section>`;
}
function renderInvite() {
  const nextMilestone = (Math.floor(state.inviteCount / 5) + 1) * 5;
  const progress = state.inviteCount % 5;
  const rewards = state.inviteRewardMilestones.length;
  return `${heading('دعوت از دوستان', 'دوستات رو به دابرناز دعوت کن و با هم جایزه بگیرین.', 'INVITE & EARN')}
  <section class="invite-hero"><div class="invite-visual">👥</div><span class="eyebrow">پاداش دعوت دوستان</span><h2>۵ دعوت موفق، جایزه بگیر!</h2><div class="invite-reward-pair"><div><b>۲۰٬۰۰۰ تومان</b><small>اعتبار کیف پول</small></div><div><b>۵ BGC</b><small>بینگوکوین</small></div></div><div class="ref-box"><input id="refCode" value="${escapeHTML(state.referralCode)}" readonly aria-label="کد دعوت"><button class="btn btn-primary" data-action="copy-ref">کپی کد</button></div><button class="btn btn-gold btn-block" style="margin-top:9px" data-action="share-ref">اشتراک‌گذاری لینک دعوت</button></section>
  <section class="panel invite-progress-panel"><div class="section-title"><h2>پیشرفت دعوت‌ها</h2><span class="gold-text">${state.inviteCount.toLocaleString('fa-IR')} دعوت موفق</span></div><div class="invite-progress-track"><span style="width:${progress/5*100}%"></span></div><div class="invite-progress-label"><b>${progress.toLocaleString('fa-IR')} از ۵</b><small>تا دریافت جایزه بعدی · ${Math.max(0,nextMilestone-state.inviteCount).toLocaleString('fa-IR')} دعوت مانده</small></div><div class="mini-stats"><div class="stat-card"><b>${state.inviteCount.toLocaleString('fa-IR')}</b><small>دعوت موفق</small></div><div class="stat-card"><b>${rewards.toLocaleString('fa-IR')}</b><small>جایزه دریافت‌شده</small></div><div class="stat-card"><b>${(rewards*5).toLocaleString('fa-IR')}</b><small>بینگوکوین کسب‌شده</small></div></div></section>
  <div class="steps"><div class="step"><i>🔗</i><b>۱. کد رو کپی کن</b><small>کد اختصاصی خودت رو بفرست.</small></div><div class="step"><i>📨</i><b>۲. دوستت ثبت‌نام کنه</b><small>با لینک یا کد دعوت تو عضو بشه.</small></div><div class="step"><i>🎉</i><b>۳. جایزه بگیر</b><small>با هر ۵ دعوت موفق، جایزه دریافت کن.</small></div></div>
  <p class="muted-note">دعوت موفق هنگام ثبت‌نام با کد اختصاصی روی سرور ثبت می‌شود و پاداش هر ۵ دعوت موفق به‌صورت خودکار اعمال می‌گردد.</p>`;
}
function renderWallet() {
  const rows = state.transactions.length ? state.transactions.map(tx => `<div class="transaction"><div class="transaction-icon ${tx.amount < 0 ? 'out' : ''}">${tx.amount < 0 ? '↗' : '↙'}</div><div class="transaction-info"><b>${escapeHTML(tx.title)}</b><small>${escapeHTML(tx.date)}</small></div><span class="transaction-amount ${tx.amount < 0 ? 'negative' : 'positive'}">${tx.amount > 0 ? '+' : ''}${money(tx.amount)} تومان</span></div>`).join('') : `<div class="empty"><span>🪙</span>هنوز تراکنش تومانی ثبت نشده است.</div>`;
  const coinRows = state.coinTransactions.length ? state.coinTransactions.map(tx => `<div class="transaction"><div class="transaction-icon coin-transaction-icon">B</div><div class="transaction-info"><b>${escapeHTML(tx.title)}</b><small>${escapeHTML(tx.date)}</small></div><span class="transaction-amount ${tx.amount < 0 ? 'negative' : 'positive'}">${tx.amount > 0 ? '+' : ''}${tx.amount.toLocaleString('fa-IR')} BGC</span></div>`).join('') : `<div class="empty"><span>✦</span>هنوز تراکنش بینگوکوین ثبت نشده است.</div>`;
  return `${heading('کیف پول من', 'موجودی تومان و بینگوکوین را جداگانه مدیریت کن.', 'MY WALLET')}
  <div class="wallet-currency-grid"><section class="wallet-hero"><small>موجودی تومان</small><div class="wallet-balance">${money(state.balance)} <span>تومان</span></div><p>اعتبار کیف پول برای خرید کارت و خدمات.</p><div class="wallet-actions"><button class="btn btn-outline" data-action="wallet-info">شارژ حساب</button><button class="btn btn-outline" data-action="wallet-info">برداشت</button></div></section><section class="wallet-hero bingocoin-wallet-hero"><small>موجودی BINGO COIN</small><div class="wallet-balance">${state.bingoCoins.toLocaleString('fa-IR')} <img class="bingocoin-icon-img wallet-coin-img" src="./assets/bingocoin.svg" alt="بینگوکوین"></div><p>ارز مجازی اختصاصی برای ورود به تورنومنت‌ها.</p><button class="btn btn-gold btn-block" data-page="tournaments">مشاهده تورنومنت‌ها</button></section></div>
  ${section('تاریخچه بینگوکوین')}<section class="panel" style="padding:2px 12px">${coinRows}</section>
  ${section('تاریخچه کیف پول تومانی')}<section class="panel" style="padding:2px 12px">${rows}</section>
  <p class="muted-note">شارژ و برداشت تومان تا اتصال درگاه غیرفعال است. بینگوکوین پاداش مجازی دبرناست و ارزش نقدی یا امکان برداشت ندارد.</p>`;
}

function renderAccount() {
  if (!currentUser) return renderAuthPage();
  return `${heading('حساب کاربری', 'اطلاعات حساب و امنیت ورودت را مدیریت کن.', 'PLAYER ACCOUNT')}
    <section class="profile-hero"><div class="avatar avatar-large">♛</div><div class="profile-info"><h2>${escapeHTML(state.username)}</h2><small>شناسه بازیکن: ${escapeHTML(state.memberId)}</small><small style="display:block">${escapeHTML(currentUser.email)}</small><div class="profile-score">حساب ثبت‌شده</div></div></section>
    <div class="profile-stat-grid"><div class="profile-stat"><b>${money(state.gamesPlayed)}</b><small>بازی‌ها</small></div><div class="profile-stat"><b>${money(state.wins)}</b><small>بردها</small></div><div class="profile-stat"><b>${money(state.points)}</b><small>امتیاز</small></div><div class="profile-stat"><b>${state.joined.length}</b><small>تورنمنت</small></div></div>
    ${section('مدیریت حساب')}
    ${accountRow('✎','اطلاعات شخصی','نام نمایشی و مشخصات حساب','edit-profile')}
    ${accountRow('🛡','امنیت حساب','ورود با رمز عبور رمزنگاری‌شده','security')}
    ${accountRow('⇥','خروج از حساب','خروج امن از حساب کاربری','logout')}`;
}
function renderAuthPage() {
  const register=authMode==='register';
  return `${heading('حساب کاربری دابرناز', 'برای ذخیره حساب و ورود به بازی‌ها ثبت‌نام کن یا وارد شو.', 'SECURE PLAYER ACCOUNT')}
    <section class="panel auth-panel">
      ${authReady && !apiReady ? `<div class="mini-game-info-notice" role="status">اتصال API برقرار نشد: ${escapeHTML(apiErrorMessage || 'خطای نامشخص')}<br>نشانی بررسی سلامت: <a href="/api/health" target="_blank" rel="noopener">/api/health</a></div>` : authReady && apiReady ? '<div class="mini-game-info-notice" role="status">اتصال به سرور برقرار است؛ ثبت‌نام و ورود آماده است.</div>' : '<div class="mini-game-info-notice" role="status">در حال بررسی اتصال سرور…</div>'}
      <div class="auth-tabs"><button class="${register?'':'active'}" data-auth-mode="login">ورود</button><button class="${register?'active':''}" data-auth-mode="register">ثبت‌نام</button></div>
      <form id="authForm" class="form-stack" autocomplete="on">
        ${register?'<label class="muted-note" for="authName">نام نمایشی</label><input id="authName" class="form-control" name="name" minlength="2" maxlength="32" autocomplete="name" placeholder="نامی که در بازی نمایش داده می‌شود" required><label class="muted-note" for="authReferral">کد دعوت (اختیاری)</label><input id="authReferral" class="form-control" name="referralCode" maxlength="40" autocomplete="off" placeholder="کد دعوت دوستت">':''}
        <label class="muted-note" for="authEmail">ایمیل</label><input id="authEmail" class="form-control" name="email" type="email" maxlength="190" autocomplete="email" placeholder="name@example.com" required>
        <label class="muted-note" for="authPassword">رمز عبور</label><input id="authPassword" class="form-control" name="password" type="password" minlength="8" maxlength="128" autocomplete="${register?'new-password':'current-password'}" placeholder="حداقل ۸ نویسه" required>
        <button class="btn btn-primary btn-block" type="submit">${register?'ساخت حساب کاربری':'ورود به حساب'}</button>
      </form>
      <p class="muted-note auth-security-note">رمز عبور به‌صورت متن ساده ذخیره نمی‌شود. حساب‌ها روی سرور ثبت می‌شوند و ورود با نشست امن انجام می‌شود.</p>
    </section>`;
}
function accountRow(icon, title, desc, action) { return `<button class="list-row" data-action="${action}"><span class="row-icon">${icon}</span><span class="row-copy"><b>${title}</b><small>${desc}</small></span><span class="chevron">‹</span></button>`; }
function renderSettings() {
  const sw = (key, title, desc) => `<div class="setting-row"><div class="setting-copy"><b>${title}</b><small>${desc}</small></div><button class="switch ${state.settings[key] ? 'on' : ''}" role="switch" aria-checked="${!!state.settings[key]}" aria-label="${title}" data-setting="${key}"></button></div>`;
  return `${heading('تنظیمات', 'دابرناز رو مطابق سلیقه خودت تنظیم کن.', 'PREFERENCES')}
  <section class="setting-group"><h3 class="settings-title">تنظیمات عمومی</h3>${sw('sounds','صدای بازی','فعال یا غیرفعال کردن صداها')}${sw('notifications','اعلان‌ها','دریافت اعلان‌های داخل سایت')}${sw('vibration','لرزش','بازخورد لرزشی در دستگاه‌های پشتیبانی‌شده')}</section>
  <section class="setting-group"><h3 class="settings-title">حریم خصوصی</h3>${sw('privacy','نمایش وضعیت آنلاین','تنظیم نمایش وضعیت حضور در بخش‌های بازی')}</section>
  <section class="setting-group"><h3 class="settings-title">درباره برنامه</h3><div class="setting-row"><div class="setting-copy"><b>زبان برنامه</b><small>فارسی</small></div><span class="tag">FA</span></div><div class="setting-row"><div class="setting-copy"><b>نسخه دابرناز</b><small>حساب سروری و اتاق‌های خودکار</small></div><span class="muted-note">4.0.0</span></div></section>
  <button class="btn btn-outline btn-block" data-action="reset-settings">بازنشانی تنظیمات</button>`;
}
const faqs = [
  ['چطور وارد اتاق بازی بشم؟','از صفحه خانه روی «اتاق بازی» بزن یا از کارت بازی مورد علاقه‌ات وارد شو.'],
  ['ورود به اتاق دبرنا هزینه دارد؟','خرید کارت از اعتبار کیف پول انجام می‌شود. شارژ آنلاین و برداشت پول تا اتصال درگاه پرداخت غیرفعال است.'],
  ['تورنمنت‌ها و کیف پول فعال هستند؟','ثبت‌نام تورنومنت با بینگوکوین روی سرور انجام می‌شود. شارژ و برداشت واقعی کیف پول تا اتصال درگاه پرداخت فعال نیست.'],
  ['اطلاعات حساب من کجا ذخیره می‌شود؟','در نسخه فعلی Cloudflare، اطلاعات حساب و آمار در دیتابیس D1 نگهداری می‌شوند و رمز عبور فقط به‌شکل هش‌شده ذخیره می‌شود. تنظیمات ظاهری غیرحساس در مرورگر می‌مانند.'],
  ['چطور با پشتیبانی ارتباط بگیرم؟','فرم پایین صفحه را تکمیل کن. پیام روی سرور ذخیره می‌شود و شماره پیگیری دریافت می‌کنی.']
];
function renderSupportTickets() {
  const tickets = Array.isArray(state.supportTickets) ? state.supportTickets : [];
  if (!tickets.length) return '<div class="empty"><span>🎧</span>هنوز تیکتی ثبت نکرده‌ای.</div>';
  return `<div class="panel support-ticket-list">${tickets.map(ticket => {
    const date = ticket.created_at ? new Date(ticket.created_at).toLocaleString('fa-IR') : '';
    const status = ticket.status === 'open' ? 'در انتظار بررسی' : ticket.status === 'answered' ? 'پاسخ داده شد' : ticket.status === 'closed' ? 'بسته' : escapeHTML(ticket.status || 'ثبت‌شده');
    return `<article class="setting-row"><div class="setting-copy"><b>#${faDigits(ticket.id)} · ${escapeHTML(ticket.subject)}</b><small>${escapeHTML(date)}</small></div><span class="tag">${status}</span></article>`;
  }).join('')}</div>`;
}
function renderSupport() {
  return `${heading('پشتیبانی دابرناز', 'درخواستت را ثبت کن و شماره پیگیری دریافت کن.', 'WE ARE HERE FOR YOU')}
  <section class="invite-hero" style="text-align:right;padding:15px"><div style="display:flex;align-items:center;gap:13px"><div style="font-size:48px;filter:drop-shadow(0 0 12px #f32b43)">🎧</div><div><span class="eyebrow">سامانه تیکت</span><h2 style="font-size:18px;margin:4px 0;color:#fff">پیگیری درخواست پشتیبانی</h2><p style="margin:0;font-size:9px">پیام‌ها در حساب خودت ذخیره می‌شوند و شماره پیگیری دارند.</p></div></div></section>
  ${section('سوالات متداول')}
  ${faqs.map((f,i) => `<div class="faq-item"><button class="faq-question" data-action="faq" data-id="${i}"><span>${f[0]}</span><span class="chevron">⌄</span></button><div class="faq-answer">${f[1]}</div></div>`).join('')}
  ${section('ارسال پیام به پشتیبانی')}
  ${currentUser ? `<form id="supportForm" class="panel form-stack" style="padding:13px"><input class="form-control" name="subject" maxlength="70" minlength="3" placeholder="موضوع پیام" required><textarea class="form-control" name="message" rows="4" minlength="3" maxlength="1000" placeholder="پیام خودت رو بنویس..." required></textarea><button class="btn btn-primary btn-block" type="submit">ارسال پیام</button><small class="muted-note">پیام روی سرور ذخیره می‌شود.</small></form>` : '<div class="empty">برای ثبت و مشاهده تیکت‌ها ابتدا وارد حساب کاربری شو.</div>'}
  ${section('تیکت‌های من')}
  ${renderSupportTickets()}`;
}
function render() {
  const pages = {
    home:renderHome, games:renderGames,
    room5000:renderRoomPurchasePage, room10000:renderRoomPurchasePage, room20000:renderRoomPurchasePage, room50000:renderRoomPurchasePage,
    roomGame:renderRoomGame, tournaments:renderTournaments,
    tournamentRoom:() => renderTournamentDetail(false), bingoTournament:() => renderTournamentDetail(true),
    invite:renderInvite, wallet:renderWallet, account:renderAccount, settings:renderSettings, support:renderSupport
  };
  $('#appView').innerHTML = pages[currentPage]();
  const roomPages = ['room5000','room10000','room20000','room50000','roomGame'];
  document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === (roomPages.includes(currentPage) ? 'games' : currentPage)));
  updateHeader();
  if (currentPage === 'roomGame') updateRoomDrawDisplay();
}
function addTransaction(title, amount) {
  state.balance = Math.max(0, state.balance + amount);
  state.transactions.unshift({ title, amount, date: new Date().toLocaleString('fa-IR') });
  state.transactions = state.transactions.slice(0, 30);
  saveState();
}
function addBingoCoins(amount, title) {
  if (!Number.isInteger(amount) || amount === 0) return;
  state.bingoCoins = Math.max(0, state.bingoCoins + amount);
  state.coinTransactions.unshift({ title, amount, date: new Date().toLocaleString('fa-IR') });
  state.coinTransactions = state.coinTransactions.slice(0, 50);
  saveState(); updateHeader();
}
function rewardReferralMilestones() {
  const milestone = Math.floor(state.inviteCount / 5);
  if (milestone < 1 || state.inviteRewardMilestones.includes(milestone)) return false;
  state.inviteRewardMilestones.push(milestone);
  addTransaction(`جایزه ${milestone * 5} دعوت موفق`, 20000);
  addBingoCoins(5, `جایزه ${milestone * 5} دعوت موفق`);
  return true;
}
function openModal(title, content) {
  $('#modalRoot').innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHTML(title)}"><div class="modal-head"><h3>${title}</h3><button class="close-btn" data-action="close-modal" aria-label="بستن">×</button></div>${content}</section></div>`;
}
function closeModal() { $('#modalRoot').innerHTML = ''; }
let rpsMatch = null;
let ticMatch = null;
const RPS_CHOICES = {
  rock: { label:'سنگ', emoji:'✊' },
  paper: { label:'کاغذ', emoji:'✋' },
  scissors: { label:'قیچی', emoji:'✌️' }
};
const RPS_HISTORY_KEY = 'dabernaz.rps.player-history.v1';
function loadRpsPlayerHistory() {
  try {
    const raw = localStorage.getItem(RPS_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(choice => Object.hasOwn(RPS_CHOICES, choice)).slice(-120) : [];
  } catch { return []; }
}
function saveRpsPlayerChoice(choice) {
  try {
    const history = [...loadRpsPlayerHistory(), choice].slice(-120);
    localStorage.setItem(RPS_HISTORY_KEY, JSON.stringify(history));
  } catch { /* Private browsing or disabled storage: this match still works without persistent memory. */ }
}
function adaptiveRpsComputerChoice(history) {
  const choices = Object.keys(RPS_CHOICES);
  const beats = { rock:'scissors', paper:'rock', scissors:'paper' };
  if (!history.length) return choices[secureRandomInt(choices.length)];

  // Estimate the player's next gesture using recency-weighted frequency and first-order transitions.
  const predicted = { rock:1.25, paper:1.25, scissors:1.25 };
  history.forEach((choice, index) => {
    const recency = Math.pow(0.965, history.length - 1 - index);
    predicted[choice] += recency;
  });
  const last = history[history.length - 1];
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i] === last) {
      const recency = Math.pow(0.975, history.length - 2 - i);
      predicted[history[i + 1]] += 1.8 * recency;
    }
  }
  if (history.length >= 2) {
    const previous = history[history.length - 2];
    for (let i = 0; i < history.length - 2; i++) {
      if (history[i] === previous && history[i + 1] === last) {
        const recency = Math.pow(0.98, history.length - 3 - i);
        predicted[history[i + 2]] += 2.6 * recency;
      }
    }
  }

  // A fair adaptive opponent: sometimes explores instead of always taking the statistically
  // strongest counter. This keeps the match challenging without making it effectively unbeatable.
  if (secureRandomInt(100) < 32) return choices[secureRandomInt(choices.length)];
  const total = choices.reduce((sum, choice) => sum + predicted[choice], 0);
  const expected = {};
  for (const computer of choices) {
    expected[computer] = choices.reduce((score, player) => {
      const probability = predicted[player] / total;
      if (beats[computer] === player) return score + probability;
      if (beats[player] === computer) return score - probability;
      return score;
    }, 0);
  }
  const best = Math.max(...Object.values(expected));
  const bestReplies = choices.filter(choice => Math.abs(expected[choice] - best) < 1e-9);
  // Randomize only among equally strong replies, preventing a fixed counter-pattern.
  return bestReplies[secureRandomInt(bestReplies.length)];
}
function secureRandomInt(max) {
  if (!Number.isInteger(max) || max < 1) throw new TypeError('max باید عدد صحیح مثبت باشد');
  if (window.crypto?.getRandomValues) {
    const range = 0x100000000;
    const limit = range - (range % max);
    const buffer = new Uint32Array(1);
    let value;
    do { window.crypto.getRandomValues(buffer); value = buffer[0]; } while (value >= limit);
    return value % max;
  }
  return Math.floor(Math.random() * max);
}
function miniGameDisclaimer() { return `<div class="mini-game-info-notice">بازی مهارتی با حریف رایانه‌ای؛ بدون شرط‌بندی و پرداخت وجه.</div>`; }
function miniGameEntryPanel() { return ''; }
function updateHomeMiniStats() {
  if ($('#homeGamesPlayed')) $('#homeGamesPlayed').textContent = money(state.gamesPlayed);
  if ($('#homeWins')) $('#homeWins').textContent = money(state.wins);
}
function applyMiniGameUser(user) {
  if (!user || !currentUser) return;
  currentUser=user;
  state.username=user.name; state.memberId=user.memberId;
  state.balance=Math.max(0,Number(user.balance)||0);
  state.bingoCoins=Math.max(0,Number(user.bingoCoins)||0);
  state.coinTransactions=Array.isArray(user.coinTransactions)?user.coinTransactions.slice(0,50):[];
  state.gamesPlayed=Number(user.stats?.gamesPlayed)||0;
  state.wins=Number(user.stats?.wins)||0;
  state.points=Number(user.stats?.points)||0;
  saveState(); updateHeader(); updateHomeMiniStats();
}
async function loadOrStartServerGame(gameType) {
  const active=await apiRequest('/api/games/active?gameType='+encodeURIComponent(gameType),{method:'GET',headers:{}});
  if(active.match) return active.match;
  const started=await apiRequest('/api/games/start',{method:'POST',body:JSON.stringify({gameType})});
  return started.match;
}
function launchGame(game) {
  if (game === 'rps') {
    if (!requireLogin()) return;
    rpsMatch = null;
    openModal('✊ سنگ، کاغذ، قیچی · رقابت تا ۳ برد', `
      ${miniGameEntryPanel()}
      <p class="muted-note" style="text-align:center">بازی تا زمانی ادامه دارد که تو یا رایانه به ۳ برد برسید. مساوی امتیاز ندارد و دور دوباره بازی می‌شود.</p>
      ${miniGameDisclaimer()}
      <div class="mini-game-rules"><b>حالت پیشرفته · حریف تطبیقی</b><span>رایانه انتخاب‌های قبلی و الگوهای تکراری تو را تحلیل می‌کند.</span><small>حریف از سابقه انتخاب‌ها برای پیش‌بینی استفاده می‌کند، اما همیشه پاسخ برتر را انتخاب نمی‌کند. در برابر انتخاب کاملاً تصادفی، برتری تضمین‌شده‌ای وجود ندارد.</small></div>
      <button class="btn btn-primary btn-block" data-action="rps-start">شروع مسابقه</button>`);
    return;
  }
  if (game === 'tic') {
    if (!requireLogin()) return;
    ticMatch = null;
    openModal('⭕ دوز حرفه‌ای · نبرد ذهنی', `
      ${miniGameEntryPanel()}
      <p class="muted-note" style="text-align:center">روی صفحه ۳×۳ بازی کن و سه علامت خودت را در یک ردیف، ستون یا قطر قرار بده. تو با X شروع می‌کنی و حریف با O پاسخ می‌دهد.</p>
      ${miniGameDisclaimer()}
      <div class="mini-game-rules"><b>حالت پیشرفته · حریف قابل‌رقابت</b><span>حریف حرکت‌های برد فوری و دفاع‌های مهم را تشخیص می‌دهد، اما گاهی انتخاب جایگزین می‌کند تا بازی قابل‌رقابت بماند.</span><small>بازی با برد یکی از طرفین یا پر شدن تمام خانه‌ها پایان می‌یابد. در صورت بازی بی‌نقص هر دو طرف، نتیجه مساوی است.</small></div>
      <button class="btn btn-primary btn-block" data-action="tic-start">شروع بازی دوز</button>`);
    return;
  }
  if (!requireLogin()) return;
  if (game === 'bingo') {
    const nums = Array.from({length:25}, (_,i) => i+1).sort(() => Math.random()-.5);
    bingoGame = { nums, marked:[], calls:0, called:[], won:false };
    openModal('🎱 بینگو تمرینی', `<p class="muted-note">روی عددی که اعلام می‌شود بزن. پنج خانه پشت سر هم را کامل کن.</p><div class="ticker"><span>عدد بعدی</span><strong id="bingoCall">شروع نشده</strong><span id="bingoCount">۰ از ۲۵</span></div><div class="bingo-board">${nums.map(n => `<button class="bingo-cell" data-action="mark-bingo" data-num="${n}">${n}</button>`).join('')}</div><button class="btn btn-primary btn-block" data-action="call-bingo">اعلام عدد جدید</button>`);
    return;
  }
  memoryOpen = []; memoryMatched = [];
  const icons = ['🍒','🍋','🍇','🍒','🍋','🍇'];
  openModal('🧠 حافظه طلایی', `<p class="muted-note">کارت‌ها رو یکی‌یکی باز کن و جفت‌های مشابه رو پیدا کن.</p><div class="bingo-board" id="memoryBoard">${[...icons].sort(() => Math.random()-.5).map((v,i) => `<button class="bingo-cell" data-action="memory-card" data-value="${v}" data-index="${i}">✦</button>`).join('')}</div><p id="memoryStatus" class="muted-note" style="text-align:center">جفت‌های پیدا شده: ۰</p>`);
}
async function startRpsMatch() {
  try {
    const match=await loadOrStartServerGame('rps');
    rpsMatch={...match,awaitingNext:false,last:null};
    renderRpsMatch();
  } catch(error) { showToast(error.message || 'شروع مسابقه ممکن نشد.'); }
}
function renderRpsMatch(lastRound = null) {
  if (!rpsMatch) return;
  const pips = (score, side) => `<div class="rps-targets" aria-label="${side}">${Array.from({length:3},(_,i)=>`<span class="${i<score?'filled':''}">${i<score?'★':'☆'}</span>`).join('')}</div>`;
  let body = `<div class="mini-game-info-notice">مسابقه مهارتی · نتیجه بر اساس انتخاب‌های همین مسابقه</div>
    <div class="rps-score-targets"><div><small>بردهای تو تا ۳</small>${pips(rpsMatch.player,'بردهای تو')}</div><div><small>بردهای رایانه تا ۳</small>${pips(rpsMatch.bot,'بردهای رایانه')}</div></div>
    <div class="mini-game-scoreboard"><div><small>امتیاز تو</small><b>${faDigits(rpsMatch.player)} / ۳</b></div><span>VS</span><div><small>امتیاز رایانه</small><b>${faDigits(rpsMatch.bot)} / ۳</b></div></div>`;
  if (lastRound) body += `<div class="mini-game-round-result ${lastRound.outcome}"><b>نتیجه دور ${faDigits(lastRound.round)}</b><span>${lastRound.text}</span><small>انتخاب تو: ${RPS_CHOICES[lastRound.player].label} · رایانه: ${RPS_CHOICES[lastRound.bot].label}</small></div>`;
  if (rpsMatch.finished) {
    const result = rpsMatch.player === 3 ? 'win' : 'lose';
    body += `<div class="mini-game-final ${result}"><strong>${result === 'win' ? '🏆 برنده شدی!' : 'این بار رایانه برنده شد'}</strong><b>${result === 'win' ? 'یک مسابقه را با موفقیت به پایان رساندی.' : 'برای مسابقه بعدی آماده شو'}</b></div><button class="btn btn-primary btn-block" data-action="rps-start-again">مسابقه جدید</button>`;
  } else if (lastRound) {
    body += `<button class="btn btn-primary btn-block" data-action="rps-next">رفتن به دور بعد</button>`;
  } else {
    body += `<p class="muted-note" style="text-align:center">دور ${faDigits(rpsMatch.round)} · اولین نفر با ۳ برد، قهرمان است.</p><div class="rps-options">${Object.entries(RPS_CHOICES).map(([key,item])=>`<button class="rps-choice" data-action="rps-play" data-choice="${key}"><span>${item.emoji}</span><b>${item.label}</b></button>`).join('')}</div>`;
  }
  body += `<p class="muted-note" style="text-align:center">حریف تطبیقی فعال است · الگوهای قبلی انتخاب‌ها را بررسی می‌کند و برای جلوگیری از پیش‌بینی قطعی، گاهی تصادفی انتخاب می‌کند. سابقه ذخیره‌شده: ${faDigits(rpsMatch.history.length)} انتخاب.</p>`;
  openModal('✊ سنگ، کاغذ، قیچی · رقابت تا ۳ برد', body);
}
async function playRps(choice) {
  if (!rpsMatch || rpsMatch.finished || rpsMatch.awaitingNext || !RPS_CHOICES[choice]) return;
  try {
    const result=await apiRequest('/api/games/move',{method:'POST',body:JSON.stringify({matchId:rpsMatch.id,choice})});
    rpsMatch={...result.match,awaitingNext:!result.match.finished,last:result.lastRound||null};
    saveRpsPlayerChoice(choice);
    if(result.user) applyMiniGameUser(result.user);
    renderRpsMatch(result.lastRound||null);
  } catch(error) { showToast(error.message || 'ثبت حرکت ناموفق بود.'); }
}
function nextRpsRound() {
  if (!rpsMatch || !rpsMatch.awaitingNext || rpsMatch.finished) return;
  rpsMatch.awaitingNext = false;
  renderRpsMatch(rpsMatch.last);
}

// Tic-tac-toe: adaptive opponent with tactical wins/blocks and controlled exploration.
const TIC_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function ticWinner(board) {
  for (const [a,b,c] of TIC_LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return null;
}
function ticMinimax(board, maximizing, depth=0) {
  const winner = ticWinner(board);
  if (winner === 'O') return 10-depth;
  if (winner === 'X') return depth-10;
  if (board.every(Boolean)) return 0;
  if (maximizing) {
    let best = -Infinity;
    for (let i=0;i<9;i++) if (!board[i]) { board[i]='O'; best=Math.max(best,ticMinimax(board,false,depth+1)); board[i]=''; }
    return best;
  }
  let best = Infinity;
  for (let i=0;i<9;i++) if (!board[i]) { board[i]='X'; best=Math.min(best,ticMinimax(board,true,depth+1)); board[i]=''; }
  return best;
}
function ticBotMove(board) {
  // Take an immediate win or block an immediate player win; otherwise use a
  // bounded, imperfect choice so the opponent is challenging but beatable.
  const winningMove = (mark) => {
    for (let i=0;i<9;i++) if (!board[i]) {
      board[i]=mark; const wins=ticWinner(board)===mark; board[i]='';
      if (wins) return i;
    }
    return -1;
  };
  const win = winningMove('O');
  if (win !== -1) return win;
  const block = winningMove('X');
  if (block !== -1 && secureRandomInt(100) < 82) return block;
  const available = board.map((v,i)=>v ? -1 : i).filter(i=>i!==-1);
  if (!available.length) return -1;
  // Prefer center/corners, but occasionally choose another legal square.
  const preferred = available.filter(i=>[0,2,4,6,8].includes(i));
  const pool = preferred.length && secureRandomInt(100)<68 ? preferred : available;
  return pool[secureRandomInt(pool.length)];
}
async function startTicMatch() {
  try {
    const match=await loadOrStartServerGame('tic');
    ticMatch={...match};
    renderTicMatch();
  } catch(error) { showToast(error.message || 'شروع بازی دوز ممکن نشد.'); }
}
function finishTicMatch(result) {
  if (!ticMatch || ticMatch.finished) return;
  ticMatch.finished=true; ticMatch.result=result;
  renderTicMatch();
}
function renderTicMatch() {
  if (!ticMatch) return;
  const cells=ticMatch.board.map((mark,index)=>`<button class="tic-cell ${mark==='X'?'tic-x':mark==='O'?'tic-o':''}" data-action="tic-move" data-index="${index}" ${mark||ticMatch.finished?'disabled':''} aria-label="خانه ${faDigits(index+1)} ${mark?'علامت '+mark:'خالی'}">${mark==='X'?'×':mark==='O'?'○':''}</button>`).join('');
  let status = ticMatch.finished ? (ticMatch.result==='win'?'آفرین! تو برنده شدی.':ticMatch.result==='lose'?'حریف هوشمند برنده شد.':'بازی مساوی شد.') : 'نوبت توست؛ خانه‌ای را انتخاب کن.';
  let body=`<div class="mini-game-info-notice">حریف هوشمند · حرکت‌های برد فوری و دفاع‌های مهم را تشخیص می‌دهد، اما گاهی انتخاب متفاوتی دارد تا بازی قابل‌رقابت بماند.</div>
    <div class="tic-player-legend"><span class="tic-player-x"><b>×</b> تو · X</span><span class="tic-player-o"><b>○</b> رایانه · O</span></div>
    <div class="tic-status ${ticMatch.finished?'finished':''}" aria-live="polite">${status}</div>
    <div class="tic-board" role="group" aria-label="صفحه بازی دوز">${cells}</div>`;
  if (ticMatch.finished) {
    const cls=ticMatch.result==='win'?'win':ticMatch.result==='lose'?'lose':'draw';
    body+=`<div class="mini-game-final ${cls}"><strong>${ticMatch.result==='win'?'🏆 پیروزی!':ticMatch.result==='lose'?'حریف این دور را برد':'🤝 مساوی'}</strong><b>${ticMatch.result==='win'?'بازی را بردی.':'این مسابقه به پایان رسید.'}</b></div><button class="btn btn-primary btn-block" data-action="tic-start-again">بازی دوباره</button>`;
  } else {
    body+=`<p class="muted-note" style="text-align:center">سه علامت یکسان را در یک ردیف، ستون یا قطر قرار بده.</p><button class="btn btn-outline btn-block" data-action="tic-reset">شروع دوباره همین بازی</button>`;
  }
  openModal('⭕ دوز حرفه‌ای · حریف هوشمند',body);
}
async function playTicMove(index) {
  if (!ticMatch || ticMatch.finished || ticMatch.board[index] || !Number.isInteger(index) || index<0 || index>8) return;
  try {
    const result=await apiRequest('/api/games/move',{method:'POST',body:JSON.stringify({matchId:ticMatch.id,index})});
    ticMatch={...result.match};
    if(result.user) applyMiniGameUser(result.user);
    renderTicMatch();
  } catch(error) { showToast(error.message || 'ثبت حرکت دوز ناموفق بود.'); }
}
let bingoLastCall = null;
let memoryOpen = [];
let memoryMatched = [];
function checkBingoWin() {
  const marked = bingoGame.marked;
  const lines = [];
  for (let r=0;r<5;r++) lines.push(Array.from({length:5},(_,c)=>r*5+c));
  for (let c=0;c<5;c++) lines.push(Array.from({length:5},(_,r)=>r*5+c));
  lines.push([0,6,12,18,24],[4,8,12,16,20]);
  return lines.some(line => line.every(index => marked.includes(bingoGame.nums[index])));
}

document.addEventListener('click', async event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) { event.preventDefault(); setPage(pageButton.dataset.page); return; }
  const authTab=event.target.closest('[data-auth-mode]');
  if(authTab){authMode=authTab.dataset.authMode;render();return;}
  const gameButton = event.target.closest('[data-game]');
  if (gameButton) { launchGame(gameButton.dataset.game); return; }
  const filter = event.target.closest('[data-game-filter]');
  if (filter) {
    document.querySelectorAll('[data-game-filter]').forEach(el => el.classList.toggle('active', el === filter));
    document.querySelectorAll('.game-list-item').forEach(el => el.hidden = filter.dataset.gameFilter !== 'all' && el.dataset.category !== filter.dataset.gameFilter);
    return;
  }
  const setting = event.target.closest('[data-setting]');
  if (setting) { const key = setting.dataset.setting; state.settings[key] = !state.settings[key]; saveState(); renderSettingsIntoView(); return; }
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  if (action === 'close-modal' || (action === 'backdrop-close' && event.target === actionEl)) { closeModal(); return; }
  if (action === 'room-join-auto') {
    if(!requireLogin()) return;
    try {
      let result;
      // A short retry makes simultaneous joins resilient to a temporary D1 room lock.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await apiRequest(`/api/rooms/${activeRoomId}/join`, {
            method:'POST',
            body:JSON.stringify({cardsCount:roomCardCount})
          });
          break;
        } catch (error) {
          const temporaryLock = error.message.includes('اتاق در حال به‌روزرسانی است');
          if (!temporaryLock || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      const requestedCardCount=roomCardCount;
      roomServerSnapshot=result.room;
      roomCards=result.room.myCards||[];
      roomCardCount=roomCards.length||roomCardCount;
      if(result.room.status==='playing'){
        activeRoomId=result.room.id;
        roomCalledNumbers=result.room.allCalledNumbers||[];
        currentPage='roomGame';
      }
      // Refresh the authenticated profile from D1 immediately after payment.
      await loadAuthenticatedUser();
      if(roomCards.length < requestedCardCount) {
        showToast(`فقط ${faDigits(roomCards.length)} کارت باقی مانده بود؛ همان تعداد ثبت و از کیف پول کسر شد.`);
      } else {
        showToast(result.room.status==='playing'?'ظرفیت ۳۰ کارت تکمیل شد؛ بازی آغاز شد.':'کارت‌ها خریداری و در صف ثبت شدند.');
      }
      render();
    } catch(error) { showToast(error.message); }
    return;
  }
  if (action === 'room-add-card') {
    if(!requireLogin() || actionEl.disabled) return;
    actionEl.disabled=true;
    try {
      let result;
      for (let attempt=0; attempt<3; attempt++) {
        try {
          result=await apiRequest(`/api/rooms/${activeRoomId}/join`, {
            method:'POST',
            body:JSON.stringify({cardsCount:1})
          });
          break;
        } catch(error) {
          const temporaryLock=error.message.includes('اتاق در حال به‌روزرسانی است');
          if(!temporaryLock || attempt===2) throw error;
          await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
        }
      }
      roomServerSnapshot=result.room;
      roomCards=Array.isArray(result.room.myCards)?result.room.myCards:[];
      roomCardCount=roomCards.length;
      if(result.room.status==='playing') {
        activeRoomId=result.room.id;
        roomCalledNumbers=result.room.allCalledNumbers||[];
        currentPage='roomGame';
      }
      await loadAuthenticatedUser();
      showToast(result.room.status==='playing'
        ? 'کارت اضافی خریداری شد و ظرفیت اتاق تکمیل شد؛ بازی آغاز شد.'
        : 'یک کارت جدید خریداری و به کارت‌های تو اضافه شد.');
      render();
    } catch(error) {
      showToast(error.message);
    } finally {
      if(actionEl.isConnected) actionEl.disabled=false;
    }
    return;
  }
  if (action === 'room-open-game') { if(roomServerSnapshot?.status==='playing'){setPage('roomGame');} else showToast('این سانس هنوز شروع نشده است.'); return; }
  if (action === 'room-back-lobby') { setPage(activeRoomId); return; }
  if (action === 'copy-ref') {
    try { await navigator.clipboard.writeText(state.referralCode); showToast('کد دعوت کپی شد'); }
    catch (_) { const input = $('#refCode'); input?.select(); showToast('کد دعوت را به‌صورت دستی کپی کن'); }
  } else if (action === 'share-ref') {
    const inviteUrl = new URL(location.href); inviteUrl.searchParams.set('ref', state.referralCode); const shareData = { title:'دعوت به دابرناز', text:`با کد ${state.referralCode} به دابرناز بیا!`, url:inviteUrl.toString() };
    if (navigator.share) { try { await navigator.share(shareData); } catch (_) {} }
    else { try { await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`); showToast('متن دعوت کپی شد'); } catch (_) { showToast('اشتراک‌گذاری در این مرورگر پشتیبانی نمی‌شود'); } }
  } else if (action === 'demo-credit') {
    showToast('برای شارژ واقعی، اتصال درگاه پرداخت لازم است.');
  } else if (action === 'wallet-info') showToast('شارژ و برداشت تا اتصال درگاه پرداخت در دسترس نیست.');
  else if (action === 'join-tournament') {
    if(!requireLogin() || actionEl.disabled) return;
    actionEl.disabled=true;
    apiRequest('/api/tournaments/register',{method:'POST',body:JSON.stringify({type:actionEl.dataset.tournament})})
      .then(async result=>{ applyAuthenticatedUser(result.user); await loadAuthenticatedUser(); showToast('ثبت‌نام تورنومنت با موفقیت انجام شد.'); })
      .catch(error=>showToast(error.message))
      .finally(()=>{ if(actionEl.isConnected) actionEl.disabled=false; });
  } else if (action === 'faq') actionEl.parentElement.classList.toggle('open');
  else if (action === 'rps-start' || action === 'rps-start-again') startRpsMatch();
  else if (action === 'rps-play') playRps(actionEl.dataset.choice);
  else if (action === 'rps-next') nextRpsRound();
  else if (action === 'tic-start' || action === 'tic-start-again' || action === 'tic-reset') startTicMatch();
  else if (action === 'tic-move') playTicMove(Number(actionEl.dataset.index));
  else if (action === 'room-increase') { if (roomCardCount < 4) { roomCardCount++; updateRoomCardDisplay(); } else showToast('حداکثر ۴ کارت برای هر بازیکن قابل انتخاب است.'); }
  else if (action === 'room-decrease') { if (roomCardCount > 1) { roomCardCount--; updateRoomCardDisplay(); } }
  else if (action === 'room-show-rules') showRoomQuickRules();
  else if (action === 'call-bingo') callBingo();
  else if (action === 'mark-bingo') markBingo(Number(actionEl.dataset.num));
  else if (action === 'memory-card') revealMemory(actionEl);
  else if (action === 'edit-profile') editProfile();
  else if (action === 'settings') setPage('settings');
  else if (action === 'security') openModal('امنیت حساب', `<div class="form-stack"><p class="muted-note">در نسخه فعلی Cloudflare رمز عبور با PBKDF2-SHA256 و salt اختصاصی هش می‌شود. رمز خام ذخیره نمی‌شود.</p><p class="muted-note">نشست ورود با کوکی HttpOnly نگهداری می‌شود، روی HTTPS ویژگی Secure دارد و پس از ۳۰ روز منقضی می‌شود. سیاست SameSite با توجه به نوع استقرار تنظیم می‌شود.</p><p class="muted-note">تأیید ایمیل و بازیابی رمز عبور هنوز به سرویس ارسال ایمیل نیاز دارد و در این نسخه فعال نیست.</p></div>`);
  else if (action === 'achievements') showToast(`تعداد بردهای ثبت‌شده: ${state.wins}`);
  else if (action === 'logout') { try { await apiRequest('/api/auth/logout',{method:'POST',body:'{}'}); currentUser=null; state=cloneData(defaultState); roomServerSnapshot=null; saveState(); closeModal(); setPage('home'); showToast('با موفقیت از حساب خارج شدی.'); } catch(error){showToast(error.message);} }
  else if (action === 'reset-settings') { state.settings = { ...defaultState.settings }; saveState(); render(); showToast('تنظیمات بازنشانی شد'); }
});
function renderSettingsIntoView() { const y = window.scrollY; render(); window.scrollTo(0,y); }
function callBingo() {
  if (!bingoGame || bingoGame.calls >= 25) return;
  const remaining = bingoGame.nums.filter(n => !bingoGame.called?.includes(n));
  if (!bingoGame.called) bingoGame.called = [];
  const number = remaining[Math.floor(Math.random()*remaining.length)]; bingoGame.called.push(number); bingoGame.calls++;
  $('#bingoCall').textContent = number; $('#bingoCount').textContent = `${bingoGame.calls} از ۲۵`;
  const cell = [...document.querySelectorAll('.bingo-cell')].find(el => Number(el.dataset.num) === number);
  cell?.classList.add('marked');
  if (!bingoGame.marked.includes(number)) bingoGame.marked.push(number);
  if (!bingoGame.won && checkBingoWin()) { bingoGame.won = true; $('#bingoCall').textContent = `${number} · بینگو!`; showToast('آفرین! بینگو تمرینی را کامل کردی؛ در آمار رسمی ثبت نمی‌شود.'); }
}
function markBingo(number) {
  if (!bingoGame || !bingoGame.called?.includes(number)) { showToast('اول صبر کن این عدد اعلام بشه'); return; }
  const cell = [...document.querySelectorAll('.bingo-cell')].find(el => Number(el.dataset.num) === number);
  cell?.classList.add('marked');
}
function revealMemory(button) {
  const index = Number(button.dataset.index);
  if (memoryMatched.includes(index) || memoryOpen.some(x => x.index === index)) return;
  button.textContent = button.dataset.value; button.classList.add('marked'); memoryOpen.push({ index, value:button.dataset.value, button });
  if (memoryOpen.length === 2) {
    const pair = memoryOpen.slice(); memoryOpen = [];
    if (pair[0].value === pair[1].value) {
      memoryMatched.push(pair[0].index,pair[1].index); $('#memoryStatus').textContent = `جفت‌های پیدا شده: ${memoryMatched.length/2}`;
      if (memoryMatched.length === 6) { showToast('آفرین! همه جفت‌ها پیدا شدند؛ این بازی تمرینی است و در آمار رسمی ثبت نمی‌شود.'); }
    } else setTimeout(() => pair.forEach(x => { if (x.button.isConnected) { x.button.textContent='✦'; x.button.classList.remove('marked'); } }), 700);
  }
}
function editProfile() {
  openModal('ویرایش اطلاعات حساب', `<form id="profileForm" class="form-stack"><label class="muted-note">نام نمایشی</label><input class="form-control" name="username" maxlength="32" minlength="2" value="${escapeHTML(state.username)}" required><p class="muted-note">شناسه بازیکن: ${state.memberId}</p><button class="btn btn-primary btn-block" type="submit">ذخیره تغییرات</button></form>`);
}
function confirmReset() {
  openModal('پاک کردن اطلاعات محلی؟', `<p class="muted-note">با این کار اطلاعات نمایشی این مرورگر به حالت اولیه برمی‌گردد.</p><div style="display:flex;gap:8px"><button class="btn btn-muted" style="flex:1" data-action="close-modal">انصراف</button><button class="btn btn-primary" style="flex:1" data-action="confirm-reset">تأیید و بازنشانی</button></div>`);
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action="confirm-reset"]');
  if (button) { state = cloneData(defaultState); saveState(); closeModal(); setPage('home'); showToast('اطلاعات محلی بازنشانی شد'); }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'authForm') {
    event.preventDefault(); const data=new FormData(event.target); const register=authMode==='register';
    const payload={email:String(data.get('email')||'').trim(),password:String(data.get('password')||'')};
    if(register) { payload.name=String(data.get('name')||'').trim(); payload.referralCode=String(data.get('referralCode')||new URLSearchParams(location.search).get('ref')||'').trim(); }
    const submit=event.target.querySelector('button[type=submit]'); if(submit) submit.disabled=true;
    try { await apiRequest(register?'/api/auth/register':'/api/auth/login',{method:'POST',body:JSON.stringify(payload)}); currentPage='home'; await loadAuthenticatedUser(); showToast(register?'حساب با موفقیت ساخته شد.':'با موفقیت وارد شدی.'); }
    catch(error){showToast(error.message);} finally { if(submit?.isConnected) submit.disabled=false; }
  }
  if (event.target.id === 'profileForm') {
    event.preventDefault(); const name = new FormData(event.target).get('username').toString().trim();
    if (name.length < 2) { showToast('نام باید حداقل ۲ حرف داشته باشد'); return; }
    try { const result=await apiRequest('/api/profile',{method:'PATCH',body:JSON.stringify({name})}); applyAuthenticatedUser(result.user); closeModal(); render(); showToast('نام نمایشی در حساب ذخیره شد'); } catch(error){showToast(error.message);}
  }
  if (event.target.id === 'supportForm') {
    event.preventDefault(); const data = new FormData(event.target);
    if (!data.get('subject').toString().trim() || !data.get('message').toString().trim()) return;
    if(!requireLogin()) return;
    const submit=event.target.querySelector('button[type=submit]'); if(submit) submit.disabled=true;
    apiRequest('/api/support',{method:'POST',body:JSON.stringify({subject:String(data.get('subject')).trim(),message:String(data.get('message')).trim()})})
      .then(result=>{ const subject=String(data.get('subject')).trim(); event.target.reset(); state.supportTickets=[{id:result.ticketId,subject,status:'open',created_at:new Date().toISOString()},...(state.supportTickets||[])].slice(0,20); render(); showToast(`پیام ثبت شد. شماره پیگیری: ${faDigits(result.ticketId)}`); })
      .catch(error=>showToast(error.message))
      .finally(()=>{ if(submit?.isConnected) submit.disabled=false; });
  }
});

render();
loadAuthenticatedUser();
// Refresh the authenticated account and the active room when a mobile browser/WebView
// returns to the foreground. Background tabs can throttle timers, so rely on an
// immediate authoritative read when visibility or focus returns.
async function refreshAppAfterForeground() {
  if (document.hidden) return;
  if (currentUser) await loadAuthenticatedUser();
  if (currentUser && (ROOM_CONFIGS.some(room=>room.id===currentPage) || currentPage==='roomGame')) {
    pollCurrentRoom();
  }
}
document.addEventListener('visibilitychange', refreshAppAfterForeground);
window.addEventListener('focus', refreshAppAfterForeground);
window.addEventListener('online', () => {
  loadAuthenticatedUser().then(() => {
    if (currentUser && (ROOM_CONFIGS.some(room=>room.id===currentPage) || currentPage==='roomGame')) pollCurrentRoom();
  });
});
setInterval(() => { if (currentUser && (ROOM_CONFIGS.some(room=>room.id===currentPage) || currentPage==='roomGame')) pollCurrentRoom(); }, 2200);
