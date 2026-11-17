# ممیزی Playwright دابرناز

این سند دو اجرای جداگانه را توصیف می‌کند: مرورگر Chromium روی نسخه محلی ایزوله و مرورگر Chromium روی Preview واقعی Cloudflare Pages.

## مرز ایمنی

- شاخه هدف فقط `test/playwright-audit` است.
- اجرای محلی از Node fallback در حالت تست و پوشه داده موقت استفاده می‌کند.
- اجرای Preview مستقیماً آدرس `https://test-playwright-audit.dabernaz.pages.dev` را باز می‌کند.
- در هر دو اجرا، درخواست‌های هم‌مبدأ با روش‌هایی غیر از `GET`، `HEAD` و `OPTIONS` پیش از ارسال به سرور مسدود می‌شوند.
- هیچ ثبت‌نام، ورود، خرید کارت، ثبت‌نام تورنومنت، تغییر کیف پول یا عملیات مدیریتی توسط این ممیزی مرورگر انجام نمی‌شود.
- این آزمون مرورگر، جایگزین تست اتمیک D1/Worker، احراز هویت چندکاربره یا آزمون مالی نیست.

## پوشش رابط کاربری

- صفحه اصلی در عرض‌های 320، 360، 375، 390، 430، 768، 1024، 1366 و 1920 پیکسل.
- اندازه‌های موبایل افقی 844x390 و 932x430.
- شبیه‌سازی حالت روشن و تاریک.
- بررسی RTL، متادیتای فارسی، landmark اصلی و منوی پایین.
- 15 مسیر عمومی SPA شامل صفحه خانه، لابی بازی، چهار اتاق قیمتی، نمای بازی اتاق، صفحات تورنومنت، دعوت، کیف پول، حساب، تنظیمات و پشتیبانی.
- تغییر مسیر با منوی پایین، محل ورودی PWA و هندسه ناوبری در موبایل افقی.
- جمع‌آوری خطاهای JavaScript، درخواست‌های ناموفق، HTTP errorها، overflow افقی، اندازه متن و اهداف لمسی کوچک، و تلاش برای درخواست نوشتنی.

اندازه‌های متن و دکمه‌ها فقط شاخص تشخیصی هستند و گواهی انطباق WCAG محسوب نمی‌شوند. اسکرین‌شات، وضعیت رندرشده را ثابت می‌کند نه صحت همه مسیرهای Backend را.

## بررسی سلامت Preview

تست `API health` پاسخ `/api/health` را ذخیره و بررسی می‌کند. در Pages، سلامت D1 به‌تنهایی به معنی آماده‌بودن موتور اتاق نیست؛ پاسخ باید وضعیت Schema و وجود یا نبود Binding با نام `ROOM_COORDINATOR` را جداگانه نشان دهد. نبود Worker/Binding باید `readiness=degraded` و قابلیت غیرفعال اتاق پولی را نشان دهد.

## اجرای محلی

با Node.js 22 یا جدیدتر:

```bash
mkdir -p /tmp/dabernaz-playwright-data
NODE_ENV=test COOKIE_SECURE=false HOST=127.0.0.1 PORT=8788 \
  DABERNAZ_DATA_DIR=/tmp/dabernaz-playwright-data node server.js
```

در ترمینال دوم:

```bash
npm install --no-save --package-lock=false @playwright/test@1.65.1
npx playwright install chromium
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8788 npx playwright test --config=playwright.config.js
```

برای اجرای همین مجموعه روی Preview:

```bash
PLAYWRIGHT_BASE_URL=https://test-playwright-audit.dabernaz.pages.dev \
  npx playwright test --config=playwright.config.js
```

در اجرای Preview نیز همه درخواست‌های نوشتنی هم‌مبدأ مسدود می‌شوند.

## خروجی

- `playwright-report/`: گزارش HTML.
- `test-results/`: اسکرین‌شات‌ها، Trace هنگام شکست و پیوست‌های تشخیصی از جمله وضعیت Health API.

GitHub Actions این خروجی‌ها را به‌صورت Artifact به مدت 14 روز نگه می‌دارد.

## محدودیت‌های شناخته‌شده

این مجموعه صفحات عمومی و رندر رابط کاربری را بررسی می‌کند. فرم‌های احراز هویت، ورود به حساب، پرداخت، تورنومنت و خرید اتاق را عمداً ارسال نمی‌کند. برای آن‌ها باید Integration Test جداگانه با حساب‌های ساختگی مستقل، D1 محلی/Preview و Worker ایزوله اجرا شود. موفقیت این Workflow به‌تنهایی به معنی آماده‌بودن نسخه برای پول واقعی یا انتشار عمومی نیست.
