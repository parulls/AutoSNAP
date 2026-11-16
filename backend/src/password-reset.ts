import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseService } from "./database.service";
import { hashPassword } from "./security";

type ResetRow={id:string;user_id:string;otp_hash:string;expires_at:string;attempts:number;used_at:string|null};
const fail=(error:string,status=400):never=>{throw {error,status};};
const normalizedEmail=(value:unknown)=>String(value??"").trim().toLowerCase();
const resetSecret=()=>{const value=String(process.env.AUTOSNAP_PASSWORD_RESET_SECRET??"");if(value.length<32)fail("Layanan lupa password belum dikonfigurasi.",503);return value;};
const otpHash=(id:string,otp:string)=>createHmac("sha256",resetSecret()).update(`${id}:${otp}`).digest("hex");
const safeEqual=(left:string,right:string)=>{const a=Buffer.from(left,"hex"),b=Buffer.from(right,"hex");return a.length===b.length&&timingSafeEqual(a,b);};
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]!));

async function sendOtp(email:string,name:string,otp:string){
  const apiKey=String(process.env.RESEND_API_KEY??"").trim(),from=String(process.env.AUTOSNAP_EMAIL_FROM??"").trim();
  if(!apiKey||!from)fail("Layanan email OTP belum dikonfigurasi.",503);
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({from,to:[email],subject:"Kode OTP reset password AutoSNAP",html:`<p>Halo ${escapeHtml(name)},</p><p>Kode OTP AutoSNAP Anda:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p><p>Kode berlaku 10 menit dan hanya dapat digunakan satu kali.</p><p>Abaikan email ini jika Anda tidak meminta reset password.</p>`}),signal:AbortSignal.timeout(10_000)}).catch(()=>null);
  if(!response?.ok)fail("Email OTP gagal dikirim. Coba lagi beberapa saat.",503);
}

export async function requestPasswordReset(db:DatabaseService,emailValue:unknown){
  const email=normalizedEmail(emailValue),resetId=randomUUID();
  if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)fail("Masukkan email akun AutoSNAP yang valid.");
  resetSecret();if(!process.env.RESEND_API_KEY||!process.env.AUTOSNAP_EMAIL_FROM)fail("Layanan email OTP belum dikonfigurasi.",503);
  await db.query("DELETE FROM autosnap_password_resets WHERE expires_at<=$1 OR used_at IS NOT NULL",[new Date().toISOString()]);
  const user=await db.one<{id:string;name:string;email:string}>("SELECT id,name,email FROM autosnap_users WHERE LOWER(email)=$1 AND active=TRUE",[email]);
  if(user){
    const otp=String(randomInt(100000,1_000_000));
    await db.query("DELETE FROM autosnap_password_resets WHERE user_id=$1",[user.id]);
    await db.query("INSERT INTO autosnap_password_resets (id,user_id,otp_hash,expires_at,attempts,used_at,created_at) VALUES ($1,$2,$3,$4,0,NULL,$5)",[resetId,user.id,otpHash(resetId,otp),new Date(Date.now()+10*60_000).toISOString(),new Date().toISOString()]);
    try{await sendOtp(user.email,user.name,otp);}catch(error){await db.query("DELETE FROM autosnap_password_resets WHERE id=$1",[resetId]);throw error;}
  }
  return {resetId,message:"Jika email terdaftar dan aktif, kode OTP telah dikirim."};
}

export async function resetPasswordWithOtp(db:DatabaseService,input:Record<string,unknown>){
  const id=String(input.resetId??""),otp=String(input.otp??"").trim(),password=String(input.password??"");
  if(!/^[0-9]{6}$/.test(otp)||!id||id.length>80)fail("Kode OTP harus terdiri dari 6 angka.");
  if(password.length<12||password.length>256)fail("Password harus 12–256 karakter.");
  resetSecret();
  await db.transaction(async query=>{
    const row=(await query<ResetRow>("SELECT * FROM autosnap_password_resets WHERE id=$1 FOR UPDATE",[id]))[0];
    if(!row||row.used_at||row.expires_at<=new Date().toISOString()||row.attempts>=5)fail("Kode OTP tidak valid atau sudah kedaluwarsa.");
    await query("UPDATE autosnap_password_resets SET attempts=attempts+1 WHERE id=$1",[id]);
    if(!safeEqual(row.otp_hash,otpHash(id,otp)))fail("Kode OTP tidak valid atau sudah kedaluwarsa.");
    const pass=await hashPassword(password);
    await query("UPDATE autosnap_users SET salt=$1,password_hash=$2 WHERE id=$3",[pass.salt,pass.hash,row.user_id]);
    await query("DELETE FROM autosnap_sessions WHERE user_id=$1",[row.user_id]);
    await query("UPDATE autosnap_password_resets SET used_at=$1 WHERE id=$2",[new Date().toISOString(),id]);
  });
}
