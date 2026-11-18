'use strict';

const STORAGE_KEY = 'dabernaz_state_v1';
const cloneData = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const defaultState = {
  username: '', memberId: '', balance: 0, joined: [], transactions: [],
  settings: { sounds: true, voiceNumbers: false, voiceAudioVersion: 6, notifications: false, vibration: false },
  referralCode: '', gamesPlayed: 0, wins: 0, points: 0,
  bingoCoins: 0, coinTransactions: [], inviteCount: 0, inviteRewardMilestones: [],
  roomHistory: [], supportTickets: [], tournamentRooms: [], tournamentEntries: [],
  walletRequests: [], walletPaymentInfo: {cardNumber:'',cardHolder:'',bankName:'',paymentNote:''}
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const previous = saved && typeof saved === 'object' && saved.settings && typeof saved.settings === 'object'
      ? saved.settings : {};
    const settings = { ...defaultState.settings, ...previous };
    if (!Number.isFinite(Number(previous.voiceAudioVersion)) || Number(previous.voiceAudioVersion) < 4) {
      settings.voiceNumbers = false;
    }
    settings.voiceAudioVersion = 6;
    // Older builds stored balances, histories, tickets and wallet data locally.
    // Rewrite the record immediately so private account data is removed at startup.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings }));
    return { ...cloneData(defaultState), settings };
  } catch (_) { return cloneData(defaultState); }
}
let state = loadState();
// Never trust balances or guest identities left by older demo builds.
state.username=''; state.memberId=''; state.balance=0; state.bingoCoins=0;
state.gamesPlayed=0; state.wins=0; state.points=0; state.joined=[];
state.transactions=[]; state.coinTransactions=[]; state.referralCode='';
let currentUser = null;
let supportAdminEnabled=false, supportAdminTickets=[], supportSelectedTicketId=null, supportThread=null, supportAdminFilter='all', supportAdminKnownTicketIds=new Set();
let walletAdminEnabled=false, walletAdminRequests=[], walletAdminFilter='all', walletAdminSelectedRequest=null, walletAdminUsers=[], walletAdminSelectedMemberId='';
let walletActivePaymentInfo=null;
let authReady = false;
let apiReady = false;
let apiErrorMessage = '';
let authMode = 'login';
let roomServerSnapshot = null;
let roomPollBusy = false;
let currentPage = 'home';
let toastTimer = null;
let bingoGame = null;
let tournamentLobbyTab = 'all';
let tournamentPollTimer = null;
let tournamentPollBusy = false;
const spokenTournamentAnnouncementKeys = new Set();
const spokenRoomAnnouncementKeys = new Set();
const roomSpeechInFlight = new Set();
const roomSpeechRetryAt = new Map();
let roomJoinBusy = false;

function settingEnabled(key) { return !!state?.settings?.[key]; }

function numberToPersianWords(number) {
  const value = Math.trunc(Number(number));
  if (!Number.isFinite(value) || value < 0 || value > 999) return '';
  const units = ['صفر','یک','دو','سه','چهار','پنج','شش','هفت','هشت','نه'];
  const teens = ['ده','یازده','دوازده','سیزده','چهارده','پانزده','شانزده','هفده','هجده','نوزده'];
  const tens = ['','','بیست','سی','چهل','پنجاه','شصت','هفتاد','هشتاد','نود'];
  const hundreds = ['','صد','دویست','سیصد','چهارصد','پانصد','ششصد','هفتصد','هشتصد','نهصد'];
  if (value < 10) return units[value];
  if (value < 20) return teens[value - 10];
  if (value < 100) {
    const ten = Math.floor(value / 10);
    const one = value % 10;
    return one ? `${tens[ten]} و ${units[one]}` : tens[ten];
  }
  const hundred = Math.floor(value / 100);
  const rest = value % 100;
  return rest ? `${hundreds[hundred]} و ${numberToPersianWords(rest)}` : hundreds[hundred];
}

function numberToPersianSpeechText(number) {
  return numberToPersianWords(number).replace(/\s+و\s+/g, ' ').replace(/\s+/g, ' ').trim();
}

let persianAudioContext = null;
let persianAudioAssetPromise = null;
let persianAudioAsset = null;
let persianAudioQueue = Promise.resolve();
let browserSpeechVoice = null;
let voicePackReady = false;
let voicePackCheckPromise = null;
let voicePlaybackErrorShown = false;
const nativeSpeechPending = new Map();
let nativeSpeechSequence = 0;

function refreshPersianBrowserVoices() {
  if (!('speechSynthesis' in window) || typeof window.speechSynthesis.getVoices !== 'function') return null;
  const voices = window.speechSynthesis.getVoices();
  const persianVoices = voices.filter(voice => /^fa(?:-|_)/i.test(voice.lang) || /persian|farsi|فارسی/i.test(voice.name));
  browserSpeechVoice = persianVoices.find(voice => /female|woman|زن/i.test(voice.name)) || persianVoices[0] || null;
  return browserSpeechVoice;
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = refreshPersianBrowserVoices;
  refreshPersianBrowserVoices();
}

function nativePersianTtsAvailable() {
  try {
    return !!(window.DabernazNativeTTS &&
      typeof window.DabernazNativeTTS.isAvailable === 'function' &&
      window.DabernazNativeTTS.isAvailable());
  } catch (_) {
    return false;
  }
}

window.addEventListener('dabernaz-native-tts-result', event => {
  const detail = event?.detail || {};
  const pending = nativeSpeechPending.get(String(detail.requestId || ''));
  if (!pending) return;
  nativeSpeechPending.delete(String(detail.requestId));
  clearTimeout(pending.timer);
  if (detail.ok) pending.resolve(true);
  else pending.reject(new Error(detail.error || 'موتور گفتار فارسی اندروید نتوانست شماره را پخش کند.'));
});

function speakPersianNumberNative(number) {
  const value = Math.trunc(Number(number));
  const bridge = window.DabernazNativeTTS;
  if (!Number.isInteger(value) || value < 1 || value > 90 ||
      !nativePersianTtsAvailable() || typeof bridge.speak !== 'function') {
    return Promise.reject(new Error('موتور گفتار بومی فارسی اندروید در دسترس نیست.'));
  }
  const requestId = 'dabernaz-voice-' + (++nativeSpeechSequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeSpeechPending.delete(requestId);
      reject(new Error('موتور گفتار اندروید در زمان مقرر پاسخ نداد.'));
    }, 18000);
    nativeSpeechPending.set(requestId, { resolve, reject, timer });
    try {
      bridge.speak(numberToPersianSpeechText(value), 'fa-IR', requestId);
    } catch (error) {
      clearTimeout(timer);
      nativeSpeechPending.delete(requestId);
      reject(error);
    }
  });
}

function speakPersianNumberFallback(number) {
  const value = Math.trunc(Number(number));
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    return Promise.reject(new Error('شمارهٔ صوتی معتبر نیست.'));
  }

  // Prefer Android's native TTS bridge in the installed APK. Browser speech is
  // retained only for the normal website/PWA where the native bridge is absent.
  if (nativePersianTtsAvailable()) return speakPersianNumberNative(value);

  if (!('speechSynthesis' in window) ||
      typeof window.SpeechSynthesisUtterance !== 'function') {
    return Promise.reject(new Error('موتور گفتار در این مرورگر موجود نیست. برای صدای Sage Woman باید بستهٔ کامل صوتی نصب شود.'));
  }

  refreshPersianBrowserVoices();
  const text = numberToPersianSpeechText(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let keepAlive = null;
    let startTimeout = null;
    let endTimeout = null;
    const cleanup = () => {
      if (keepAlive) clearInterval(keepAlive);
      if (startTimeout) clearTimeout(startTimeout);
      if (endTimeout) clearTimeout(endTimeout);
    };
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (ok) resolve(true);
      else reject(error || new Error('پخش صدای فارسی توسط مرورگر متوقف شد.'));
    };
    try {
      const synth = window.speechSynthesis;
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = browserSpeechVoice?.lang || 'fa-IR';
      if (browserSpeechVoice) utterance.voice = browserSpeechVoice;
      utterance.rate = 0.84;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onstart = () => {
        started = true;
        if (startTimeout) clearTimeout(startTimeout);
        endTimeout = setTimeout(() => finish(false, new Error('گفتار فارسی مرورگر شروع شد اما کامل نشد.')), 14000);
      };
      utterance.onend = () => finish(true);
      utterance.onerror = event => finish(false, new Error(event?.error || 'مرورگر صدای فارسی را پخش نکرد.'));
      synth.resume();
      synth.speak(utterance);
      startTimeout = setTimeout(() => {
        if (!started) finish(false, new Error('مرورگر نتوانست موتور گفتار فارسی را فعال کند؛ صدای فارسی دستگاه را بررسی کن.'));
      }, 4000);
      keepAlive = setInterval(() => {
        if (settled) return cleanup();
        if (synth.paused) synth.resume();
      }, 250);
    } catch (error) {
      finish(false, error);
    }
  });
}

function unlockPersianAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!persianAudioContext || persianAudioContext.state === 'closed') {
      persianAudioContext = new AudioContextClass();
    }
    const context = persianAudioContext;
    if (context.state === 'suspended') context.resume().catch(() => {});
    const silent = context.createBufferSource();
    silent.buffer = context.createBuffer(1, Math.max(1, Math.floor(context.sampleRate * 0.02)), context.sampleRate);
    const gain = context.createGain();
    gain.gain.value = 0;
    silent.connect(gain);
    gain.connect(context.destination);
    silent.start();
    silent.stop(context.currentTime + 0.02);
    return true;
  } catch (error) {
    console.warn('[Dabernaz audio unlock]', error);
    return false;
  }
}

async function loadPersianNumberAudio(number) {
  const value = Math.trunc(Number(number));
  if (!Number.isInteger(value) || value < 1 || value > 90) throw new Error('شمارهٔ صوتی معتبر نیست.');
  if (!persianAudioContext) throw new Error('خروجی صوتی مرورگر فعال نشده است.');
  if (persianAudioAsset) {
    const clip = persianAudioAsset.manifest.numbers[String(value)];
    if (!clip) throw new Error('فایل صوتی این شماره در بسته Sage Woman پیدا نشد.');
    return { buffer: persianAudioAsset.buffer, clip };
  }

  if (!persianAudioAssetPromise) {
    const loading = (async () => {
      const base = new URL('./assets/voice/', document.baseURI);
      const manifestResponse = await fetch(new URL('sage-woman.json?v=6', base), {
        method: 'GET', cache: 'no-store', credentials: 'same-origin'
      });
      if (!manifestResponse.ok) throw new Error('مانیفست صدای Sage Woman دریافت نشد.');
      const manifest = await manifestResponse.json();
      if (!manifest || manifest.provider !== 'kenerate-sage-woman' ||
          manifest.voice !== 'Sage Woman' || manifest.language !== 'fa-IR' ||
          manifest.configured !== true || !manifest.numbers ||
          Object.keys(manifest.numbers).length !== 90) {
        throw new Error('بستهٔ کامل ۹۰ شماره با صدای Sage Woman نصب نشده است.');
      }

      const audioResponse = await fetch(new URL('sage-woman.mp3?v=6', base), {
        method: 'GET', cache: 'no-store', credentials: 'same-origin'
      });
      if (!audioResponse.ok) throw new Error('فایل MP3 صدای Sage Woman دریافت نشد.');
      if (!(audioResponse.headers.get('content-type') || '').toLowerCase().includes('audio')) {
        throw new Error('نوع فایل صدای Sage Woman معتبر نیست.');
      }
      const audioData = await audioResponse.arrayBuffer();
      if (audioData.byteLength < 15000) throw new Error('فایل صوتی Sage Woman ناقص است.');
      const buffer = await persianAudioContext.decodeAudioData(audioData.slice(0));
      if (!Number.isFinite(buffer.duration) || buffer.duration < 20) {
        throw new Error('فایل صوتی باید شامل تمام ۹۰ شماره باشد.');
      }

      let previousEnd = 0;
      for (let n = 1; n <= 90; n++) {
        const clip = manifest.numbers[String(n)];
        const start = Number(clip?.start);
        const duration = Number(clip?.duration);
        if (!clip || !Number.isFinite(start) || !Number.isFinite(duration) ||
            start < 0 || duration <= 0 || start < previousEnd - 0.03 ||
            start + duration > buffer.duration + 0.1 ||
            String(clip.text || '').trim() !== numberToPersianSpeechText(n)) {
          throw new Error('اطلاعات صوتی شمارهٔ ' + n + ' معتبر نیست.');
        }
        previousEnd = start + duration;
      }
      persianAudioAsset = { manifest, buffer };
      voicePackReady = true;
      return persianAudioAsset;
    })();
    persianAudioAssetPromise = loading.catch(error => {
      persianAudioAssetPromise = null;
      throw error;
    });
  }

  await persianAudioAssetPromise;
  const clip = persianAudioAsset.manifest.numbers[String(value)];
  return { buffer: persianAudioAsset.buffer, clip };
}

