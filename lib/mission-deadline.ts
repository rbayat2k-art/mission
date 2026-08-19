function toLatinDigits(value: string) {
  return value.replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function toPersianDigits(value: string) {
  return value.replace(/\d/g, digit => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
}

function div(a: number, b: number) { return Math.trunc(a / b); }
function mod(a: number, b: number) { return a - Math.trunc(a / b) * b; }

function jalaliToGregorian(jy: number, jm: number, jd: number) {
  jy += 1595;
  let days = -355668 + (365 * jy) + (div(jy, 33) * 8) + div(mod(jy, 33) + 3, 4) + jd;
  days += jm < 7 ? (jm - 1) * 31 : ((jm - 7) * 30) + 186;
  let gy = 400 * div(days, 146097);
  days = mod(days, 146097);
  if (days > 36524) {
    gy += 100 * div(--days, 36524);
    days = mod(days, 36524);
    if (days >= 365) days++;
  }
  gy += 4 * div(days, 1461);
  days = mod(days, 1461);
  if (days > 365) {
    gy += div(days - 1, 365);
    days = mod(days - 1, 365);
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  while (gm <= 12 && gd > monthDays[gm]) gd -= monthDays[gm++];
  return { gy, gm, gd };
}

export function normalizeJalaliDeadline(dateValue?: string | null, timeValue?: string | null) {
  const rawDate = dateValue?.trim() ?? "";
  const rawTime = timeValue?.trim() ?? "";
  if (!rawDate && !rawTime) return { deadline: null } as const;
  if (!rawDate || !rawTime) return { error: "برای تعیین مهلت، تاریخ شمسی و ساعت را با هم وارد کنید." } as const;

  const date = toLatinDigits(rawDate);
  const time = toLatinDigits(rawTime);
  const dateMatch = /^(1[34]\d{2})\/(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])$/.exec(date);
  const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!dateMatch || !timeMatch) return { error: "فرمت مهلت درست نیست؛ نمونه صحیح: ۱۴۰۵/۰۵/۲۷ و ساعت ۱۴:۳۰" } as const;

  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const maxDay = month <= 6 ? 31 : 30;
  if (day > maxDay) return { error: "روز واردشده با ماه شمسی انتخاب‌شده سازگار نیست." } as const;
  const normalizedDate = `${dateMatch[1]}/${dateMatch[2].padStart(2, "0")}/${dateMatch[3].padStart(2, "0")}`;
  const normalizedTime = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
  const { gy, gm, gd } = jalaliToGregorian(Number(dateMatch[1]), month, day);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  // Iran standard time is UTC+03:30. Storing UTC makes overdue/on-time reports reliable.
  const deadlineAt = new Date(Date.UTC(gy, gm - 1, gd, hour, minute) - 210 * 60_000).toISOString();
  return { deadline: `${toPersianDigits(normalizedDate)}، ساعت ${toPersianDigits(normalizedTime)}`, deadlineAt } as const;
}

export function storedJalaliDeadlineToIso(value?: string | null) {
  if (!value) return null;
  const date = value.match(/[۰-۹٠-٩0-9]{4}\/[۰-۹٠-٩0-9]{1,2}\/[۰-۹٠-٩0-9]{1,2}/)?.[0];
  const time = value.match(/[۰-۹٠-٩0-9]{1,2}:[۰-۹٠-٩0-9]{2}/)?.[0];
  if (!date || !time) return null;
  const normalized = normalizeJalaliDeadline(date, time);
  return "deadlineAt" in normalized ? normalized.deadlineAt : null;
}
