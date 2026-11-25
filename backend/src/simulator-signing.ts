import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
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

/** Bank Sumut menolak X-TIMESTAMP yang tidak di depan jam server. Pengujian positif memakai minimal sekarang + 2 menit, sama seperti skrip Postman mereka. */
export function ensureFutureTimestamp(config:TimestampConfig,requested:string|undefined,testType:"positive"|"negative",at=new Date()){
  const ahead=isoTimestamp(config,new Date(at.getTime()+2*60_000));
  if(testType==="negative")return requested?.trim()||isoTimestamp(config,at);
  if(!requested?.trim())return ahead;
  const parsed=Date.parse(requested);
  if(!Number.isFinite(parsed)||parsed<at.getTime()+90_000)return ahead;
  return requested.trim();
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

/** One-line PKCS#1 base64 for the ASPI Private_Key field. PEM text is converted; an existing DER base64 key is kept in that form. */
export function toAspiPrivateKey(value:string){
  const trimmed=value.trim();
  if(!trimmed)throw {error:"Private Key untuk Signature Authentication kosong.",status:400};
  let parsed:KeyObject|undefined;
  if(trimmed.includes("BEGIN")||trimmed.includes("PRIVATE KEY")){
    try{parsed=createPrivateKey(trimmed);}catch{throw {error:"Private Key PEM tidak bisa diubah menjadi base64. Periksa teksnya, termasuk BEGIN dan END.",status:400};}
  }else{
    const compact=trimmed.replace(/\s+/g,"");
    if(!/^[A-Za-z0-9+/=]+$/.test(compact))throw {error:"Private Key Signature Authentication harus PEM atau base64.",status:400};
    const der=Buffer.from(compact,"base64");
    for(const type of ["pkcs1","pkcs8"] as const){
      try{parsed=createPrivateKey({key:der,format:"der",type});break;}catch{/* try the other container */}
    }
    if(!parsed)throw {error:"Private Key Signature Authentication belum berupa kunci yang utuh, jadi tidak bisa diubah menjadi base64.",status:400};
  }
  if(!parsed)throw {error:"Private Key untuk Signature Authentication kosong.",status:400};
  return parsed.export({type:"pkcs1",format:"der"}).toString("base64");
}

/** Direct SNAP utility path on any host, including v1.0 and v1.0.0. The ASPI documentation page is not this path. */
export function snapUtilityKind(raw:string):"auth"|"service"|null{
  let url:URL;
  try{url=new URL(raw);}catch{return null;}
  const path=url.pathname.replace(/\/$/,"").toLowerCase();
  if(path.endsWith("/utilities/signature-auth")||path.endsWith("/signature-auth"))return "auth";
  if(path.endsWith("/utilities/signature-service")||path.endsWith("/signature-service"))return "service";
  return null;
}

export function snapUtilityRequest(kind:"auth"|"service",input:{timestamp:string;clientKey?:string;privateKey?:string;clientSecret?:string;method?:string;endpoint?:string;accessToken?:string;bodyText?:string}):{headers:Record<string,string>;body:string|undefined}{
  if(kind==="auth")return {headers:{"X-TIMESTAMP":input.timestamp,"X-CLIENT-KEY":input.clientKey??"","Private_Key":input.privateKey??""},body:undefined};
  // ASPI docs use the typo EndpoinUrl. Bank Sumut validates EndpointUrl / ENDPOINTURL and rejects when that header is empty.
  const endpoint=String(input.endpoint??"").trim();
  return {headers:{"Content-Type":"application/json","X-TIMESTAMP":input.timestamp,"X-CLIENT-SECRET":input.clientSecret??"","HttpMethod":(input.method??"POST").toUpperCase(),"EndpoinUrl":endpoint,"EndpointUrl":endpoint,"AccessToken":input.accessToken??""},body:input.bodyText??""};
}

/** Join Base URL + endpoint path. Absolute https values are kept only when they cannot be reduced to a path. */
export function joinProviderUrl(baseUrl:string,endpoint:string){
  const path=String(endpoint??"").trim();
  if(!path)return "";
  if(/^https?:\/\//i.test(path))return path;
  const base=String(baseUrl??"").trim().replace(/\/$/,"");
  if(!base)throw {error:"Base URL penyedia wajib diisi sebelum memakai endpoint relatif.",status:400};
  const rel=path.startsWith("/")?path:`/${path}`;
  return `${base}${rel}`;
}

/**
 * Store only the endpoint path. Full URLs that share the provider origin become pathname+search.
 * If Base URL includes a prefix such as /snapgov and the full URL starts with that prefix, the stored
 * path is relative to the Base URL so joining does not duplicate /snapgov.
 */
export function normalizeEndpointPath(raw:string,baseUrl=""){
  const trimmed=String(raw??"").trim();
  if(!trimmed)return "";
  if(!/^https?:\/\//i.test(trimmed))return trimmed.startsWith("/")?trimmed:`/${trimmed.replace(/^\.\//,"")}`;
  let absolute:URL;
  try{absolute=new URL(trimmed);}catch{throw {error:"Endpoint tidak valid.",status:400};}
  if(absolute.protocol!=="https:")throw {error:"Endpoint wajib HTTPS bila diisi sebagai URL lengkap.",status:400};
  const baseText=String(baseUrl??"").trim();
  if(!baseText)return absolute.pathname+(absolute.search||"")||"/";
  try{
    const base=new URL(baseText);
    if(absolute.origin!==base.origin)return absolute.toString();
    const basePath=(base.pathname.replace(/\/$/,"")||"");
    const full=absolute.pathname+(absolute.search||"");
    if(basePath&&basePath!=="/"&&(full===basePath||full.startsWith(`${basePath}/`))){
      const rest=full.slice(basePath.length)||"/";
      return rest.startsWith("/")?rest:`/${rest}`;
    }
    return full || "/";
  }catch{
    return absolute.pathname+(absolute.search||"")||"/";
  }
}

/** @deprecated use joinProviderUrl after normalizeEndpointPath */
export function resolveSignerUrl(raw:string,baseUrl=""){
  const path=normalizeEndpointPath(raw,baseUrl);
  if(!path)return "";
  if(/^https?:\/\//i.test(path))return path;
  return joinProviderUrl(baseUrl,path);
}

/** Halaman atau path resmi ASPI. Halaman dokumentasi Keamanan mencakup kedua operasi. */
export function aspiSignatureTarget(raw:string,kind:"auth"|"service"){
  let url:URL;
  try{url=new URL(raw);}catch{return null;}
  if(url.protocol!=="https:"||url.hostname!=="apidevportal.aspi-indonesia.or.id")return null;
  const page="https://apidevportal.aspi-indonesia.or.id/api-services/keamanan";
  const authPath="/api/v1.0/utilities/signature-auth";
  const servicePath="/api/v1.0/utilities/signature-service";
  const path=url.pathname.replace(/\/$/,"");
  if(path==="/api-services/keamanan"||path.startsWith("/api-services/keamanan/"))return {page:`${page}#/Keamanan/post_api_v1_0_utilities_${kind==="auth"?"signature_auth":"signature_service"}`,path:kind==="auth"?authPath:servicePath};
  if(kind==="auth"&&path===authPath)return {page,path:authPath};
  if(kind==="service"&&path===servicePath)return {page,path:servicePath};
  if(path===authPath||path===servicePath)throw {error:kind==="auth"?"URL Signature Access Token mengarah ke signature-service. Gunakan signature-auth atau halaman Keamanan ASPI.":"URL Signature Service mengarah ke signature-auth. Gunakan signature-service atau halaman Keamanan ASPI.",status:400};
  return null;
}

/** HTTPS-only HIT_API URL. Private hosts stay blocked. A saved public URL is allowed unless an allowlist narrows it. */
export function assertSafeSignerUrl(raw:string){
  let url:URL;
  try{url=new URL(raw);}catch{throw {error:"URL layanan signature tidak valid. Gunakan alamat HTTPS lengkap, misalnya https://dev.banksumut.co.id/.../signature-service",status:400};}
  if(url.protocol!=="https:")throw {error:"URL layanan signature wajib HTTPS.",status:400};
  if(url.username||url.password)throw {error:"URL layanan signature tidak boleh berisi kredensial.",status:400};
  const host=url.hostname.toLowerCase();
  if(PRIVATE_HOST.test(host)||host==="0.0.0.0")throw {error:"Host layanan signature tidak diizinkan.",status:400};
  const allow=signerAllowlist();
  if(allow.length&&!allow.includes(host))throw {error:`Host signature ${host} tidak ada di allowlist.`,status:403};
  return url;
}

export async function hitApiSignature(input:{url:string;method?:string;headers?:Record<string,string>;body?:unknown;timeoutMs?:number;extractPath?:string}){
  const url=assertSafeSignerUrl(input.url);
  const method=(input.method??"POST").toUpperCase();
  const headers:Record<string,string>={...(input.body===undefined?{}:{"Content-Type":"application/json"}),...(input.headers??{})};
  for(const [k,v] of Object.entries(headers))if(/[\r\n]/.test(k)||/[\r\n]/.test(v))throw {error:"Header signing tidak valid.",status:400};
  const timeoutMs=Math.min(input.timeoutMs??15000,20000);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let status=0;let responseBody:unknown=null;
  const payload=input.body===undefined||method==="GET"||method==="HEAD"?undefined:typeof input.body==="string"?input.body:JSON.stringify(input.body);
  try{
    const response=await fetch(url.toString(),{method,headers,body:payload,signal:controller.signal,redirect:"error"});
    status=response.status;
    const text=await response.text();
    try{responseBody=JSON.parse(text);}catch{responseBody=text.slice(0,2000);}
  }catch(error){
    if((error as Error)?.name==="AbortError")throw {error:`Layanan signature tidak menjawab dalam ${Math.round(timeoutMs/1000)} detik (${method} ${url.pathname}).`,status:504};
    throw {error:`Layanan signature tidak dapat dihubungi (${method} ${url.pathname}).`,status:502};
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
