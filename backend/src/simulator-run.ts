import { randomUUID } from "node:crypto";
import type { DatabaseService, RecordRow } from "./database.service";
import type { Operator } from "./accounts";
import { decrypt, redact } from "./security";
import {
  getXSignatureAccessTokenFunction,
  getXSignatureServiceFunction,
  hitApiSignature,
  isoTimestamp,
  minifyJsonBody,
  normalizeSignatureMode,
  type SignatureMode,
  type TimestampConfig,
} from "./simulator-signing";

const value=(row:RecordRow|undefined,key:string)=>String(row?.data[key]??"");
const methods=new Set(["GET","POST","PUT","PATCH","DELETE"]);

export type SimulatorOverrides={
  partnerId?:string;externalId?:string;deviceId?:string;channelId?:string;
  body?:string;timestamp?:string;includeMillis?:boolean;offsetMinutes?:number;
  regenerateExternalId?:boolean;
};

function timestampConfig(provider:RecordRow,overrides:SimulatorOverrides):TimestampConfig{
  const raw=provider.data.timestampConfig;
  const base=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
  return {
    offsetMinutes:overrides.offsetMinutes??Number(base.offsetMinutes??420),
    includeMillis:overrides.includeMillis??base.includeMillis===true,
  };
}

function encodingOf(raw:unknown,fallback:"base64"|"hex"):"base64"|"hex"{
  return raw==="hex"||raw==="base64"?raw:fallback;
}

async function resolveAccessTokenSignature(provider:RecordRow,mode:SignatureMode,clientKey:string,timestamp:string){
  if(mode==="NONE")return {signature:"",httpStatus:null as number|null,response:null as unknown,mode};
  if(mode==="FUNCTION"){
    const privateKey=decrypt(value(provider,"privateKey"));
    const encoding=encodingOf(provider.data.rsaEncoding,"base64");
    return {signature:getXSignatureAccessTokenFunction(privateKey,clientKey,timestamp,encoding),httpStatus:null,response:null,mode};
  }
  const url=value(provider,"signatureAccessTokenUrl");
  if(!url)throw {error:"URL Signature Access Token (HIT_API) wajib diisi.",status:400};
  const allowPrivate=provider.data.allowPrivateKeyToSigner===true;
  const body:Record<string,unknown>={clientKey,timestamp,stringToSign:`${clientKey}|${timestamp}`};
  if(allowPrivate&&value(provider,"privateKey"))body.privateKey=decrypt(value(provider,"privateKey"));
  const hit=await hitApiSignature({url,body,headers:value(provider,"clientKey")?{"X-CLIENT-KEY":clientKey}:{}});
  if(!hit.signature)throw {error:`Layanan signature Access Token tidak mengembalikan signature (HTTP ${hit.httpStatus}).`,status:502};
  return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
}

async function resolveServiceSignature(provider:RecordRow,mode:SignatureMode,input:{method:string;relative:string;token:string;body:string;timestamp:string}){
  if(mode==="NONE")return {signature:"",httpStatus:null as number|null,response:null as unknown,mode};
  if(mode==="FUNCTION"){
    const secret=decrypt(value(provider,"clientSecret"));
    const encoding=encodingOf(provider.data.hmacEncoding,"hex");
    return {signature:getXSignatureServiceFunction(secret,input.method,input.relative,input.token,input.body,input.timestamp,encoding),httpStatus:null,response:null,mode};
  }
  const url=value(provider,"signatureServiceUrl");
  if(!url)throw {error:"URL Signature Service (HIT_API) wajib diisi.",status:400};
  const hit=await hitApiSignature({url,body:{method:input.method,relativeUrl:input.relative,accessToken:input.token,body:input.body,timestamp:input.timestamp}});
  if(!hit.signature)throw {error:`Layanan signature Service tidak mengembalikan signature (HTTP ${hit.httpStatus}).`,status:502};
  return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
}

async function httpJson(url:string,method:string,headers:Record<string,string>,body:string|undefined,timeoutMs=15000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{method,headers,body:method==="GET"||method==="HEAD"?undefined:body,signal:controller.signal,redirect:"manual"});
    const text=await response.text();
    let json:unknown=text;
    try{json=JSON.parse(text);}catch{/* keep text */}
    return {httpStatus:response.status,body:json,headers:Object.fromEntries(response.headers.entries())};
  }catch(error){
    if((error as Error)?.name==="AbortError")throw {error:"Request timeout.",status:504};
    throw {error:`Gagal menghubungi ${url}: ${(error as Error).message??"network error"}`,status:502};
  }finally{clearTimeout(timer);}
}

