"use client";

import Script from "next/script";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Api, State } from "./model";

declare global {
  interface Window {
    grecaptcha?: {
      render?: (container: HTMLElement, options: Record<string, unknown>) => number;
      reset?: (widgetId?: number) => void;
    };
  }
}

function RecaptchaV2({siteKey,onChange,resetKey}:{siteKey:string;onChange:(token:string)=>void;resetKey:number}){
  const container=useRef<HTMLDivElement>(null),widgetId=useRef<number|undefined>(undefined);
  const [loadError,setLoadError]=useState("");
  const render=useCallback(()=>{
    if(widgetId.current!==undefined)return true;
    const api=window.grecaptcha;
    if(!container.current||typeof api?.render!=="function")return false;
    widgetId.current=api.render(container.current,{
      sitekey:siteKey,theme:"light",
      callback:(token:string)=>onChange(token),
      "expired-callback":()=>onChange(""),"error-callback":()=>onChange("")
    });
    setLoadError("");return true;
  },[siteKey,onChange]);
  useEffect(()=>{
    let attempts=0,timer:ReturnType<typeof setTimeout>;
    const waitUntilReady=()=>{
      if(render())return;
      if(++attempts>=150){setLoadError("Google reCAPTCHA gagal dimuat. Periksa koneksi, VPN, atau pemblokir iklan.");return;}
      timer=setTimeout(waitUntilReady,100);
    };
    waitUntilReady();return()=>clearTimeout(timer);
  },[render]);
  useEffect(()=>{
    const reset=window.grecaptcha?.reset;
    if(widgetId.current!==undefined&&typeof reset==="function"){reset(widgetId.current);onChange("");}
  },[resetKey,onChange]);
  return <>
    <Script src="https://www.google.com/recaptcha/api.js?render=explicit&hl=id" strategy="afterInteractive" onError={()=>setLoadError("Skrip Google reCAPTCHA tidak dapat dimuat. Periksa koneksi, VPN, atau pemblokir iklan.")}/>
    <div className="recaptcha-wrap" ref={container}/>
    {loadError&&<div className="captcha-config-error" role="alert">{loadError}</div>}
  </>;
}

export default function AuthScreen({state,api,reload}:{state:State;api:Api;reload:()=>Promise<void>}){
  const [register,setRegister]=useState(false),[recaptchaToken,setRecaptchaToken]=useState("");
  const [resetKey,setResetKey]=useState(0),[form,setForm]=useState({username:"",password:"",setupToken:""});
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const signup=!!state.setupRequired||register,configured=!!state.recaptchaConfigured&&!!state.recaptchaSiteKey;
  const captchaChange=useCallback((token:string)=>setRecaptchaToken(token),[]);
  async function submit(event:FormEvent){
    event.preventDefault();setError("");setNotice("");setBusy(true);
    try{
      const result=await api(state.setupRequired?"setup":register?"register":"login",{...form,recaptchaToken});
      if(register&&!state.setupRequired){setNotice(String(result.message));setRegister(false);}else await reload();
      setForm(old=>({...old,password:""}));setRecaptchaToken("");
    }catch(e){setError((e as Error).message);if(signup){setRecaptchaToken("");setResetKey(value=>value+1);}}
    finally{setBusy(false);}
  }
  return <div className="auth-screen"><form className="card auth-card" onSubmit={submit}>
    <div className="brand-mark">AS</div><h1>AutoSNAP</h1>
    <p>{state.setupRequired?"Daftarkan administrator pertama":register?"Daftar akun AutoSNAP":"Masuk ke AutoSNAP"}</p>
    {error&&<div className="form-error" role="alert">{error}</div>}{notice&&<div className="form-notice" role="status">{notice}</div>}
    <label>Username AutoSNAP<input required autoComplete="username" maxLength={signup?40:120} value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label>
    <label>Password<input type="password" required minLength={signup?12:1} maxLength={256} autoComplete={signup?"new-password":"current-password"} value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label>
    {signup&&<><small className="helper">Username 3–40 karakter. Password minimal 12 karakter. Gunakan akun AutoSNAP tersendiri.</small>
      <div className="captcha-field"><strong>Verifikasi keamanan</strong>
        {configured?<RecaptchaV2 siteKey={state.recaptchaSiteKey!} onChange={captchaChange} resetKey={resetKey}/>:<div className="captcha-config-error" role="alert">Google reCAPTCHA belum dikonfigurasi oleh administrator server.</div>}
      </div></>}
    {state.setupRequired&&state.setupTokenRequired&&<label>Setup token<input type="password" required value={form.setupToken} onChange={e=>setForm({...form,setupToken:e.target.value})}/></label>}
    <button className="primary-button" disabled={busy||signup&&(!configured||!recaptchaToken)}>{busy?"Memproses...":signup?"Daftar":"Masuk"}</button>
    {!state.setupRequired&&<button type="button" className="text-button" disabled={busy} onClick={()=>{setRegister(!register);setError("");setNotice("");setRecaptchaToken("");setResetKey(value=>value+1);}}>{register?"Sudah punya akun? Masuk":"Belum punya akun? Daftar"}</button>}
    {register&&<small className="helper">Setelah daftar, admin mengaktifkan akun melalui User Management.</small>}
    {!signup&&<small className="helper">Akun lama tetap bisa masuk menggunakan email AutoSNAP sebelumnya.</small>}
  </form></div>;
}
