"use client";

import { useEffect, useRef, useState } from "react";

export type AppNotification={id:string;type:string;title:string;message:string;entityType:string|null;entityId:string|null;readAt:string|null;createdAt:string};
type Props={accountId:string;onOpenMissions:()=>void;onOpenFollowUps?:()=>void;onCounts?:(counts:{unread:number;open:number})=>void;compact?:boolean};

export default function NotificationCenter({accountId,onOpenMissions,onOpenFollowUps,onCounts,compact=false}:Props){
  const [items,setItems]=useState<AppNotification[]>([]);
  const [openCount,setOpenCount]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [revision,setRevision]=useState(0);
  const actionPending=useRef(false);
  const mounted=useRef(false);
  const onCountsRef=useRef(onCounts);
  useEffect(()=>{onCountsRef.current=onCounts},[onCounts]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
  useEffect(()=>{
    const controller=new AbortController();let current=true;
    void fetch("/api/notifications",{cache:"no-store",credentials:"same-origin",headers:{"X-Tapra-User-Id":accountId},signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error("دریافت اعلان‌ها ناموفق بود.");
      const body=await response.json() as {userId?:string;notifications?:AppNotification[];unreadCount?:number;openRequestCount?:number};
      if(body.userId&&body.userId!==accountId)throw new Error("حساب فعال تغییر کرده است؛ دوباره وارد شوید.");
      if(!Array.isArray(body.notifications))throw new Error("پاسخ اعلان‌ها معتبر نیست.");
      if(!current)return;
      setItems(body.notifications);setOpenCount(body.openRequestCount||0);setError("");
      onCountsRef.current?.({unread:body.unreadCount||0,open:body.openRequestCount||0});
    }).catch(()=>{if(current)setError("دریافت اعلان‌ها ناموفق بود؛ دوباره تلاش کنید.")}).finally(()=>{if(current)setLoading(false)});
    return()=>{current=false;controller.abort()};
  },[accountId,revision]);
  const mark=async(item?:AppNotification)=>{
    if(actionPending.current)return;
    actionPending.current=true;setBusy(true);
    try{
      if(!item?.readAt){
        const response=await fetch("/api/notifications",{method:"PATCH",headers:{"Content-Type":"application/json","X-Tapra-User-Id":accountId},body:JSON.stringify(item?{id:item.id}:{markAll:true})});
        if(!response.ok)throw new Error("ثبت خواندن اعلان ناموفق بود؛ دوباره تلاش کنید.");
      }
      if(!mounted.current)return;
      setError("");
      if(item?.entityType==="mission")onOpenMissions();
      else if(item?.entityType==="follow_up_request"&&onOpenFollowUps)onOpenFollowUps();
      else setRevision(value=>value+1);
    }catch{if(mounted.current)setError("ثبت خواندن اعلان ناموفق بود؛ دوباره تلاش کنید.")}
    finally{actionPending.current=false;if(mounted.current)setBusy(false)}
  };
  return <div className={`notification-center ${compact?"compact":""}`}>
    <button className="open-request-summary" onClick={onOpenFollowUps??onOpenMissions}><span><b>درخواست‌های باز</b><small>موارد قابل اقدام شما</small></span><strong>{openCount.toLocaleString("fa-IR")}</strong></button>
    <div className="notification-center-head"><div><h2>اعلان‌ها</h2><p>مأموریت‌ها و نتیجه بررسی‌ها</p></div>{items.some(item=>!item.readAt)&&<button disabled={busy} onClick={()=>mark()}>خواندن همه</button>}</div>
    {error&&<div role="alert" className="notification-empty"><p>{error}</p><button disabled={busy} onClick={()=>setRevision(value=>value+1)}>دریافت دوباره اعلان‌ها</button></div>}
    {loading?<div className="notification-empty">در حال دریافت اعلان‌ها...</div>:items.length?<div className="notification-items">{items.map(item=><button disabled={busy} key={item.id} className={item.readAt?"read":"unread"} onClick={()=>mark(item)}><i>{item.type.startsWith("approval")?"✓":"▣"}</i><span><b>{item.title}</b><small>{item.message}</small><time>{new Date(item.createdAt).toLocaleString("fa-IR")}</time></span>{!item.readAt&&<em/>}</button>)}</div>:!error&&<div className="notification-empty"><span>✓</span><b>اعلان تازه‌ای ندارید</b><small>با تخصیص مأموریت یا ثبت نتیجه بررسی، اینجا نمایش داده می‌شود.</small></div>}
  </div>;
}
