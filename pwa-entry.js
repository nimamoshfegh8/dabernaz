'use strict';

(() => {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const androidWebView = /Android/i.test(window.navigator.userAgent) && /\bwv\b/i.test(window.navigator.userAgent);
  if (standalone || androidWebView || document.querySelector('.pwa-install-entry')) return;

  const link = document.createElement('a');
  link.className = 'pwa-install-entry';
  link.href = './install.html';
  link.setAttribute('aria-label', 'نصب برنامه دابرناز');
  link.innerHTML = '<span class="pwa-install-entry-icon" aria-hidden="true">↓</span><span>نصب برنامه</span>';

  // Place the install action directly after the sticky header, not over page content.
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.insertAdjacentElement('afterend', link);
  else document.body.prepend(link);
})();
