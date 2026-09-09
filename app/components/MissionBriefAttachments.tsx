"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import AttachmentLink from "./AttachmentLink";

type BriefAttachment = { id: string; fileName: string; contentType: string; messageId?: string | null; uploadedByName?: string; uploadedByRole?: string };

// The parent keys this component by account + mission: old lists/previews cannot
// survive a selection change, and in-flight requests are cancelled on unmount.
export default function MissionBriefAttachments({ missionId, accountId }: { missionId: string; accountId: string }) {
  const [attachments, setAttachments] = useState<BriefAttachment[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void fetch(`/api/attachments?missionId=${encodeURIComponent(missionId)}`, {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { "X-Tapra-User-Id": accountId },
    }).then(async response => {
      if (!response.ok) throw new Error("unavailable");
      const body = await response.json() as { attachments: BriefAttachment[] };
      if (!Array.isArray(body.attachments)) throw new Error("invalid");
      if (active) setAttachments(body.attachments.filter(attachment => !attachment.messageId && attachment.uploadedByRole !== "employee"));
    }).catch(() => { if (active) setError(true); }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [accountId, missionId, attempt]);
  if (error) return <section className="mission-brief-files" role="alert"><p>فایل‌های راهنمای مأموریت دریافت نشد.</p><button onClick={() => { setError(false); setAttempt(value => value + 1); }}>دریافت دوباره فایل‌ها</button></section>;
  if (attachments === null) return <section className="mission-brief-files loading" role="status">در حال دریافت فایل‌های راهنمای مأموریت...</section>;
  if (!attachments.length) return null;
  return <section className="mission-brief-files"><header><span>▤</span><div><b>فایل‌های ارسالی همراه مأموریت</b><small>قبل از شروع کار، تصاویر و اسناد زیر را بررسی کنید.</small></div></header><div>
    {attachments.map(attachment => <AttachmentLink key={attachment.id} attachment={attachment} accountId={accountId}>
      {attachment.contentType.startsWith("image/") ? <Image unoptimized width={92} height={68} src={`/api/attachments/${encodeURIComponent(attachment.id)}`} alt={attachment.fileName} /> : <span>▤</span>}
      <div><b>{attachment.fileName}</b><small>{attachment.uploadedByName ? `ارسال توسط ${attachment.uploadedByName}` : "فایل راهنمای مأموریت"}</small></div><i>مشاهده</i>
    </AttachmentLink>)}
  </div></section>;
}
