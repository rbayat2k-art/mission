"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AppNotification={id:string;type:string;title:string;message:string;entityType:string|null;entityId:string|null;readAt:string|null;createdAt:string};
type Props={onOpenMissions:()=>void;onCounts?:(counts:{unread:number;open:number})=>void;compact?:boolean};

export default function NotificationCenter({onOpenMissions,onCounts,compact=false}:Props){
  const [items,setItems]=useState<AppNotification[]>([]);const [openCount,setOpenCount]=useState(0);const [loading,setLoading]=useState(true);
  const onCountsRef=useRef(onCounts);useEffect(()=>{onCountsRef.current=onCounts},[onCounts]);
  const load=useCallback(async()=>{const response=await fetch("/api/notifications");const body=await response.json() as {notifications?:AppNotification[];unreadCount?:number;openRequestCount?:number;error?:string};if(!response.ok)throw new Error(body.error||"دریافت اعلان‌ها ناموفق بود");setItems(body.notifications||[]);setOpenCount(body.openRequestCount||0);onCountsRef.current?.({unread:body.unreadCount||0,open:body.openRequestCount||0});setLoading(false)},[]);
  useEffect(()=>{const timer=window.setTimeout(()=>load().catch(()=>setLoading(false)),0);return()=>window.clearTimeout(timer)},[load]);
  const markAll=async()=>{await fetch("/api/notifications",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({markAll:true})});await load()};
  const openItem=async(item:AppNotification)=>{if(!item.readAt)await fetch("/api/notifications",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:item.id})});if(item.entityType==="mission")onOpenMissions();else await load()};
  return <div className={`notification-center ${compact?"compact":""}`}>
    <button className="open-request-summary" onClick={onOpenMissions}><span><b>درخواست‌های باز</b><small>مأموریت‌های قابل اقدام شما</small></span><strong>{openCount.toLocaleString("fa-IR")}</strong></button>
    <div className="notification-center-head"><div><h2>اعلان‌ها</h2><p>مأموریت‌ها و نتیجه بررسی‌ها</p></div>{items.some(item=>!item.readAt)&&<button onClick={markAll}>خواندن همه</button>}</div>
    {loading?<div className="notification-empty">در حال دریافت اعلان‌ها...</div>:items.length?<div className="notification-items">{items.map(item=><button key={item.id} className={item.readAt?"read":"unread"} onClick={()=>openItem(item)}><i>{item.type.startsWith("approval")?"✓":"▣"}</i><span><b>{item.title}</b><small>{item.message}</small><time>{new Date(item.createdAt).toLocaleString("fa-IR")}</time></span>{!item.readAt&&<em/>}</button>)}</div>:<div className="notification-empty"><span>✓</span><b>اعلان تازه‌ای ندارید</b><small>با تخصیص مأموریت یا ثبت نتیجه بررسی، اینجا نمایش داده می‌شود.</small></div>}
  </div>;
}
