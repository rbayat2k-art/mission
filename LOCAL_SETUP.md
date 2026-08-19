# راهنمای اجرای محلی راهکار

## پیش‌نیاز

- Node.js نسخه 22 یا جدیدتر
- MySQL 8 یا MariaDB 10.6 به بالا

## آماده‌سازی

یک دیتابیس خالی و یک کاربر با دسترسی کامل به همان دیتابیس بسازید. سپس فایل `.env.example` را با نام `.env` کپی و این مقادیر را تنظیم کنید:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=rahkar
DB_USER=rahkar_user
DB_PASSWORD=your_password
UPLOAD_DIR=storage/uploads
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_SUBJECT=mailto:admin@taprasystem.ir
```

کلیدهای اعلان گوشی فقط یک‌بار ساخته می‌شوند:

```powershell
npx web-push generate-vapid-keys
```

دو مقدار خروجی را در `.env` قرار دهید. اعلان گوشی در محیط عمومی به HTTPS معتبر نیاز دارد؛ مرکز اعلان داخل برنامه بدون این کلیدها هم کار می‌کند.

## اجرا

```powershell
npm ci
npm run db:migrate
npm run dev
```

یا در ویندوز `START_LOCAL.cmd` را اجرا کنید. برنامه در `http://127.0.0.1:3000` باز می‌شود.

## حساب اولیه

- نام کاربری: `admin`
- رمز عبور: `123123456`

حساب فقط وقتی ساخته می‌شود که جدول کاربران خالی باشد. بعد از اولین ورود رمز را عوض کنید.

## بررسی نهایی

```powershell
npm run verify
```

این بررسی TypeScript، Lint، Build، تست‌ها و ممیزی امنیتی وابستگی‌ها را اجرا می‌کند.
