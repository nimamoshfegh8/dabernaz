# انتشار اندروید دابرناز بدون Play Store

نسخهٔ وب‌اپ از مسیر /install.html نصب می‌شود و برای APK از GitHub Releases استفاده می‌کنیم. لینک دانلود در صفحهٔ نصب فقط وقتی فعال می‌شود که یک Release رسمی شامل فایل Dabernaz.apk پیدا شود.

## ساخت کلید امضای ثابت (فقط یک‌بار)

هر نسخهٔ APK با شناسهٔ app.dabernaz.club باید با همان کلید خصوصی امضا شود؛ در غیر این صورت اندروید آن را به‌عنوان به‌روزرسانی نمی‌پذیرد. فایل کلید را در مخزن یا داخل کد قرار ندهید و یک نسخهٔ پشتیبان آفلاین امن نگه دارید.

در Termux ابتدا با دستور pkg search openjdk نسخهٔ در دسترس Java را پیدا و نصب کن؛ سپس keytool باید در ترمینال قابل اجرا باشد. این دستور یک کلید PKCS12 می‌سازد:

    keytool -genkeypair -v -keystore "$HOME/dabernaz-release.p12" -storetype PKCS12 -alias dabernaz -keyalg RSA -keysize 4096 -validity 10000

هنگام پرسش رمز کلید، همان رمز مخزن را دوباره وارد کن یا در صورت درخواست keytool از رمز یکسان استفاده کن. رمزها را در اختیار دیگران قرار نده.

برای تبدیل کلید به Base64 در Termux:

    pkg install coreutils
    base64 -w0 "$HOME/dabernaz-release.p12"

محتوای خروجی را در Secret اول GitHub قرار بده. فایل p12 را در محل امن دیگری نیز پشتیبان بگیر. فایل و رمز آن را برای چت ارسال نکن.

## تنظیم Secretهای GitHub

در مخزن GitHub به مسیر Settings → Secrets and variables → Actions برو و این چهار Secret را بساز:

- ANDROID_SIGNING_KEYSTORE_BASE64: خروجی Base64 فایل p12
- ANDROID_KEYSTORE_PASSWORD: رمز فایل p12
- ANDROID_KEY_ALIAS: مقدار dabernaz
- ANDROID_KEY_PASSWORD: همان رمز کلید برای PKCS12

## انتشار APK

بعد از ثبت Secretها:

1. به Actions → Build Dabernaz Android Release → Run workflow برو.
2. گزینهٔ publish_release را روی true بگذار.
3. پس از ساخت و تأیید امضای APK، فایل Dabernaz.apk به GitHub Release اضافه می‌شود.
4. صفحهٔ https://dabernaz.pages.dev/install.html انتشار آخر را بررسی می‌کند و دکمهٔ دانلود را فعال می‌سازد.

ساخت Pull Request و اجرای معمول CI به کلید خصوصی نیاز ندارد و خروجی unsigned تولید می‌کند؛ این خروجی برای توزیع عمومی یا نصب نهایی نیست.

## نکتهٔ سازگاری و امنیت

اگر قبلاً نسخه‌ای با شناسهٔ app.dabernaz.club و کلید امضای دیگری نصب شده باشد، نسخهٔ جدید با کلید تازه نمی‌تواند آن را به‌روزرسانی کند؛ ابتدا باید کلید انتشار قبلی بازیابی شود. نسخهٔ Debug با شناسهٔ جداگانهٔ app.dabernaz.club.debug نصب مستقل دارد.

نصب APK خارج از Google Play ممکن است هشدار Play Protect نشان دهد. منبع و ناشر فایل را بررسی کن؛ این پروژه هیچ گزینه‌ای برای خاموش‌کردن Play Protect یا دورزدن هشدارهای اندروید اضافه نمی‌کند.
