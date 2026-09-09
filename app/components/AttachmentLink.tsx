"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Attachment = { id: string; fileName: string; contentType: string };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

function ImagePreview({ attachment, accountId, onClose }: { attachment: Attachment; accountId: string; onClose: () => void }) {
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [originalSize, setOriginalSize] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    void (async () => {
      try {
        const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
          headers: { "X-Tapra-User-Id": accountId },
        });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 409
          ? "نشست شما تغییر کرده یا پایان یافته است. دوباره وارد حساب خود شوید."
          : response.status === 403 ? "دسترسی به این فایل برای حساب شما مجاز نیست."
          : response.status === 404 ? "این فایل در دسترس نیست؛ از مدیر بخواهید فایل را بررسی کند."
          : "دریافت تصویر ناموفق بود. دوباره تلاش کنید.");
        if (!IMAGE_TYPES.includes((response.headers.get("content-type") ?? "").split(";")[0].trim())) {
          throw new Error("پاسخ دریافتی تصویر قابل نمایش نیست.");
        }
        const blob = await response.blob();
        if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error("اندازه فایل تصویر معتبر نیست.");
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (failure) {
        if (active) setError(timedOut ? "دریافت تصویر طول کشید؛ اتصال اینترنت را بررسی و دوباره تلاش کنید."
          : failure instanceof TypeError ? "ارتباط برقرار نشد؛ اتصال اینترنت را بررسی کنید."
          : failure instanceof Error ? failure.message : "نمایش تصویر ناموفق بود.");
      } finally { window.clearTimeout(timeout); }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, accountId, attempt]);

  return createPortal(<div className="attachment-preview-backdrop" role="presentation">
    <div ref={panel} className="attachment-preview" role="dialog" aria-modal="true" aria-label="نمایش تصویر مأموریت" tabIndex={-1} dir="rtl">
      <header><b>{attachment.fileName}</b><button ref={closeButton} onClick={onClose}>بستن تصویر</button></header>
      {imageUrl && !error && <button className="attachment-size-toggle" aria-pressed={originalSize} onClick={() => setOriginalSize(value => !value)}>{originalSize ? "متناسب با صفحه" : "نمایش اندازه اصلی"}</button>}
      {error ? <div role="alert"><p>{error}</p><button onClick={() => { setError(""); setImageUrl(""); setAttempt(value => value + 1); }}>تلاش دوباره</button></div>
        : imageUrl ? <div className={`attachment-preview-image${originalSize ? " original-size" : ""}`}>
          {/* Blob stays inside this authenticated page; do not navigate WebView to a textless image document. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt={attachment.fileName} onError={() => setError("فایل دریافت شد اما تصویر خوانا نیست؛ از مدیر بخواهید آن را دوباره ارسال کند.")} />
        </div> : <p role="status">در حال دریافت تصویر…</p>}
    </div>
  </div>, document.body);
}

export default function AttachmentLink({ attachment, accountId, children }: { attachment: Attachment; accountId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const image = IMAGE_TYPES.includes(attachment.contentType);
  return <>
    <a href={`/api/attachments/${encodeURIComponent(attachment.id)}`} target={image ? undefined : "_blank"} rel="noreferrer"
      onClick={event => { if (image) { event.preventDefault(); setOpen(true); } }}>
      {children ?? attachment.fileName}
    </a>
    {open && <ImagePreview key={`${accountId}:${attachment.id}`} attachment={attachment} accountId={accountId} onClose={close} />}
  </>;
}
