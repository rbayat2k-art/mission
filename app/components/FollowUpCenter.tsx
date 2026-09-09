"use client";

import { useEffect, useRef, useState } from "react";
import AttachmentLink from "./AttachmentLink";
import { clientEventId } from "../../lib/client-event-id";

type FollowUpRequest = {
  id:string; missionId:string; missionTitle:string; missionStatus:string; employeeId:string; employeeName:string;
  supervisorName:string; assignedToName:string; category:string; requestText:string; status:string;
  createdAt:string; updatedAt:string; messageCount?:number; resolutionNote?:string|null;
};
type FollowUpMessage = {id:string;senderId:string;senderName:string;senderRole:string;messageType:string;body:string;createdAt:string};
type FollowUpAttachment = {id:string;messageId:string|null;fileName:string;contentType:string;sizeBytes:number;createdAt:string;uploadedByName:string};
type FollowUpDetail = {request:FollowUpRequest;messages:FollowUpMessage[];attachments:FollowUpAttachment[]};

const statusLabels:Record<string,string>={
  awaiting_supervisor:"در انتظار اقدام سرپرست",awaiting_employee:"منتظر پاسخ کارمند",escalated:"ارجاع‌شده به مدیر",
  ready_for_employee:"آماده پیگیری مجدد",resolved:"حل‌شده",rejected:"ردشده",
};
const categoryLabels:Record<string,string>={missing_documents:"کسری مدارک",coordination:"تأیید یا هماهنگی",payment:"پرداخت",administrative:"اقدام اداری",other:"سایر"};

async function jsonRequest<T>(url:string,options?:RequestInit,accountId?:string){
  const response=await fetch(url,{cache:"no-store",credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...(accountId?{"X-Tapra-User-Id":accountId}:{}),...(options?.headers??{})}});
  const body=await response.json().catch(()=>({error:"پاسخ سرور قابل خواندن نیست؛ دوباره تلاش کنید."})) as T&{error?:string};
  if(!response.ok)throw new Error(body.error||"ارتباط با سرور ناموفق بود.");
  return body;
}

