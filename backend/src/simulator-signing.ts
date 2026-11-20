import { createHash } from "node:crypto";
import { hmacSignature, redact, rsaSignature } from "./security";

export type SignatureMode="FUNCTION"|"HIT_API"|"NONE";
export type TimestampConfig={offsetMinutes:number;includeMillis:boolean};

const PRIVATE_HOST=/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|::1|fc|fd)/i;

export function normalizeSignatureMode(raw:unknown):SignatureMode{
  const value=String(raw??"FUNCTION").toUpperCase();
  if(value==="HIT_API"||value==="NONE"||value==="FUNCTION")return value;
  throw {error:"Mode signature harus FUNCTION, HIT_API, atau NONE.",status:400};
}

/** ISO 8601 with timezone offset, e.g. 2026-11-19T17:35:00+07:00 or with millis. */
export function isoTimestamp(config:TimestampConfig,at=new Date()){
  const offset=Number.isFinite(config.offsetMinutes)?Math.trunc(config.offsetMinutes):420;
  if(Math.abs(offset)>14*60)throw {error:"Offset timezone timestamp tidak valid.",status:400};
  const local=new Date(at.getTime()+offset*60_000);
  const y=local.getUTCFullYear(),m=String(local.getUTCMonth()+1).padStart(2,"0"),d=String(local.getUTCDate()).padStart(2,"0");
  const hh=String(local.getUTCHours()).padStart(2,"0"),mm=String(local.getUTCMinutes()).padStart(2,"0"),ss=String(local.getUTCSeconds()).padStart(2,"0");
  const ms=config.includeMillis?`.${String(local.getUTCMilliseconds()).padStart(3,"0")}`:"";
  const sign=offset>=0?"+":"-",abs=Math.abs(offset),oh=String(Math.floor(abs/60)).padStart(2,"0"),om=String(abs%60).padStart(2,"0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${ms}${sign}${oh}:${om}`;
}

export function shiftTimestamp(iso:string,deltaMinutes:number){
  const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?([+-]\d{2}:\d{2}|Z)$/.exec(iso);
  if(!match)throw {error:"Timestamp ISO 8601 tidak valid.",status:400};
  const base=Date.parse(iso);
  if(!Number.isFinite(base))throw {error:"Timestamp ISO 8601 tidak valid.",status:400};
  const includeMillis=!!match[2];
  const offsetMinutes=match[3]==="Z"?0:(Number(match[3].slice(1,3))*60+Number(match[3].slice(4,6)))*(match[3][0]==="-"?-1:1);
  return isoTimestamp({offsetMinutes,includeMillis},new Date(base+deltaMinutes*60_000));
}

/** Equivalent of getXSignatureAccessTokenFunction(): RSA-SHA256(clientKey|xTimestamp). */
export function getXSignatureAccessTokenFunction(privateKeyPem:string,clientKey:string,xTimestamp:string,encoding:"base64"|"hex"="base64"){
  if(!privateKeyPem.includes("PRIVATE KEY"))throw {error:"Private Key PEM tidak valid untuk signature Access Token.",status:400};
  return rsaSignature(privateKeyPem,`${clientKey}|${xTimestamp}`,encoding);
}

/** Equivalent of getXSignatureServiceFunction(): HMAC-SHA512 SNAP string-to-sign. */
export function getXSignatureServiceFunction(clientSecret:string,method:string,relativeUrl:string,accessToken:string,minifiedBody:string,xTimestamp:string,encoding:"base64"|"hex"="hex"){
  const bodyHash=createHash("sha256").update(minifiedBody||"").digest("hex");
  const stringToSign=`${method.toUpperCase()}:${relativeUrl}:${accessToken}:${bodyHash}:${xTimestamp}`;
  return hmacSignature(clientSecret,stringToSign,encoding);
}

export function signerAllowlist(){
  return String(process.env.AUTOSNAP_SIGNER_ALLOWLIST??"").split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
}

/** HTTPS-only HIT_API URL with host allowlist and private-network rejection (SSRF guard). */
export function assertSafeSignerUrl(raw:string){
  let url:URL;
  try{url=new URL(raw);}catch{throw {error:"URL layanan signature tidak valid.",status:400};}
  if(url.protocol!=="https:")throw {error:"URL layanan signature wajib HTTPS.",status:400};
  if(url.username||url.password)throw {error:"URL layanan signature tidak boleh berisi kredensial.",status:400};
  const host=url.hostname.toLowerCase();
  if(PRIVATE_HOST.test(host)||host==="0.0.0.0")throw {error:"Host layanan signature tidak diizinkan.",status:400};
  const allow=signerAllowlist();
  if(!allow.length)throw {error:"AUTOSNAP_SIGNER_ALLOWLIST belum dikonfigurasi untuk mode HIT_API.",status:503};
  if(!allow.includes(host))throw {error:`Host signature ${host} tidak ada di allowlist.`,status:403};
  return url;
}

export async function hitApiSignature(input:{url:string;method?:string;headers?:Record<string,string>;body?:unknown;timeoutMs?:number;extractPath?:string}){
  const url=assertSafeSignerUrl(input.url);
  const method=(input.method??"POST").toUpperCase();
  const headers:Record<string,string>={"Content-Type":"application/json",...(input.headers??{})};
  for(const [k,v] of Object.entries(headers))if(/[\r\n]/.test(k)||/[\r\n]/.test(v))throw {error:"Header signing tidak valid.",status:400};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(input.timeoutMs??8000,15000));
  let status=0;let responseBody:unknown=null;
  try{
    const response=await fetch(url.toString(),{method,headers,body:method==="GET"||method==="HEAD"?undefined:JSON.stringify(input.body??{}),signal:controller.signal,redirect:"error"});
    status=response.status;
    const text=await response.text();
    try{responseBody=JSON.parse(text);}catch{responseBody=text.slice(0,2000);}
  }catch(error){
    if((error as Error)?.name==="AbortError")throw {error:"Layanan signature timeout.",status:504};
    throw {error:"Layanan signature tidak dapat dihubungi.",status:502};
  }finally{clearTimeout(timer);}
  const signature=extractSignature(responseBody,input.extractPath);
  return {httpStatus:status,signature,response:redact(responseBody)};
}

function extractSignature(body:unknown,path?:string):string|undefined{
  if(!body||typeof body!=="object")return undefined;
  const keys=(path||"signature,xSignature,X-SIGNATURE,data.signature").split(".");
  let cur:unknown=body;
  if(path){
    for(const key of keys){if(!cur||typeof cur!=="object")return undefined;cur=(cur as Record<string,unknown>)[key];}
    return typeof cur==="string"&&cur?cur:undefined;
  }
  const obj=body as Record<string,unknown>;
  for(const key of ["signature","xSignature","X-SIGNATURE","x-signature"])if(typeof obj[key]==="string"&&obj[key])return String(obj[key]);
  if(obj.data&&typeof obj.data==="object"){
    const data=obj.data as Record<string,unknown>;
    for(const key of ["signature","xSignature","X-SIGNATURE"])if(typeof data[key]==="string"&&data[key])return String(data[key]);
  }
  return undefined;
}

export function minifyJsonBody(body:string){
  if(!body.trim())return "";
  try{return JSON.stringify(JSON.parse(body));}catch{throw {error:"Request body harus JSON valid.",status:400};}
}
