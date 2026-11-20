import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseService } from "./database.service";
import { hashPassword } from "./security";
import { assertAccountRole, assertAssignablePrivileges, can, normalizeRole, normalizedPrivileges, type AccountRole } from "./privileges";

export type Operator={id:string;username:string;email:string;name:string;role:AccountRole;active:boolean;privileges:unknown;created_at:string};
const fail=(error:string,status=400):never=>{throw {error,status};};
const usernameOf=(input:Record<string,unknown>)=>String(input.username??"").trim().toLowerCase();
const emailOf=(input:Record<string,unknown>)=>String(input.email??"").trim().toLowerCase();

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
  if(result!["error-codes"]?.some(code=>["invalid-input-secret","missing-input-secret"].includes(code)))fail("Konfigurasi secret Google reCAPTCHA tidak valid. Hubungi administrator server.",503);
  if(!result!.success)fail(result!["error-codes"]?.includes("timeout-or-duplicate")?"reCAPTCHA kedaluwarsa atau sudah digunakan. Centang kembali.":"Verifikasi reCAPTCHA gagal. Coba lagi.");
  const allowed=String(process.env.AUTOSNAP_RECAPTCHA_HOSTNAMES??"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean);
  if(process.env.NODE_ENV==="production"&&!allowed.length)fail("Hostname reCAPTCHA belum dikonfigurasi.",503);
  if(allowed.length&&(!result!.hostname||!allowed.includes(result!.hostname.toLowerCase())))fail("Hostname reCAPTCHA tidak diizinkan.",403);
}
export async function createAccount(db:DatabaseService,input:Record<string,unknown>,role:AccountRole|"tester",active:boolean,first=false){
  const accountRole=normalizeRole(role);
  assertAccountRole(accountRole);
  const username=usernameOf(input),email=emailOf(input),password=String(input.password??"");
  if(String(input.name??"").length>120)fail("Nama maksimal 120 karakter.");
  if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))fail("Username 3–40 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)fail("Email akun AutoSNAP harus valid.");
  if(password.length<12||password.length>256)fail("Password harus 12–256 karakter.");
  const pass=await hashPassword(password),id=randomUUID();
  // The legacy email column is retained for existing account recovery.
  try{
    const result=await db.transaction(async query=>{
      if(first)await query("LOCK TABLE autosnap_users IN SHARE ROW EXCLUSIVE MODE");
      return query("INSERT INTO autosnap_users (id,email,username,name,salt,password_hash,role,active,privileges,created_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10 WHERE ($11=FALSE OR NOT EXISTS (SELECT 1 FROM autosnap_users)) RETURNING id",[id,email,username,String(input.name??"").trim()||username,pass.salt,pass.hash,accountRole,active,JSON.stringify(normalizedPrivileges(input.privileges,accountRole)),new Date().toISOString(),first]);
    });
    if(!result.length)fail("Administrator sudah dibuat.",409);
  }catch(error){if((error as {code?:string}).code==="23505")fail("Username atau email sudah dipakai.",409);throw error;}
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
  if(!own&&!can(current,"user_management","update")&&current.role!=="admin")fail("Anda tidak memiliki privilege untuk mengubah akun lain.",403);
  return db.transaction(async query=>{
    const rows=await query<Operator&{salt:string;password_hash:string}>("SELECT * FROM autosnap_users FOR UPDATE");
    const row=rows.find(item=>item.id===id);
    if(!row)fail("Akun tidak ditemukan.",404);
    if(input.action==="userDelete"){
      if(!can(current,"user_management","delete")&&current.role!=="admin")fail("Anda tidak memiliki privilege untuk menghapus akun.",403);
      if(own)fail("Akun yang sedang dipakai tidak dapat dihapus.",409);
      if(row!.role==="admin"&&rows.filter(item=>item.role==="admin"&&item.active).length<=1)fail("Minimal satu admin aktif diperlukan.",409);
      await query("DELETE FROM autosnap_users WHERE id=$1",[id]);return;
    }
    const stored=normalizeRole(row!.role);
    assertAccountRole(stored);
    const role=input.role===undefined?stored:normalizeRole(input.role);
    assertAccountRole(role);
    const active=input.active===undefined?row!.active:input.active;
    if(typeof active!=="boolean")fail("Peran atau status akun tidak valid.");
    if((role!==stored||active!==row!.active)&&current.role!=="admin")fail("Hanya admin yang boleh mengubah peran/status akun.",403);
    if(own&&(!active||role!==stored))fail("Ubah peran/status akun sendiri melalui admin lain.",409);
    if(stored==="admin"&&row!.active&&(role!=="admin"||!active)&&rows.filter(item=>item.role==="admin"&&item.active).length<=1)fail("Minimal satu admin aktif diperlukan.",409);
    const email=input.email===undefined?row!.email:String(input.email).trim().toLowerCase();
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)fail("Email akun AutoSNAP harus valid.");
    if(rows.some(item=>item.id!==id&&item.email.toLowerCase()===email))fail("Email sudah dipakai.",409);
    let privileges=normalizedPrivileges(row!.privileges,role);
    if(input.privileges!==undefined){
      const next=assertAssignablePrivileges(current,input.privileges);
      const same=next.length===privileges.length&&next.every(key=>privileges.includes(key));
      if(!same){
        if(current.role!=="admin"&&!can(current,"user_management","update"))fail("Anda tidak memiliki privilege untuk mengubah privilege akun.",403);
        if(own&&current.role!=="admin")fail("Tidak dapat mengubah privilege akun sendiri.",403);
        privileges=next;
      }
    }
    await query("UPDATE autosnap_users SET role=$1,active=$2,email=$3,privileges=$4::jsonb WHERE id=$5",[role,active,email,JSON.stringify(privileges),id]);
    if(!active||role!==stored)await query("DELETE FROM autosnap_sessions WHERE user_id=$1",[id]);
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