function FollowUpThread({detail,accountId,management,onChanged,onMessage}:{detail:FollowUpDetail;accountId:string;management:boolean;onChanged:()=>Promise<void>;onMessage:(value:string)=>void}){
  const [text,setText]=useState("");const [files,setFiles]=useState<File[]>([]);const [busy,setBusy]=useState(false);const [decision,setDecision]=useState("");const [note,setNote]=useState("");
  const sending = useRef(false);
  const pendingMessage = useRef<{id:string;text:string;receipt:string|null}|null>(null);
  const [retryingFiles,setRetryingFiles]=useState(false);
  const closed=["resolved","rejected"].includes(detail.request.status);
  const send=async()=>{
    if(sending.current||(!text.trim()&&!files.length&&!pendingMessage.current))return;
    sending.current=true;setBusy(true);
    try{
      const messageText=text.trim()||"فایل پیوست شد.";
      if(!pendingMessage.current||(!pendingMessage.current.receipt&&pendingMessage.current.text!==messageText))pendingMessage.current={id:clientEventId(),text:messageText,receipt:null};
      const pending=pendingMessage.current;
      if(!pending.receipt){
        const result=await jsonRequest<{message:{id:string}}>(`/api/follow-up-requests/${detail.request.id}/messages`,{method:"POST",body:JSON.stringify({text:pending.text,clientMessageId:pending.id})},accountId);
        if(!result.message?.id)throw new Error("تأیید ثبت پیام دریافت نشد؛ دوباره تلاش کنید.");
        pending.receipt=result.message.id;setRetryingFiles(true);
      }
      for(const file of files){
        const form=new FormData();form.append("missionId",detail.request.missionId);form.append("messageId",pending.receipt);form.append("file",file);
        const response=await fetch("/api/attachments",{method:"POST",headers:{"X-Tapra-User-Id":accountId},body:form});
        const body=await response.json().catch(()=>({error:"پاسخ ارسال فایل قابل خواندن نیست."})) as {error?:string};
        if(!response.ok)throw new Error(body.error||"ارسال فایل ناموفق بود.");
        setFiles(current=>current.filter(item=>item!==file));
      }
      pendingMessage.current=null;setRetryingFiles(false);setText("");setFiles([]);
      try { await onChanged(); onMessage("پیام و ضمیمه‌ها ثبت شد"); }
      catch { onMessage("پیام ثبت شد، ولی تازه‌سازی گفت‌وگو ناموفق بود."); }
    }catch(error){onMessage(error instanceof Error?error.message:"ارسال ناموفق بود")}finally{sending.current=false;setBusy(false)}
  };
  const decide=async()=>{if(sending.current)return;if(!decision||note.trim().length<3)return onMessage("تصمیم و توضیح کوتاه را وارد کنید");sending.current=true;setBusy(true);try{await jsonRequest(`/api/follow-up-requests/${detail.request.id}/decision`,{method:"POST",body:JSON.stringify({action:decision,note:note.trim()})},accountId);setDecision("");setNote("");await onChanged();onMessage("تصمیم ثبت و اعلان ارسال شد")}catch(error){onMessage(error instanceof Error?error.message:"ثبت تصمیم ناموفق بود")}finally{sending.current=false;setBusy(false)}};
  return <div className="follow-up-thread">
    <header><div><span>{categoryLabels[detail.request.category]||"پیگیری"}</span><h3>{detail.request.missionTitle}</h3><p>{detail.request.employeeName} · {statusLabels[detail.request.status]||detail.request.status}</p></div><b className={`follow-up-status ${detail.request.status}`}>{statusLabels[detail.request.status]||detail.request.status}</b></header>
    <div className="follow-up-messages">{detail.messages.map(message=>{const own=management?message.senderRole!=="employee":message.senderRole==="employee";const linked=detail.attachments.filter(file=>file.messageId===message.id);return <div key={message.id} className={`follow-up-message ${own?"own":"other"} ${message.messageType==="decision"?"decision":""}`}><small>{message.senderName}</small><p>{message.body}</p>{linked.length>0&&<div className="follow-up-files">{linked.map(file=><AttachmentLink key={file.id} attachment={file} accountId={accountId}>{file.contentType.startsWith("audio/")?"◉":"▤"} {file.fileName}</AttachmentLink>)}</div>}<time>{new Date(message.createdAt).toLocaleString("fa-IR")}</time></div>})}</div>
    {detail.attachments.some(file=>!file.messageId)&&<div className="initial-evidence"><b>مدارک ثبت‌شده هنگام انجام مأموریت</b>{detail.attachments.filter(file=>!file.messageId).map(file=><AttachmentLink key={file.id} attachment={file} accountId={accountId}>▤ {file.fileName}</AttachmentLink>)}</div>}
    {!closed&&<div className="follow-up-composer"><textarea disabled={busy||retryingFiles} maxLength={4000} value={text} onChange={event=>setText(event.target.value)} placeholder={management?"پاسخ یا راهنمایی برای کارمند...":"پاسخ کوتاه به سرپرست..."}/><div><label className="follow-up-attach">＋ عکس، فایل یا ویس<input disabled={busy||retryingFiles} type="file" multiple accept="image/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label>{files.length>0&&<small>{files.length.toLocaleString("fa-IR")} فایل انتخاب شد</small>}<button disabled={busy} onClick={send}>{busy?"در حال ارسال...":retryingFiles?"ارسال فایل‌های باقیمانده":"ارسال"}</button></div></div>}
    {retryingFiles&&<p role="status">متن پیام ثبت شده است؛ فقط فایل‌های باقیمانده دوباره ارسال می‌شوند.</p>}
    {files.length>0&&<ul className="follow-up-pending-files">{files.map((file,index)=><li key={`${file.name}:${index}`}>{file.name} <button disabled={busy} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}>حذف از ارسال</button></li>)}</ul>}
    {management&&!closed&&<section className="follow-up-decisions"><h4>اقدام سرپرست یا مدیر</h4><div>{[{id:"request_info",label:"درخواست اطلاعات"},{id:"return_to_employee",label:"بازگشت به پیگیری"},{id:"resolve",label:"حل و بستن"},{id:"escalate",label:"ارجاع به مدیر"},{id:"reject",label:"رد درخواست"}].map(item=><button key={item.id} className={decision===item.id?"active":""} onClick={()=>setDecision(item.id)}>{item.label}</button>)}</div>{decision&&<><textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="علت تصمیم یا کاری که باید انجام شود..."/><button className="primary" disabled={busy} onClick={decide}>ثبت تصمیم و ارسال اعلان</button></>}</section>}
  </div>;
}

function FollowUpDetailPanel({requestId,accountId,management,onMessage,onChanged}:{requestId:string;accountId:string;management:boolean;onMessage:(value:string)=>void;onChanged?:()=>Promise<void>}){
  const [detail,setDetail]=useState<FollowUpDetail|null>(null);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    let current=true;
    void jsonRequest<FollowUpDetail>(`/api/follow-up-requests/${encodeURIComponent(requestId)}`,{signal:controller.signal},accountId)
      .then(result=>{if(current){setDetail(result);setError(false)}})
      .catch(()=>{if(current)setError(true)});
    return()=>{current=false;controller.abort()};
  },[requestId,accountId,revision]);
  const refresh=async()=>{setRevision(value=>value+1);await onChanged?.()};
  if(error)return <div role="alert" className="follow-up-empty">دریافت گفت‌وگو ناموفق بود. <button onClick={()=>{setError(false);setRevision(value=>value+1)}}>تلاش دوباره</button></div>;
  if(!detail)return <p className="follow-up-empty" role="status">در حال دریافت گفت‌وگوی پیگیری...</p>;
  return <FollowUpThread key={`${accountId}:${requestId}`} detail={detail} accountId={accountId} management={management} onChanged={refresh} onMessage={onMessage}/>;
}