function joinUrl(base:string,path:string){
  const root=base.replace(/\/$/,"");
  const rel=path.startsWith("/")?path:`/${path}`;
  return `${root}${rel}`;
}

export async function runClientSimulator(db:DatabaseService,records:RecordRow[],operator:Operator,input:Record<string,unknown>){
  const provider=records.find(row=>row.id===input.providerId&&row.kind==="sim_provider");
  const service=records.find(row=>row.id===input.serviceId&&row.kind==="sim_service");
  if(!provider)throw {error:"Penyedia Client Simulator tidak ditemukan.",status:404};
  if(!service||service.parent_id!==provider.id)throw {error:"API Service tidak milik penyedia yang dipilih.",status:400};
  const testType=String(input.testType??"positive")==="negative"?"negative":"positive";
  const overrides=(input.overrides&&typeof input.overrides==="object"&&!Array.isArray(input.overrides)?input.overrides:{}) as SimulatorOverrides;
  const method=String(service.data.method??"POST").toUpperCase();
  if(!methods.has(method))throw {error:"Method HTTP service tidak valid.",status:400};
  const relative=String(service.data.path??service.data.serviceUrl??"").trim();
  if(!relative.startsWith("/")||relative.startsWith("//"))throw {error:"Service URL harus relative path diawali /.",status:400};
  const baseUrl=value(provider,"baseUrl");
  try{if(new URL(baseUrl).protocol!=="https:")throw new Error();}catch{throw {error:"Base URL penyedia wajib HTTPS.",status:400};}

  const clientKey=value(provider,"clientKey")||value(provider,"clientId");
  if(!clientKey)throw {error:"Client Key / Client ID penyedia wajib diisi.",status:400};

  const tsConfig=timestampConfig(provider,overrides);
  const timestamp=overrides.timestamp?.trim()?overrides.timestamp.trim():isoTimestamp(tsConfig);
  const partnerId=overrides.partnerId?.trim()||value(service,"partnerId")||value(provider,"partnerId")||clientKey;
  const channelId=overrides.channelId?.trim()||value(service,"channelId")||value(provider,"channelId")||"";
  const deviceId=overrides.deviceId?.trim()||value(service,"deviceId")||value(provider,"deviceId")||"";
  let externalId=overrides.externalId?.trim()||value(service,"externalId")||"";
  if(!externalId||overrides.regenerateExternalId===true)externalId=String(Date.now()).slice(-16);

  const bodyText=typeof overrides.body==="string"?overrides.body:typeof service.data.defaultBody==="string"?service.data.defaultBody:typeof service.data.requestBody==="string"?String(service.data.requestBody):"{}";
  const minified=method==="GET"||method==="HEAD"?"":minifyJsonBody(bodyText||"{}");

  const accessMode=normalizeSignatureMode(provider.data.signatureAccessTokenMode??"FUNCTION");
  const serviceMode=normalizeSignatureMode(provider.data.signatureServiceMode??"FUNCTION");
  const steps:Record<string,unknown>[]=[];

  const accessSign=await resolveAccessTokenSignature(provider,accessMode,clientKey,timestamp);
  steps.push({stage:"signature_access_token",mode:accessSign.mode,httpStatus:accessSign.httpStatus,response:accessSign.response,ok:true});

  let accessToken="";
  const tokenPath=value(provider,"accessTokenUrl")||"/api/v1.0/access-token/b2b";
  const tokenUrl=tokenPath.startsWith("http")?tokenPath:joinUrl(baseUrl,tokenPath);
  if(accessMode!=="NONE"||value(provider,"accessTokenUrl")){
    const tokenHeaders:Record<string,string>={"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientKey};
    if(accessSign.signature)tokenHeaders["X-SIGNATURE"]=accessSign.signature;
    const tokenBody=JSON.stringify({grantType:"client_credentials"});
    const tokenResult=await httpJson(tokenUrl,"POST",tokenHeaders,tokenBody);
    steps.push({stage:"access_token",uri:tokenUrl,httpStatus:tokenResult.httpStatus,request:{headers:redact(tokenHeaders),body:{grantType:"client_credentials"}},response:redact(tokenResult.body)});
    const tokenBodyObj=tokenResult.body&&typeof tokenResult.body==="object"?tokenResult.body as Record<string,unknown>:{};
    accessToken=String(tokenBodyObj.accessToken??tokenBodyObj.access_token??"");
    if(!accessToken)throw {error:`Access Token API tidak mengembalikan accessToken (HTTP ${tokenResult.httpStatus}).`,status:502};
  }else{
    steps.push({stage:"access_token",skipped:true,reason:"Mode NONE tanpa Access Token URL"});
  }

  const serviceSign=await resolveServiceSignature(provider,serviceMode,{method,relative,token:accessToken,body:minified,timestamp});
  steps.push({stage:"signature_service",mode:serviceSign.mode,httpStatus:serviceSign.httpStatus,response:serviceSign.response,ok:true});

  const serviceHeaders:Record<string,string>={
    "Content-Type":"application/json",
    "X-TIMESTAMP":timestamp,
    "X-PARTNER-ID":partnerId,
    "X-EXTERNAL-ID":externalId,
  };
  if(accessToken)serviceHeaders.Authorization=`Bearer ${accessToken}`;
  if(serviceSign.signature)serviceHeaders["X-SIGNATURE"]=serviceSign.signature;
  if(channelId)serviceHeaders["CHANNEL-ID"]=channelId;
  if(deviceId)serviceHeaders["X-DEVICE-ID"]=deviceId;
  for(const key of ["ORIGIN","X-IP-ADDRESS","X-LATITUDE","X-LONGITUDE"] as const){
    const headerKey=key==="ORIGIN"?"ORIGIN":key;
    const dataKey=key==="ORIGIN"?"origin":key==="X-IP-ADDRESS"?"ipAddress":key==="X-LATITUDE"?"latitude":"longitude";
    const val=value(provider,dataKey);
    if(val)serviceHeaders[headerKey]=val;
  }

  const serviceUrl=joinUrl(baseUrl,relative);
  const serviceResult=await httpJson(serviceUrl,method,serviceHeaders,method==="GET"||method==="HEAD"?undefined:minified);
  steps.push({stage:"service_request",uri:serviceUrl,httpStatus:serviceResult.httpStatus,request:{method,headers:redact(serviceHeaders),body:minified?JSON.parse(minified):null},response:redact(serviceResult.body)});

  const expectedHttp=Number(service.data.expectedHttpStatus??0)||null;
  const expectedCode=String(service.data.expectedCode??service.data.expectedSnapCode??"").trim()||null;
  const responseObj=serviceResult.body&&typeof serviceResult.body==="object"?serviceResult.body as Record<string,unknown>:{};
  const responseCode=String(responseObj.responseCode??"");

  let matched=false;
  if(testType==="positive"){
    if(expectedCode)matched=responseCode===expectedCode&&(expectedHttp?serviceResult.httpStatus===expectedHttp:true);
    else if(expectedHttp)matched=serviceResult.httpStatus===expectedHttp;
    else matched=serviceResult.httpStatus>=200&&serviceResult.httpStatus<300;
  }else{
    matched=expectedHttp?serviceResult.httpStatus===expectedHttp:serviceResult.httpStatus>=400;
  }

  const status=matched?"PASSED":"FAILED";
  const activityName=`${provider.name} - ${service.name} - ${testType==="positive"?"Positif":"Negatif"}`;
  const runId=randomUUID();
  const now=new Date().toISOString();
  const requestJson={
    mode:"client_sim",
    activityName,
    provider:{id:provider.id,name:provider.name},
    service:{id:service.id,name:service.name,method,path:relative},
    testType,
    timestamp,
    headers:redact(serviceHeaders),
    body:minified?JSON.parse(minified):null,
    uris:{accessToken:tokenUrl,service:serviceUrl},
    steps,
    overrides:redact(overrides),
    operator:{id:operator.id,name:operator.name,username:operator.username,role:operator.role},
    evaluation:{matched,expectedHttp,expectedCode,httpStatus:serviceResult.httpStatus,responseCode,testType},
  };
  await db.query(
    `INSERT INTO autosnap_runs (id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,scenario_id,mode,status,http_status,response_code,expected_code,duration_ms,request_json,response_json,notes,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)`,
    [runId,operator.id,provider.id,provider.id,provider.id,null,service.id,provider.id,null,"client_sim",status,serviceResult.httpStatus,responseCode||null,expectedCode,null,JSON.stringify(requestJson),JSON.stringify(redact(serviceResult.body)),activityName,now]
  );
  return {ok:true,id:runId,status,httpStatus:serviceResult.httpStatus,responseCode,matched,activityName,steps:requestJson.steps,request:redact(requestJson),response:redact(serviceResult.body)};
}