async function checkPersianVoicePack() {
  if (voicePackCheckPromise) return voicePackCheckPromise;
  voicePackCheckPromise = (async () => {
    try {
      const base = new URL('./assets/voice/', document.baseURI);
      const [manifestResponse, audioHead] = await Promise.all([
        fetch(new URL('sage-woman.json?v=6', base), { cache: 'no-store', credentials: 'same-origin' }),
        fetch(new URL('sage-woman.mp3?v=6', base), { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' })
      ]);
      if (!manifestResponse.ok || !audioHead.ok) throw new Error('Sage Woman audio files are missing');
      const manifest = await manifestResponse.json();
      const contentType = String(audioHead.headers.get('content-type') || '').toLowerCase();
      const contentLength = Number(audioHead.headers.get('content-length') || 0);
      if (!manifest || manifest.provider !== 'kenerate-sage-woman' ||
          manifest.voice !== 'Sage Woman' || manifest.language !== 'fa-IR' ||
          manifest.configured !== true || !manifest.numbers ||
          Object.keys(manifest.numbers).length !== 90 ||
          !contentType.includes('audio') || (contentLength > 0 && contentLength < 15000)) {
        throw new Error('Sage Woman metadata is incomplete');
      }
      let previousEnd = 0;
      for (let n = 1; n <= 90; n++) {
        const clip = manifest.numbers[String(n)];
        const start = Number(clip?.start);
        const duration = Number(clip?.duration);
        if (!clip || String(clip.text || '').trim() !== numberToPersianSpeechText(n) ||
            !Number.isFinite(start) || !Number.isFinite(duration) ||
            start < 0 || duration <= 0 || start < previousEnd - 0.03) {
          throw new Error('Sage Woman clip ' + n + ' is invalid');
        }
        previousEnd = start + duration;
      }
      if (!Number.isFinite(Number(manifest.audioDurationSeconds)) ||
          Number(manifest.audioDurationSeconds) + 0.1 < previousEnd) {
        throw new Error('Sage Woman manifest duration does not cover all 90 clips');
      }
      voicePackReady = true;
    } catch (_) {
      voicePackReady = false;
    }
    if (currentPage === 'settings') renderSettingsIntoView();
    return voicePackReady;
  })().finally(() => { voicePackCheckPromise = null; });
  return voicePackCheckPromise;
}

async function playSageWomanNumber(number) {
  if (!persianAudioContext && !unlockPersianAudio()) throw new Error('خروجی صوتی برای پخش Sage Woman در دسترس نیست.');
  const context = persianAudioContext;
  if (context.state === 'suspended') await context.resume();
  const loaded = await loadPersianNumberAudio(number);
  return new Promise((resolve, reject) => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = loaded.buffer;
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(context.destination);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { source.stop(); } catch (_) {}
      reject(new Error('پخش فایل صوتی Sage Woman کامل نشد.'));
    }, Math.max(2500, Number(loaded.clip.duration) * 1000 + 2500));
    source.onended = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    try {
      source.start(0, Number(loaded.clip.start), Number(loaded.clip.duration));
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function playPersianNumberInternal(number) {
  if (voicePackReady) {
    return playSageWomanNumber(number).catch(error => {
      console.warn('[Dabernaz Sage Woman playback failed; using device voice]', error);
      return speakPersianNumberFallback(number);
    });
  }
  return speakPersianNumberFallback(number);
}

const PersianAudioManager = {
  playEffectTone() {
    if (!settingEnabled('sounds')) return;
    try {
      if (!persianAudioContext && !unlockPersianAudio()) return;
      const context = persianAudioContext;
      if (context.state === 'suspended') context.resume().catch(() => {});
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.05, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.12);
    } catch (_) {}
  },
  supportsPlayback() {
    return voicePackReady || nativePersianTtsAvailable() ||
      ('speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function');
  },
  activateFromGesture() {
    unlockPersianAudio();
    if ('speechSynthesis' in window) {
      try {
        const synth = window.speechSynthesis;
        synth.resume();
        refreshPersianBrowserVoices();
        if (!nativePersianTtsAvailable() && !voicePackReady &&
            typeof window.SpeechSynthesisUtterance === 'function') {
          const prime = new window.SpeechSynthesisUtterance(' ');
          prime.lang = browserSpeechVoice?.lang || 'fa-IR';
          prime.volume = 0;
          synth.cancel();
          synth.speak(prime);
        }
      } catch (error) {
        console.warn('[Dabernaz browser speech activation]', error);
      }
    }
    return this.supportsPlayback();
  },
  speak(number, options = {}) {
    const value = Math.trunc(Number(number));
    if (!Number.isInteger(value) || value < 1 || value > 90) return Promise.resolve(false);

    if (options.fromGesture) this.activateFromGesture();

    let task;
    if (options.fromGesture) {
      // Do not defer the first fallback call: Android/browser speech engines
      // must be invoked synchronously inside the trusted tap event.
      try { task = playPersianNumberInternal(value); }
      catch (error) { task = Promise.reject(error); }
    } else {
      task = persianAudioQueue.catch(() => false).then(() => playPersianNumberInternal(value));
    }

    const result = Promise.resolve(task).then(ok => {
      if (!ok) throw new Error('موتور صوتی شماره را پخش نکرد؛ امکان تلاش دوباره وجود دارد.');
      voicePlaybackErrorShown = false;
      return true;
    }).catch(error => {
      console.error('[Dabernaz Persian Audio Manager]', error);
      if (!voicePlaybackErrorShown) {
        voicePlaybackErrorShown = true;
        showToast(error?.message || 'پخش صدای فارسی انجام نشد.');
      }
      return false;
    });
    persianAudioQueue = result.catch(() => false);
    return result;
  }
};

function speakRoomNumber(number, room) {
  if (!settingEnabled('voiceNumbers')) return false;
  const value = Math.trunc(Number(number));
  if (!Number.isInteger(value) || value < 1 || value > 90) return false;
  const roundKey = String(room?.roundId || room?.startedAt || room?.registrationDeadline || 'current');
  const announcementKey = (room?.id || activeRoomId) + ':' + roundKey + ':' + value;
  if (spokenRoomAnnouncementKeys.has(announcementKey) || roomSpeechInFlight.has(announcementKey)) return false;
  const now = Date.now();
  if (now < (roomSpeechRetryAt.get(announcementKey) || 0)) return false;

  roomSpeechInFlight.add(announcementKey);
  roomSpeechRetryAt.set(announcementKey, now + 7000);
  PersianAudioManager.speak(value).then(ok => {
    roomSpeechInFlight.delete(announcementKey);
    if (ok) {
      spokenRoomAnnouncementKeys.add(announcementKey);
      roomSpeechRetryAt.delete(announcementKey);
      if (spokenRoomAnnouncementKeys.size > 300) {
        spokenRoomAnnouncementKeys.delete(spokenRoomAnnouncementKeys.values().next().value);
      }
    } else {
      // Failed announcements are deliberately not marked as spoken. Polling
      // retries the same number after a cooldown, and the room button retries now.
      roomSpeechRetryAt.set(announcementKey, Date.now() + 7000);
    }
  });
  return true;
}


async function toggleSetting(key) {
  const next = !settingEnabled(key);
  if (key === 'voiceNumbers' && next) {
    voicePlaybackErrorShown = false;
    if (!PersianAudioManager.activateFromGesture()) {
      showToast('هیچ موتور صوتی برای اعلام شماره در این دستگاه در دسترس نیست.');
      return;
    }
  }
  if (key === 'notifications' && next) {
    if (!('Notification' in window)) {
      showToast('اعلان‌های سیستمی در این مرورگر پشتیبانی نمی‌شود.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      state.settings.notifications = false;
      saveState(); renderSettingsIntoView();
      showToast('اجازه ارسال اعلان داده نشد.');
      return;
    }
  }
  state.settings[key] = next;
  saveState();
  if (key === 'sounds' && next) PersianAudioManager.playEffectTone();
  if (key === 'vibration' && next && navigator.vibrate) navigator.vibrate(25);
  renderSettingsIntoView();
  const labels = {
    sounds: 'صداهای محیط بازی', voiceNumbers: 'اعلام صوتی شماره‌ها', notifications: 'اعلان‌ها',
    vibration: 'لرزش', privacy: 'نمایش وضعیت آنلاین'
  };
  showToast((labels[key] || 'تنظیم') + ' ' + (next ? 'فعال' : 'غیرفعال') + ' شد');
}

const ROOM_CONFIGS = [
  { id:'room5000', price:5000, label:'۵,۰۰۰', code:'DB-5000', linePrizePercent:10, fullPrizePercent:75, commissionPercent:15 },
  { id:'room10000', price:10000, label:'۱۰,۰۰۰', code:'DB-10000', linePrizePercent:10, fullPrizePercent:75, commissionPercent:15 },
  { id:'room20000', price:20000, label:'۲۰,۰۰۰', code:'DB-20000', linePrizePercent:10, fullPrizePercent:75, commissionPercent:15 },
  { id:'room50000', price:50000, label:'۵۰,۰۰۰', code:'DB-50000', linePrizePercent:10, fullPrizePercent:75, commissionPercent:15 }
];
function currentRoomConfig() { const id = currentPage === 'roomGame' ? activeRoomId : currentPage; return ROOM_CONFIGS.find(room => room.id === id) || ROOM_CONFIGS[0]; }
const MAX_ROOM_CARDS_PER_PLAYER = 5;
let activeRoomId = 'room5000';
let roomCards = [];
let roomAllCards = [];
let roomCardCount = 1;
let roomCalledNumbers = [];
let roomStages = { one:false, full:false };

const $ = (selector, root = document) => root.querySelector(selector);
const roomMarkupCache = new WeakMap();
function setHtmlIfChanged(element, markup) {
  if (!element || typeof markup !== 'string' || roomMarkupCache.get(element) === markup) return;
  element.innerHTML = markup;
  roomMarkupCache.set(element, markup);
}
function setTextIfChanged(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}
const money = value => Number(value).toLocaleString('en-US');
const faDigits = value => Number(value).toLocaleString('fa-IR');
const escapeHTML = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function saveState() {
  try {
    // Only non-sensitive preferences belong in browser storage. Account identity,
    // balances, histories, tickets, wallet requests and payment data are server-owned.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: { ...state.settings } }));
  } catch (_) { showToast('فضای ذخیره‌سازی مرورگر در دسترس نیست'); }
}
const WALLET_REQUEST_KEY_STORAGE = 'dabernaz_wallet_request_idempotency_v1';
let walletRequestKeyFallback = '';
function getWalletRequestIdempotencyKey() {
  if (walletRequestKeyFallback) return walletRequestKeyFallback;
  try {
    const existing = window.sessionStorage.getItem(WALLET_REQUEST_KEY_STORAGE);
    if (/^[A-Za-z0-9._:-]{16,128}$/.test(existing || '')) return existing;
  } catch (_) {}
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = 'wallet.' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  walletRequestKeyFallback = key;
  try { window.sessionStorage.setItem(WALLET_REQUEST_KEY_STORAGE, key); } catch (_) {}
  return key;
}
function clearWalletRequestIdempotencyKey() {
  walletRequestKeyFallback = '';
  try { window.sessionStorage.removeItem(WALLET_REQUEST_KEY_STORAGE); } catch (_) {}
}
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
  // Money, authentication, room coordination and tournament routes must never
  // fall back to the legacy PHP backend. Those fallbacks do not share the D1
  // transaction/DO source of truth and could duplicate or mis-handle payments.
  const criticalApiRoute = /^\/api\/(?:rooms\/|tournaments(?:\/|$)|wallet(?:\/|$)|profile$|games\/|admin\/wallet(?:\/|$))/.test(path);
  // PHP fallback is only for non-critical HTTP routes when the Pages route is unavailable.
  if (!criticalApiRoute && path.startsWith('/api/') && (!contentType.includes('application/json') || response.status === 404)) {
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
const pendingRoomPurchaseMemory = new Map();
function getAdminAdjustmentAttempt(payload) {
  const owner = String(currentUser?.memberId || state.memberId || 'admin');
  const keyName = 'dabernaz:wallet-adjustment:' + owner;
  const payloadText = JSON.stringify(payload);
  let current = null;
  try { current = JSON.parse(sessionStorage.getItem(keyName) || 'null'); } catch (_) {}
  if (!current || current.payload !== payloadText ||
      typeof current.key !== 'string' || Date.now() - Number(current.createdAt || 0) > 86400000) {
    current = {
      key: globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : 'wallet-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2),
      payload: payloadText,
      createdAt: Date.now()
    };
    try { sessionStorage.setItem(keyName, JSON.stringify(current)); } catch (_) {}
  }
  return {
    key: current.key,
    clear() { try { sessionStorage.removeItem(keyName); } catch (_) {} }
  };
}

function getRoomPurchaseAttempt(roomId, cardsCount) {
  const owner = String(currentUser?.memberId || state.memberId || 'account');
  const storageKey = 'dabernaz:pending-room-purchase:' + owner + ':' + roomId;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); }
  catch (_) { pending = pendingRoomPurchaseMemory.get(storageKey) || null; }
  if (!pending || Number(pending.cardsCount) !== Number(cardsCount) ||
      typeof pending.key !== 'string' || Date.now() - Number(pending.createdAt || 0) > 86400000) {
    const key = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : 'room-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    pending = { key, cardsCount:Number(cardsCount), createdAt:Date.now() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(pending)); }
    catch (_) { pendingRoomPurchaseMemory.set(storageKey, pending); }
  }
  return {
    key:pending.key,
    clear() {
      try { sessionStorage.removeItem(storageKey); } catch (_) {}
      pendingRoomPurchaseMemory.delete(storageKey);
    }
  };
}

function applyAuthenticatedUser(user) {
  currentUser = user;
  state.username = user.name; state.memberId = user.memberId;
  state.referralCode = `DABERNAZ${user.memberId}`;
  state.balance = Math.max(0, Number(user.balance)||0); state.bingoCoins = Math.max(0, Number(user.bingoCoins)||0);
  state.coinTransactions = Array.isArray(user.coinTransactions) ? user.coinTransactions.slice(0,50) : [];
  state.transactions = Array.isArray(user.transactions) ? user.transactions.slice(0,50) : [];
  state.gamesPlayed = Number(user.stats?.gamesPlayed)||0; state.wins = Number(user.stats?.wins)||0; state.points = Number(user.stats?.points)||0;
  state.transactions = []; state.joined = []; state.tournamentEntries = [];
  saveState(); updateHeader(); updateHomeMiniStats();
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
    supportAdminEnabled=false;supportAdminTickets=[];supportThread=null;supportSelectedTicketId=null;supportAdminKnownTicketIds=new Set();
    walletAdminEnabled=false;walletAdminRequests=[];walletAdminSelectedRequest=null;walletActivePaymentInfo=null;state.walletRequests=[];state.walletPaymentInfo={cardNumber:'',cardHolder:'',bankName:'',paymentNote:''};
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
      state.tournamentEntries = [];
      state.walletRequests=[]; state.walletPaymentInfo={cardNumber:'',cardHolder:'',bankName:'',paymentNote:''};walletActivePaymentInfo=null;
    }
  } catch (error) {
    apiReady = false;
    apiErrorMessage = error?.message || 'سرور حساب کاربری در دسترس نیست.';
    currentUser = null;
    state = { ...cloneData(defaultState), settings:state.settings };
    showToast(apiErrorMessage);
  }
  if(!currentUser){supportAdminEnabled=false;supportAdminTickets=[];supportThread=null;supportSelectedTicketId=null;walletAdminEnabled=false;walletAdminRequests=[];walletAdminSelectedRequest=null;}
  authReady = true;

  // Completed room history is public; load it even for visitors who are not signed in.
  try {
    const history = await apiRequest('/api/rooms/history', { method:'GET', headers:{} });
    state.roomHistory = Array.isArray(history.rounds) ? history.rounds.slice(0,12) : [];
  } catch (_) { /* Keep the last successfully loaded history for a temporary outage. */ }

  try {
    const publicTournaments = await apiRequest('/api/tournaments', { method:'GET', headers:{} });
    state.tournamentRooms = Array.isArray(publicTournaments.rooms) ? publicTournaments.rooms : [];
  } catch (_) { /* Aggregate tournament counts are optional during an API outage. */ }

  if (currentUser) {
    const [referralResult, tournamentResult, ticketResult, walletRequestsResult] = await Promise.allSettled([
      apiRequest('/api/referrals', { method:'GET', headers:{} }),
      apiRequest('/api/tournaments/me', { method:'GET', headers:{} }),
      apiRequest('/api/tickets', { method:'GET', headers:{} }),
      apiRequest('/api/wallet/requests', { method:'GET', headers:{}})
    ]);
    if (referralResult.status === 'fulfilled') {
      const referral = referralResult.value;
      state.inviteCount = Number(referral.count) || 0;
      state.referralCode = referral.referralCode || state.referralCode;
      state.inviteRewardMilestones = Array.from({length:Math.floor(state.inviteCount/5)},(_,i)=>i+1);
    }
    if (tournamentResult.status === 'fulfilled') {
      const data = tournamentResult.value;
      state.tournamentEntries = Array.isArray(data.entries) ? data.entries : [];
      if (Number.isFinite(Number(data.bingo_coins))) state.bingoCoins = Math.max(0, Number(data.bingo_coins) || 0);
      state.joined = state.tournamentEntries.filter(entry => entry.status !== 'refunded').map(entry => entry.tournament_type === 'bingo' ? 'bingoTournamentEntry' : 'simpleTournamentEntry');
      state.tournamentRooms = Array.isArray(data.rooms) ? data.rooms : [];
    }
    if (ticketResult.status === 'fulfilled') state.supportTickets = Array.isArray(ticketResult.value.tickets) ? ticketResult.value.tickets : [];
    state.walletPaymentInfo = {cardNumber:'',cardHolder:'',bankName:'',paymentNote:''};
    if (walletRequestsResult.status === 'fulfilled') state.walletRequests = Array.isArray(walletRequestsResult.value.requests) ? walletRequestsResult.value.requests : [];
    try { const adminResult=await apiRequest('/api/admin/support',{method:'GET',headers:{}}); supportAdminEnabled=adminResult.isAdmin===true; supportAdminTickets=Array.isArray(adminResult.tickets)?adminResult.tickets:[]; supportAdminKnownTicketIds=new Set(supportAdminTickets.map(t=>Number(t.id))); }
    catch (_) { supportAdminEnabled=false; supportAdminTickets=[]; }
    try {
      const walletAdminResult=await apiRequest('/api/admin/wallet',{method:'GET',headers:{}});
      walletAdminEnabled=walletAdminResult.isAdmin===true;
      walletAdminRequests=Array.isArray(walletAdminResult.requests)?walletAdminResult.requests:[];
      const walletSettings=await apiRequest('/api/admin/wallet/settings',{method:'GET',headers:{}});
      if(walletSettings.settings)state.walletPaymentInfo=walletSettings.settings;
    } catch (_) { walletAdminEnabled=false;walletAdminRequests=[];walletAdminSelectedRequest=null; }
  } else { supportAdminEnabled=false; supportAdminTickets=[]; }
  if(currentPage==='supportAdmin'&&!supportAdminEnabled) currentPage='support';
  if(currentPage==='walletAdmin'&&!walletAdminEnabled) currentPage='wallet';
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
const APP_PAGES = ['home','games','room5000','room10000','room20000','room50000','roomGame','tournaments','tournamentRoom','bingoTournament','invite','wallet','walletAdmin','account','settings','support','supportAdmin'];
function pageFromLocation() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const page = hash.get('page');
  const room = hash.get('room');
  if (page === 'roomGame' && ROOM_CONFIGS.some(item => item.id === room)) activeRoomId = room;
  return APP_PAGES.includes(page) ? page : 'home';
}
function syncPageLocation(page, replace = false) {
  const hash = new URLSearchParams();
  hash.set('page', page);
  if (page === 'roomGame') hash.set('room', activeRoomId);
  const next = '#' + hash.toString();
  if (location.hash !== next) {
    if (replace) history.replaceState(null, '', next);
    else history.pushState(null, '', next);
  }
}
function setPage(page, options = {}) {
  const { sync = true, scroll = true } = options;
  if (!APP_PAGES.includes(page)) page = 'home';
  if (ROOM_CONFIGS.some(room => room.id === page)) {
    if(roomServerSnapshot && roomServerSnapshot.id!==page){roomServerSnapshot=null;roomCards=[];roomAllCards=[];roomCardCount=1;roomCalledNumbers=[];roomStages={one:false,full:false};}
    activeRoomId = page;
  }
  currentPage = page;
  if (sync) syncPageLocation(page);
  render();
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  configureTournamentPolling();
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
  
  ${section('بازی‌های محبوب', 'همه بازی‌ها', 'games')}
  <div class="game-grid">${roomGameCard()}${gameCard('rps','✊✋✌️','سنگ، کاغذ، قیچی','مسابقه خودکار تا رسیدن یکی از طرفین به ۳ برد','بازی مهارتی · بدون شرط‌بندی','game-cover-rps')}${gameCard('tic','⭕❌','دوز حرفه‌ای','صفحه ۳×۳ با حریف هوشمند و تصمیم‌های تاکتیکی','بازی مهارتی · بدون شرط‌بندی','game-cover-tic')}</div>
  ${section('وضعیت حساب', 'حساب کاربری', 'account')}
  <div class="mini-stats"><div class="stat-card"><b id="homeGamesPlayed">${money(state.gamesPlayed)}</b><small>بازی انجام‌شده</small></div><div class="stat-card"><b id="homeWins">${money(state.wins)}</b><small>بردها</small></div><div class="stat-card"><b id="homePoints">${money(state.points)}</b><small>امتیاز کل</small></div></div>
  <div class="ticker"><span>⭐ وضعیت حساب</span><strong>${currentUser ? 'حساب ثبت‌شده' : 'مهمان'}</strong><span>● آماده بازی</span></div>`;
}
function gameCard(id, symbol, name, desc, price, coverClass = '') {
  return `<article class="game-card"><div class="game-cover ${coverClass}">${symbol}</div><h3>${name}</h3><p>${desc}</p><button class="btn btn-primary" data-game="${id}">ورود به بازی</button><div class="price">${price}</div></article>`;
}
function roomGameCard() {
  return `<article class="game-card"><div class="game-cover room-game-cover"><img class="game-cover-image" src="./assets/daberna-icon.jpg" alt="تصویر بازی دبرنا" loading="lazy"></div><h3>دبرنای ۹۰ توپی</h3><p>۴ سطح قیمت · حداقل ۲ شرکت‌کننده برای شروع</p><button class="btn btn-primary" data-page="games">انتخاب اتاق</button><div class="price">شروع خودکار مسابقه</div></article>`;
}
function renderGames() {
  const tiers = ['red','silver','gold','purple'];
  const cardIcons = ['♛','♜','♕','👑'];
  return `<section class="games-page">
    <header class="games-lobby-heading">
      <div class="games-lobby-title"><span class="games-lobby-icon">🎮</span><div><h1>اتاق بازی</h1><p>وارد صف شو، بازی خودکار شروع می‌شود.</p></div></div>
      <div class="games-online-badge"><span class="online-people-icon">♟</span><div><small>اتاق‌های چندنفره</small><b>مهلت خرید ۲:۳۰</b></div><i aria-label="صف واقعی"></i></div>
    </header>

    <section class="games-lobby-hero">
      <div class="games-lobby-callout"><small>اتاق با ظرفیت نامحدود</small><h2>شروع خودکار!</h2><p>از اولین خرید کارت، ۲ دقیقه و ۳۰ ثانیه برای خرید و ورود بازیکنان فرصت هست؛ بازی پس از پایان مهلت و با حداقل ۲ شرکت‌کننده آغاز می‌شود.</p><button class="games-rules-button" data-action="room-show-rules">قوانین بازی <span>ⓘ</span></button></div>
      <div class="games-lobby-art"><img src="./assets/room-lobby-art.png" alt="کارت‌های دبرنا و گوی‌های شماره‌دار" loading="eager"></div>
      <div class="games-lobby-features">
        <div><span>▤</span><p>ظرفیت اتاق<strong>نامحدود</strong></p></div>
        <div><span>◷</span><p>مهلت خرید<strong>۲ دقیقه و ۳۰ ثانیه</strong></p></div>
        <div><span>♟</span><p>حداقل شروع<strong>۲ شرکت‌کننده</strong></p></div>
        <div><span>🎲</span><p>مهره‌ها<strong>شماره‌های ۱ تا ۹۰</strong></p></div>
        <div><span>♛</span><p>شرط برنده شدن<strong>یک خط و دبرنای کامل</strong></p></div>
      </div>
    </section>

    <section class="games-purchase-section">
      <div class="games-section-heading"><div><span class="games-section-symbol">▧</span><h2>انتخاب اتاق</h2></div><p>اتاق را انتخاب کن؛ قیمت کارت و مبلغ جایزه‌ها در صفحه همان اتاق نمایش داده می‌شود.</p></div>
      <div class="games-price-grid">${ROOM_CONFIGS.map((room, index) => `<article class="games-price-card tier-${tiers[index]}">
        <div class="games-price-card-art" aria-hidden="true"><span class="mini-bingo-card card-a">BINGO</span><span class="mini-bingo-card card-b">BINGO</span><span class="mini-bingo-card card-c">BINGO</span><span class="mini-bingo-crown">${cardIcons[index]}</span></div>
        <b class="games-price-name">اتاق سطح ${index+1}</b>
        <button class="games-price-button" data-page="${room.id}">ورود به اتاق</button>
        <small class="games-price-caption">بدون سقف اتاق · حداکثر ۵ کارت برای هر حساب</small>
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
function roomCardMarkup(card, index, details = null) {
  const meta = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
  const cardNumber = Math.max(1, Number(meta.cardNumber) || index + 1);
  const ownerLabel = meta.playerName ? `بازیکن: ${escapeHTML(meta.playerName)} · ` : '';
  const rowsDone = card.map(row => row.filter(n => n !== null && roomCalledNumbers.includes(n)).length === 5);
  const doneRows = rowsDone.filter(Boolean).length;
  const full = doneRows === 3;
  const line = doneRows > 0;
  return `<article class="room-ticket">
    <div class="room-ticket-head"><div><b>کارت شماره ${faDigits(cardNumber)}</b><small>${ownerLabel}شناسه کارت · DB-${String(index + 1).padStart(3,'0')}</small></div><span class="room-ticket-state ${line ? 'is-progress' : ''}">${full ? 'دبرنای کامل' : line ? 'یک خط تکمیل' : 'در حال بازی'}</span></div>
    <div class="daberna-grid" role="group" aria-label="کارت دبرنا شماره ${faDigits(cardNumber)}">${card.map(row => row.map(number => number === null
      ? `<span class="daberna-cell empty-cell" aria-hidden="true"></span>`
      : `<span class="daberna-cell ${roomCalledNumbers.includes(number) ? 'called-cell' : ''}" data-number="${number}" aria-label="${number}${roomCalledNumbers.includes(number) ? ' اعلام شده' : ''}">${number}</span>`).join('')).join('')}</div>
    <div class="room-ticket-foot"><span>۱۵ عدد در ۳ ردیف</span><span>${full ? 'هر ۱۵ عدد اعلام شده' : line ? 'یک ردیف کامل شده' : 'منتظر اعلام شماره'}</span></div>
  </article>`;
}
function roomAllCardsMarkup() {
  const entries = Array.isArray(roomAllCards) ? roomAllCards.filter(item => item && Array.isArray(item.card)) : [];
  if (!entries.length) return '<div class="empty"><span>🎟️</span>کارت‌های بازیکنان این اتاق هنوز دریافت نشده‌اند.</div>';
  return entries.map((item, index) => roomCardMarkup(item.card, index, item)).join('');
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
function formatRoomCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(Math.max(0, Number(milliseconds) || 0) / 1000));
  return `${faDigits(Math.floor(totalSeconds / 60))}:${faDigits(totalSeconds % 60).padStart(2, '0')}`;
}
function renderRoomPurchasePage() {
  const room = currentRoomConfig();
  const queue = getRoomQueueState();
  const playerCount = Number(queue.playerCount ?? queue.queueCount ?? 0);
  const cardsSold = Number(queue.cardCount || 0);
  const joined = !!queue.joined;
  if (Array.isArray(queue.myCards) && queue.myCards.length) { roomCards = queue.myCards; roomCardCount = roomCards.length; }
  roomCardCount = Math.max(1, Math.min(MAX_ROOM_CARDS_PER_PLAYER, Number(roomCardCount) || 1));
  const selectedCount = joined ? roomCards.length : roomCardCount;
  const waiting = queue.status === 'waiting';
  const ownedCardCount = joined ? roomCards.length : 0;
  const registrationStarted = !!queue.registrationDeadline;
  const remainingMs = queue.registrationRemainingMs == null ? null : Math.max(0, Number(queue.registrationRemainingMs) || 0);
  const timerExpired = registrationStarted && remainingMs <= 0;
  const timerText = queue.status === 'playing' ? 'بازی آغاز شده'
    : queue.status === 'finished' ? 'سانس پایان یافته'
    : registrationStarted ? formatRoomCountdown(remainingMs) : '۲:۳۰ پس از اولین خرید';
  const collected = Math.max(0, Number(queue.grossRevenue) || 0);
  const lineEstimate = Math.max(0, Number(queue.estimatedPrizes?.line ?? Math.floor(collected * 0.10)) || 0);
  const fullEstimate = Math.max(0, Number(queue.estimatedPrizes?.full ?? Math.floor(collected * 0.75)) || 0);
  const minPlayersToStart = Math.max(2, Number(queue.minPlayersToStart) || 2);
  const nextRound = queue.status === 'playing' ? queue.nextRound : null;
  const nextRoundJoined = Boolean(nextRound?.joined);
  const nextRoundCardCount = Array.isArray(nextRound?.myCards) ? nextRound.myCards.length : 0;
  const purchaseControls = joined && waiting
    ? `<small>کارت‌های خریداری‌شده</small><div class="purchase-qty-controls"><b id="roomQty">${faDigits(ownedCardCount)} از ۵ کارت</b></div>`
    : queue.status === 'playing' && nextRoundJoined
      ? `<small>کارت‌های ثبت‌شده برای سانس بعدی</small><div class="purchase-qty-controls"><b id="roomQty">${faDigits(nextRoundCardCount)} از ۵ کارت</b></div>`
      : `<small>تعداد کارت برای این سانس</small><div class="purchase-qty-controls"><button data-action="room-decrease" aria-label="کاهش تعداد کارت" ${selectedCount <= 1 ? 'disabled' : ''}>−</button><b id="roomQty">${faDigits(selectedCount)}</b><button data-action="room-increase" aria-label="افزایش تعداد کارت" ${selectedCount >= MAX_ROOM_CARDS_PER_PLAYER ? 'disabled' : ''}>+</button></div>`;
  const purchaseTotal = queue.status === 'playing' && nextRoundJoined
    ? `<div class="purchase-total"><span>هزینه هر کارت اضافی برای سانس بعدی</span><b>${faDigits(room.price)} تومان</b></div>`
    : queue.status === 'finished'
      ? `<div class="purchase-total"><span>هزینه کارت سانس بعدی</span><b>${faDigits(room.price * selectedCount)} تومان</b></div>`
      : joined && waiting
        ? `<div class="purchase-total"><span>هزینه ۱ کارت اضافی</span><b>${faDigits(room.price)} تومان</b></div>`
        : `<div class="purchase-total"><span>هزینه کل ${faDigits(selectedCount)} کارت</span><b>${faDigits(room.price * selectedCount)} تومان</b></div>`;
  const purchaseAction = !currentUser
    ? `<button class="btn btn-primary btn-block" data-page="account">ورود / ثبت‌نام برای بازی</button>`
    : queue.status === 'playing' && joined
      ? `<button class="btn btn-primary btn-block" data-action="room-open-game">ورود به بازی زنده</button>`
      : queue.status === 'playing' && nextRoundJoined
        ? `<button class="btn btn-primary btn-block" data-action="room-add-card" ${nextRoundCardCount >= MAX_ROOM_CARDS_PER_PLAYER ? 'disabled' : ''}>${nextRoundCardCount >= MAX_ROOM_CARDS_PER_PLAYER ? 'سقف ۵ کارت سانس بعدی تکمیل شده' : 'افزودن یک کارت به سانس بعدی'}</button>`
        : queue.status === 'playing'
          ? `<button class="btn btn-primary btn-block" data-action="room-join-next">خرید کارت و ثبت‌نام سانس بعدی</button>`
          : queue.status === 'finished'
            ? `<button class="btn btn-primary btn-block" data-action="room-next-session">ورود رایگان به سانس بعدی</button>`
            : joined && waiting
              ? `<button class="btn btn-primary btn-block" data-action="room-add-card" ${ownedCardCount >= MAX_ROOM_CARDS_PER_PLAYER || timerExpired ? 'disabled' : ''}>${ownedCardCount >= MAX_ROOM_CARDS_PER_PLAYER ? 'سقف ۵ کارت تکمیل شده' : timerExpired ? 'مهلت خرید پایان یافته' : 'افزودن و خرید یک کارت'}</button>`
              : `<button class="btn btn-primary btn-block purchase-join" data-action="room-join-auto">خرید کارت و ورود به اتاق</button>`;
  const waitingMessage = queue.status === 'playing' ? (nextRound
    ? 'بازی فعلی در حال اجراست؛ ثبت‌نام سانس بعدی در جریان است و پس از پایان بازی فعلی آغاز می‌شود.'
    : 'بازی فعلی در حال اجراست؛ می‌توانی برای سانس بعدی ثبت‌نام کنی.')
    : queue.status === 'finished' ? 'سانس قبلی پایان یافته است؛ ورود به صفحه سانس بعدی رایگان است و هیچ مبلغی تا تأیید جداگانه خرید کارت کسر نمی‌شود.'
    : registrationStarted && playerCount < minPlayersToStart && timerExpired ? `مهلت اولیه تمام شده؛ بازی پس از رسیدن تعداد شرکت‌کنندگان به حداقل ${faDigits(minPlayersToStart)} نفر شروع می‌شود.`
    : registrationStarted ? (timerExpired ? 'مهلت خرید به پایان رسیده و حداقل شرکت‌کنندگان کامل شده؛ بازی در حال شروع است.' : `تا پایان مهلت خرید و شروع خودکار بازی با حداقل ${faDigits(minPlayersToStart)} شرکت‌کننده:`)
    : 'با اولین خرید کارت، زمان‌سنج ۲ دقیقه و ۳۰ ثانیه‌ای شروع می‌شود.';
  return `${heading(`اتاق دبرنا · سطح ${ROOM_CONFIGS.findIndex(x => x.id === room.id) + 1}`, 'بدون محدودیت تعداد بازیکن و کارت در کل اتاق؛ هر حساب حداکثر ۵ کارت و شروع بازی با حداقل ۲ شرکت‌کننده.', 'DABERNAZ · LIVE ROOM')}
  <div id="roomWinnerBannerMount" aria-live="polite" aria-atomic="true">${roomWinnerBanner()}</div>
  <section class="room-info-strip room-prize-strip">
    <div><b>🎟️ کارت ${faDigits(room.price)} تومان</b><small>قیمت هر کارت</small></div>
    <div><b>🏅 ${faDigits(lineEstimate)} تومان</b><small>مبلغ جایزه یک خط</small></div>
    <div><b>👑 ${faDigits(fullEstimate)} تومان</b><small>مبلغ جایزه دبرنای کامل</small></div>
  </section>
  <section class="purchase-wait-hero"><div class="purchase-art"><img src="./assets/room-lobby-art.png" alt="کارت‌های دبرنا و گوی‌های شماره‌دار" loading="eager"></div>
    <div class="purchase-box"><div class="purchase-box-top"><span class="live-dot"></span> سالن آنلاین <b>${room.code}</b></div>
      ${purchaseControls}${purchaseTotal}${purchaseAction}
      <small class="purchase-disclaimer">پس از اولین خرید، مهلت ۲:۳۰ دقیقه‌ای شروع می‌شود. هر حساب در هر سانس حداکثر ۵ کارت می‌تواند بخرد؛ خرید ثبت‌شده قابل لغو یا بازپرداخت نیست.</small>
    </div></section>
  <section class="room-wait-panel" id="roomWaitPanel">
    <div class="wait-panel-heading"><div><span class="eyebrow">ONLINE WAITING ROOM</span><h2>${queue.status === 'playing' ? 'بازی شروع شده' : queue.status === 'finished' ? 'سانس پایان یافته' : joined ? 'کارت‌ها ثبت شده‌اند' : 'منتظر اولین خرید'}</h2><p>${waitingMessage}</p></div><div class="wait-hourglass">${queue.status === 'playing' ? '🎱' : '⌛'}</div></div>
    <div class="wait-stats">
      <div><b id="queuePlayers">${faDigits(playerCount)}</b><small>بازیکنان ثبت‌نام‌کرده</small></div>
      <div><b id="queueCardCount">${faDigits(cardsSold)}</b><small>کل کارت‌های فروخته‌شده</small></div>
      <div><b id="roomRegistrationTimer">${timerText}</b><small>${registrationStarted ? 'زمان باقی‌مانده' : 'زمان شروع خرید'}</small></div>
    </div>
    <div class="purchase-total"><span>💰 کل مبلغ جمع‌شده</span><b id="roomGrossRevenue">${faDigits(collected)} تومان</b></div>
    <div class="wait-stats room-estimated-prizes">
      <div><b>${faDigits(lineEstimate)} تومان</b><small>مبلغ جایزه یک خط</small></div>
      <div><b>${faDigits(fullEstimate)} تومان</b><small>مبلغ جایزه دبرنای کامل</small></div>
    </div>
    <div class="queue-wait-hint">${joined ? 'کارت‌های تو ثبت شده‌اند و تا پایان مهلت خرید در صف باقی می‌مانند.' : 'با خرید اولین کارت، زمان‌سنج همه بازیکنان شروع می‌شود؛ مهلت با خریدهای بعدی تمدید نمی‌شود.'}</div>
    <p class="muted-note room-session-note">ظرفیت کلی اتاق و تعداد بازیکنان محدود نیست. بازی پس از پایان مهلت خرید و با حداقل ۲ شرکت‌کننده شروع می‌شود. هر حساب فقط می‌تواند در هر سانس حداکثر ۵ کارت داشته باشد. اگر چند نفر در یک شماره برنده شوند، مبلغ جایزه همان مرحله به‌طور مساوی بین آن‌ها تقسیم می‌شود.</p>
  </section>
  <section class="room-info-strip"><div><b>🏅 یک خط</b><small>اولین تکمیل ردیف</small></div><div><b>👑 دبرنای کامل</b><small>تکمیل هر ۱۵ عدد کارت</small></div><div><b>🎱 ۹۰ مهره</b><small>اعلام خودکار بدون تکرار</small></div></section>
  <section class="room-panel ticket-selection"><div class="room-panel-heading"><div><span class="eyebrow">YOUR TICKETS</span><h3>کارت‌های تو</h3><p>کارت‌ها هنگام خرید روی سرور ساخته و نگهداری می‌شوند.</p></div><span class="ticket-count-badge" id="roomTicketCount">${faDigits(selectedCount)} کارت</span></div><div class="room-tickets-list" id="roomTicketsList">${joined && roomCards.length ? roomCards.map(roomCardMarkup).join('') : '<div class="empty"><span>🎟️</span>کارت نهایی پس از خرید و ثبت در صف، به‌صورت تصادفی روی سرور ساخته می‌شود.</div>'}</div></section>`;
}

function renderNextRoundPanel() {
  const next = roomServerSnapshot?.nextRound || null;
  const joined = Boolean(next?.joined);
  const count = Array.isArray(next?.myCards) ? next.myCards.length : 0;
  const remaining = next?.registrationRemainingMs == null ? null : formatRoomCountdown(next.registrationRemainingMs);
  return `<section class="room-panel room-next-round-panel">
    <div class="room-panel-heading"><div><span class="eyebrow">NEXT SESSION QUEUE</span><h3>ثبت‌نام سانس بعدی</h3>
      <p>${joined ? 'ثبت‌نام تو برای سانس بعدی ذخیره شده و مستقل از بازی جاری است.' : 'در حالی که این بازی ادامه دارد، می‌توانی برای سانس بعدی کارت بخری.'}</p></div>
      <span class="ticket-count-badge">${joined ? faDigits(count) + ' از ۵ کارت' : 'هنوز ثبت‌نام نکرده‌ای'}</span></div>
    ${next ? `<div class="wait-stats"><div><b>${faDigits(next.playerCount || 0)}</b><small>بازیکنان سانس بعدی</small></div>
      <div><b>${faDigits(next.cardCount || 0)}</b><small>کارت‌های سانس بعدی</small></div>
      <div><b>${remaining || '۰:۰۰'}</b><small>زمان ثبت‌نام</small></div></div>` : '<p class="muted-note">با اولین خرید، دور بعدی و مهلت مستقل ۱۵۰ ثانیه‌ای آن ایجاد می‌شود.</p>'}
    <button class="btn btn-primary btn-block" data-action="${joined ? 'room-add-card' : 'room-join-next'}" ${joined && count >= MAX_ROOM_CARDS_PER_PLAYER ? 'disabled' : ''}>
      ${joined ? (count >= MAX_ROOM_CARDS_PER_PLAYER ? 'سقف ۵ کارت سانس بعدی تکمیل شده' : 'خرید یک کارت دیگر برای سانس بعدی') : 'خرید کارت و ثبت‌نام سانس بعدی'}
    </button>
  </section>`;
}

function renderRoomGame() {
  const room=currentRoomConfig();
  const isFinished=roomServerSnapshot?.status==='finished';
  return `${heading(`بازی زنده دبرنا · سطح ${ROOM_CONFIGS.findIndex(x=>x.id===room.id)+1}`, 'شماره‌ها به‌صورت خودکار اعلام و نتیجه روی سرور ثبت می‌شود.', 'LIVE DABERNA ROOM')}
    <div id="roomWinnerBannerMount" aria-live="polite" aria-atomic="true">${roomWinnerBanner()}</div>
    <div class="room-game-live-banner"><span class="live-dot"></span><b>${isFinished?'سانس پایان یافته':'بازی در حال اجرا'}</b><span>${room.code}</span><strong>${isFinished?'نتیجه نهایی':'قرعه‌کشی خودکار'}</strong></div>
    <section class="room-panel live-preview-panel"><div class="room-panel-heading"><div><span class="eyebrow">LIVE DRAW</span><h3>تابلوی اعلام شماره‌ها</h3><p>هر شماره فقط یک بار و به ترتیب تصادفی اعلام می‌شود.</p></div><span class="tag">${isFinished?'پایان':'زنده'}</span></div>
      <div class="room-current-number"><div><small>آخرین شماره اعلام‌شده</small><b id="roomLatestNumber" aria-live="polite" aria-atomic="true">${roomServerSnapshot?.latestNumber??'—'}</b></div><div class="room-draw-count"><strong id="roomDrawCount">${faDigits(roomServerSnapshot?.drawCount||0)} / ۹۰</strong><small>شماره اعلام‌شده</small></div></div>
      <button class="btn btn-outline btn-block" type="button" data-action="enable-room-audio">فعال‌سازی صدای فارسی شماره‌ها</button>
      <div class="room-number-history" id="roomNumberHistory">${roomCalledMarkup()}</div>
      <small class="room-safe-caption">${isFinished?'این سانس به پایان رسیده است.':'قرعه‌کشی توسط سرور انجام می‌شود؛ نیازی به فشردن دکمه نیست.'}</small>
    </section>
    ${renderNextRoundPanel()}\n    <section class="room-game-layout"><div class="room-game-ticket"><div class="room-panel-heading"><div><span class="eyebrow">MY TICKETS</span><h3>کارت‌های من</h3></div><span class="ticket-count-badge">${faDigits(roomCards.length)} کارت</span></div><div id="roomTicketsList" class="room-tickets-list">${roomCards.map(roomCardMarkup).join('')}</div></div>
      <aside class="room-panel stages-panel"><div class="room-panel-heading"><div><span class="eyebrow">WINNING PATTERNS</span><h3>برندگان سانس</h3></div><span class="trophy-mark">🏆</span></div><div class="room-stages-list" id="roomStagesList">${roomStageMarkup()}</div><div class="room-rules-tip"><b>برد هم‌زمان پشتیبانی می‌شود</b><p>یک یا چند نفر می‌توانند در یک شماره هم‌زمان برنده یک خط یا دبرنای کامل شوند؛ جایزه همان مرحله بین برندگان تقسیم می‌شود.</p></div></aside>
    </section>
    <section class="room-panel"><div class="room-panel-heading"><div><span class="eyebrow">SESSION HISTORY</span><h3>برندگان سانس‌های اخیر</h3></div><span class="trophy-mark">🏆</span></div><div id="recentSessionWinners">${recentSessionWinnersMarkup()}</div></section>
    <section class="room-panel room-all-tickets-panel"><div class="room-panel-heading"><div><span class="eyebrow">ALL ROOM TICKETS</span><h3>تمام کارت‌های خریداری‌شده در این اتاق</h3><p>کارت‌های همهٔ بازیکنان همین سانس؛ شماره‌های اعلام‌شده روی تمام کارت‌ها مشخص می‌شوند.</p></div><span class="ticket-count-badge" id="roomAllTicketCount">${faDigits(roomAllCards.length)} کارت</span></div><div id="roomAllTicketsList" class="room-tickets-list room-all-tickets-list">${roomAllCardsMarkup()}</div></section>
    ${isFinished?'<button class="btn btn-primary btn-block" data-action="room-back-lobby">بازگشت به اتاق‌ها</button>':''}`;
}
async function pollCurrentRoom() {
  if (!currentUser || roomPollBusy) return;
  const roomId = currentPage==='roomGame' ? activeRoomId : currentPage;
  if (!ROOM_CONFIGS.some(room=>room.id===roomId)) return;
  roomPollBusy=true;
  try {
    const result=await apiRequest(`/api/rooms/${roomId}`,{method:'GET',headers:{}});
    const wasJoined = !!roomServerSnapshot?.joined;
    roomServerSnapshot=result.room;
    if(result.room.joined && Array.isArray(result.room.myCards)) roomCards=result.room.myCards;
    else if(wasJoined && result.room.status==='waiting') {
      roomCards=[];
      roomCardCount=1;
      showToast('حداقل ۲ بازیکن در مهلت ثبت‌نام کامل نشد؛ سانس لغو و مبلغ خرید کارت به کیف پولت بازگشت.');
    }
    roomAllCards = Array.isArray(result.room.allPlayerCards) ? result.room.allPlayerCards : [];
    roomCalledNumbers=Array.isArray(result.room.allCalledNumbers)?result.room.allCalledNumbers:(result.room.calledNumbers||[]);
    roomStages={one:roomHasWinner(result.room.winners?.line),full:roomHasWinner(result.room.winners?.full)};
    if (Number.isFinite(Number(result.room.myBingoCoins))) { state.bingoCoins=Math.max(0,Number(result.room.myBingoCoins)); state.coinTransactions=Array.isArray(result.room.myCoinTransactions)?result.room.myCoinTransactions.slice(0,50):state.coinTransactions; saveState(); updateHeader(); }
    if (result.room.status==='playing' && currentPage==='roomGame') speakRoomNumber(result.room.latestNumber, result.room);
    if (result.room.status==='finished') {
      roomCards=[];
      roomCardCount=1;
      if (currentUser) {
      try {
        const me=await apiRequest('/api/auth/me',{method:'GET',headers:{}});
        if(me.user) applyAuthenticatedUser(me.user);
      } catch (_) {}
      }
    }
    if (result.room.status==='playing' && result.room.joined && currentPage===roomId) { activeRoomId=roomId; currentPage='roomGame'; render(); }
    else if (currentPage==='roomGame' && result.room.status==='finished') render();
    else if (currentPage===roomId) render();
    if (currentPage==='roomGame') {
      const mount=$('#roomWinnerBannerMount'); setHtmlIfChanged(mount, roomWinnerBanner());
      updateRoomDrawDisplay();
      const recent=$('#recentSessionWinners'); setHtmlIfChanged(recent, recentSessionWinnersMarkup());
    }
  } catch(error) { if (error.message.includes('وارد حساب')) { currentUser=null; setPage('account'); } else showToast(error.message); }
  finally { roomPollBusy=false; }
}
function updateRoomCardDisplay() {
  const list=$('#roomTicketsList');
  setHtmlIfChanged(list, roomServerSnapshot?.joined && roomCards.length ? roomCards.map(roomCardMarkup).join('') : '<div class="empty"><span>🎟️</span>کارت نهایی پس از ورود به صف، به‌صورت تصادفی و روی سرور ساخته می‌شود.</div>');
  setTextIfChanged($('#roomQty'), faDigits(roomCardCount));
  setTextIfChanged($('#roomTicketCount'), `${faDigits(roomServerSnapshot?.joined ? roomCards.length : roomCardCount)} کارت`);
  detectRoomStages();
}
function detectRoomStages() {
  const winners=roomServerSnapshot?.winners||{};
  roomStages={one:roomHasWinner(winners.line),full:roomHasWinner(winners.full)};
  const stages=$('#roomStagesList'); setHtmlIfChanged(stages, roomStageMarkup());
}
function updateRoomAllCardDisplay() {
  const list = $('#roomAllTicketsList');
  setHtmlIfChanged(list, roomAllCardsMarkup());
  setTextIfChanged($('#roomAllTicketCount'), `${faDigits(Array.isArray(roomAllCards) ? roomAllCards.length : 0)} کارت`);
}
function updateRoomDrawDisplay() {
  const room=roomServerSnapshot||{}; const last=room.latestNumber;
  setTextIfChanged($('#roomLatestNumber'), last ? faDigits(last) : '—');
  setTextIfChanged($('#roomDrawCount'), `${faDigits(room.drawCount||0)} / ۹۰`);
  setHtmlIfChanged($('#roomNumberHistory'), roomCalledMarkup());
  updateRoomCardDisplay();
  updateRoomAllCardDisplay();
}
function showRoomQuickRules() {
  openModal('راهنمای سریع دبرنا', `<div class="room-quick-rules"><p><b>۱. مهلت خرید:</b> از اولین خرید کارت، ۲ دقیقه و ۳۰ ثانیه برای ورود بازیکنان فرصت است. بازی پس از پایان مهلت و با حداقل ۲ شرکت‌کننده آغاز می‌شود.</p><p><b>۲. حداقل شروع:</b> اگر تا پایان مهلت حداقل ۲ شرکت‌کننده ثبت‌نام نکرده باشند، سانس لغو و وجه خرید کارت به کیف پول بازگردانده می‌شود.</p><p><b>۳. سقف خرید:</b> هر حساب در هر سانس حداکثر ۵ کارت می‌تواند بخرد؛ تعداد کل بازیکنان و کارت‌های اتاق محدود نیست.</p><p><b>۴. مبلغ جایزه:</b> مبلغ جایزه یک خط و دبرنای کامل در همان صفحه اتاق و بر اساس وضعیت سانس نمایش داده می‌شود.</p><p><b>۵. کارت و اعلام شماره:</b> هر کارت ۳ ردیف و ۹ ستون دارد؛ مهره‌ها از ۱ تا ۹۰ و بدون تکرار اعلام می‌شوند.</p><p class="muted-note">در صورت برنده شدن هم‌زمان چند نفر در یک مرحله، مبلغ جایزه همان مرحله به‌طور مساوی بین برندگان تقسیم می‌شود.</p></div>`);
}


const tournaments = [
  { id:'t1', name:'تورنمنت آزاد دابرناز', kind:'عمومی', prize:'۵,۰۰۰', players:'۱۲۸', time:'امروز · ۲۰:۳۰', icon:'🏆' },
  { id:'t2', name:'جام طلایی VIP', kind:'ویژه', prize:'۱۲,۰۰۰', players:'۶۴', time:'فردا · ۱۹:۰۰', icon:'👑' },
  { id:'t3', name:'چالش قهرمانان', kind:'مهارتی', prize:'۲,۵۰۰', players:'۳۲', time:'شنبه · ۱۸:۰۰', icon:'🥇' }
];
function getTournamentRoom(type) {
  return (state.tournamentRooms || []).find(item => item.tournament_type === type) || {};
}
function hasTournamentEntry(type) {
  const room = getTournamentRoom(type);
  if (!room.id) return false;
  return (state.tournamentEntries || []).some(entry => entry.tournament_type === type && entry.event_id === room.id && entry.status !== 'refunded');
}
function tournamentStatus(room) {
  if (!room?.id) return 'در حال دریافت وضعیت مسابقه';
  if (room.status === 'scheduled') return 'ثبت‌نام هنوز باز نشده';
  if (room.status === 'cancelled') return 'این دوره لغو شد';
  if (room.status === 'running') return room.stage_label || 'در حال برگزاری';
  if (room.status === 'completed') return 'پایان‌یافته';
  if (room.registration_full) return 'ظرفیت ۳۰ نفره تکمیل شده';
  return 'ثبت‌نام باز است';
}
function tournamentEntryState(type) {
  const room = getTournamentRoom(type);
  const entry = (state.tournamentEntries || []).find(item =>
    item.event_id === room.id && item.tournament_type === type && item.status !== 'refunded'
  );
  if (!entry) return '';
  if (entry.status === 'winner_1') return 'رتبه اول · برنده جام';
  if (entry.status === 'winner_2') return 'رتبه دوم جام';
  if (entry.status === 'winner_3') return 'رتبه سوم جام';
  if (entry.status === 'eliminated') return 'پایان مرحله · صعود نکردی';
  if (entry.status === 'qualified') return 'صعود کردی · مرحله بعد';
  if (room.status === 'completed') return 'مسابقه به پایان رسیده';
  if (room.status === 'running') return 'در حال رقابت';
  return 'ثبت‌نام تو تکمیل شده';
}
function tournamentLivePanel(room, type) {
  if (!room) return '';
  const stage = room.stage_label || tournamentStatus(room);
  const current = room.current_round;
  const called = Array.isArray(current?.called_numbers) ? current.called_numbers : [];
  const latest = Number(current?.latest_number) || 0;
  if (current && latest) {
    const key = String(room.id) + ':' + String(current.id) + ':' + String(latest);
    if (settingEnabled('voiceNumbers') && !spokenTournamentAnnouncementKeys.has(key)) {
      spokenTournamentAnnouncementKeys.add(key);
      PersianAudioManager.speak(latest).then(ok => { if (!ok) spokenTournamentAnnouncementKeys.delete(key); });
      if (spokenTournamentAnnouncementKeys.size > 250) spokenTournamentAnnouncementKeys.delete(spokenTournamentAnnouncementKeys.values().next().value);
    }
  }
  const lineWinners = Array.isArray(current?.line_winners) ? current.line_winners : [];
  const winners = Array.isArray(current?.full_winners) ? current.full_winners : [];
  const top = Array.isArray(room.top_players) ? room.top_players : [];
  const recent = called.slice(-12).reverse().map(number => '<span>' + faDigits(number) + '</span>').join('');
  const card = Array.isArray(room.my_card) ? room.my_card : [];
  const calledSet = new Set(called);
  const cardMarkup = card.length === 3
    ? '<div class="tour-my-card"><div class="tour-my-card-heading"><b>کارت اختصاصی تو</b><span>' + faDigits(Number(room.my_matched_count)||0) + ' / ۱۵ عدد</span></div><div class="tour-my-card-grid">' +
      card.map(row => row.map(value => Number.isInteger(value)
        ? '<span class="tour-my-card-cell' + (calledSet.has(value) ? ' is-called' : '') + '">' + faDigits(value) + '</span>'
        : '<span class="tour-my-card-cell is-empty" aria-hidden="true"></span>').join('')).join('') +
      '</div><div class="tour-my-card-stats"><span>امتیاز این دور: <b>' + faDigits(Number(room.my_round_score)||0) + '</b></span><span>مجموع امتیاز: <b>' + faDigits(Number(room.my_total_points)||0) + '</b></span></div>' +
      (room.my_line_hit ? '<p class="tour-winner-notice">✓ یک خط روی کارت تو ثبت شده است</p>' : '') +
      (room.my_full_hit ? '<p class="tour-winner-notice">🏆 کارت کامل تو برنده شده است</p>' : '') + '</div>'
    : '';
  const leaderboard = top.length ? top.map((player,index) => '<li><b>' + faDigits(index+1) + '. ' + escapeHTML(player.name || 'بازیکن') + '</b><span>' + faDigits(Number(player.points)||0) + ' امتیاز</span></li>').join('') : '<li class="muted-note">هنوز امتیازی ثبت نشده است.</li>';
  return `<section class="tour-live-panel"><div class="tour-live-heading"><div><small>LIVE TOURNAMENT</small><h3>${escapeHTML(stage)}</h3></div><span class="tour-live-state">${room.status === 'running' ? '● زنده' : '● برنامه‌ریزی‌شده'}</span></div>
    ${current ? `<div class="tour-live-number"><small>آخرین شماره اعلام‌شده</small><b>${latest ? faDigits(latest) : '—'}</b><span>${faDigits(called.length)} / ۹۰ شماره</span></div><div class="tour-called-list">${recent || '<span>هنوز شماره‌ای اعلام نشده</span>'}</div>` : '<p class="muted-note">پس از شروع مسابقه، شماره‌های اعلام‌شده و جدول زنده در این بخش نمایش داده می‌شوند.</p>'}
    ${cardMarkup}
    ${lineWinners.length ? '<p class="tour-winner-notice">🏅 برنده خط این دور: ' + lineWinners.map(player => escapeHTML(player.name) + (player.memberId ? ' · شناسه ' + faDigits(player.memberId) : '')).join('، ') + '</p>' : ''}
    ${winners.length ? '<p class="tour-winner-notice">🏆 برنده کامل این دور: ' + winners.map(player => escapeHTML(player.name) + (player.memberId ? ' · شناسه ' + faDigits(player.memberId) : '')).join('، ') + '</p>' : ''}
    <div class="tour-live-leaders"><b>رتبه‌بندی برترها</b><ol>${leaderboard}</ol></div></section>`;
}
async function refreshTournamentData() {
  if (document.hidden || navigator.onLine === false ||
      tournamentPollBusy || !['tournaments','tournamentRoom','bingoTournament'].includes(currentPage)) return;
  tournamentPollBusy = true;
  try {
    const publicData = await apiRequest('/api/tournaments', { method:'GET', headers:{} });
    state.tournamentRooms = Array.isArray(publicData.rooms) ? publicData.rooms : [];
    if (currentUser) {
      const mine = await apiRequest('/api/tournaments/me', { method:'GET', headers:{} });
      state.tournamentRooms = Array.isArray(mine.rooms) ? mine.rooms : state.tournamentRooms;
      state.tournamentEntries = Array.isArray(mine.entries) ? mine.entries : [];
      if (Number.isFinite(Number(mine.bingo_coins))) state.bingoCoins = Math.max(0, Number(mine.bingo_coins) || 0);
      state.joined = state.tournamentEntries.filter(entry => entry.status !== 'refunded').map(entry => entry.tournament_type === 'bingo' ? 'bingoTournamentEntry' : 'simpleTournamentEntry');
    }
    saveState();
    if (['tournaments','tournamentRoom','bingoTournament'].includes(currentPage)) render();
  } catch (_) {
    // Retain the last successful server snapshot when polling fails temporarily.
  } finally {
    tournamentPollBusy = false;
  }
}
function configureTournamentPolling() {
  if (tournamentPollTimer) clearInterval(tournamentPollTimer);
  tournamentPollTimer = null;
  if (['tournaments','tournamentRoom','bingoTournament'].includes(currentPage)) {
    tournamentPollTimer = setInterval(refreshTournamentData, 3000);
  }
}
function tournamentScheduleText(room, type) {
  if (!room?.scheduled_at) return type === 'bingo' ? 'ماهانه · آخرین پنجشنبه' : 'هفتگی · پنجشنبه';
  try {
    return new Intl.DateTimeFormat('fa-IR',{timeZone:'Asia/Tehran',weekday:'long',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(room.scheduled_at));
  } catch (_) { return type === 'bingo' ? 'ماهانه' : 'هفتگی'; }
}
function tournamentCountdownText(room) {
  if (room?.status === 'running') return 'در حال برگزاری · ' + (room.stage_label || 'مسابقه زنده');
  if (room?.status === 'completed') return 'این دوره به پایان رسیده است';
  if (room?.status === 'cancelled') return 'این دوره لغو شده است';
  const start = Date.parse(room?.scheduled_at || '');
  const opens = Date.parse(room?.registration_opens_at || '');
  if (!Number.isFinite(start)) return 'زمان برگزاری به‌زودی اعلام می‌شود';
  const now = Date.now();
  const isScheduled = room?.status === 'scheduled' || !room?.status;
  const target = isScheduled && Number.isFinite(opens) && opens > now ? opens : start;
  let remaining = Math.max(0, target - now);
  const days = Math.floor(remaining / 86400000); remaining %= 86400000;
  const hours = Math.floor(remaining / 3600000); remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000); remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  const parts = [];
  if (days) parts.push(faDigits(days) + ' روز');
  if (hours) parts.push(faDigits(hours) + ' ساعت');
  if (minutes) parts.push(faDigits(minutes) + ' دقیقه');
  if (!parts.length) parts.push(faDigits(seconds) + ' ثانیه');
  return (isScheduled && target === opens && opens > now ? 'بازشدن ثبت‌نام تا ' : 'شروع مسابقه تا ') + parts.join(' و ');
}
function tournamentCard(type, index) {
  const bingo = type === 'bingo';
  const room = getTournamentRoom(type);
  const cost = bingo ? 100 : 20;
  const minimum = Math.max(5, Number(room.min_players) || 5);
  const capacity = Math.max(minimum, Number(room.capacity) || 30);
  const registered = Math.max(0, Number(room.registered_count) || 0);
  const entered = hasTournamentEntry(type);
  const full = !!room.registration_full || room.status === 'running' || room.status === 'completed' || room.status === 'cancelled';
  const progress = Math.min(100, Math.round(registered / capacity * 100));
  const title = bingo ? 'جام ویژه بینگو' : 'جام کلاسیک دبرنا';
  const subtitle = bingo ? 'تورنومنت VIP ماهانه · آخرین پنجشنبه هر ماه ساعت ۲۲' : 'تورنومنت ساده هفتگی · پنجشنبه‌ها ساعت ۲۱';
  const typeLabel = bingo ? 'BINGO CUP' : 'CLASSIC CUP';
  return `<article class="tour-card ${bingo ? 'tour-card-gold' : 'tour-card-red'}">
    <div class="tour-card-top"><span class="tour-card-icon">${bingo ? '🎱' : '🏆'}</span><span class="tour-card-type">${typeLabel}</span><span class="tour-card-state ${full ? 'is-full' : entered ? 'is-entered' : 'is-open'}">${entered ? escapeHTML(tournamentEntryState(type)) : room.status === 'scheduled' ? 'به‌زودی' : !room.id ? 'در حال بررسی' : full ? 'بسته' : 'آزاد'}</span></div>
    <div class="tour-card-title"><h3>${title}</h3><p>${subtitle}</p></div>
    <div class="tour-card-entry"><div><small>هزینه ورود</small><b>${faDigits(cost)} <em>BGC</em></b></div><div><small>ثبت‌نام فعلی</small><b>${faDigits(registered)} <em>از ${faDigits(capacity)}</em></b></div></div>
    <div class="tour-progress"><span style="width:${progress}%"></span></div>
    <div class="tour-card-meta"><span>${tournamentScheduleText(room,type)}</span><span>${faDigits(registered)} شرکت‌کننده · حداقل ${faDigits(minimum)}</span></div>
    <div class="tour-card-countdown">${tournamentCountdownText(room)}</div>
    <div class="tour-card-meta"><span>۹۰ توپ · کارت ۱۵ عددی</span><span>${tournamentStatus(room)}</span></div>${tournamentLivePanel(room,type)}
    <button class="btn ${entered ? 'btn-outline' : 'btn-primary'} tour-card-button" data-page="${bingo ? 'bingoTournament' : 'tournamentRoom'}">${entered ? 'مشاهده ثبت‌نام' : 'مشاهده و ثبت‌نام'} <span>←</span></button>
  </article>`;
}
function renderTournaments() {
  const simpleRoom = getTournamentRoom('simple');
  const bingoRoom = getTournamentRoom('bingo');
  const simpleCount = Math.max(0, Number(simpleRoom.registered_count) || 0);
  const bingoCount = Math.max(0, Number(bingoRoom.registered_count) || 0);
  const enteredCount = Number(hasTournamentEntry('simple')) + Number(hasTournamentEntry('bingo'));
  const allTypes = ['simple','bingo'];
  const visibleTypes = tournamentLobbyTab === 'mine' ? allTypes.filter(hasTournamentEntry) : allTypes;
  const cards = visibleTypes.map(tournamentCard).join('');
  return `${heading('جام‌ها و تورنومنت‌ها', 'وارد رقابت‌های دبرنا شو؛ کارت‌ها و قرعه‌کشی بر پایه دبرنای استاندارد ۹۰ توپی هستند.', 'DABERNAZ CHAMPIONSHIP')}
  <section class="tour-hero">
    <div class="tour-hero-backdrop" aria-hidden="true"><span>♛</span><i></i><b></b></div>
    <div class="tour-hero-copy"><span class="tour-kicker">فصل رقابت‌های دابرناز</span><h2>قهرمانی از <em>اینجا</em> شروع می‌شه</h2><p>جام خودت را انتخاب کن، قوانین را ببین و با بازیکنان دیگر برای ثبت بهترین نتیجه رقابت کن.</p>
      <div class="tour-hero-actions"><button class="btn btn-gold" data-page="tournamentRoom">جام کلاسیک</button><button class="tour-hero-link" data-page="bingoTournament">جام ویژه بینگو <span>←</span></button></div>
    </div>
    <div class="tour-hero-stats">
      <div><b>۲</b><small>مسیر رقابت</small></div><div><b>${faDigits(simpleCount + bingoCount)}</b><small>ثبت‌نام فعلی</small></div><div><b>۹۰</b><small>گوی در هر مسابقه</small></div>
    </div>
  </section>
  <section class="tour-section">
    <div class="tour-section-heading"><div><span class="tour-eyebrow">CHOOSE YOUR CUP</span><h2>مسابقات فعال</h2><p>جزئیات، شرایط ورود و وضعیت ثبت‌نام هر جام را بررسی کن.</p></div>
      <div class="tour-tabs" role="group" aria-label="فیلتر مسابقات">
        <button type="button" data-tournament-tab="all" class="${tournamentLobbyTab === 'all' ? 'active' : ''}" aria-pressed="${tournamentLobbyTab === 'all'}">همه جام‌ها</button>
        <button type="button" data-tournament-tab="mine" class="${tournamentLobbyTab === 'mine' ? 'active' : ''}" aria-pressed="${tournamentLobbyTab === 'mine'}">ثبت‌نام‌های من ${enteredCount ? `<b>${faDigits(enteredCount)}</b>` : ''}</button>
      </div>
    </div>
    <div class="tour-card-grid">${cards || '<div class="tour-empty"><span>🏆</span><b>هنوز در جامی ثبت‌نام نکرده‌ای</b><small>از بخش «همه جام‌ها» یکی از مسابقات را انتخاب کن.</small><button class="btn btn-outline" type="button" data-tournament-tab="all">نمایش همه جام‌ها</button></div>'}</div>
  </section>
  <section class="tour-format-panel">
    <div class="tour-format-heading"><span>🎱</span><div><small>قالب مشترک مسابقات</small><h2>دبرنای استاندارد ۹۰ توپی</h2></div></div>
    <div class="tour-format-grid">
      <div><b>۹۰</b><small>گوی شماره‌دار</small></div><div><b>۳ × ۹</b><small>ساختار هر کارت</small></div><div><b>۱۵</b><small>عدد در هر کارت</small></div><div><b>۲</b><small>مرحله برد: خط و کامل</small></div>
    </div>
    <p>شماره‌ها به‌صورت تصادفی و بدون تکرار اعلام می‌شوند. بردهای خطی و کاملِ هم‌زمان برای همهٔ برندگان ثبت و در امتیاز نهایی لحاظ می‌شوند؛ صندوق جایزه پس از پایان فینال، بر اساس رتبه‌بندی کلی و درصدهای اعلام‌شده میان سه رتبهٔ اول تقسیم می‌شود.</p>
  </section>
  <section class="tour-how-section">
    <div class="tour-section-heading"><div><span class="tour-eyebrow">HOW IT WORKS</span><h2>مسیر ورود به رقابت</h2></div></div>
    <div class="tour-step-grid"><div><span>۱</span><b>انتخاب جام</b><small>نوع مسابقه و هزینه ورود را بررسی کن.</small></div><div><span>۲</span><b>ثبت‌نام سروری</b><small>ورود با بینگوکوین از موجودی حساب کسر می‌شود.</small></div><div><span>۳</span><b>اعلام برنامه مسابقه</b><small>جزئیات زمان‌بندی و اجرای مراحل از همین بخش اطلاع‌رسانی می‌شود.</small></div></div>
    <p class="tour-honesty-note">تورنومنت ساده به‌صورت هفتگی و تورنومنت VIP به‌صورت ماهانه زمان‌بندی می‌شوند. حداقل ۵ شرکت‌کننده برای شروع لازم است؛ در صورت تکمیل‌نشدن حداقل نفرات، دوره لغو و ورودی بینگوکوین به حساب شرکت‌کنندگان بازگردانده می‌شود.</p>
  </section>`;
}
function renderTournamentDetail(bingo=false) {
  const title = bingo ? 'جام ویژه بینگو' : 'جام کلاسیک دبرنا';
  const type = bingo ? 'bingo' : 'simple';
  const cost = bingo ? 100 : 20;
  const room = getTournamentRoom(type);
  const minimum = Math.max(5, Number(room.min_players) || 5);
  const capacity = Math.max(minimum, Number(room.capacity) || 30);
  const registered = Math.max(0, Number(room.registered_count) || 0);
  const full = !!room.registration_full || room.status === 'running' || room.status === 'completed' || room.status === 'cancelled';
  const entered = hasTournamentEntry(type);
  const entryState = tournamentEntryState(type);
  const left = Math.max(0, capacity - registered);
  const progress = Math.min(100, Math.round(registered / capacity * 100));
  const statusText = entered ? entryState : tournamentStatus(room);
  const stageFormat = bingo
    ? '۵ تا ۸ نفر: فینال ۵ دور؛ ۹ تا ۱۶ نفر: مقدماتی ۲ دور و فینال ۵ دور؛ ۱۷ تا ۳۰ نفر: مقدماتی ۲ دور، نیمه‌نهایی ۳ دور و فینال ۵ دور.'
    : '۵ تا ۸ نفر: فینال ۳ دور؛ ۹ تا ۱۶ نفر: مقدماتی ۲ دور و فینال ۳ دور؛ ۱۷ تا ۳۰ نفر: مقدماتی ۲ دور، نیمه‌نهایی ۲ دور و فینال ۳ دور.';
  const otherPage = bingo ? 'tournamentRoom' : 'bingoTournament';
  const otherTitle = bingo ? 'مشاهده جام کلاسیک دبرنا' : 'مشاهده جام ویژه بینگو';
  const otherCost = bingo ? '۲۰ BGC' : '۱۰۰ BGC';
  return `${heading(title, bingo ? 'رقابت ویژه دبرنا با ورودی بینگوکوین و قوانین یکسان ۹۰ توپی.' : 'مسابقه کلاسیک دبرنای ۹۰ توپی با ثبت‌نام سروری و کارت‌های اختصاصی.', 'CHAMPIONSHIP DETAILS')}
  <section class="tour-detail-hero ${bingo ? 'tour-detail-gold' : 'tour-detail-red'}">
    <div class="tour-detail-symbol">${bingo ? '🎱' : '🏆'}</div>
    <div class="tour-detail-info"><span class="tour-kicker">${bingo ? 'BINGO CHAMPIONSHIP' : 'CLASSIC DABERNA CUP'}</span><h2>${title}</h2><p>${bingo ? 'یک رقابت اختصاصی برای علاقه‌مندان بینگو؛ همان هیجان ۹۰ گوی، در جامی جداگانه.' : 'قالب آشنای دبرنا با کارت ۱۵ عددی، قرعه‌کشی خودکار و رقابت بین شرکت‌کنندگان.'}</p><span class="tour-status-pill ${entered ? 'entered' : full ? 'full' : ''}">${statusText}</span></div>
    <div class="tour-entry-price"><small>هزینه ورود</small><b>${faDigits(cost)}</b><span>بینگوکوین</span></div>
  </section>
  <section class="tour-registration-panel">
    <div class="tour-registration-heading"><div><small>REGISTRATION STATUS</small><h2>وضعیت ثبت‌نام</h2></div><span class="tour-registration-icon">${entered ? '✓' : full ? '!' : '♟'}</span></div>
    <div class="tour-registration-numbers"><div><b>${faDigits(registered)}</b><small>ثبت‌نام‌شده</small></div><div><b>${faDigits(left)}</b><small>ظرفیت باقی‌مانده</small></div><div><b>${faDigits(Number(room.prize_pool)||0)}</b><small>صندوق جایزه BGC</small></div></div>
    <div class="tour-progress tour-progress-large"><span style="width:${progress}%"></span></div>
    <div class="tour-registration-foot"><span>زمان برگزاری: ${tournamentScheduleText(room,type)}</span><span>${tournamentStatus(room)}</span></div>
    <div class="tour-card-countdown tour-detail-countdown">${tournamentCountdownText(room)}</div>
    <button class="btn ${entered ? 'btn-outline' : 'btn-primary'} btn-block tour-register-button" data-action="join-tournament" data-tournament="${type}" ${entered || full || room.status === 'scheduled' || !room.id ? 'disabled' : ''}>${entered ? '✓ ' + escapeHTML(entryState) : !room.id ? 'در حال دریافت برنامه مسابقه' : room.status === 'scheduled' ? 'ثبت‌نام هنوز باز نشده' : full ? 'ثبت‌نام بسته است' : `ثبت‌نام و پرداخت ${faDigits(cost)} بینگوکوین`}</button>
    <p class="tour-balance-note">موجودی فعلی تو: <b>${state.bingoCoins.toLocaleString('fa-IR')} BGC</b> · هزینه فقط یک‌بار و پس از تأیید سرور کسر می‌شود.</p>
    ${tournamentLivePanel(room,type)}
  </section>
  <section class="tour-detail-grid">
    <div class="tour-rules-card"><div class="tour-panel-heading"><span>📜</span><div><small>GAME RULES</small><h3>قوانین مسابقه</h3></div></div>
      <ul><li>هر کارت شامل ۳ ردیف و ۹ ستون و مجموعاً ۱۵ عدد است.</li><li>گوی‌ها از ۱ تا ۹۰، تصادفی و بدون تکرار اعلام می‌شوند و همهٔ بازیکنان هر دور شماره‌های یکسان می‌گیرند.</li><li>اولین بازیکنی که یک ردیف پنج‌عددی را کامل کند برنده خط است؛ تکمیل هر ۱۵ عدد، برد کامل محسوب می‌شود.</li><li>اگر چند بازیکن با یک شماره به‌طور هم‌زمان برنده شوند، همهٔ آن‌ها در همان مرحله برنده ثبت می‌شوند.</li><li>ثبت‌نام از ۷ روز پیش از زمان مسابقه باز می‌شود و حداکثر ۳۰ جایگاه دارد.</li><li>${stageFormat}</li><li>${bingo ? 'امتیاز VIP: حضور ۲، خط ۱۵، کامل ۳۰ و پیشرفت ۱۰/۷/۵.' : 'امتیاز ساده: حضور ۱، خط ۱۰، کامل ۲۵ و پیشرفت ۸/۶/۴.'}</li></ul>
    </div>
    <div class="tour-prize-card"><div class="tour-panel-heading"><span>👑</span><div><small>WINNING FORMAT</small><h3>مراحل برد</h3></div></div>
      <div class="tour-winning-stage"><b>Ⅰ</b><div><strong>برنده یک خط</strong><small>تکمیل یک ردیف افقی</small></div></div>
      <div class="tour-winning-stage"><b>♛</b><div><strong>برنده دبرنای کامل</strong><small>تکمیل تمام خانه‌های کارت</small></div></div>
      <div class="tour-prize-shares"><b>تقسیم صندوق جایزه</b><div><span>🥇 نفر اول</span><strong>${bingo ? '۵۰٪' : '۶۰٪'}</strong></div><div><span>🥈 نفر دوم</span><strong>${bingo ? '۳۰٪' : '۲۵٪'}</strong></div><div><span>🥉 نفر سوم</span><strong>${bingo ? '۲۰٪' : '۱۵٪'}</strong></div></div>
      <p class="tour-prize-disclaimer">ساده پنجشنبه‌ها ساعت ۲۱ و VIP آخرین پنجشنبهٔ هر ماه ساعت ۲۲ به وقت تهران برگزار می‌شود. ثبت‌نام ۷ روز قبل باز می‌شود؛ حداقل ۵ و حداکثر ۳۰ شرکت‌کننده لازم است. در صورت لغو، ورودی به‌صورت سروری بازگردانده می‌شود. در تساوی امتیاز، ابتدا برد کامل، سپس برد خطی، تعداد دورهای انجام‌شده، زمان ثبت‌نام و در نهایت شناسه بازیکن معیار رتبه‌بندی است.</p>
    </div>
  </section>
  <section class="tour-next-cup"><div><small>مسیر جایگزین</small><b>${otherTitle}</b><span>هزینه ورود: ${otherCost}</span></div><button class="btn btn-outline" data-page="${otherPage}">مشاهده جام دیگر ←</button></section>
  <button class="btn btn-muted btn-block tour-back-button" data-page="tournaments">بازگشت به فهرست جام‌ها</button>`;
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
function walletStatusLabel(status){
  return ({awaiting_receipt:'در انتظار ارسال رسید',pending_review:'در انتظار بررسی مدیر',pending_transfer:'در انتظار واریز مدیر',approved:'واریز تأیید شد',paid:'برداشت پرداخت شد',rejected:'رد شده',cancelled:'لغو شده'})[status]||status||'نامشخص';
}
function walletTypeLabel(type){return type==='deposit'?'واریز':'برداشت';}
function walletCardNumber(value){return String(value||'').replace(/\D/g,'').replace(/(\d{4})(?=\d)/g,'$1 ').trim();}
async function showWalletPaymentInstructions(requestId){
 const result=await apiRequest('/api/wallet/requests/'+Number(requestId)+'/payment-instructions',{method:'GET',headers:{}});
 const info=result.paymentInfo||{};
 if(!info.cardNumber)throw new Error('اطلاعات کارت مقصد در دسترس نیست.');
 walletActivePaymentInfo=info;
 const requestRow=(state.walletRequests||[]).find(item=>Number(item.id)===Number(requestId));
 const card=walletCardNumber(info.cardNumber);
 const body='<section class="wallet-transfer-instructions wallet-private-payment"><div class="wallet-payment-heading"><span>پرداخت امن · درخواست #'+faDigits(requestId)+'</span><b>'+money(requestRow?.amount||0)+' تومان</b></div><p>مبلغ این درخواست را به کارت زیر انتقال بده و سپس تصویر رسید را همین‌جا ارسال کن.</p><div class="wallet-payment-card"><small>'+(escapeHTML(info.bankName||'کارت مقصد'))+'</small><strong dir="ltr">'+escapeHTML(card)+'</strong><b>'+escapeHTML(info.cardHolder||'')+'</b><button type="button" class="btn btn-outline" data-action="wallet-copy-card">کپی شماره کارت</button></div>'+(info.paymentNote?'<p class="muted-note">'+escapeHTML(info.paymentNote)+'</p>':'')+'</section><form id="walletReceiptForm" class="form-stack" data-request-id="'+Number(requestId)+'"><label>تصویر رسید پرداخت<input class="form-control" type="file" name="receipt" accept="image/png,image/jpeg,image/webp" required></label><small class="muted-note">فرمت مجاز PNG، JPG یا WebP · حداکثر ۵۱۲ کیلوبایت</small><button class="btn btn-primary btn-block" type="submit">ارسال رسید برای بررسی</button></form>';
 openModal('اطلاعات پرداخت و ارسال رسید',body);
}
function renderWallet(){
 const rows=state.transactions.length?state.transactions.map(tx=>'<div class="transaction"><div class="transaction-icon '+(Number(tx.amount)<0?'out':'')+'">'+(Number(tx.amount)<0?'↗':'↙')+'</div><div class="transaction-info"><b>'+escapeHTML(tx.title||'تراکنش کیف پول')+'</b><small>'+escapeHTML(tx.date||'')+'</small></div><span class="transaction-amount '+(Number(tx.amount)<0?'negative':'positive')+'">'+(Number(tx.amount)>0?'+':'')+money(tx.amount)+' تومان</span></div>').join(''):'<div class="empty"><span>🪙</span>هنوز تراکنش تومانی ثبت نشده است.</div>';
 const coinRows=state.coinTransactions.length?state.coinTransactions.map(tx=>'<div class="transaction"><div class="transaction-icon coin-transaction-icon">B</div><div class="transaction-info"><b>'+escapeHTML(tx.title)+'</b><small>'+escapeHTML(tx.date)+'</small></div><span class="transaction-amount '+(tx.amount<0?'negative':'positive')+'">'+(tx.amount>0?'+':'')+tx.amount.toLocaleString('fa-IR')+' BGC</span></div>').join(''):'<div class="empty"><span>✦</span>هنوز تراکنش بینگوکوین ثبت نشده است.</div>';
 const requestRows=state.walletRequests.length?state.walletRequests.map(r=>'<article class="wallet-request-row"><div class="wallet-request-main"><b>#'+faDigits(r.id)+' · '+walletTypeLabel(r.request_type)+'</b><strong>'+money(r.amount)+' تومان</strong><small>'+escapeHTML(r.created_at||'')+'</small><span class="tag">'+walletStatusLabel(r.status)+'</span></div><div class="wallet-request-extra">'+(r.request_type==='withdraw'?'<small>کارت مقصد: '+escapeHTML('ثبت شده')+'</small>':'<small>'+(r.has_receipt?'رسید ارسال شده':'رسید ارسال نشده')+'</small>')+(r.status==='awaiting_receipt'&&r.request_type==='deposit'?'<button class="btn btn-outline" data-action="wallet-upload-receipt" data-request-id="'+Number(r.id)+'">نمایش کارت و ارسال رسید</button>':'')+(r.status==='pending_transfer'?'<button class="btn btn-outline" data-action="wallet-cancel-request" data-request-id="'+Number(r.id)+'">لغو درخواست</button>':'')+(r.user_note?'<small>توضیحات: '+escapeHTML(r.user_note)+'</small>':'')+(r.admin_note?'<small>یادداشت مدیریت: '+escapeHTML(r.admin_note)+'</small>':'')+'</div></article>').join(''):'<div class="empty">هنوز درخواست واریز یا برداشتی ثبت نکرده‌ای.</div>';
 return heading('کیف پول من','درخواست واریز و برداشت را ثبت کن و وضعیت آن را از همین صفحه پیگیری کن.','MANUAL WALLET')+
 '<div class="wallet-currency-grid"><section class="wallet-hero"><small>موجودی تومان</small><div class="wallet-balance">'+money(state.balance)+' <span>تومان</span></div><p>اعتبار قابل استفاده در بازی‌ها و خدمات دابرناز.</p><div class="wallet-actions"><button class="btn btn-outline" data-action="wallet-open-deposit">درخواست واریز</button><button class="btn btn-outline" data-action="wallet-open-withdraw">درخواست برداشت</button></div></section><section class="wallet-hero bingocoin-wallet-hero"><small>موجودی BINGO COIN</small><div class="wallet-balance">'+state.bingoCoins.toLocaleString('fa-IR')+' <img class="bingocoin-icon-img wallet-coin-img" src="./assets/bingocoin.svg" alt="بینگوکوین"></div><p>ارز مجازی اختصاصی برای ورود به تورنومنت‌ها.</p><button class="btn btn-gold btn-block" data-page="tournaments">مشاهده تورنومنت‌ها</button></section></div>'+
 '<section class="panel wallet-request-form-panel"><div class="section-title"><div><h2>ثبت درخواست مالی</h2><p class="muted-note">نوع عملیات، مبلغ و اطلاعات لازم را وارد کن؛ درخواست مستقیماً به صندوق مدیریت مالی می‌رود.</p></div></div><form id="walletRequestForm" class="wallet-request-form"><div class="wallet-request-type-grid" role="group" aria-label="نوع درخواست"><label class="wallet-request-type-option"><input type="radio" name="type" value="deposit" checked><span class="wallet-request-type-icon">＋</span><span><b>واریز به کیف پول</b><small>شارژ موجودی با انتقال وجه و ارسال رسید</small></span></label><label class="wallet-request-type-option"><input type="radio" name="type" value="withdraw"><span class="wallet-request-type-icon">↗</span><span><b>برداشت از کیف پول</b><small>واریز مبلغ به کارت بانکی ثبت‌شده</small></span></label></div><label class="wallet-request-field">مبلغ درخواست (تومان)<input class="form-control" id="walletRequestAmount" name="amount" type="number" inputmode="numeric" min="105" max="50000000" step="1" placeholder="مبلغ را به تومان وارد کن" required><small id="walletRequestMinHelp">حداقل واریز: ۱۰۵ تومان · حداکثر: ۵۰ میلیون تومان</small></label><div id="walletWithdrawFields" class="wallet-withdraw-fields" hidden><label class="wallet-request-field">شماره کارت مقصد (۱۶ رقم)<input class="form-control" name="cardNumber" inputmode="numeric" maxlength="19" autocomplete="off" placeholder="شماره کارت به نام خودت" pattern="[0-9۰-۹٠-٩ ]{16,23}"></label><label class="wallet-request-field">نام صاحب کارت<input class="form-control" name="cardHolder" maxlength="80" autocomplete="name" placeholder="نام مطابق کارت"></label><label class="wallet-request-field">نام بانک (اختیاری)<input class="form-control" name="bankName" maxlength="60" placeholder="نام بانک"></label></div><label class="wallet-request-field">توضیحات یا شماره پیگیری (اختیاری)<textarea class="form-control" name="userNote" rows="2" maxlength="300" placeholder="در صورت نیاز، توضیح یا کد پیگیری را بنویس..."></textarea></label><div class="wallet-request-security-note"><span>ⓘ</span><p id="walletRequestRuleText">پس از ثبت واریز، اطلاعات کارت مقصد فقط برای همین حساب و همین درخواست نمایش داده می‌شود. رسید را برای بررسی مدیریت ارسال کن.</p></div><button class="btn btn-primary btn-block wallet-request-submit" id="walletRequestSubmit" type="submit">ثبت درخواست واریز</button></form></section>'+
 section('درخواست‌های واریز و برداشت')+'<section class="panel wallet-request-list">'+requestRows+'</section>'+
 section('تاریخچه کیف پول تومانی')+'<section class="panel" style="padding:2px 12px">'+rows+'</section>'+
 section('تاریخچه بینگوکوین')+'<section class="panel" style="padding:2px 12px">'+coinRows+'</section>'+
 '<p class="muted-note">حداقل واریز ۱۰۵ تومان و حداقل برداشت ۲۰۵ تومان است. مبلغ برداشت هنگام ثبت درخواست از موجودی قابل برداشت رزرو می‌شود؛ در صورت رد یا لغو، به کیف پول بازمی‌گردد. بینگوکوین قابل برداشت نقدی نیست.</p>';
}
function renderWalletAdmin(){
 if(!walletAdminEnabled)return heading('مدیریت مالی','دسترسی مدیر برای این حساب فعال نیست.','WALLET ADMIN');
 const counts={all:walletAdminRequests.length,pending_review:walletAdminRequests.filter(r=>r.status==='pending_review').length,awaiting_receipt:walletAdminRequests.filter(r=>r.status==='awaiting_receipt').length,pending_transfer:walletAdminRequests.filter(r=>r.status==='pending_transfer').length};
 const filters=[['all','همه'],['pending_review','در انتظار بررسی'],['pending_transfer','برداشت‌های در انتظار پرداخت'],['awaiting_receipt','در انتظار رسید'],['paid','پرداخت‌شده'],['approved','تأییدشده'],['rejected','ردشده'],['cancelled','لغوشده']];
 const filtered=walletAdminRequests.filter(r=>walletAdminFilter==='all'||r.status===walletAdminFilter);
 const selected=walletAdminSelectedRequest&&walletAdminSelectedRequest.request?walletAdminSelectedRequest.request:null;
 const list=filtered.length?filtered.map(r=>'<button class="wallet-admin-request" data-action="wallet-admin-open-request" data-request-id="'+Number(r.id)+'"><span><b>#'+faDigits(r.id)+' · '+walletTypeLabel(r.request_type)+' · '+escapeHTML(r.username||'')+'</b><small>شناسه '+escapeHTML(r.member_id||'')+' · '+money(r.amount)+' تومان · '+escapeHTML(r.created_at||'')+(r.user_note?' · توضیح: '+escapeHTML(r.user_note):'')+'</small></span><span class="tag">'+walletStatusLabel(r.status)+'</span></button>').join(''):'<div class="empty">درخواستی در این وضعیت وجود ندارد.</div>'
 let detail='';
 if(selected){
  detail='<section class="panel wallet-admin-detail"><div class="section-title"><h2>درخواست #'+faDigits(selected.id)+'</h2><span class="tag">'+walletStatusLabel(selected.status)+'</span></div>'+
  '<div class="wallet-admin-user-data"><b>'+escapeHTML(selected.username||'')+'</b><small>شناسه '+escapeHTML(selected.member_id||'')+' · '+escapeHTML(selected.email||'')+'</small><strong>موجودی فعلی: '+money(selected.balance)+' تومان</strong></div>'+
  '<div class="wallet-admin-data-grid"><div><small>نوع درخواست</small><b>'+walletTypeLabel(selected.request_type)+'</b></div><div><small>مبلغ</small><b>'+money(selected.amount)+' تومان</b></div><div><small>شماره کارت</small><b>'+escapeHTML(walletCardNumber(selected.card_number))+'</b></div><div><small>صاحب کارت</small><b>'+escapeHTML(selected.card_holder||'—')+'</b></div><div><small>بانک</small><b>'+escapeHTML(selected.bank_name||'—')+'</b></div><div><small>زمان ثبت</small><b>'+escapeHTML(selected.created_at||'')+'</b></div></div>'+
  (selected.receiptDataUrl?'<div class="wallet-proof"><b>رسید پرداخت کاربر</b><a href="'+escapeHTML(selected.receiptDataUrl)+'" target="_blank" rel="noopener"><img class="wallet-proof-image" src="'+escapeHTML(selected.receiptDataUrl)+'" alt="تصویر رسید ارسالی"></a></div>':'<p class="muted-note">برای این درخواست رسیدی ثبت نشده است.</p>')+
  (selected.status==='pending_review'&&selected.request_type==='deposit'?'<div class="wallet-admin-actions"><button class="btn btn-primary" data-action="wallet-admin-decision" data-decision="approve" data-request-id="'+Number(selected.id)+'">تأیید و شارژ کیف پول</button><button class="btn btn-outline" data-action="wallet-admin-decision" data-decision="reject" data-request-id="'+Number(selected.id)+'">رد درخواست</button></div>':'')+
  (selected.status==='pending_transfer'&&selected.request_type==='withdraw'?'<div class="wallet-admin-actions"><button class="btn btn-primary" data-action="wallet-admin-decision" data-decision="paid" data-request-id="'+Number(selected.id)+'">ثبت واریز وجه به کارت</button><button class="btn btn-outline" data-action="wallet-admin-decision" data-decision="reject" data-request-id="'+Number(selected.id)+'">رد و بازگرداندن موجودی</button></div>':'')+
  (selected.user_note?'<p class="muted-note">توضیحات کاربر: '+escapeHTML(selected.user_note)+'</p>':'')+'<p class="muted-note">یادداشت مدیر: '+escapeHTML(selected.admin_note||'—')+'</p></section>';
 }
 const info=state.walletPaymentInfo||{};
 const users=walletAdminUsers.length?walletAdminUsers.map(u=>'<button class="wallet-admin-user-result" data-action="wallet-admin-pick-user" data-member-id="'+escapeHTML(u.member_id||'')+'" data-username="'+escapeHTML(u.username||'')+'"><b>'+escapeHTML(u.username||'')+'</b><small>ID '+escapeHTML(u.member_id||'')+' · '+escapeHTML(u.email||'')+' · موجودی '+money(u.balance)+' تومان</small></button>').join(''):'<div class="muted-note">برای جست‌وجو، نام کاربری، ایمیل یا شناسه بازیکن را وارد کن.</div>';
 return heading('مدیریت مالی','صندوق درخواست‌های واریز و برداشت، بررسی رسیدها و پردازش پرداخت کاربران.','SECURE WALLET ADMIN')+
 '<div class="support-admin-stats"><div><b>'+faDigits(counts.all)+'</b><small>همه درخواست‌ها</small></div><div><b>'+faDigits(counts.pending_review)+'</b><small>رسیدهای آماده بررسی</small></div><div><b>'+faDigits(counts.pending_transfer)+'</b><small>برداشت‌های باز</small></div><div><b>'+faDigits(counts.awaiting_receipt)+'</b><small>منتظر رسید</small></div></div>'+
 '<section class="panel wallet-admin-settings"><div class="section-title"><h2>کارت مقصد واریز کاربران (فقط مدیر)</h2></div><form id="walletAdminSettingsForm" class="form-stack"><label>شماره کارت ۱۶ رقمی<input class="form-control" name="cardNumber" inputmode="numeric" maxlength="19" value="'+escapeHTML(info.cardNumber||'')+'" placeholder="شماره کارت مقصد" required></label><label>نام صاحب کارت<input class="form-control" name="cardHolder" maxlength="80" value="'+escapeHTML(info.cardHolder||'')+'" placeholder="نام و نام خانوادگی" required></label><label>نام بانک<input class="form-control" name="bankName" maxlength="60" value="'+escapeHTML(info.bankName||'')+'" placeholder="نام بانک"></label><label>توضیحات داخلی/پرداخت<textarea class="form-control" name="paymentNote" rows="2" maxlength="400" placeholder="توضیحات">'+escapeHTML(info.paymentNote||'')+'</textarea></label><button class="btn btn-primary btn-block" type="submit">ذخیره اطلاعات کارت مقصد</button></form></section>'+
 '<section class="panel wallet-admin-adjust"><div class="section-title"><h2>جست‌وجو و اصلاح موجودی کاربر</h2></div><form id="walletAdminSearchForm" class="wallet-admin-search"><input class="form-control" name="query" minlength="2" placeholder="شناسه، نام کاربری یا ایمیل"><button class="btn btn-outline" type="submit">جست‌وجو</button></form><div class="wallet-admin-user-results">'+users+'</div><form id="walletAdminAdjustForm" class="form-stack"><label>شناسه بازیکن<input class="form-control" name="memberId" inputmode="numeric" value="'+escapeHTML(walletAdminSelectedMemberId||'')+'" placeholder="شناسه دقیق کاربر" required></label><label>مبلغ تغییر موجودی (تومان)<input class="form-control" name="amount" type="number" step="1000" min="-50000000" max="50000000" placeholder="مثبت برای افزایش، منفی برای کاهش" required></label><label>علت تغییر<input class="form-control" name="reason" minlength="3" maxlength="180" placeholder="علت ثبت‌شده در سوابق مالی" required></label><button class="btn btn-primary btn-block" type="submit">ثبت تغییر موجودی</button></form><p class="muted-note">هر اصلاح، همراه با مبلغ و علت، در تاریخچه تراکنش‌های همان حساب ثبت می‌شود. موجودی منفی مجاز نیست.</p></section>'+
 '<section class="panel wallet-admin-inbox"><div class="section-title"><h2>صندوق درخواست‌های مالی</h2></div><div class="support-admin-filters">'+filters.map(x=>'<button class="btn '+(walletAdminFilter===x[0]?'btn-primary':'btn-outline')+'" data-action="wallet-admin-filter" data-filter="'+x[0]+'">'+x[1]+'</button>').join('')+'</div>'+detail+'<div class="wallet-admin-request-list">'+list+'</div></section>';
}
async function refreshWalletData(){
 const [profile,requests]=await Promise.all([
  apiRequest('/api/auth/me',{method:'GET',headers:{}}),
  apiRequest('/api/wallet/requests',{method:'GET',headers:{}})
 ]);
 if(profile.user)applyAuthenticatedUser(profile.user);
 state.walletPaymentInfo={cardNumber:'',cardHolder:'',bankName:'',paymentNote:''};
 state.walletRequests=Array.isArray(requests.requests)?requests.requests:[];
 saveState();
}
async function refreshWalletAdmin(){
 const result=await apiRequest('/api/admin/wallet',{method:'GET',headers:{}});
 walletAdminEnabled=result.isAdmin===true;
 walletAdminRequests=Array.isArray(result.requests)?result.requests:[];
 const settings=await apiRequest('/api/admin/wallet/settings',{method:'GET',headers:{}});
 if(settings.settings)state.walletPaymentInfo=settings.settings;
 if(walletAdminSelectedRequest&&walletAdminSelectedRequest.request){
  walletAdminSelectedRequest=await apiRequest('/api/admin/wallet/'+Number(walletAdminSelectedRequest.request.id),{method:'GET',headers:{}});
 }
}

function renderAccount() {
  if (!currentUser) return renderAuthPage();
  return `${heading('حساب کاربری', 'اطلاعات حساب و امنیت ورودت را مدیریت کن.', 'PLAYER ACCOUNT')}
    <section class="profile-hero"><div class="avatar avatar-large">♛</div><div class="profile-info"><h2>${escapeHTML(state.username)}</h2><small>شناسه بازیکن: ${escapeHTML(state.memberId)}</small><small style="display:block">${escapeHTML(currentUser.email)}</small><div class="profile-score">حساب ثبت‌شده</div></div></section>
    <div class="profile-stat-grid"><div class="profile-stat"><b>${money(state.gamesPlayed)}</b><small>بازی‌ها</small></div><div class="profile-stat"><b>${money(state.wins)}</b><small>بردها</small></div><div class="profile-stat"><b>${money(state.points)}</b><small>امتیاز</small></div><div class="profile-stat"><b>${state.joined.length}</b><small>تورنمنت</small></div></div>
    ${section('مدیریت حساب')}
    ${accountRow('✎','اطلاعات شخصی','نام نمایشی و مشخصات حساب','edit-profile')}
    ${accountRow('🛡','امنیت حساب','ورود با رمز عبور رمزنگاری‌شده','security')}
    ${accountRow('⇥','خروج از حساب','خروج امن از این دستگاه','logout')}
    ${accountRow('⛨','خروج از همه دستگاه‌ها','ابطال تمام نشست‌های فعال حساب','logout-all')}`;
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
  const sw = (key, title, desc) => `<div class="setting-row"><div class="setting-copy"><b>${title}</b><small>${desc}</small></div><button class="switch ${state.settings[key] ? 'on' : ''}" type="button" role="switch" aria-checked="${!!state.settings[key]}" aria-label="${title}" data-setting="${key}"></button></div>`;
  const voiceControl = sw('voiceNumbers',
    voicePackReady ? 'اعلام صوتی شماره‌ها با Sage Woman' : 'اعلام صوتی شماره‌ها',
    voicePackReady ? 'صدای زنانه Sage Woman برای اعلام شماره‌های ۱ تا ۹۰' : 'بستهٔ Sage Woman هنوز نصب نشده؛ در APK از موتور بومی فارسی Android و در وب از موتور گفتار مرورگر استفاده می‌شود.');
  return `${heading('تنظیمات', 'صدای بازی، اعلام شماره‌ها و اعلان‌های دستگاه را مدیریت کن.', 'PREFERENCES')}
  <section class="setting-group"><h3 class="settings-title">صدا و بازی</h3>
    ${sw('sounds','صداهای محیط بازی','افکت‌ها و صداهای محیطی بازی؛ مستقل از اعلام شماره‌ها')}
    ${voiceControl}
    <div class="setting-row"><div class="setting-copy"><b>آزمایش صدای شماره ۴۲</b><small>${voicePackReady ? 'پخش نمونهٔ «چهل دو» با صدای Sage Woman' : 'پخش نمونه از موتور گفتار دستگاه؛ صدای Sage Woman پس از نصب بسته فعال می‌شود'}</small></div><button class="btn btn-outline" type="button" data-action="test-number-voice">تست</button></div>
    ${sw('vibration','لرزش','بازخورد لرزشی در دستگاه‌های پشتیبانی‌شده')}
  </section>
  <section class="setting-group"><h3 class="settings-title">اعلان‌های دستگاه</h3>
    ${sw('notifications','اجازه اعلان مرورگر','فقط مجوز اعلان این دستگاه را فعال می‌کند؛ اعلان خودکار سرور هنوز راه‌اندازی نشده است')}
    <div class="setting-row"><div class="setting-copy"><b>آزمایش اعلان</b><small>نمایش یک اعلان آزمایشی در همین دستگاه</small></div><button class="btn btn-outline" type="button" data-action="test-notification">تست</button></div>
  </section>
  <section class="setting-group"><h3 class="settings-title">درباره برنامه</h3>
    <div class="setting-row"><div class="setting-copy"><b>زبان برنامه</b><small>فارسی</small></div><span class="tag">FA</span></div>
    <div class="setting-row"><div class="setting-copy"><b>نسخه دابرناز</b><small>حساب سروری و اتاق‌های دبرنا</small></div><span class="muted-note">4.30.0</span></div>
  </section>
  <button class="btn btn-outline btn-block" type="button" data-action="reset-settings">بازنشانی تنظیمات</button>`;
}
const faqs = [
  ['چطور وارد اتاق بازی بشم؟','از صفحه خانه روی «اتاق بازی» بزن یا از کارت بازی مورد علاقه‌ات وارد شو.'],
  ['ورود به اتاق دبرنا هزینه دارد؟','خرید کارت از اعتبار کیف پول انجام می‌شود. برای شارژ، درخواست واریز ثبت کن و پس از انتقال وجه رسید را بفرست؛ مدیریت پس از بررسی موجودی را شارژ می‌کند. برداشت نیز با ثبت کارت مقصد و بررسی مدیریت انجام می‌شود. درگاه پرداخت خودکار هنوز متصل نیست.'],
  ['تورنمنت‌ها و کیف پول فعال هستند؟','ثبت‌نام تورنومنت با بینگوکوین روی سرور انجام می‌شود. واریز و برداشت تومانی کیف پول به‌صورت دستی و با بررسی مدیریت انجام می‌شود؛ درگاه پرداخت خودکار هنوز متصل نیست.'],
  ['اطلاعات حساب من کجا ذخیره می‌شود؟','در نسخه فعلی Cloudflare، اطلاعات حساب و آمار در دیتابیس D1 نگهداری می‌شوند و رمز عبور فقط به‌شکل هش‌شده ذخیره می‌شود. تنظیمات ظاهری غیرحساس در مرورگر می‌مانند.'],
  ['چطور با پشتیبانی ارتباط بگیرم؟','فرم پایین صفحه را تکمیل کن. پیام روی سرور ذخیره می‌شود و شماره پیگیری دریافت می‌کنی.']
];
function supportStatusLabel(status){return status==='open'?'در انتظار بررسی':status==='answered'?'پاسخ داده شد':status==='closed'?'بسته':'ثبت‌شده';}
function supportMessagesMarkup(messages,adminView){
  return (messages||[]).map(item=>'<article class="support-message '+(item.sender_role==='admin'?'from-admin':'from-user')+'"><div class="support-message-meta"><b>'+(item.sender_role==='admin'?'پشتیبانی دابرناز':(adminView?'کاربر':'شما'))+'</b><time>'+escapeHTML(item.created_at?new Date(item.created_at).toLocaleString('fa-IR'):'')+'</time></div><p>'+escapeHTML(item.message||'')+'</p></article>').join('')||'<div class="empty">هنوز پیامی در این تیکت وجود ندارد.</div>';
}
function renderSupportTickets(){
 const tickets=Array.isArray(state.supportTickets)?state.supportTickets:[];
 if(!tickets.length)return '<div class="empty"><span>🎧</span>هنوز تیکتی ثبت نکرده‌ای.</div>';
 return '<div class="panel support-ticket-list">'+tickets.map(t=>'<button class="support-ticket-row" data-action="support-open-ticket" data-ticket-id="'+Number(t.id)+'"><span><b>#'+faDigits(t.id)+' · '+escapeHTML(t.subject)+'</b><small>'+escapeHTML(t.last_message||'مشاهده گفتگو')+'</small></span><span class="tag">'+supportStatusLabel(t.status)+'</span></button>').join('')+'</div>';
}
function renderSupportThread(){
 if(!supportThread||!supportThread.ticket)return '';
 const t=supportThread.ticket;
 return '<section class="setting-group support-thread"><div class="support-thread-heading"><div><h3>گفتگوی تیکت #'+faDigits(t.id)+'</h3><small>'+escapeHTML(t.subject)+' · '+supportStatusLabel(t.status)+'</small></div><button class="btn btn-outline" data-action="support-close-thread">بازگشت</button></div><div class="support-messages">'+supportMessagesMarkup(supportThread.messages,false)+'</div>'+(t.status==='closed'?'<p class="muted-note">این تیکت بسته شده است و امکان ارسال پیام جدید ندارد.</p>':'<form id="supportReplyForm" class="form-stack"><textarea class="form-control" name="message" rows="3" maxlength="2000" placeholder="پیام خودت را بنویس..." required></textarea><button class="btn btn-primary btn-block" type="submit">ارسال پیام</button></form>')+'</section>';
}
function renderSupportAdminThread(){
 if(!supportThread||!supportThread.ticket)return '';
 const t=supportThread.ticket;
 return '<section class="setting-group support-thread"><div class="support-thread-heading"><div><h3>تیکت #'+faDigits(t.id)+' · '+escapeHTML(t.subject)+'</h3><small>'+escapeHTML(t.username)+' · شناسه '+escapeHTML(t.member_id||'')+' · '+escapeHTML(t.email||'')+'</small></div><span class="tag">'+supportStatusLabel(t.status)+'</span></div><div class="support-messages">'+supportMessagesMarkup(supportThread.messages,true)+'</div><div class="support-admin-controls"><button class="btn btn-outline" data-action="support-admin-status" data-status="open">باز</button><button class="btn btn-outline" data-action="support-admin-status" data-status="answered">پاسخ داده‌شده</button><button class="btn btn-outline" data-action="support-admin-status" data-status="closed">بستن تیکت</button></div>'+(t.status==='closed'?'<p class="muted-note">برای پاسخ ابتدا تیکت را باز کن.</p>':'<form id="supportAdminReplyForm" class="form-stack"><textarea class="form-control" name="message" rows="3" maxlength="2000" placeholder="پاسخ شما به کاربر..." required></textarea><button class="btn btn-primary btn-block" type="submit">ارسال پاسخ به کاربر</button></form>')+'</section>';
}
function renderSupportAdmin(){
 if(!supportAdminEnabled)return heading('مدیریت پشتیبانی','دسترسی مدیر برای این حساب فعال نیست.','ADMIN SUPPORT');
 const counts={all:supportAdminTickets.length,open:supportAdminTickets.filter(t=>t.status==='open').length,answered:supportAdminTickets.filter(t=>t.status==='answered').length,closed:supportAdminTickets.filter(t=>t.status==='closed').length};
 const list=supportAdminTickets.filter(t=>supportAdminFilter==='all'||t.status===supportAdminFilter);
 return heading('مدیریت پشتیبانی','صندوق ورودی تیکت‌ها و پاسخ مستقیم به کاربران','ADMIN SUPPORT')+
 '<div class="support-admin-stats"><div><b>'+faDigits(counts.all)+'</b><small>همه</small></div><div><b>'+faDigits(counts.open)+'</b><small>باز</small></div><div><b>'+faDigits(counts.answered)+'</b><small>پاسخ‌داده‌شده</small></div><div><b>'+faDigits(counts.closed)+'</b><small>بسته</small></div></div>'+
 '<div class="support-admin-filters">'+[['all','همه'],['open','باز'],['answered','پاسخ‌داده‌شده'],['closed','بسته']].map(x=>'<button class="btn '+(supportAdminFilter===x[0]?'btn-primary':'btn-outline')+'" data-action="support-admin-filter" data-filter="'+x[0]+'">'+x[1]+'</button>').join('')+'</div>'+
 renderSupportAdminThread()+'<div class="panel support-ticket-list">'+(list.length?list.map(t=>'<button class="support-ticket-row" data-action="support-admin-open-ticket" data-ticket-id="'+Number(t.id)+'"><span><b>#'+faDigits(t.id)+' · '+escapeHTML(t.subject)+'</b><small>'+escapeHTML(t.username)+' · ID '+escapeHTML(t.member_id||'')+' · '+escapeHTML(t.last_message||'')+'</small></span><span class="tag">'+supportStatusLabel(t.status)+'</span></button>').join(''):'<div class="empty">در این فیلتر تیکتی وجود ندارد.</div>')+'</div>';
}
async function refreshSupportAdmin(){
 const result=await apiRequest('/api/admin/support',{method:'GET',headers:{}});
 supportAdminEnabled=result.isAdmin===true; supportAdminTickets=Array.isArray(result.tickets)?result.tickets:[];
 if(supportSelectedTicketId)supportThread=await apiRequest('/api/admin/support/'+supportSelectedTicketId,{method:'GET',headers:{}});
}
function renderSupport() {
  return `${heading('پشتیبانی دابرناز', 'درخواستت را ثبت کن و شماره پیگیری دریافت کن.', 'WE ARE HERE FOR YOU')}
  <section class="invite-hero" style="text-align:right;padding:15px"><div style="display:flex;align-items:center;gap:13px"><div style="font-size:48px;filter:drop-shadow(0 0 12px #f32b43)">🎧</div><div><span class="eyebrow">سامانه تیکت</span><h2 style="font-size:18px;margin:4px 0;color:#fff">پیگیری درخواست پشتیبانی</h2><p style="margin:0;font-size:9px">پیام‌ها در حساب خودت ذخیره می‌شوند و شماره پیگیری دارند.</p></div></div></section>
  ${section('سوالات متداول')}
  ${faqs.map((f,i) => `<div class="faq-item"><button class="faq-question" data-action="faq" data-id="${i}"><span>${f[0]}</span><span class="chevron">⌄</span></button><div class="faq-answer">${f[1]}</div></div>`).join('')}
  ${section('ارسال پیام به پشتیبانی')}
  ${currentUser ? `<form id="supportForm" class="panel form-stack" style="padding:13px"><input class="form-control" name="subject" maxlength="70" minlength="3" placeholder="موضوع پیام" required><textarea class="form-control" name="message" rows="4" minlength="3" maxlength="1000" placeholder="پیام خودت رو بنویس..." required></textarea><button class="btn btn-primary btn-block" type="submit">ارسال پیام</button><small class="muted-note">پیام روی سرور ذخیره می‌شود.</small></form>` : '<div class="empty">برای ثبت و مشاهده تیکت‌ها ابتدا وارد حساب کاربری شو.</div>'}
  ${section('تیکت‌های من')}
  ${renderSupportTickets()}
  ${renderSupportThread()}
`;
}
function render() {
  const pages = {
    home:renderHome, games:renderGames,
    room5000:renderRoomPurchasePage, room10000:renderRoomPurchasePage, room20000:renderRoomPurchasePage, room50000:renderRoomPurchasePage,
    roomGame:renderRoomGame, tournaments:renderTournaments,
    tournamentRoom:() => renderTournamentDetail(false), bingoTournament:() => renderTournamentDetail(true),
    invite:renderInvite, wallet:renderWallet, walletAdmin:renderWalletAdmin, account:renderAccount, settings:renderSettings, support:renderSupport, supportAdmin:renderSupportAdmin
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
let rpsMoveBusy = false;
let ticMoveBusy = false;
let ticResetBusy = false;
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
  if ($('#homePoints')) $('#homePoints').textContent = money(state.points);
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
  } else if (rpsMatch.awaitingNext && lastRound) {
    body += `<button class="btn btn-primary btn-block" data-action="rps-next">رفتن به دور بعد</button>`;
  } else {
    body += `<p class="muted-note" style="text-align:center">دور ${faDigits(rpsMatch.round)} · اولین نفر با ۳ برد، قهرمان است.</p><div class="rps-options">${Object.entries(RPS_CHOICES).map(([key,item])=>`<button class="rps-choice" data-action="rps-play" data-choice="${key}" ${rpsMoveBusy?'disabled':''}><span>${item.emoji}</span><b>${item.label}</b></button>`).join('')}</div>`;
  }
  body += `<p class="muted-note" style="text-align:center">حریف تطبیقی فعال است · الگوهای قبلی انتخاب‌ها را بررسی می‌کند و برای جلوگیری از پیش‌بینی قطعی، گاهی تصادفی انتخاب می‌کند. سابقه ذخیره‌شده: ${faDigits(rpsMatch.history.length)} انتخاب.</p>`;
  openModal('✊ سنگ، کاغذ، قیچی · رقابت تا ۳ برد', body);
}
async function playRps(choice) {
  if (!rpsMatch || rpsMatch.finished || rpsMatch.awaitingNext || rpsMoveBusy || !RPS_CHOICES[choice]) return;
  rpsMoveBusy = true;
  renderRpsMatch(rpsMatch.last || null);
  try {
    const result=await apiRequest('/api/games/move',{method:'POST',body:JSON.stringify({matchId:rpsMatch.id,choice})});
    rpsMatch={...result.match,awaitingNext:!result.match.finished,last:result.lastRound||null};
    saveRpsPlayerChoice(choice);
    if(result.user) applyMiniGameUser(result.user);
    rpsMoveBusy = false;
    renderRpsMatch(result.lastRound||null);
  } catch(error) {
    rpsMoveBusy = false;
    renderRpsMatch(rpsMatch.last || null);
    showToast(error.message || 'ثبت حرکت ناموفق بود.');
  }
}
function nextRpsRound() {
  if (!rpsMatch || !rpsMatch.awaitingNext || rpsMatch.finished || rpsMoveBusy) return;
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
async function resetTicMatch() {
  if (ticResetBusy || ticMoveBusy) return;
  ticResetBusy = true;
  try {
    if (ticMatch?.id && !ticMatch.finished) {
      await apiRequest('/api/games/abandon',{method:'POST',body:JSON.stringify({matchId:ticMatch.id})});
    }
    const started=await apiRequest('/api/games/start',{method:'POST',body:JSON.stringify({gameType:'tic'})});
    ticMatch={...started.match};
    ticResetBusy = false;
    renderTicMatch();
  } catch(error) {
    ticResetBusy = false;
    renderTicMatch();
    showToast(error.message || 'شروع دوباره بازی دوز ممکن نشد.');
  }
}
function finishTicMatch(result) {
  if (!ticMatch || ticMatch.finished) return;
  ticMatch.finished=true; ticMatch.result=result;
  renderTicMatch();
}
function renderTicMatch() {
  if (!ticMatch) return;
  const cells=ticMatch.board.map((mark,index)=>`<button class="tic-cell ${mark==='X'?'tic-x':mark==='O'?'tic-o':''}" data-action="tic-move" data-index="${index}" ${mark||ticMatch.finished||ticMoveBusy||ticResetBusy?'disabled':''} aria-label="خانه ${faDigits(index+1)} ${mark?'علامت '+mark:'خالی'}">${mark==='X'?'×':mark==='O'?'○':''}</button>`).join('');
  let status = ticMatch.finished ? (ticMatch.result==='win'?'آفرین! تو برنده شدی.':ticMatch.result==='lose'?'حریف هوشمند برنده شد.':'بازی مساوی شد.') : 'نوبت توست؛ خانه‌ای را انتخاب کن.';
  let body=`<div class="mini-game-info-notice">حریف هوشمند · حرکت‌های برد فوری و دفاع‌های مهم را تشخیص می‌دهد، اما گاهی انتخاب متفاوتی دارد تا بازی قابل‌رقابت بماند.</div>
    <div class="tic-player-legend"><span class="tic-player-x"><b>×</b> تو · X</span><span class="tic-player-o"><b>○</b> رایانه · O</span></div>
    <div class="tic-status ${ticMatch.finished?'finished':''}" aria-live="polite">${status}</div>
    <div class="tic-board" role="group" aria-label="صفحه بازی دوز">${cells}</div>`;
  if (ticMatch.finished) {
    const cls=ticMatch.result==='win'?'win':ticMatch.result==='lose'?'lose':'draw';
    body+=`<div class="mini-game-final ${cls}"><strong>${ticMatch.result==='win'?'🏆 پیروزی!':ticMatch.result==='lose'?'حریف این دور را برد':'🤝 مساوی'}</strong><b>${ticMatch.result==='win'?'بازی را بردی.':'این مسابقه به پایان رسید.'}</b></div><button class="btn btn-primary btn-block" data-action="tic-start-again">بازی دوباره</button>`;
  } else {
    body+=`<p class="muted-note" style="text-align:center">سه علامت یکسان را در یک ردیف، ستون یا قطر قرار بده.</p><button class="btn btn-outline btn-block" data-action="tic-reset" ${ticResetBusy?'disabled':''}>شروع بازی تازه</button>`;
  }
  openModal('⭕ دوز حرفه‌ای · حریف هوشمند',body);
}
async function playTicMove(index) {
  if (!ticMatch || ticMatch.finished || ticMoveBusy || ticResetBusy ||
      ticMatch.board[index] || !Number.isInteger(index) || index<0 || index>8) return;
  ticMoveBusy = true;
  renderTicMatch();
  try {
    const result=await apiRequest('/api/games/move',{method:'POST',body:JSON.stringify({matchId:ticMatch.id,index})});
    ticMatch={...result.match};
    if(result.user) applyMiniGameUser(result.user);
    ticMoveBusy = false;
    renderTicMatch();
  } catch(error) {
    ticMoveBusy = false;
    renderTicMatch();
    showToast(error.message || 'ثبت حرکت دوز ناموفق بود.');
  }
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
  const tournamentTab = event.target.closest('[data-tournament-tab]');
  if (tournamentTab) {
    tournamentLobbyTab = tournamentTab.dataset.tournamentTab === 'mine' ? 'mine' : 'all';
    render();
    return;
  }
  const gameButton = event.target.closest('[data-game]');
  if (gameButton) { launchGame(gameButton.dataset.game); return; }
  const filter = event.target.closest('[data-game-filter]');
  if (filter) {
    document.querySelectorAll('[data-game-filter]').forEach(el => el.classList.toggle('active', el === filter));
    document.querySelectorAll('.game-list-item').forEach(el => el.hidden = filter.dataset.gameFilter !== 'all' && el.dataset.category !== filter.dataset.gameFilter);
    return;
  }
  const setting = event.target.closest('[data-setting]');
  if (setting) { event.preventDefault(); await toggleSetting(setting.dataset.setting); return; }
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  if(action==='wallet-open-deposit'||action==='wallet-open-withdraw'){
    if(!requireLogin())return;
    const type=action==='wallet-open-withdraw'?'withdraw':'deposit';
    const option=document.querySelector('#walletRequestForm input[name="type"][value="'+type+'"]');
    if(option){option.checked=true;updateWalletRequestType(type);}
    document.getElementById('walletRequestForm')?.scrollIntoView({behavior:'smooth',block:'center'});
    document.getElementById('walletRequestAmount')?.focus({preventScroll:true});
    return;
  }
  if(action==='wallet-upload-receipt'){
    if(!requireLogin())return;
    try{await showWalletPaymentInstructions(Number(actionEl.dataset.requestId));}
    catch(error){showToast(error.message);}
    return;
  }
  if(action==='wallet-copy-card'){
    const card=String(walletActivePaymentInfo?.cardNumber||state.walletPaymentInfo?.cardNumber||'');
    if(card){try{await navigator.clipboard.writeText(card);showToast('شماره کارت کپی شد.');}catch(_){showToast('کپی خودکار انجام نشد؛ شماره کارت را انتخاب و کپی کن.');}}
    return;
  }
  if(action==='wallet-cancel-request'){
    const requestId=Number(actionEl.dataset.requestId);
    if(!window.confirm('درخواست برداشت لغو و مبلغ به موجودی کیف پول برگردانده شود؟'))return;
    try{await apiRequest('/api/wallet/requests/'+requestId+'/cancel',{method:'POST',body:JSON.stringify({})});await refreshWalletData();render();showToast('درخواست لغو شد و مبلغ به کیف پول برگشت.');}
    catch(error){showToast(error.message);}
    return;
  }
  if(action==='wallet-admin-filter'){walletAdminFilter=actionEl.dataset.filter||'all';render();return;}
  if(action==='wallet-admin-open-request'){
    if(!requireLogin())return;
    try{
     walletAdminSelectedRequest=await apiRequest('/api/admin/wallet/'+Number(actionEl.dataset.requestId),{method:'GET',headers:{}});
     setPage('walletAdmin',{scroll:false});
    }catch(error){showToast(error.message);}
    return;
  }
  if(action==='wallet-admin-decision'){
    const requestId=Number(actionEl.dataset.requestId),decision=actionEl.dataset.decision;
    const confirmText=decision==='approve'?'واریز تأیید و موجودی کاربر شارژ شود؟':decision==='paid'?'پرداخت برداشت انجام‌شده ثبت شود؟':'درخواست رد شود؟'+(walletAdminSelectedRequest?.request?.request_type==='withdraw'?' مبلغ به کیف پول کاربر برگردد؟':'');
    if(!window.confirm(confirmText))return;
    try{await apiRequest('/api/admin/wallet/'+requestId+'/decision',{method:'POST',body:JSON.stringify({decision,note:''})});await refreshWalletAdmin();await refreshWalletData();render();showToast(decision==='approve'?'واریز تأیید و کیف پول شارژ شد.':decision==='paid'?'پرداخت برداشت ثبت شد.':'درخواست رد شد.');}
    catch(error){showToast(error.message);}
    return;
  }
  if(action==='wallet-admin-pick-user'){
    walletAdminSelectedMemberId=String(actionEl.dataset.memberId||'');
    render();
    return;
  }
  if(action==='support-open-ticket'||action==='support-admin-open-ticket'){
    if(!requireLogin())return;
    supportSelectedTicketId=Number(actionEl.dataset.ticketId);
    try{supportThread=await apiRequest((action==='support-admin-open-ticket'?'/api/admin/support/':'/api/tickets/')+supportSelectedTicketId,{method:'GET',headers:{}});if(action==='support-admin-open-ticket')setPage('supportAdmin');else render();}
    catch(error){showToast(error.message);}return;
  }
  if(action==='support-close-thread'){supportThread=null;supportSelectedTicketId=null;render();return;}
  if(action==='support-admin-filter'){supportAdminFilter=actionEl.dataset.filter||'all';render();return;}
  if(action==='support-admin-status'){
    try{await apiRequest('/api/admin/support/'+supportSelectedTicketId+'/status',{method:'PATCH',body:JSON.stringify({status:actionEl.dataset.status})});await refreshSupportAdmin();render();showToast('وضعیت تیکت به‌روزرسانی شد.');}
    catch(error){showToast(error.message);}return;
  }
  if (action === 'close-modal' || (action === 'backdrop-close' && event.target === actionEl)) { closeModal(); return; }
  if (action === 'room-next-session') {
    if (!requireLogin() || roomJoinBusy || actionEl.disabled) return;
    roomJoinBusy = true;
    actionEl.disabled = true;
    try {
      const result = await apiRequest(`/api/rooms/${activeRoomId}/next`, {
        method:'POST',
        body:JSON.stringify({})
      });
      roomServerSnapshot = result.room;
      roomCards = Array.isArray(result.room.myCards) ? result.room.myCards : [];
      roomAllCards = Array.isArray(result.room.allPlayerCards) ? result.room.allPlayerCards : [];
      roomCalledNumbers = Array.isArray(result.room.allCalledNumbers) ? result.room.allCalledNumbers : [];
      roomStages = {one:false,full:false};
      roomCardCount = Math.max(1, Math.min(MAX_ROOM_CARDS_PER_PLAYER, Number(roomCardCount) || 1));
      render();
      showToast('سانس جدید آماده شد؛ هنوز هیچ کارتی خریداری نشده و مبلغی از کیف پول کم نشده است.');
    } catch(error) { showToast(error.message); }
    finally { roomJoinBusy = false; if (actionEl.isConnected) actionEl.disabled = false; }
    return;
  }
  if (action === 'room-join-auto' || action === 'room-join-next') {
    if(!requireLogin() || roomJoinBusy || actionEl.disabled) return;
    roomJoinBusy = true;
    actionEl.disabled = true;
    unlockPersianAudio();
    const requestedCardCount = action === 'room-join-next' ? 1 : Math.max(1, Math.min(MAX_ROOM_CARDS_PER_PLAYER, Number(roomCardCount) || 1));
    const purchaseAttempt = getRoomPurchaseAttempt(activeRoomId, requestedCardCount);
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await apiRequest(`/api/rooms/${activeRoomId}/join`, {
            method:'POST',
            headers:{'Idempotency-Key':purchaseAttempt.key},
            body:JSON.stringify({cardsCount:requestedCardCount,purchaseConfirmed:true})
          });
          break;
        } catch (error) {
          const temporaryLock = error.message.includes('اتاق در حال به‌روزرسانی است');
          if (!temporaryLock || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      purchaseAttempt.clear();
      roomServerSnapshot = result.room;
      roomCards = Array.isArray(result.room.myCards) ? result.room.myCards : [];
      roomAllCards = Array.isArray(result.room.allPlayerCards) ? result.room.allPlayerCards : [];
      roomCardCount = roomCards.length || requestedCardCount;
      if (result.room.status === 'playing' && result.room.joined) {
        activeRoomId = result.room.id;
        roomCalledNumbers = result.room.allCalledNumbers || [];
        currentPage = 'roomGame';
      }
      await loadAuthenticatedUser();
      if (result.room.status === 'playing' && !result.room.joined) {
        showToast('ثبت‌نام سانس بعدی ثبت شد؛ پس از پایان بازی جاری نوبت آن می‌رسد.');
      } else if (result.room.status === 'playing') {
        showToast('کارت‌های سانس بعدی ثبت شد؛ بازی فعلی ادامه دارد.');
      } else {
        showToast('کارت‌ها خریداری شدند؛ مهلت ۲:۳۰ دقیقه‌ای از اولین خرید این سانس محاسبه می‌شود.');
      }
      render();
    } catch(error) {
      // Keep the same idempotency key on ambiguous network/server failures.
      showToast(error.message);
    } finally {
      roomJoinBusy = false;
      if (actionEl.isConnected) actionEl.disabled = false;
    }
    return;
  }
  if (action === 'room-add-card') {
    if(!requireLogin() || roomJoinBusy || actionEl.disabled) return;
    roomJoinBusy = true;
    unlockPersianAudio();
    actionEl.disabled = true;
    const purchaseAttempt = getRoomPurchaseAttempt(activeRoomId, 1);
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await apiRequest(`/api/rooms/${activeRoomId}/join`, {
            method:'POST',
            headers:{'Idempotency-Key':purchaseAttempt.key},
            body:JSON.stringify({cardsCount:1,purchaseConfirmed:true})
          });
          break;
        } catch(error) {
          const temporaryLock = error.message.includes('اتاق در حال به‌روزرسانی است');
          if (!temporaryLock || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      purchaseAttempt.clear();
      roomServerSnapshot = result.room;
      roomCards = Array.isArray(result.room.myCards) ? result.room.myCards : [];
      roomAllCards = Array.isArray(result.room.allPlayerCards) ? result.room.allPlayerCards : [];
      roomCardCount = roomCards.length || roomCardCount;
      if (result.room.status === 'playing' && result.room.joined) {
        activeRoomId = result.room.id;
        roomCalledNumbers = result.room.allCalledNumbers || [];
        currentPage = 'roomGame';
      }
      await loadAuthenticatedUser();
      showToast(result.room.status === 'playing' && !result.room.joined
        ? 'یک کارت برای سانس بعدی خریداری شد.'
        : result.room.status === 'playing'
          ? 'کارت سانس بعدی ثبت شد؛ بازی جاری ادامه دارد.'
          : 'یک کارت جدید خریداری و به کارت‌های تو اضافه شد.');
      render();
    } catch(error) {
      showToast(error.message);
    } finally {
      roomJoinBusy = false;
      if (actionEl.isConnected) actionEl.disabled = false;
    }
    return;
  }
  if (action === 'room-open-game') { unlockPersianAudio(); if(roomServerSnapshot?.status==='playing'){setPage('roomGame');} else showToast('این سانس هنوز شروع نشده است.'); return; }
  if (action === 'room-back-lobby') { roomCards=[]; roomAllCards=[]; roomCardCount=1; roomServerSnapshot=null; roomCalledNumbers=[]; roomStages={one:false,full:false}; setPage('games'); return; }
  if (action === 'copy-ref') {
    try { await navigator.clipboard.writeText(state.referralCode); showToast('کد دعوت کپی شد'); }
    catch (_) { const input = $('#refCode'); input?.select(); showToast('کد دعوت را به‌صورت دستی کپی کن'); }
  } else if (action === 'share-ref') {
    const inviteUrl = new URL(location.href); inviteUrl.searchParams.set('ref', state.referralCode); const shareData = { title:'دعوت به دابرناز', text:`با کد ${state.referralCode} به دابرناز بیا!`, url:inviteUrl.toString() };
    if (navigator.share) { try { await navigator.share(shareData); } catch (_) {} }
    else { try { await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`); showToast('متن دعوت کپی شد'); } catch (_) { showToast('اشتراک‌گذاری در این مرورگر پشتیبانی نمی‌شود'); } }
  } else if (action === 'demo-credit') {
    showToast('برای شارژ واقعی، اتصال درگاه پرداخت لازم است.');
  } else if (action === 'wallet-info') setPage('wallet');
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
  else if (action === 'tic-start' || action === 'tic-start-again') startTicMatch();
  else if (action === 'tic-reset') resetTicMatch();
  else if (action === 'tic-move') playTicMove(Number(actionEl.dataset.index));
  else if (action === 'room-increase') { if (roomCardCount < MAX_ROOM_CARDS_PER_PLAYER) { roomCardCount++; updateRoomCardDisplay(); } else showToast('حداکثر ۵ کارت برای هر حساب در هر سانس مجاز است.'); }
  else if (action === 'room-decrease') { if (roomCardCount > 1) { roomCardCount--; updateRoomCardDisplay(); } }
  else if (action === 'room-show-rules') showRoomQuickRules();
  else if (action === 'call-bingo') callBingo();
  else if (action === 'mark-bingo') markBingo(Number(actionEl.dataset.num));
  else if (action === 'memory-card') revealMemory(actionEl);
  else if (action === 'edit-profile') editProfile();
  else if (action === 'settings') setPage('settings');
  else if (action === 'security') openModal('امنیت حساب', `<div class="form-stack"><p class="muted-note">در نسخه Cloudflare رمز عبور با PBKDF2-HMAC-SHA256، ۶۰۰٬۰۰۰ تکرار و salt اختصاصی هش می‌شود. رمز خام ذخیره نمی‌شود.</p><p class="muted-note">نشست ورود با کوکی HttpOnly نگهداری می‌شود، روی HTTPS ویژگی Secure دارد و پس از ۳۰ روز منقضی می‌شود. سیاست SameSite با توجه به نوع استقرار تنظیم می‌شود.</p><p class="muted-note">تأیید ایمیل و بازیابی رمز عبور هنوز به سرویس ارسال ایمیل نیاز دارد و در این نسخه فعال نیست.</p></div>`);
  else if (action === 'achievements') showToast(`تعداد بردهای ثبت‌شده: ${state.wins}`);
  else if (action === 'logout') { try { await apiRequest('/api/auth/logout',{method:'POST',body:'{}'}); currentUser=null; walletActivePaymentInfo=null; state=cloneData(defaultState); roomServerSnapshot=null; saveState(); closeModal(); setPage('home'); showToast('با موفقیت از حساب خارج شدی.'); } catch(error){showToast(error.message);} }
  else if (action === 'logout-all') { try { await apiRequest('/api/auth/logout-all',{method:'POST',body:'{}'}); currentUser=null; walletActivePaymentInfo=null; state=cloneData(defaultState); roomServerSnapshot=null; saveState(); closeModal(); setPage('home'); showToast('تمام نشست‌های فعال حساب باطل شدند.'); } catch(error){showToast(error.message);} }
  else if (action === 'test-number-voice') {
    voicePlaybackErrorShown = false;
    const ok = await PersianAudioManager.speak(42, { fromGesture: true });
    if (ok) {
      state.settings.voiceNumbers = true;
      saveState();
      showToast(voicePackReady ? 'نمونه با صدای Sage Woman پخش شد.' : 'تست صدای فارسی با موفقیت پخش شد.');
    }
    renderSettingsIntoView();
  }
  else if (action === 'enable-room-audio') {
    voicePlaybackErrorShown = false;
    state.settings.voiceNumbers = true;
    saveState();
    const latest = Number(roomServerSnapshot?.latestNumber);
    const sample = latest >= 1 && latest <= 90 ? latest : 42;
    const ok = await PersianAudioManager.speak(sample, { fromGesture: true });
    if (ok) {
      showToast(latest >= 1 && latest <= 90
        ? 'صدای فارسی فعال شد و شمارهٔ فعلی دوباره پخش شد.'
        : 'صدای فارسی فعال شد؛ نمونه پخش شد و شماره‌های بعدی اعلام می‌شوند.');
    }
  }

  else if (action === 'test-notification') {
    if (!settingEnabled('notifications')) { showToast('ابتدا اعلان‌های دستگاه را فعال کن.'); return; }
    if (!('Notification' in window) || Notification.permission !== 'granted') { showToast('اجازه اعلان در دسترس نیست.'); return; }
    try {
      const options = { body:'اعلان آزمایشی با موفقیت فعال است.', tag:'dabernaz-test-notification' };
      const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready.catch(() => null) : null;
      if (registration && typeof registration.showNotification === 'function') await registration.showNotification('دابرناز', options);
      else new Notification('دابرناز', options);
      showToast('اعلان آزمایشی ارسال شد.');
    } catch (_) { showToast('نمایش اعلان در این مرورگر ممکن نشد.'); }
  }
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
function updateWalletRequestType(type){
 const form=document.getElementById('walletRequestForm');
 if(!form)return;
 const withdraw=type==='withdraw';
 const amount=form.querySelector('[name="amount"]');
 const fields=document.getElementById('walletWithdrawFields');
 const card=form.querySelector('[name="cardNumber"]');
 const holder=form.querySelector('[name="cardHolder"]');
 const minHelp=document.getElementById('walletRequestMinHelp');
 const rule=document.getElementById('walletRequestRuleText');
 const submit=document.getElementById('walletRequestSubmit');
 if(fields)fields.hidden=!withdraw;
 if(amount){amount.min=withdraw?'205':'105';amount.placeholder=withdraw?'مبلغ برداشت را به تومان وارد کن':'مبلغ واریز را به تومان وارد کن';}
 if(card)card.required=withdraw;
 if(holder)holder.required=withdraw;
 if(minHelp)minHelp.textContent=withdraw?'حداقل برداشت: ۲۰۵ تومان · حداکثر: ۵۰ میلیون تومان':'حداقل واریز: ۱۰۵ تومان · حداکثر: ۵۰ میلیون تومان';
 if(rule)rule.textContent=withdraw?'مبلغ برداشت پس از ثبت از موجودی رزرو می‌شود. شماره کارت و نام صاحب کارت باید دقیق باشد؛ در صورت رد درخواست، مبلغ به کیف پول برمی‌گردد.':'پس از ثبت واریز، اطلاعات کارت مقصد فقط برای همین حساب و همین درخواست نمایش داده می‌شود. رسید را برای بررسی مدیریت ارسال کن.';
 if(submit)submit.textContent=withdraw?'ثبت درخواست برداشت':'ثبت درخواست واریز';
}
document.addEventListener('input', event => {
  if (event.target.closest?.('#walletRequestForm')) clearWalletRequestIdempotencyKey();
});
document.addEventListener('change',event=>{
 if(event.target.matches('#walletRequestForm input[name="type"]')) {
   clearWalletRequestIdempotencyKey();
   updateWalletRequestType(event.target.value);
 }
});
document.addEventListener('submit', async event => {

  if(event.target.id==='walletRequestForm'){
    event.preventDefault();
    const data=new FormData(event.target);
    const type=String(data.get('type')||'');
    const amount=Number(data.get('amount'));
    const payload={type,amount,userNote:String(data.get('userNote')||'').trim()};
    if(type==='withdraw'){
      payload.cardNumber=String(data.get('cardNumber')||'');
      payload.cardHolder=String(data.get('cardHolder')||'').trim();
      payload.bankName=String(data.get('bankName')||'').trim();
    }
    const button=event.target.querySelector('button[type=submit]');if(button)button.disabled=true;
    try{
      const idempotencyKey = getWalletRequestIdempotencyKey();
      const result=await apiRequest('/api/wallet/requests',{
        method:'POST',
        headers:{'Idempotency-Key':idempotencyKey},
        body:JSON.stringify(payload)
      });
      clearWalletRequestIdempotencyKey();
      await refreshWalletData();
      render();
      if(type==='deposit'){
        showToast('درخواست واریز ثبت شد؛ اطلاعات پرداخت مخصوص همین درخواست آماده است.');
        await showWalletPaymentInstructions(result.requestId);
      }else{
        showToast('درخواست برداشت ثبت شد؛ مبلغ از موجودی قابل برداشت رزرو شد.');
      }
    }catch(error){showToast(error.message);}
    finally{if(button?.isConnected)button.disabled=false;}
  }
  if(event.target.id==='walletReceiptForm'){
    event.preventDefault();
    const file=new FormData(event.target).get('receipt');
    if(!(file instanceof File)||!file.size){showToast('ابتدا تصویر رسید را انتخاب کن.');return;}
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){showToast('فقط تصویر PNG، JPG یا WebP پذیرفته می‌شود.');return;}
    if(file.size>512*1024){showToast('حجم تصویر رسید باید حداکثر ۵۱۲ کیلوبایت باشد.');return;}
    const button=event.target.querySelector('button[type=submit]');if(button)button.disabled=true;
    try{
      const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('خواندن فایل رسید ناموفق بود.'));reader.readAsDataURL(file);});
      await apiRequest('/api/wallet/requests/'+Number(event.target.dataset.requestId)+'/receipt',{method:'POST',body:JSON.stringify({dataUrl})});
      await refreshWalletData();closeModal();render();showToast('رسید ارسال شد و درخواست در صف بررسی مدیر قرار گرفت.');
    }catch(error){showToast(error.message);}
    finally{if(button?.isConnected)button.disabled=false;}
  }
  if(event.target.id==='walletAdminSettingsForm'){
    event.preventDefault();
    const data=new FormData(event.target);
    const payload={cardNumber:String(data.get('cardNumber')||'').replace(/[۰-۹]/g,digit=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g,digit=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/\D/g,''),cardHolder:String(data.get('cardHolder')||'').trim(),bankName:String(data.get('bankName')||'').trim(),paymentNote:String(data.get('paymentNote')||'').trim()};
    const button=event.target.querySelector('button[type=submit]');if(button)button.disabled=true;
    try{const result=await apiRequest('/api/admin/wallet/settings',{method:'POST',body:JSON.stringify(payload)});state.walletPaymentInfo=result.settings||payload;await refreshWalletAdmin();render();showToast('اطلاعات کارت مقصد ذخیره شد.');}
    catch(error){showToast(error.message);}
    finally{if(button?.isConnected)button.disabled=false;}
  }
  if(event.target.id==='walletAdminSearchForm'){
    event.preventDefault();
    const query=String(new FormData(event.target).get('query')||'').trim();
    try{const result=await apiRequest('/api/admin/wallet/users?q='+encodeURIComponent(query),{method:'GET',headers:{}});walletAdminUsers=Array.isArray(result.users)?result.users:[];render();if(!walletAdminUsers.length)showToast('کاربری با این عبارت پیدا نشد.');}
    catch(error){showToast(error.message);}
  }
  if(event.target.id==='walletAdminAdjustForm'){
    event.preventDefault();
    const data=new FormData(event.target);
    const payload={memberId:String(data.get('memberId')||'').trim(),amount:Number(data.get('amount')),reason:String(data.get('reason')||'').trim()};
    const attempt=getAdminAdjustmentAttempt(payload);
    const button=event.target.querySelector('button[type=submit]');if(button)button.disabled=true;
    try{const result=await apiRequest('/api/admin/wallet/adjust',{method:'POST',headers:{'Idempotency-Key':attempt.key},body:JSON.stringify(payload)});attempt.clear();await refreshWalletAdmin();await refreshWalletData();walletAdminSelectedMemberId=String(result.user?.member_id||payload.memberId);walletAdminUsers=[result.user,...walletAdminUsers.filter(u=>String(u.member_id)!==String(result.user?.member_id))].filter(Boolean);render();showToast((result.replayed?'درخواست قبلی تأیید شد. ':'')+'موجودی '+escapeHTML(result.user?.username||'کاربر')+' به اندازه '+money(payload.amount)+' تومان اصلاح شد.');}
    catch(error){showToast(error.message);}
    finally{if(button?.isConnected)button.disabled=false;}
  }

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
  if(event.target.id==='supportReplyForm'||event.target.id==='supportAdminReplyForm'){
    event.preventDefault();const admin=event.target.id==='supportAdminReplyForm',message=String(new FormData(event.target).get('message')||'').trim();
    if(!message||!supportSelectedTicketId)return;
    const button=event.target.querySelector('button[type=submit]');if(button)button.disabled=true;
    try{await apiRequest(admin?'/api/admin/support/'+supportSelectedTicketId+'/reply':'/api/tickets/'+supportSelectedTicketId,{method:'POST',body:JSON.stringify({message})});
      if(admin)await refreshSupportAdmin();else{supportThread=await apiRequest('/api/tickets/'+supportSelectedTicketId,{method:'GET',headers:{}});const rows=await apiRequest('/api/tickets',{method:'GET',headers:{}});state.supportTickets=rows.tickets||[];}
      render();showToast('پیام با موفقیت ارسال شد.');
    }catch(error){showToast(error.message);}finally{if(button?.isConnected)button.disabled=false;}
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

currentPage = pageFromLocation();
render();
loadAuthenticatedUser();
checkPersianVoicePack(); refreshPersianBrowserVoices();
// Refresh the authenticated account and the active room when a mobile browser/WebView
// returns to the foreground. Background tabs can throttle timers, so rely on an
// immediate authoritative read when visibility or focus returns.
let foregroundRefreshBusy = false;
async function refreshAppAfterForeground() {
  if (document.hidden || foregroundRefreshBusy) return;
  foregroundRefreshBusy = true;
  try {
    if (currentUser) await loadAuthenticatedUser();
    if (currentUser && (ROOM_CONFIGS.some(room=>room.id===currentPage) || currentPage==='roomGame')) {
      pollCurrentRoom();
    } else if (['tournaments','tournamentRoom','bingoTournament'].includes(currentPage)) {
      refreshTournamentData();
    }
  } finally {
    foregroundRefreshBusy = false;
  }
}
document.addEventListener('visibilitychange', refreshAppAfterForeground);
window.addEventListener('focus', refreshAppAfterForeground);
window.addEventListener('online', () => {
  loadAuthenticatedUser().then(() => {
    if (currentUser && (ROOM_CONFIGS.some(room=>room.id===currentPage) || currentPage==='roomGame')) pollCurrentRoom();
  });
});
setInterval(() => {
  if (!document.hidden && navigator.onLine !== false && currentUser &&
      (ROOM_CONFIGS.some(room=>room.id===currentPage) || currentPage==='roomGame')) pollCurrentRoom();
}, 2200);
setInterval(async()=>{
  if (!currentUser || document.hidden || navigator.onLine === false) return;
  if(currentPage==='supportAdmin'&&supportAdminEnabled){
    try{await refreshSupportAdmin();const composing=document.activeElement?.closest('#supportAdminReplyForm');if(!composing)render();}catch(_){}
  }else if(currentPage==='support'){
    try{
      const list=await apiRequest('/api/tickets',{method:'GET',headers:{}});
      state.supportTickets=Array.isArray(list.tickets)?list.tickets:[];
      if(supportSelectedTicketId)supportThread=await apiRequest('/api/tickets/'+supportSelectedTicketId,{method:'GET',headers:{}});
      const composing=document.activeElement?.closest('#supportForm,#supportReplyForm');if(!composing)render();
    }catch(_){}
  }else if(currentPage==='wallet'){
    try{await refreshWalletData();const composing=document.activeElement?.closest('#walletRequestForm,#walletReceiptForm');if(!composing)render();}catch(_){}
  }else if(currentPage==='walletAdmin'&&walletAdminEnabled){
    try{await refreshWalletAdmin();const composing=document.activeElement?.closest('#walletAdminSettingsForm,#walletAdminSearchForm,#walletAdminAdjustForm');if(!composing)render();}catch(_){}
  }
},15000);

window.addEventListener('hashchange', () => {
  const page = pageFromLocation();
  if (page !== currentPage || (page === 'roomGame' && currentPage === 'roomGame')) setPage(page, { sync:false, scroll:false });
});