export function EmployeeFollowUpPanel({missionId,accountId,onMessage}:{missionId:string;accountId:string;onMessage:(value:string)=>void}){
  const [requestId,setRequestId]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let current=true;
    void jsonRequest<{requests:FollowUpRequest[]}>(`/api/follow-up-requests?missionId=${encodeURIComponent(missionId)}`,{signal:controller.signal},accountId)
      .then(result=>{if(current)setRequestId(result.requests[0]?.id??null)})
      .catch(()=>{if(current)setError(true)}).finally(()=>{if(current)setLoading(false)});
    return()=>{current=false;controller.abort()};
  },[missionId,accountId,revision]);
  if(error)return <section className="employee-follow-up-card" role="alert">دریافت پیگیری ناموفق بود. <button onClick={()=>{setError(false);setLoading(true);setRevision(value=>value+1)}}>تلاش دوباره</button></section>;
  if(loading)return <section className="employee-follow-up-card"><p>در حال دریافت گفت‌وگوی پیگیری...</p></section>;
  if(!requestId)return null;
  return <section className="employee-follow-up-card"><div className="employee-follow-up-title"><span>↻</span><div><h3>پیگیری با سرپرست</h3><p>برای این مأموریت یک گفت‌وگوی کاری ثبت شده است.</p></div></div><FollowUpDetailPanel key={`${accountId}:${requestId}`} requestId={requestId} accountId={accountId} management={false} onMessage={onMessage}/></section>;
}

export function FollowUpActionCenter({accountId,onMessage,onCountChange}:{accountId:string;onMessage:(value:string)=>void;onCountChange?:(count:number)=>void}){
  const [items,setItems]=useState<FollowUpRequest[]>([]);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const [filter,setFilter]=useState<"action"|"open"|"all">("action");
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let current=true;
    void jsonRequest<{requests:FollowUpRequest[]}>("/api/follow-up-requests",{signal:controller.signal},accountId).then(result=>{
      if(!current)return;
      setItems(result.requests);setError(false);
      onCountChange?.(result.requests.filter(item=>["awaiting_supervisor","escalated"].includes(item.status)).length);
      setSelectedId(previous=>previous&&result.requests.some(item=>item.id===previous)?previous:result.requests[0]?.id??null);
    }).catch(()=>{if(current)setError(true)}).finally(()=>{if(current)setLoading(false)});
    return()=>{current=false;controller.abort()};
  },[accountId,onCountChange,revision]);
  const visible=items.filter(item=>filter==="all"?true:filter==="action"?["awaiting_supervisor","escalated"].includes(item.status):!["resolved","rejected"].includes(item.status));
  return <div className="follow-up-center"><aside className="follow-up-queue"><div className="follow-up-filter"><button className={filter==="action"?"active":""} onClick={()=>setFilter("action")}>نیازمند اقدام</button><button className={filter==="open"?"active":""} onClick={()=>setFilter("open")}>باز</button><button className={filter==="all"?"active":""} onClick={()=>setFilter("all")}>همه</button></div>{error?<p role="alert">دریافت درخواست‌ها ناموفق بود. <button onClick={()=>setRevision(value=>value+1)}>تلاش دوباره</button></p>:loading?<p className="follow-up-empty">در حال دریافت...</p>:visible.length?<div>{visible.map(item=><button key={item.id} className={selectedId===item.id?"active":""} onClick={()=>setSelectedId(item.id)}><span>{item.employeeName.slice(0,2)}</span><div><b>{item.missionTitle}</b><small>{item.employeeName} · {categoryLabels[item.category]||"سایر"}</small><em>{statusLabels[item.status]||item.status}</em></div><i>{Number(item.messageCount||0).toLocaleString("fa-IR")}</i></button>)}</div>:<p className="follow-up-empty">درخواستی در این دسته وجود ندارد.</p>}</aside><section className="follow-up-detail">{selectedId?<FollowUpDetailPanel key={`${accountId}:${selectedId}`} requestId={selectedId} accountId={accountId} management onChanged={async()=>setRevision(value=>value+1)} onMessage={onMessage}/>:<div className="follow-up-empty large"><span>✓</span><h3>درخواستی انتخاب نشده است</h3></div>}</section></div>;
}
