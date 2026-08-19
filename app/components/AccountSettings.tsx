"use client";

import { FormEvent, useState } from "react";

type Props = { initialFullName:string; initialUsername:string; onSaved:(user:{fullName:string;username:string})=>void; onMessage:(message:string)=>void };

export default function AccountSettings({ initialFullName, initialUsername, onSaved, onMessage }: Props) {
  const [fullName,setFullName]=useState(initialFullName);
  const [username,setUsername]=useState(initialUsername);
  const [currentPassword,setCurrentPassword]=useState("");
  const [newPassword,setNewPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [saving,setSaving]=useState(false);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();
    if(newPassword && newPassword!==confirmPassword){onMessage("تکرار رمز جدید یکسان نیست");return}
    setSaving(true);
    try{
      const response=await fetch("/api/account",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({fullName,username,currentPassword,newPassword:newPassword||undefined})});
      const body=await response.json() as {error?:string;user?:{fullName:string;username:string}};
      if(!response.ok||!body.user)throw new Error(body.error||"ذخیره حساب ناموفق بود");
      setCurrentPassword("");setNewPassword("");setConfirmPassword("");onSaved(body.user);onMessage("اطلاعات حساب با موفقیت ذخیره شد");
    }catch(error){onMessage(error instanceof Error?error.message:"ذخیره حساب ناموفق بود")}finally{setSaving(false)}
  };
  return <form className="account-settings-card" onSubmit={submit}>
    <div className="settings-heading"><span>♙</span><div><h2>حساب و امنیت</h2><p>نام، نام کاربری و رمز ورود خود را تغییر دهید.</p></div></div>
    <label>نام و نام خانوادگی<input value={fullName} onChange={event=>setFullName(event.target.value)} required minLength={2}/></label>
    <label>نام کاربری<input value={username} onChange={event=>setUsername(event.target.value)} required dir="ltr" pattern="[a-z0-9._-]{3,40}"/><small>فقط حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط</small></label>
    <div className="account-security-separator"><b>تأیید امنیتی</b><small>برای ذخیره هر تغییری، رمز فعلی لازم است.</small></div>
    <label>رمز عبور فعلی<input type="password" value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} autoComplete="current-password" required/></label>
    <label>رمز جدید <small>اختیاری</small><input type="password" value={newPassword} onChange={event=>setNewPassword(event.target.value)} autoComplete="new-password" placeholder="حداقل ۱۰ کاراکتر، شامل حرف و عدد"/></label>
    <label>تکرار رمز جدید<input type="password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)} autoComplete="new-password" disabled={!newPassword}/></label>
    <button className="primary-wide" disabled={saving}>{saving?"در حال ذخیره...":"ذخیره تغییرات حساب"}</button>
  </form>;
}
