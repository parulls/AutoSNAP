"use client";

import Script from "next/script";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Api, State } from "./model";
import PasswordInput from "./password-input";

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
  type Mode="login"|"register"|"forgot"|"reset";
  const [mode,setMode]=useState<Mode>("login"),[recaptchaToken,setRecaptchaToken]=useState(""),[resetId,setResetId]=useState("");
  const [resetKey,setResetKey]=useState(0),[form,setForm]=useState({username:"",email:"",password:"",confirmPassword:"",otp:"",setupToken:""});
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const signup=!!state.setupRequired||mode==="register",needsCaptcha=signup||mode==="forgot",configured=!!state.recaptchaConfigured&&!!state.recaptchaSiteKey;
  const captchaChange=useCallback((token:string)=>setRecaptchaToken(token),[]);
  function changeMode(next:Mode){setMode(next);setError("");setNotice("");setRecaptchaToken("");setResetKey(value=>value+1);setForm(old=>({...old,password:"",confirmPassword:"",otp:""}));}
  async function submit(event:FormEvent){
    event.preventDefault();setError("");setNotice("");setBusy(true);
    try{
      if(mode==="forgot"){
        const result=await api("forgotPassword",{email:form.email,recaptchaToken});
        setResetId(String(result.resetId??""));setNotice(String(result.message??"Kode OTP telah dikirim."));setMode("reset");
      }else if(mode==="reset"){
        if(form.password!==form.confirmPassword)throw Error("Konfirmasi password tidak sama.");
        const result=await api("resetPassword",{resetId,otp:form.otp,password:form.password});
        changeMode("login");setNotice(String(result.message??"Password berhasil diperbarui."));
      }else{
        const result=await api(state.setupRequired?"setup":mode==="register"?"register":"login",{...form,recaptchaToken});
        if(mode==="register"&&!state.setupRequired){changeMode("login");setNotice(String(result.message));}else await reload();
      }
      setForm(old=>({...old,password:"",confirmPassword:"",otp:""}));setRecaptchaToken("");
    }catch(e){setError((e as Error).message);if(needsCaptcha){setRecaptchaToken("");setResetKey(value=>value+1);}}
    finally{setBusy(false);}
  }
  const title=state.setupRequired?"Siapkan akun admin":mode==="register"?"Buat akun":mode==="forgot"?"Lupa password":mode==="reset"?"Masukkan kode OTP":"Selamat datang";
  const description=state.setupRequired?"Daftarkan administrator pertama.":mode==="register"?"Daftar untuk mulai menggunakan AutoSNAP.":mode==="forgot"?"Kode OTP akan dikirim ke email akun.":mode==="reset"?"Kode OTP berlaku selama 10 menit.":"Masuk untuk melanjutkan pengujian.";
  return <div className="auth-screen"><div className="auth-layout">
    <section className="auth-intro" aria-label="Tentang AutoSNAP">
      <div className="auth-story"><span className="intro-eyebrow">SNAP API AUTOMATION</span><h2>Uji API SNAP.<br/>Lebih terarah.</h2><p>Kelola pengujian dan history dalam satu workspace.</p></div>
    </section>
    <form className="card auth-card" onSubmit={submit} aria-busy={busy}>
    <div className="auth-form-heading"><span className="intro-eyebrow">WORKSPACE AUTOSNAP</span><h1>{title}</h1><p>{description}</p></div>
    {error&&<div className="form-error" role="alert">{error}</div>}{notice&&<div className="form-notice" role="status">{notice}</div>}
    {(mode==="login"||signup)&&<label>Username AutoSNAP<input required autoComplete="username" maxLength={signup?40:120} value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label>}
    {(signup||mode==="forgot")&&<label>Email AutoSNAP<input type="email" required autoComplete="email" maxLength={254} value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label>}
    {(mode==="login"||signup)&&<label>Password<PasswordInput required minLength={signup?12:1} maxLength={256} autoComplete={signup?"new-password":"current-password"} value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label>}
    {mode==="reset"&&<><label>Kode OTP<input required inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} autoComplete="one-time-code" value={form.otp} onChange={e=>setForm({...form,otp:e.target.value.replace(/\D/g,"").slice(0,6)})}/></label><label>Password baru<PasswordInput required minLength={12} maxLength={256} autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><label>Ulangi password baru<PasswordInput required minLength={12} maxLength={256} autoComplete="new-password" value={form.confirmPassword} onChange={e=>setForm({...form,confirmPassword:e.target.value})}/></label></>}
    {(signup||mode==="reset")&&<small className="helper">Password minimal 12 dan maksimal 256 karakter.</small>}
    {needsCaptcha&&<>
      <div className="captcha-field"><strong>Verifikasi keamanan</strong>
        {configured?<RecaptchaV2 key={mode} siteKey={state.recaptchaSiteKey!} onChange={captchaChange} resetKey={resetKey}/>:<div className="captcha-config-error" role="alert">Google reCAPTCHA belum dikonfigurasi oleh administrator server.</div>}
      </div></>}
    {state.setupRequired&&state.setupTokenRequired&&<label>Setup token<PasswordInput required autoComplete="off" value={form.setupToken} onChange={e=>setForm({...form,setupToken:e.target.value})}/></label>}
    <button className="primary-button" disabled={busy||needsCaptcha&&(!configured||!recaptchaToken)}>{busy?"Memproses...":signup?"Daftar":mode==="forgot"?"Kirim OTP":mode==="reset"?"Simpan password":"Masuk"}</button>
    {!state.setupRequired&&<div className="auth-links">{mode==="login"&&<><button type="button" className="text-button" disabled={busy} onClick={()=>changeMode("forgot")}>Lupa password?</button><button type="button" className="text-button" disabled={busy} onClick={()=>changeMode("register")}>Belum punya akun? Daftar</button></>}{mode!=="login"&&<button type="button" className="text-button" disabled={busy} onClick={()=>changeMode("login")}>Kembali ke halaman masuk</button>}</div>}
  </form></div></div>;
}
