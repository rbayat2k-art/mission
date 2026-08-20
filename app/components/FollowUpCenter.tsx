"use client";

import { useCallback, useEffect, useState } from "react";

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

async function jsonRequest<T>(url:string,options?:RequestInit){
  const response=await fetch(url,{...options,headers:{"Content-Type":"application/json",...(options?.headers??{})}});
  const body=await response.json() as T&{error?:string};
  if(!response.ok)throw new Error(body.error||"ارتباط با سرور ناموفق بود.");
  return body;
}

function FollowUpThread({detail,management,onChanged,onMessage}:{detail:FollowUpDetail;management:boolean;onChanged:()=>Promise<void>;onMessage:(value:string)=>void}){
  const [text,setText]=useState("");const [files,setFiles]=useState<File[]>([]);const [busy,setBusy]=useState(false);const [decision,setDecision]=useState("");const [note,setNote]=useState("");
  const closed=["resolved","rejected"].includes(detail.request.status);
  const send=async()=>{if(!text.trim()&&!files.length)return;setBusy(true);try{
    const messageText=text.trim()||"فایل پیوست شد.";
    const result=await jsonRequest<{message:{id:string}}>(`/api/follow-up-requests/${detail.request.id}/messages`,{method:"POST",body:JSON.stringify({text:messageText})});
    for(const file of files){const form=new FormData();form.append("missionId",detail.request.missionId);form.append("messageId",result.message.id);form.append("file",file);const response=await fetch("/api/attachments",{method:"POST",body:form});const body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error||"ارسال فایل ناموفق بود.")}
    setText("");setFiles([]);await onChanged();onMessage("پیام و ضمیمه‌ها ثبت شد");
  }catch(error){onMessage(error instanceof Error?error.message:"ارسال ناموفق بود")}finally{setBusy(false)}};
  const decide=async()=>{if(!decision||note.trim().length<3)return onMessage("تصمیم و توضیح کوتاه را وارد کنید");setBusy(true);try{await jsonRequest(`/api/follow-up-requests/${detail.request.id}/decision`,{method:"POST",body:JSON.stringify({action:decision,note:note.trim()})});setDecision("");setNote("");await onChanged();onMessage("تصمیم ثبت و اعلان ارسال شد")}catch(error){onMessage(error instanceof Error?error.message:"ثبت تصمیم ناموفق بود")}finally{setBusy(false)}};
  return <div className="follow-up-thread">
    <header><div><span>{categoryLabels[detail.request.category]||"پیگیری"}</span><h3>{detail.request.missionTitle}</h3><p>{detail.request.employeeName} · {statusLabels[detail.request.status]||detail.request.status}</p></div><b className={`follow-up-status ${detail.request.status}`}>{statusLabels[detail.request.status]||detail.request.status}</b></header>
    <div className="follow-up-messages">{detail.messages.map(message=>{const own=management?message.senderRole!=="employee":message.senderRole==="employee";const linked=detail.attachments.filter(file=>file.messageId===message.id);return <div key={message.id} className={`follow-up-message ${own?"own":"other"} ${message.messageType==="decision"?"decision":""}`}><small>{message.senderName}</small><p>{message.body}</p>{linked.length>0&&<div className="follow-up-files">{linked.map(file=><a key={file.id} href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer">{file.contentType.startsWith("audio/")?"◉":"▤"} {file.fileName}</a>)}</div>}<time>{new Date(message.createdAt).toLocaleString("fa-IR")}</time></div>})}</div>
    {detail.attachments.some(file=>!file.messageId)&&<div className="initial-evidence"><b>مدارک ثبت‌شده هنگام انجام مأموریت</b>{detail.attachments.filter(file=>!file.messageId).map(file=><a key={file.id} href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer">▤ {file.fileName}</a>)}</div>}
    {!closed&&<div className="follow-up-composer"><textarea value={text} onChange={event=>setText(event.target.value)} placeholder={management?"پاسخ یا راهنمایی برای کارمند...":"پاسخ کوتاه به سرپرست..."}/><div><label className="follow-up-attach">＋ عکس، فایل یا ویس<input type="file" multiple accept="image/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label>{files.length>0&&<small>{files.length.toLocaleString("fa-IR")} فایل انتخاب شد</small>}<button disabled={busy} onClick={send}>{busy?"در حال ارسال...":"ارسال"}</button></div></div>}
    {management&&!closed&&<section className="follow-up-decisions"><h4>اقدام سرپرست یا مدیر</h4><div>{[{id:"request_info",label:"درخواست اطلاعات"},{id:"return_to_employee",label:"بازگشت به پیگیری"},{id:"resolve",label:"حل و بستن"},{id:"escalate",label:"ارجاع به مدیر"},{id:"reject",label:"رد درخواست"}].map(item=><button key={item.id} className={decision===item.id?"active":""} onClick={()=>setDecision(item.id)}>{item.label}</button>)}</div>{decision&&<><textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="علت تصمیم یا کاری که باید انجام شود..."/><button className="primary" disabled={busy} onClick={decide}>ثبت تصمیم و ارسال اعلان</button></>}</section>}
  </div>;
}

export function EmployeeFollowUpPanel({missionId,onMessage}:{missionId:string;onMessage:(value:string)=>void}){
  const [request,setRequest]=useState<FollowUpRequest|null>(null);const [detail,setDetail]=useState<FollowUpDetail|null>(null);const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);try{const list=await jsonRequest<{requests:FollowUpRequest[]}>(`/api/follow-up-requests?missionId=${encodeURIComponent(missionId)}`);const latest=list.requests[0]||null;setRequest(latest);if(latest)setDetail(await jsonRequest<FollowUpDetail>(`/api/follow-up-requests/${latest.id}`));else setDetail(null)}catch(error){onMessage(error instanceof Error?error.message:"دریافت پیگیری ناموفق بود")}finally{setLoading(false)}},[missionId,onMessage]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);
  if(loading)return <section className="employee-follow-up-card"><p>در حال دریافت گفت‌وگوی پیگیری...</p></section>;
  if(!request||!detail)return null;
  return <section className="employee-follow-up-card"><div className="employee-follow-up-title"><span>↻</span><div><h3>پیگیری با سرپرست</h3><p>برای این مأموریت یک گفت‌وگوی کاری ثبت شده است.</p></div></div><FollowUpThread detail={detail} management={false} onChanged={load} onMessage={onMessage}/></section>;
}

export function FollowUpActionCenter({onMessage,onCountChange}:{onMessage:(value:string)=>void;onCountChange?:(count:number)=>void}){
  const [items,setItems]=useState<FollowUpRequest[]>([]);const [selectedId,setSelectedId]=useState<string|null>(null);const [detail,setDetail]=useState<FollowUpDetail|null>(null);const [filter,setFilter]=useState<"action"|"open"|"all">("action");const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);try{const result=await jsonRequest<{requests:FollowUpRequest[]}>("/api/follow-up-requests");setItems(result.requests);const actionCount=result.requests.filter(item=>["awaiting_supervisor","escalated"].includes(item.status)).length;onCountChange?.(actionCount);const nextId=selectedId&&result.requests.some(item=>item.id===selectedId)?selectedId:result.requests[0]?.id||null;setSelectedId(nextId);if(nextId)setDetail(await jsonRequest<FollowUpDetail>(`/api/follow-up-requests/${nextId}`));else setDetail(null)}catch(error){onMessage(error instanceof Error?error.message:"دریافت درخواست‌ها ناموفق بود")}finally{setLoading(false)}},[onCountChange,onMessage,selectedId]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);
  const visible=items.filter(item=>filter==="all"?true:filter==="action"?["awaiting_supervisor","escalated"].includes(item.status):!["resolved","rejected"].includes(item.status));
  const select=async(id:string)=>{setSelectedId(id);try{setDetail(await jsonRequest<FollowUpDetail>(`/api/follow-up-requests/${id}`))}catch(error){onMessage(error instanceof Error?error.message:"دریافت گفت‌وگو ناموفق بود")}};
  return <div className="follow-up-center"><aside className="follow-up-queue"><div className="follow-up-filter"><button className={filter==="action"?"active":""} onClick={()=>setFilter("action")}>نیازمند اقدام</button><button className={filter==="open"?"active":""} onClick={()=>setFilter("open")}>باز</button><button className={filter==="all"?"active":""} onClick={()=>setFilter("all")}>همه</button></div>{loading?<p className="follow-up-empty">در حال دریافت...</p>:visible.length?<div>{visible.map(item=><button key={item.id} className={selectedId===item.id?"active":""} onClick={()=>select(item.id)}><span>{item.employeeName.slice(0,2)}</span><div><b>{item.missionTitle}</b><small>{item.employeeName} · {categoryLabels[item.category]||"سایر"}</small><em>{statusLabels[item.status]||item.status}</em></div><i>{Number(item.messageCount||0).toLocaleString("fa-IR")}</i></button>)}</div>:<p className="follow-up-empty">درخواستی در این دسته وجود ندارد.</p>}</aside><section className="follow-up-detail">{detail?<FollowUpThread detail={detail} management onChanged={load} onMessage={onMessage}/>:<div className="follow-up-empty large"><span>✓</span><h3>درخواستی انتخاب نشده است</h3><p>درخواست‌های پیگیری کارمندان در این بخش بررسی می‌شوند.</p></div>}</section></div>;
}
