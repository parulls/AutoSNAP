import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseService } from "./database.service";
import { hashPassword } from "./security";

export type Operator={id:string;username:string;email:string;name:string;role:"admin"|"tester";active:boolean;created_at:string};
const fail=(error:string,status=400):never=>{throw {error,status};};
const usernameOf=(input:Record<string,unknown>)=>String(input.username??"").trim().toLowerCase();

type RecaptchaResponse={success?:boolean;hostname?:string;"error-codes"?:string[]};
export function recaptchaPublicConfig(){
  const siteKey=String(process.env.AUTOSNAP_RECAPTCHA_SITE_KEY??"").trim();
  return {recaptchaConfigured:!!siteKey&&!!String(process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY??"").trim(),recaptchaSiteKey:siteKey||undefined};
}
export async function verifyRecaptcha(input:Record<string,unknown>,remoteIp?:string){
  const secret=String(process.env.AUTOSNAP_RECAPTCHA_SECRET_KEY??"").trim(),token=String(input.recaptchaToken??"").trim();
  if(!secret)fail("Google reCAPTCHA belum dikonfigurasi pada server.",503);
  if(!token||token.length>8192)fail("Centang 'Saya bukan robot' terlebih dahulu.");
  const body=new URLSearchParams({secret,response:token});if(remoteIp)body.set("remoteip",remoteIp);
  let result:RecaptchaResponse;
  try{
    const response=await fetch("https://www.google.com/recaptcha/api/siteverify",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body,signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);result=await response.json() as RecaptchaResponse;
  }catch{fail("Verifikasi Google reCAPTCHA tidak dapat dihubungi. Coba lagi.",503);}
  if(!result!.success)fail(result!["error-codes"]?.includes("timeout-or-duplicate")?"reCAPTCHA kedaluwarsa atau sudah digunakan. Centang kembali.":"Verifikasi reCAPTCHA gagal. Coba lagi.");
  const allowed=String(process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES??"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean);
  if(process.env.NODE_ENV==="production"&&!allowed.length)fail("Hostname reCAPTCHA belum dikonfigurasi.",503);
  if(allowed.length&&(!result!.hostname||!allowed.includes(result!.hostname.toLowerCase())))fail("Hostname reCAPTCHA tidak diizinkan.",403);
}
export async function createAccount(db:DatabaseService,input:Record<string,unknown>,role:"admin"|"tester",active:boolean,first=false){
  const username=usernameOf(input),password=String(input.password??"");
  if(String(input.name??"").length>120)fail("Nama maksimal 120 karakter.");
  if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))fail("Username 3–40 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  if(password.length<12||password.length>256)fail("Password harus 12–256 karakter.");
  const pass=await hashPassword(password),id=randomUUID();
  // The legacy email column is retained for existing account recovery.
  try{
    const result=await db.transaction(async query=>{
      if(first)await query("LOCK TABLE autosnap_users IN SHARE ROW EXCLUSIVE MODE");
      return query("INSERT INTO autosnap_users (id,email,username,name,salt,password_hash,role,active,created_at) SELECT $1,$2,$2,$3,$4,$5,$6,$7,$8 WHERE ($9=FALSE OR NOT EXISTS (SELECT 1 FROM autosnap_users)) RETURNING id",[id,username,String(input.name??"").trim()||username,pass.salt,pass.hash,role,active,new Date().toISOString(),first]);
    });
    if(!result.length)fail("Administrator sudah dibuat.",409);
  }catch(error){if((error as {code?:string}).code==="23505")fail("Username sudah dipakai.",409);throw error;}
  return id;
}
export async function verifyPassword(password:string,row:{salt:string;password_hash:string}){
  const actual=Buffer.from((await hashPassword(password,row.salt)).hash,"hex");
  const expected=Buffer.from(row.password_hash,"hex");
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function updateAccount(db:DatabaseService,input:Record<string,unknown>,current:Operator){
  const id=String(input.id??current.id);
  const own=id===current.id;
  if(current.role!=="admin"&&!own)fail("Hanya admin yang boleh mengubah akun lain.",403);
  return db.transaction(async query=>{
    const rows=await query<Operator&{salt:string;password_hash:string}>("SELECT * FROM autosnap_users FOR UPDATE");
    const row=rows.find(item=>item.id===id);
    if(!row)fail("Akun tidak ditemukan.",404);
    if(input.action==="userDelete"){
      if(current.role!=="admin")fail("Hanya admin yang boleh menghapus akun.",403);
      if(own)fail("Akun yang sedang dipakai tidak dapat dihapus.",409);
      if(row!.role==="admin"&&rows.filter(item=>item.role==="admin"&&item.active).length<=1)fail("Minimal satu admin aktif diperlukan.",409);
      await query("DELETE FROM autosnap_users WHERE id=$1",[id]);return;
    }
    const role=input.role===undefined?row!.role:String(input.role);
    const active=input.active===undefined?row!.active:input.active;
    if(!["admin","tester"].includes(role)||typeof active!=="boolean")fail("Peran atau status akun tidak valid.");
    if((role!==row!.role||active!==row!.active)&&current.role!=="admin")fail("Hanya admin yang boleh mengubah peran/status akun.",403);
    if(own&&(!active||role!==row!.role))fail("Ubah peran/status akun sendiri melalui admin lain.",409);
    if(row!.role==="admin"&&row!.active&&(role!=="admin"||!active)&&rows.filter(item=>item.role==="admin"&&item.active).length<=1)fail("Minimal satu admin aktif diperlukan.",409);
    await query("UPDATE autosnap_users SET role=$1,active=$2 WHERE id=$3",[role,active,id]);
    if(!active||role!==row!.role)await query("DELETE FROM autosnap_sessions WHERE user_id=$1",[id]);
    if(input.password){
      const password=String(input.password);
      if(password.length<12||password.length>256)fail("Password harus 12–256 karakter.");
      const currentPassword=String(input.currentPassword??"");
      if(own&&(currentPassword.length>256||!(await verifyPassword(currentPassword,row!))))fail("Password saat ini salah.");
      const pass=await hashPassword(password);
      await query("UPDATE autosnap_users SET salt=$1,password_hash=$2 WHERE id=$3",[pass.salt,pass.hash,id]);
      await query("DELETE FROM autosnap_sessions WHERE user_id=$1",[id]);
    }
  });
}
