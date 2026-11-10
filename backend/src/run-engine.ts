import { Injectable } from "@nestjs/common";
import { request as playwrightRequest, type APIRequestContext } from "playwright-core";
import { decrypt, hmacSignature, redact, rsaSignature, sha256 } from "./security";
import type { RecordRow } from "./database.service";
import type { HitOutcome } from "./aspi-types";

export type HitResult={status:number|null;outcome?:HitOutcome;body:unknown;request:Record<string,unknown>};
export type HitInput={baseUrl:string;path:string;method:string;body:Record<string,unknown>;client:RecordRow;user:RecordRow|null;scenarioId:string|null;externalId:string;extraHeaders:Record<string,string>;authFlow:string;useCase?:string;tokenPath?:string;rsaEncoding?:string;hmacEncoding?:string;negativeAccessToken?:boolean};
const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
export function isoJakarta(){return new Date(Date.now()+7*3600000).toISOString().replace(/\.\d{3}Z$/,"+07:00");}
export function allowedUrl(base:string,path:string){
  if(!path.startsWith("/")||path.startsWith("//"))throw new Error("Path endpoint harus relative path SNAP.");
  const url=new URL(path,base.endsWith("/")?base:base+"/");
  const hosts=(process.env.AUTOSNAP_ALLOWED_HOSTS??"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(url.protocol!=="https:"||!hosts.includes(url.hostname.toLowerCase())||url.username||url.password)throw new Error("Host live harus HTTPS dan tercantum di AUTOSNAP_ALLOWED_HOSTS.");
  return url;
}
async function responseOf(context:APIRequestContext,url:URL,method:string,headers:Record<string,string>,data?:string){
  const response=await context.fetch(url.toString(),{method,headers,data,maxRedirects:0,timeout:20000,failOnStatusCode:false});
  const raw=await response.text();let body:unknown=raw;
  try{body=JSON.parse(raw);}catch{}
  return {status:response.status(),body,responseHeaders:response.headers()};
}
function checkHeaders(extra:Record<string,string>){
  for(const key of Object.keys(extra))if(typeof extra[key]!=="string"||/[\r\n]/.test(extra[key])||!/^[A-Za-z0-9-]+$/.test(key)||/^(authorization|authorization-customer|content-type|x-timestamp|x-signature|x-partner-id|x-external-id|channel-id|x-device-id|host)$/i.test(key))throw new Error(`Header template tidak boleh mengganti ${key}.`);
}

@Injectable()
export class RunEngine {
  async hit(input:HitInput):Promise<HitResult>{
    const {baseUrl,path,method,body,client,user,scenarioId,externalId,extraHeaders,authFlow}=input;
    const clientId=value(client,"clientId"),channelId=value(client,"channelId");
    const tokenPath=input.tokenPath||"/api/v1.0/access-token/b2b";
    const b2bTokenService=path===tokenPath||path==="/api/v1.0/access-token/b2b";
    const tokenService=b2bTokenService||path==="/api/v1.0/access-token/b2b2c";
    if(!clientId)throw new Error("Client ID wajib diisi untuk live hit.");
    if(!tokenService&&(!client.partner_id||!channelId))throw new Error("Partner ID dan CHANNEL-ID wajib diisi untuk request service.");
    if(channelId.length>5)throw new Error("CHANNEL-ID maksimal 5 karakter.");
    const useCase=input.useCase??"B2B";
    const rsaEncoding=input.rsaEncoding==="hex"?"hex":"base64",hmacEncoding=input.hmacEncoding==="base64"?"base64":"hex";
    if(path.endsWith("/balance-inquiry")&&authFlow==="direct_rsa")throw new Error("Balance Inquiry ini memerlukan Bearer token B2B; pilih token_b2b atau provided_token.");
    if(useCase==="B2B2C"&&!value(client,"deviceId")&&!path.includes("/access-token/"))throw new Error("X-DEVICE-ID diperlukan pada transaksi B2B2C.");
    if((authFlow==="token_b2b"||authFlow==="provided_token")&&!path.includes("/access-token/")&&!value(client,"clientSecret"))throw new Error("Client Secret wajib diisi untuk signature service.");
    checkHeaders(extraHeaders);
    const timestamp=isoJakarta();
    const context=await playwrightRequest.newContext({ignoreHTTPSErrors:false});
    try{
      let privateKey="",tokenHeaders:Record<string,string>={};
      if(authFlow==="token_b2b"||authFlow==="direct_rsa"||tokenService){
        if(!value(client,"privateKey"))throw new Error("Private Key PKCS#8 wajib diisi untuk signature RSA.");
        privateKey=decrypt(value(client,"privateKey"));
        tokenHeaders={"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientId,"X-SIGNATURE":rsaSignature(privateKey,`${clientId}|${timestamp}`,rsaEncoding)};
      }
      if(path==="/api/v1.0/access-token/b2b2c"){
        const grant=String(body.grantType??"");
        if(!["AUTHORIZATION_CODE","REFRESH_TOKEN"].includes(grant))throw new Error("grantType B2B2C harus AUTHORIZATION_CODE atau REFRESH_TOKEN.");
        if(grant==="AUTHORIZATION_CODE"&&!body.authCode)throw new Error("authCode diperlukan untuk AUTHORIZATION_CODE.");
        if(grant==="REFRESH_TOKEN"&&!body.refreshToken)throw new Error("refreshToken diperlukan untuk REFRESH_TOKEN.");
        const result=await responseOf(context,allowedUrl(baseUrl,path),"POST",tokenHeaders,JSON.stringify(body));
        return {...result,request:{method:"POST",path,timestamp,body,headers:redact(tokenHeaders)}};
      }
      let token="";
      const steps:Record<string,unknown>[]=[];
      if(authFlow==="token_b2b"||b2bTokenService){
        const tokenBody={grantType:"client_credentials",additionalInfo:{}};
        const result=await responseOf(context,allowedUrl(baseUrl,tokenPath),"POST",tokenHeaders,JSON.stringify(tokenBody));
        if(b2bTokenService)return {...result,request:{method:"POST",path:tokenPath,timestamp,body:tokenBody,headers:redact(tokenHeaders)}};
        steps.push({name:"Access Token B2B",method:"POST",path:tokenPath,timestamp,requestHeaders:redact(tokenHeaders),httpStatus:result.status,response:redact(result.body),responseHeaders:redact(result.responseHeaders)});
        const parsed=result.body&&typeof result.body==="object"?result.body as Record<string,unknown>:{};
        if(result.status<200||result.status>=300||typeof parsed.accessToken!=="string"||!parsed.accessToken||parsed.responseCode&&!String(parsed.responseCode).startsWith("200"))return {status:result.status,body:{error:"API Keamanan tidak memberikan access token yang valid. Balance Inquiry tidak dikirim.",securityResponse:redact(result.body)},request:{method,path,timestamp,body,steps}};
        token=String(parsed.accessToken);
      }else if(authFlow==="provided_token"){
        if(!value(client,"accessToken"))throw new Error("Access Token B2B tersimpan diperlukan untuk provided_token.");
        token=decrypt(value(client,"accessToken"));
      }
      if(!["token_b2b","provided_token","direct_rsa"].includes(authFlow))throw new Error("Auth flow environment tidak dikenal.");
      if(useCase==="B2B2C"&&(!user||!value(user,"customerToken")))throw new Error("User SNAP live memerlukan customer access token B2B2C dari proses consent/OAuth.");
      const customerToken=useCase==="B2B2C"&&user?decrypt(value(user,"customerToken")):"";
      if(customerToken&&authFlow==="direct_rsa")throw new Error("B2B2C memerlukan token_b2b atau provided_token.");
      if(input.negativeAccessToken||scenarioId?.endsWith(".1"))token="invalid-access-token";
      const url=allowedUrl(baseUrl,path),serialized=method==="GET"?"":JSON.stringify(body);
      if(method==="GET"&&body.queryParameter&&typeof body.queryParameter==="object"&&!Array.isArray(body.queryParameter))for(const [key,param] of Object.entries(body.queryParameter))if(param!==null&&param!==undefined)url.searchParams.set(key,String(param));
      const relative=url.pathname+url.search;
      let signature=authFlow==="direct_rsa"?rsaSignature(privateKey,`${method}:${relative}:${sha256(serialized)}:${timestamp}`,rsaEncoding):hmacSignature(decrypt(value(client,"clientSecret")),`${method}:${relative}:${token}:${sha256(serialized)}:${timestamp}`,hmacEncoding);
      if(scenarioId?.endsWith(".2"))signature="invalid-signature";
      const headers:Record<string,string>={"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-SIGNATURE":signature,"X-PARTNER-ID":value(client,"partnerIdSource")==="client_id"?clientId:client.partner_id??"","X-EXTERNAL-ID":externalId,"CHANNEL-ID":channelId,...extraHeaders};
      if(token)headers.Authorization=`Bearer ${token}`;
      if(customerToken)headers["Authorization-Customer"]=`Bearer ${customerToken}`;
      if(value(client,"deviceId"))headers["X-DEVICE-ID"]=value(client,"deviceId");
      const result=await responseOf(context,url,method,headers,method==="GET"?undefined:serialized);
      return {...result,request:{method,path:url.pathname+url.search,timestamp,externalId,body:method==="GET"?null:body,headers:redact(headers),responseHeaders:redact(result.responseHeaders),steps,signatureEncoding:{rsa:rsaEncoding,hmac:hmacEncoding}}};
    }finally{await context.dispose();}
  }
}
