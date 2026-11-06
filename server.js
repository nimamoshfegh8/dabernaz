'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PRIVATE_DIR = process.env.DABERNAZ_DATA_DIR || path.join(ROOT, '.private');
const DB_FILE = path.join(PRIVATE_DIR, 'store.json');
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ROOM_CAPACITY = 20;
const requestedDrawInterval = Number(process.env.DABERNAZ_DRAW_INTERVAL_MS || 3000);
const DRAW_INTERVAL_MS = Number.isFinite(requestedDrawInterval) ? Math.max(20, Math.min(requestedDrawInterval, 60000)) : 3000;
const ROOM_CONFIG = {
  room5000: { price: 5000 }, room10000: { price: 10000 },
  room20000: { price: 20000 }, room50000: { price: 50000 }
};
const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.ico':'image/x-icon'
};

let db = { users: [], sessions: [], rooms: {}, roomHistory: [] };
let writeChain = Promise.resolve();
const drawTimers = new Map();
const authAttempts = new Map();

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, memberId: user.memberId, createdAt: user.createdAt, stats: user.stats || { gamesPlayed:0, wins:0, points:0 }, bingoCoins:Number(user.bingoCoins)||0, coinTransactions:Array.isArray(user.coinTransactions)?user.coinTransactions.slice(0,50):[] };
}
function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(JSON.stringify(payload));
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    const key = part.slice(0,index);
    const raw = part.slice(index+1);
    try { return [key, decodeURIComponent(raw)]; }
    catch { return [key, raw]; }
  }));
}
function validateWriteOrigin(req, url) {
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw Object.assign(new Error('مبدأ درخواست معتبر نیست.'), { status:403 }); }
    if (parsed.origin !== url.origin) throw Object.assign(new Error('مبدأ درخواست معتبر نیست.'), { status:403 });
  } else if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    throw Object.assign(new Error('مبدأ درخواست معتبر نیست.'), { status:403 });
  }
}
function cookieOptions(maxAge) {
  const secure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  return `dabernaz_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function sessionCookie(token) {
  const secure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  return `dabernaz_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL/1000)}${secure ? '; Secure' : ''}`;
}
async function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(PRIVATE_DIR, { recursive:true, mode:0o700 });
    const temp = `${DB_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, snapshot, { mode:0o600 });
    await fs.promises.rename(temp, DB_FILE);
  });
  return writeChain;
}
async function loadDb() {
  try {
    const saved = JSON.parse(await fs.promises.readFile(DB_FILE, 'utf8'));
    db = { users:Array.isArray(saved.users)?saved.users:[], sessions:Array.isArray(saved.sessions)?saved.sessions:[], rooms:saved.rooms && typeof saved.rooms==='object'?saved.rooms:{}, roomHistory:Array.isArray(saved.roomHistory)?saved.roomHistory:[] };
  } catch (error) {
    if (error.code === 'ENOENT') {
      await persist();
    } else {
      // Never replace an unreadable/corrupt database with an empty one.
      throw new Error('Database file is unreadable; startup stopped to protect existing data.', { cause:error });
    }
  }
  for (const user of db.users) { if (!Number.isFinite(Number(user.bingoCoins))) user.bingoCoins=0; if (!Array.isArray(user.coinTransactions)) user.coinTransactions=[]; if (!user.stats) user.stats={gamesPlayed:0,wins:0,points:0}; }
  for (const id of Object.keys(ROOM_CONFIG)) if (!db.rooms[id]) db.rooms[id] = freshRoom(id);
  db.sessions = db.sessions.filter(item => item.expiresAt > Date.now());
  await persist();
  for (const room of Object.values(db.rooms)) if (room.status === 'playing') startDrawTimer(room.id);
}
function freshRoom(id) {
  return { id, status:'waiting', queue:[], cardCounts:{}, queuedCards:{}, players:[], calledNumbers:[], winners:{line:null,full:null}, startedAt:null, finishedAt:null, updatedAt:Date.now(), resultsRecorded:false };
}
function secureShuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function makeCard() {
  // 3 rows, 9 columns, 5 numbers per row, with every column populated.
  const grid=Array.from({length:3},()=>Array(9).fill(false));
  for(let r=0;r<3;r++) for(const c of secureShuffle([...Array(9).keys()]).slice(0,5)) grid[r][c]=true;
  let counts=Array.from({length:9},(_,c)=>grid.reduce((sum,row)=>sum+(row[c]?1:0),0));
  for(let missing=0;missing<9;missing++) if(counts[missing]===0) {
    const moves=[];
    for(let r=0;r<3;r++) if(!grid[r][missing]) for(let donor=0;donor<9;donor++) if(grid[r][donor]&&counts[donor]>1) moves.push({r,donor});
    if(!moves.length) throw new Error('Could not construct a valid Daberna card');
    const chosen=moves[crypto.randomInt(moves.length)];
    grid[chosen.r][chosen.donor]=false; grid[chosen.r][missing]=true;
    counts[chosen.donor]--; counts[missing]++;
  }
  const card=grid.map(row=>row.map(value=>value?0:null));
  for(let c=0;c<9;c++) {
    const min=c===0?1:c*10; const max=c===8?90:c*10+9;
    const places=[0,1,2].filter(r=>card[r][c]===0);
    const values=secureShuffle(Array.from({length:max-min+1},(_,i)=>min+i)).slice(0,places.length).sort((a,b)=>a-b);
    places.forEach((r,i)=>card[r][c]=values[i]);
  }
  return card;
}
function lineComplete(card, called) {
  return card.some(row => row.filter(Number.isInteger).length === 5 && row.every(n => n === null || called.has(n)));
}
function fullComplete(card, called) {
  return card.flat().filter(Number.isInteger).length === 15 && card.flat().every(n => n === null || called.has(n));
}
function publicRoom(room, userId) {
  const me = room.players.find(p => p.userId === userId) || null;
  const queued = room.queue.includes(userId);
  const account = db.users.find(user=>user.id===userId);
  return {
    id:room.id, status:room.status, capacity:ROOM_CAPACITY,
    queueCount:room.status==='waiting' ? room.queue.length : room.players.length,
    players:room.players.map(p=>({name:p.name,memberId:p.memberId})),
    calledNumbers:room.calledNumbers.slice(-15), allCalledNumbers:room.calledNumbers, drawCount:room.calledNumbers.length,
    latestNumber:room.calledNumbers.at(-1) ?? null, winners:{line:room.winners.line?{name:room.winners.line.name,memberId:room.winners.line.memberId,number:room.winners.line.number,at:room.winners.line.at}:null,full:room.winners.full?{name:room.winners.full.name,memberId:room.winners.full.memberId,number:room.winners.full.number,at:room.winners.full.at}:null},
    myCards:me ? me.cards : (queued ? (room.queuedCards?.[userId] || []) : []), joined:queued || !!me,
    startedAt:room.startedAt, finishedAt:room.finishedAt,
    myBingoCoins:Number(account?.bingoCoins)||0,
    myCoinTransactions:Array.isArray(account?.coinTransactions)?account.coinTransactions.slice(0,50):[],
    recentSessions:(db.roomHistory||[]).filter(item=>item.roomId===room.id).slice(-8).reverse()
  };
}
function awardBingoCoins(userId, amount, title) {
  const user=db.users.find(item=>item.id===userId); if(!user) return;
  user.bingoCoins=Math.min(1000000000,(Number(user.bingoCoins)||0)+amount);
  user.coinTransactions=Array.isArray(user.coinTransactions)?user.coinTransactions:[];
  user.coinTransactions.unshift({amount,title,date:new Date().toISOString()});
  user.coinTransactions=user.coinTransactions.slice(0,50);
}
function drawOne(room) {
  if (room.status !== 'playing') return;
  if (room.calledNumbers.length >= 90) { finishRoom(room); return; }
  const remaining = Array.from({length:90},(_,i)=>i+1).filter(n=>!room.calledNumbers.includes(n));
  const number = remaining[crypto.randomInt(remaining.length)];
  room.calledNumbers.push(number);
  const called = new Set(room.calledNumbers);
  for (const player of room.players) {
    if (!room.winners.line && player.cards.some(card=>lineComplete(card,called))) {
      room.winners.line = { name:player.name, memberId:player.memberId, userId:player.userId, number, at:Date.now() };
      awardBingoCoins(player.userId,1,'پاداش برنده یک خط دبرنا');
    }
  }
  for (const player of room.players) {
    if (!room.winners.full && player.cards.some(card=>fullComplete(card,called))) {
      room.winners.full = { name:player.name, memberId:player.memberId, userId:player.userId, number, at:Date.now() };
      awardBingoCoins(player.userId,2,'پاداش برنده دبرنای کامل');
    }
  }
  room.updatedAt = Date.now();
  if ((room.winners.line && room.winners.full) || room.calledNumbers.length >= 90) finishRoom(room);
  persist().catch(error=>console.error('Persist draw failed:',error.message));
}
function finishRoom(room) {
  if (room.status === 'finished') return;
  room.status = 'finished'; room.finishedAt = Date.now(); room.updatedAt = Date.now();

  // Account the completed round once: every participant gets a played game,
  // and every distinct line/full winner gets a win and points.
  if (!room.resultsRecorded) {
    const winnerIds = new Set();
    for (const winner of [room.winners?.line, room.winners?.full]) {
      if (winner?.userId) winnerIds.add(winner.userId);
    }
    for (const player of room.players) {
      const user = db.users.find(item=>item.id===player.userId);
      if (!user) continue;
      user.stats=user.stats||{gamesPlayed:0,wins:0,points:0};
      user.stats.gamesPlayed=Math.min(100000000,Number(user.stats.gamesPlayed||0)+1);
      if (winnerIds.has(user.id)) {
        user.stats.wins=Math.min(100000000,Number(user.stats.wins||0)+1);
        user.stats.points=Math.min(1000000000,Number(user.stats.points||0)+10);
      }
    }
    db.roomHistory=Array.isArray(db.roomHistory)?db.roomHistory:[];
    db.roomHistory.push({
      roomId:room.id,
      startedAt:room.startedAt,
      finishedAt:room.finishedAt,
      line:room.winners?.line ? {name:room.winners.line.name,memberId:room.winners.line.memberId} : null,
      full:room.winners?.full ? {name:room.winners.full.name,memberId:room.winners.full.memberId} : null
    });
    if (db.roomHistory.length>200) db.roomHistory=db.roomHistory.slice(-200);
    room.resultsRecorded=true;
  }

  stopDrawTimer(room.id); persist().catch(error=>console.error('Persist finish failed:',error.message));
}
function startDrawTimer(roomId) {
  if (drawTimers.has(roomId)) return;
  const timer = setInterval(() => {
    const room = db.rooms[roomId]; if (!room || room.status !== 'playing') return stopDrawTimer(roomId);
    drawOne(room);
  }, DRAW_INTERVAL_MS);
  drawTimers.set(roomId,timer);
}
function stopDrawTimer(roomId) { const timer=drawTimers.get(roomId); if(timer)clearInterval(timer); drawTimers.delete(roomId); }
function startRoom(room) {
  room.players = room.queue.map(userId => {
    const user = db.users.find(u=>u.id===userId);
    return { userId, name:user?.name || 'بازیکن', memberId:user?.memberId || '—', cards:room.queuedCards?.[userId] || [makeCard()] };
  });
  room.queue = []; room.queuedCards = {}; room.status = 'playing'; room.calledNumbers = [];
  room.winners = {line:null,full:null}; room.resultsRecorded=false; room.startedAt = Date.now(); room.finishedAt=null; room.updatedAt=Date.now();
  persist().catch(error=>console.error('Persist room start failed:',error.message));
  startDrawTimer(room.id);
}
function authenticate(req) {
  const token = parseCookies(req.headers.cookie).dabernaz_session;
  if (!token) return null;
  const hash = sha256(token);
  const session = db.sessions.find(item=>safeEqual(item.tokenHash,hash) && item.expiresAt>Date.now());
  if (!session) return null;
  return db.users.find(user=>user.id===session.userId) || null;
}
async function readBody(req) {
  let raw='';
  for await (const chunk of req) { raw += chunk; if (raw.length > 32*1024) throw Object.assign(new Error('درخواست بیش از حد بزرگ است.'),{status:413}); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('داده ارسالی معتبر نیست.'),{status:400}); }
}
function rateLimited(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now=Date.now(); const state=authAttempts.get(ip) || {count:0,until:now+10*60*1000};
  if (now>state.until) { state.count=0; state.until=now+10*60*1000; }
  state.count++; authAttempts.set(ip,state); return state.count>60;
}
async function routeApi(req,res,url) {
  if (['POST','PATCH','PUT','DELETE'].includes(req.method)) validateWriteOrigin(req,url);
  if (req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,service:'dabernaz',backend:'node',mode:'accounts-and-automatic-rooms-ready'});
  if (req.method==='POST' && (url.pathname==='/api/auth/register' || url.pathname==='/api/auth/login')) {
    if (rateLimited(req)) return json(res,429,{error:'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کن.'});
    const body=await readBody(req);
    const email=String(body.email||'').trim().toLowerCase(); const password=String(body.password||'');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>190) return json(res,400,{error:'ایمیل معتبر وارد کن.'});
    if (password.length<8 || password.length>128) return json(res,400,{error:'رمز عبور باید بین ۸ تا ۱۲۸ نویسه باشد.'});
    let user;
    if (url.pathname.endsWith('/register')) {
      const name=String(body.name||'').trim();
      if (name.length<2 || name.length>32) return json(res,400,{error:'نام نمایشی باید بین ۲ تا ۳۲ نویسه باشد.'});
      if (db.users.some(item=>item.email===email)) return json(res,409,{error:'با این ایمیل قبلاً حساب ساخته شده است.'});
      const salt=crypto.randomBytes(16).toString('hex');
      const passwordHash=(await scrypt(password,salt,64)).toString('hex');
      if (db.users.some(item=>item.email===email)) return json(res,409,{error:'با این ایمیل قبلاً حساب ساخته شده است.'});
      let memberId; do { memberId=String(100000+crypto.randomInt(900000)); } while(db.users.some(item=>item.memberId===memberId));
      user={id:crypto.randomUUID(),name,email,memberId,passwordSalt:salt,passwordHash,stats:{gamesPlayed:0,wins:0,points:0},bingoCoins:0,coinTransactions:[],createdAt:new Date().toISOString()};
      db.users.push(user);
    } else {
      user=db.users.find(item=>item.email===email);
      if (!user) return json(res,401,{error:'ایمیل یا رمز عبور اشتباه است.'});
      const candidate=(await scrypt(password,user.passwordSalt,64)).toString('hex');
      if (!safeEqual(candidate,user.passwordHash)) return json(res,401,{error:'ایمیل یا رمز عبور اشتباه است.'});
    }
    const token=randomToken(); db.sessions=db.sessions.filter(item=>item.expiresAt>Date.now());
    db.sessions.push({tokenHash:sha256(token),userId:user.id,expiresAt:Date.now()+SESSION_TTL});
    await persist();
    return json(res,200,{ok:true,user:publicUser(user)},{'Set-Cookie':sessionCookie(token)});
  }
  if (req.method==='POST' && url.pathname==='/api/auth/logout') {
    const token=parseCookies(req.headers.cookie).dabernaz_session;
    const activeUser=token ? authenticate(req) : null;
    if (token) db.sessions=db.sessions.filter(item=>!safeEqual(item.tokenHash,sha256(token)));
    if(activeUser) for(const room of Object.values(db.rooms)) if(room.status==='waiting'){room.queue=room.queue.filter(id=>id!==activeUser.id);if(room.queuedCards)delete room.queuedCards[activeUser.id];if(room.cardCounts)delete room.cardCounts[activeUser.id];}
    await persist(); return json(res,200,{ok:true},{'Set-Cookie':cookieOptions(0)});
  }
  if (req.method==='GET' && url.pathname==='/api/auth/me') {
    const user=authenticate(req); return user ? json(res,200,{ok:true,user:publicUser(user)}) : json(res,200,{ok:true,user:null});
  }
  const user=authenticate(req);
  if (!user) return json(res,401,{error:'برای ادامه ابتدا وارد حساب کاربری شو.'});
  if (req.method==='POST' && url.pathname==='/api/games/result') {
    const body=await readBody(req);
    if(typeof body.won!=='boolean') return json(res,400,{error:'نتیجه مسابقه معتبر نیست.'});
    user.stats=user.stats||{gamesPlayed:0,wins:0,points:0};
    user.stats.gamesPlayed=Math.min(100000000,user.stats.gamesPlayed+1);
    if(body.won){user.stats.wins=Math.min(100000000,user.stats.wins+1);user.stats.points=Math.min(1000000000,user.stats.points+10);}
    await persist(); return json(res,200,{ok:true,stats:user.stats});
  }
  if (req.method==='PATCH' && url.pathname==='/api/profile') {
    const body=await readBody(req); const name=String(body.name||'').trim();
    if(name.length<2 || name.length>32) return json(res,400,{error:'نام نمایشی باید بین ۲ تا ۳۲ نویسه باشد.'});
    user.name=name; await persist(); return json(res,200,{ok:true,user:publicUser(user)});
  }
  const roomMatch=url.pathname.match(/^\/api\/rooms\/(room5000|room10000|room20000|room50000)(?:\/(join|leave))?$/);
  if (roomMatch) {
    const [,roomId,action]=roomMatch; const room=db.rooms[roomId];
    if (req.method==='GET' && !action) return json(res,200,{ok:true,room:publicRoom(room,user.id)});
    if (req.method==='POST' && action==='join') {
      const joinBody=await readBody(req);
      const cardCount=Math.max(1,Math.min(4,Math.floor(Number(joinBody.cardsCount)||1)));
      if (room.status==='finished') { Object.assign(room,freshRoom(roomId)); }
      if (room.status==='playing') return json(res,409,{error:'این سانس در حال اجراست. بعد از پایان وارد سانس بعدی شو.',room:publicRoom(room,user.id)});
      if (room.queue.includes(user.id)) return json(res,200,{ok:true,room:publicRoom(room,user.id)});
      room.cardCounts=room.cardCounts||{}; room.queuedCards=room.queuedCards||{};
      room.cardCounts[user.id]=cardCount; room.queuedCards[user.id]=Array.from({length:cardCount},()=>makeCard());
      room.queue.push(user.id); room.updatedAt=Date.now();
      if (room.queue.length===ROOM_CAPACITY) startRoom(room); else await persist();
      return json(res,200,{ok:true,room:publicRoom(room,user.id)});
    }
    if (req.method==='POST' && action==='leave') {
      if (room.status==='waiting') { room.queue=room.queue.filter(id=>id!==user.id); if(room.cardCounts) delete room.cardCounts[user.id]; if(room.queuedCards) delete room.queuedCards[user.id]; }
      await persist(); return json(res,200,{ok:true,room:publicRoom(room,user.id)});
    }
  }
  return json(res,404,{error:'مسیر API پیدا نشد.'});
}

