# گزارش آمادگی استقرار نسخه 2.3.0

## مقصد

- دامنه: `taprasystem.ir`
- IP سرور: `62.204.61.18`
- بستر: WHM/cPanel، Node.js 22 و MySQL/MariaDB

## تغییر معماری

- Cloudflare Workers حذف شد.
- D1 با MySQL/MariaDB جایگزین شد.
- R2 با پوشه امن فایل روی سرور جایگزین شد.
- خروجی استاندارد Next.js Standalone و Startup مخصوص cPanel/PM2 ساخته شد.
- تنظیمات Apache، Nginx، CDN و SSL اضافه شد.

## نتیجه بررسی

- TypeScript: موفق
- ESLint: موفق
- Build Production: موفق
- تست‌ها: ۱۸ موفق، ۰ ناموفق
- npm audit: صفر آسیب‌پذیری
- اجرای Standalone: صفحه اصلی HTTP 200 و RTL صحیح
- Health بدون دیتابیس: HTTP 503 مطابق انتظار

## تست با دیتابیس واقعی

پس از واردکردن اطلاعات MySQL روی سرور، `npm run db:migrate` و سپس `/api/health` باید موفق شوند. اجرای این مرحله و نصب واقعی روی IP به دسترسی SSH/cPanel و اطلاعات دیتابیس نیاز دارد.

راهنمای مرحله‌به‌مرحله در `deploy/CPANEL_DEPLOYMENT.md` است.
