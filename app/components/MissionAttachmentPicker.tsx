"use client";

import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 10;
const ACCEPTED_TYPES = new Set([
  "image/jpeg", "image/png", "application/pdf", "text/plain",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "audio/aac", "audio/x-m4a",
]);

type Props = {
  files: File[];
  disabled?: boolean;
  onChange: (files: File[]) => void;
  onMessage: (message: string) => void;
};

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024)).toLocaleString("fa-IR")} کیلوبایت`;
  return `${(size / (1024 * 1024)).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} مگابایت`;
}

function clipboardFile(file: File, index: number) {
  if (file.name && !/^image\.(png|jpe?g)$/i.test(file.name)) return file;
  const extension = file.type === "image/jpeg" ? "jpg" : "png";
  return new File([file], `screenshot-${Date.now()}-${index + 1}.${extension}`, {
    type: file.type || "image/png",
    lastModified: Date.now(),
  });
}

export default function MissionAttachmentPicker({ files, disabled = false, onChange, onMessage }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const previews = useMemo(() => files.map(file => ({
    key: fileKey(file),
    url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
  })), [files]);

  useEffect(() => () => previews.forEach(preview => {
    if (preview.url) URL.revokeObjectURL(preview.url);
  }), [previews]);

  const addFiles = useCallback((incoming: File[], source: "picker" | "drop" | "paste") => {
    if (disabled || incoming.length === 0) return;
    const normalized = incoming.map((file, index) => source === "paste" ? clipboardFile(file, index) : file);
    const valid = normalized.filter(file => file.size > 0 && file.size <= MAX_FILE_BYTES && ACCEPTED_TYPES.has(file.type));
    const invalidCount = normalized.length - valid.length;
    const known = new Set(files.map(fileKey));
    const unique = valid.filter(file => !known.has(fileKey(file)));
    const available = Math.max(0, MAX_FILE_COUNT - files.length);
    const accepted = unique.slice(0, available);
    if (accepted.length) onChange([...files, ...accepted]);
    if (invalidCount) onMessage(`${invalidCount.toLocaleString("fa-IR")} فایل نامعتبر بود؛ نوع مجاز و سقف ۱۰ مگابایت را بررسی کنید.`);
    else if (unique.length > available) onMessage(`حداکثر ${MAX_FILE_COUNT.toLocaleString("fa-IR")} فایل برای هر مأموریت قابل ثبت است.`);
    else if (source === "paste" && accepted.length) onMessage("تصویر از کلیپ‌بورد به ضمیمه‌های مأموریت اضافه شد.");
  }, [disabled, files, onChange, onMessage]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const pastedFiles = Array.from(event.clipboardData?.files ?? []);
      if (!pastedFiles.length) return;
      event.preventDefault();
      addFiles(pastedFiles, "paste");
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addFiles]);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files), "drop");
  };

  return <section className="mission-attachment-picker" aria-labelledby="mission-attachment-title">
    <div className="mission-attachment-heading">
      <span><b id="mission-attachment-title">فایل راهنما برای کارمند</b><small>اختیاری · عکس، سند یا نمونه‌ای که کارمند باید قبل از مراجعه ببیند</small></span>
      <em>{files.length.toLocaleString("fa-IR")} / {MAX_FILE_COUNT.toLocaleString("fa-IR")}</em>
    </div>
    <div
      className={`mission-attachment-dropzone ${dragging ? "dragging" : ""}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={event => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={event => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={handleDrop}
    >
      <span className="mission-attachment-icon">＋</span>
      <b>فایل را انتخاب کنید یا اینجا رها کنید</b>
      <small>برای افزودن اسکرین‌شات، همین فرم را باز نگه دارید و Ctrl+V بزنید.</small>
      <small>JPG، PNG، PDF، Word، Excel، متن و صوت · هر فایل تا ۱۰ مگابایت</small>
      <input
        ref={inputRef}
        className="file-input-hidden"
        type="file"
        multiple
        accept="image/jpeg,image/png,.pdf,.doc,.docx,.xls,.xlsx,.txt,audio/*"
        disabled={disabled}
        onChange={event => {
          addFiles(Array.from(event.target.files ?? []), "picker");
          event.target.value = "";
        }}
      />
    </div>
    {files.length > 0 && <div className="mission-attachment-drafts">
      {files.map((file, index) => <article key={fileKey(file)}>
        {previews[index]?.url ? <Image unoptimized width={64} height={48} src={previews[index].url!} alt={`پیش‌نمایش ${file.name}`} /> : <span>▤</span>}
        <div><b>{file.name}</b><small>{formatFileSize(file.size)}</small></div>
        <button type="button" disabled={disabled} onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))} aria-label={`حذف ${file.name}`}>×</button>
      </article>)}
    </div>}
  </section>;
}
