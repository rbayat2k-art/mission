# استقرار روی سرور 62.204.61.18 و دامنه taprasystem.ir

## ۱. DNS و CDN

در سرویس CDN این رکوردها را بسازید:

| نوع | نام | مقدار |
|---|---|---|
| A | `@` | `62.204.61.18` |
| A | `www` | `62.204.61.18` |

ابتدا Proxy/CDN را موقتاً خاموش کنید تا صدور گواهی Origin انجام شود. پس از سالم‌شدن HTTPS، حالت SSL سرویس CDN را روی `Full (strict)` بگذارید؛ حالت Flexible مناسب نیست.

## ۲. ساخت حساب دامنه در WHM

برای `taprasystem.ir` یک حساب cPanel بسازید. PHP برای این برنامه لازم نیست. Node.js 22 و قابلیت Application Manager/Setup Node.js App باید برای همان حساب فعال باشد.

## ۳. ساخت MySQL

در cPanel از بخش MySQL Databases:

1. یک دیتابیس بسازید؛ نمونه: `cpuser_rahkar`.
2. یک کاربر اختصاصی با رمز طولانی و تصادفی بسازید.
3. کاربر را با `ALL PRIVILEGES` فقط به همین دیتابیس متصل کنید.
4. نام کامل دیتابیس، کاربر و رمز را نگه دارید.

## ۴. بارگذاری برنامه

فایل ZIP نهایی را در مسیری خارج از `public_html`، برای نمونه `/home/CPANEL_USER/rahkar` استخراج کنید. فقط Apache/Nginx باید از طریق Proxy به Node وصل شود؛ سورس و `.env` نباید مستقیماً وب‌پذیر باشند.

در Terminal یا SSH همان حساب:

```bash
cd /home/CPANEL_USER/rahkar
cp .env.example .env
```

فایل `.env` را با مقادیر واقعی تنظیم کنید:

```env
NODE_ENV=production
HOSTNAME=127.0.0.1
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=cpuser_rahkar
DB_USER=cpuser_rahkaruser
DB_PASSWORD=CHANGE_THIS
DB_POOL_SIZE=10
UPLOAD_DIR=/home/CPANEL_USER/rahkar/storage/uploads
AUTO_MIGRATE=true
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=123123456
INITIAL_ADMIN_NAME=مدیر سیستم
INITIAL_ADMIN_MOBILE=09000000000
```

مجوز فایل را محدود کنید:

```bash
chmod 600 .env
chmod 750 storage storage/uploads
```

## ۵. نصب، دیتابیس و Build

```bash
npm ci
npm run db:migrate
npm run verify
npm run build
```

بعد از اولین ورود رمز `admin` را تغییر دهید.

## ۶. اجرای دائمی

### روش پیشنهادی cPanel Application Manager

در Setup Node.js App / Application Manager:

- Node version: `22`
- Application mode: `Production`
- Application root: مسیر پوشه `rahkar`
- Application URL: `https://taprasystem.ir`
- Startup file: `app.cjs`

همه متغیرهای `.env` را نیز در بخش Environment Variables برنامه وارد کنید و سپس Restart بزنید. در این روش cPanel/Passenger اتصال دامنه به برنامه را مدیریت می‌کند و معمولاً تنظیم دستی Proxy لازم نیست.

### روش جایگزین PM2

اگر Application Manager در دسترس نبود:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

دستور نهایی‌ای را که `pm2 startup` چاپ می‌کند با دسترسی لازم اجرا کنید. سپس نمونه `nginx.conf` یا `apache-proxy.conf` این پوشه را در VirtualHost دامنه قرار دهید.

## ۷. SSL

در cPanel برای `taprasystem.ir` و `www.taprasystem.ir` گواهی AutoSSL صادر کنید. سپس:

1. `https://taprasystem.ir/api/health` باید `{"status":"ok"}` بدهد.
2. در CDN حالت SSL را `Full (strict)` کنید.
3. Proxy/CDN را فعال کنید.
4. دوباره Health و ورود مدیر را تست کنید.

## ۸. تست تحویل

- ورود با `admin / 123123456`
- تغییر رمز مدیر
- ساخت سرپرست و کارمند
- ورود کارمند با موبایل و مرورگر دسکتاپ
- شروع فعالیت و ثبت مقصد
- آپلود چند تصویر/رسید
- پایان کار و تأیید گزارش روزانه
- مشاهده مأموریت Pending در پنل سرپرست
- تأیید و قطعی‌شدن امتیاز
- بررسی Live Tracking و گزارش روزانه/هفتگی/ماهانه

## ۹. پشتیبان‌گیری

روزانه از دیتابیس MySQL و پوشه `storage/uploads` پشتیبان بگیرید. نگهداری یکی بدون دیگری بازیابی کامل مدارک را ممکن نمی‌کند.

## اطلاعات لازم برای نصب مستقیم توسط مجری

برای اجرای مستقیم روی سرور باید این موارد به‌صورت امن ارائه شود: آدرس و پورت SSH، نام کاربری SSH/cPanel، روش احراز هویت (کلید یا رمز)، و نام/کاربر/رمز MySQL. رمزها را داخل گفتگو یا فایل Git عمومی قرار ندهید.