const server=http.createServer(async (req,res)=>{
  let url;
  try {
    const forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase();
    const protocol=forwardedProto==='https' ? 'https:' : 'http:';
    url=new URL(req.url,`${protocol}//${req.headers.host||'localhost'}`);
  }
  catch { return json(res,400,{error:'آدرس درخواست معتبر نیست.'}); }
  if (url.pathname.startsWith('/api/')) {
    try { return await routeApi(req,res,url); }
    catch(error) { console.error('API error:',error); return json(res,error.status||500,{error:error.status?error.message:'خطای داخلی سرور رخ داد.'}); }
  }
  if (req.method!=='GET' && req.method!=='HEAD') { res.writeHead(405,{'Allow':'GET, HEAD'}); return res.end('Method not allowed'); }
  let pathname;
  try { pathname=decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname==='/') pathname='/index.html';
  const privateStaticFiles=new Set(['/server.js','/package.json','/README.md','/README.fa.md','/api.php','/.gitignore']);
  if (privateStaticFiles.has(pathname) || pathname.includes('\0') || pathname.split('/').some(part=>part.startsWith('.')) && pathname!=='/.well-known') { res.writeHead(404); return res.end('Not found'); }
  const filePath=path.resolve(ROOT,`.${pathname}`);
  if (!filePath.startsWith(ROOT+path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath,(error,data)=>{
    if(error) { res.writeHead(error.code==='ENOENT'?404:500,{'Content-Type':'text/plain; charset=utf-8'}); return res.end(error.code==='ENOENT'?'404 - File not found':'Server error'); }
    res.writeHead(200,{'Content-Type':MIME[path.extname(filePath).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});
    if(req.method==='HEAD')return res.end(); res.end(data);
  });
});

loadDb().then(()=>server.listen(PORT,HOST,()=>console.log(`Dabernaz server listening on ${HOST}:${PORT}`))).catch(error=>{console.error('Startup failed:',error);process.exit(1);});
process.on('SIGINT',()=>{for(const id of drawTimers.keys())stopDrawTimer(id);server.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{for(const id of drawTimers.keys())stopDrawTimer(id);server.close(()=>process.exit(0));});
