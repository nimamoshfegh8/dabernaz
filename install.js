'use strict';

(() => {
  const status = document.getElementById('pwaStatus');
  const installButton = document.getElementById('pwaInstallButton');
  const alreadyInstalled = document.getElementById('pwaAlreadyInstalled');
  const androidInstructions = document.getElementById('androidInstructions');
  const iosInstructions = document.getElementById('iosInstructions');
  let deferredPrompt = null;

  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);

  if (isStandalone()) {
    if (status) status.hidden = true;
    if (alreadyInstalled) alreadyInstalled.hidden = false;
  } else if (isIos()) {
    if (status) status.textContent = 'برای نصب روی iPhone یا iPad، مراحل زیر را در مرورگر Safari انجام بده.';
    if (iosInstructions) iosInstructions.hidden = false;
  } else {
    const isAndroid = /android/i.test(window.navigator.userAgent);
    if (status) status.textContent = isAndroid
      ? 'در منوی مرورگر Chrome گزینهٔ Install app یا Add to Home Screen را انتخاب کن. در مرورگرهای سازگار، دکمهٔ نصب مستقیم نیز فعال می‌شود.'
      : 'در رایانه، از منوی مرورگر گزینهٔ Install Dabernaz یا Install app را انتخاب کن. در مرورگرهای سازگار، دکمهٔ نصب مستقیم نیز فعال می‌شود.';
    if (androidInstructions) androidInstructions.hidden = !isAndroid;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    if (status) status.textContent = 'این مرورگر از نصب مستقیم وب‌اپ پشتیبانی می‌کند.';
    if (androidInstructions) androidInstructions.hidden = true;
    if (installButton) installButton.hidden = false;
  });

  installButton?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    installButton.disabled = true;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice?.outcome === 'accepted') {
        if (status) status.textContent = 'درخواست نصب پذیرفته شد. آیکن Dabernaz را در صفحهٔ اصلی یا فهرست برنامه‌ها پیدا کن.';
        installButton.hidden = true;
      } else if (status) {
        status.textContent = 'نصب انجام نشد. هر زمان خواستی از منوی مرورگر گزینهٔ Install app را انتخاب کن.';
      }
    } catch (_) {
      if (status) status.textContent = 'نصب مستقیم در دسترس نیست؛ از منوی مرورگر گزینهٔ Install app یا Add to Home Screen را انتخاب کن.';
    } finally {
      deferredPrompt = null;
      installButton.disabled = false;
    }
  });

  window.addEventListener('appinstalled', () => {
    if (status) status.hidden = true;
    if (installButton) installButton.hidden = true;
    if (alreadyInstalled) alreadyInstalled.hidden = false;
  });

  const apkStatus = document.getElementById('apkStatus');
  const apkButton = document.getElementById('apkDownloadButton');
  const releasesLink = document.getElementById('apkReleasesLink');
  const apiUrl = 'https://api.github.com/repos/nimamoshfegh8/dabernaz/releases/latest';
  fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
    .then(response => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Release lookup returned ' + response.status);
      return response.json();
    })
    .then(release => {
      if (!release) {
        if (apkStatus) apkStatus.textContent = 'هنوز نسخهٔ APK امضاشده منتشر نشده است. تا آماده‌شدن انتشار رسمی، وب‌اپ بالا قابل نصب و استفاده است.';
        return;
      }
      const apk = Array.isArray(release.assets)
        ? release.assets.find(asset => asset?.name === 'Dabernaz.apk' && typeof asset.browser_download_url === 'string')
        : null;
      if (!apk || !apk.browser_download_url.startsWith('https://github.com/nimamoshfegh8/dabernaz/releases/download/')) {
        if (apkStatus) apkStatus.textContent = 'هنوز نسخهٔ APK امضاشده منتشر نشده است. تا آماده‌شدن انتشار رسمی، وب‌اپ بالا قابل نصب و استفاده است.';
        return;
      }
      if (apkButton) {
        apkButton.href = './download/Dabernaz.apk';
        apkButton.hidden = false;
      }
      if (apkStatus) apkStatus.textContent = 'آخرین نسخهٔ رسمی آمادهٔ دریافت است: ' + (release.name || release.tag_name || 'Dabernaz');
      if (releasesLink) releasesLink.hidden = true;
    })
    .catch(() => {
      if (apkStatus) apkStatus.textContent = 'اکنون امکان بررسی نسخهٔ APK وجود ندارد. برای مشاهدهٔ انتشارهای رسمی از لینک GitHub استفاده کن.';
    });
})();
