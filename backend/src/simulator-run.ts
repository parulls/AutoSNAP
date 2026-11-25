import { randomUUID } from "node:crypto";
import type { DatabaseService, RecordRow } from "./database.service";
import type { Operator } from "./accounts";
import { decrypt, redact } from "./security";
import { inspectPdfProvenance, pdfContentSha256, pdfEvidenceFingerprint, validateAspiDownloadPdf } from "./aspi-evidence";
import { ASPI_SERVICE_NAME_MAX, buildClientSimulatorServiceName, buildSimulatorActivityEvidence, clientSimulatorDispatchOutcome, clientSimulatorServiceLabel, evaluateClientSimulator, normalizeClientSimulatorComponent, officialActivityId, type ClientSimulatorFormInput, type ClientSimulatorPortalResult } from "./aspi-client-simulator";
import { finalOutcome, isHttpResponse } from "./test-evaluation";
import { DUPLICATE_EXTERNAL_ID_MISSING, clientSimulatorScenario, corruptSignature, duplicateExternalIdAllowed, mintClientSimulatorExternalId, priorExternalIdFromRuns, replacementAccessToken, resolveScenarioExpectation, unknownPartnerId } from "./client-simulator-scenarios";
import {
  aspiSignatureTarget,
  getXSignatureAccessTokenFunction,
  getXSignatureServiceFunction,
  hitApiSignature,
  joinProviderUrl,
  normalizeEndpointPath,
  resolveSignerUrl,
  snapUtilityKind,
  snapUtilityRequest,
  toAspiPrivateKey,
  ensureFutureTimestamp,
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
  regenerateExternalId?:boolean;expectedHttpStatus?:string|number|null;expectedCode?:string|null;
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

function signatureHitError(kind:"auth"|"service",raw:string,httpStatus:number|null,response:unknown){
  let target=raw;
  try{const url=new URL(raw);target=`${url.host}${url.pathname}`;}catch{/* keep the raw value */}
  const body=response&&typeof response==="object"?response as Record<string,unknown>:{};
  const code=typeof body.responseCode==="string"?body.responseCode:"";
  const message=typeof body.responseMessage==="string"?body.responseMessage:"";
  const detail=[code,message].filter(Boolean).join(" ");
  const label=kind==="auth"?"Signature Authentication":"Signature Service";
  if(httpStatus===401||httpStatus===403)return `${label} ditolak ${target} (HTTP ${httpStatus}${detail?` ${detail}`:""}). Server menolak akses.`;
  if(httpStatus===400)return `${label} ditolak ${target} (HTTP 400${detail?` ${detail}`:""}). Periksa Client Secret, Access Token, EndpointUrl (path API Service), dan Request Body yang ditandatangani.`;
  return `${label} tidak mengembalikan signature (HTTP ${httpStatus??"—"} ${target}${detail?` ${detail}`:""}).`;
}

function signatureAuthMaterial(provider:RecordRow){
  const dedicated=decrypt(value(provider,"signatureAuthPrivateKey")).trim();
  const pem=decrypt(value(provider,"privateKey")).trim();
  for(const candidate of [dedicated,pem]){
    if(!candidate)continue;
    try{return toAspiPrivateKey(candidate);}catch{/* try the PEM stored for local signing */}
  }
  throw {error:"Private Key PEM tidak bisa diubah menjadi base64 untuk Signature Authentication. Isi Private Key PEM yang utuh.",status:400};
}

async function resolveAccessTokenSignature(provider:RecordRow,mode:SignatureMode,clientKey:string,timestamp:string,portal?:{user:RecordRow;gateway?:ClientSimulatorGateway}){
  if(mode==="NONE")return {signature:"",httpStatus:null as number|null,response:null as unknown,mode};
  if(mode==="FUNCTION"){
    const privateKey=decrypt(value(provider,"privateKey"));
    const encoding=encodingOf(provider.data.rsaEncoding,"base64");
    return {signature:getXSignatureAccessTokenFunction(privateKey,clientKey,timestamp,encoding),httpStatus:null,response:null,mode};
  }
  const url=resolveSignerUrl(value(provider,"signatureAccessTokenUrl"),value(provider,"baseUrl"));
  if(!url)throw {error:"Endpoint Signature Authentication (HIT_API) wajib diisi.",status:400};
  const signaturePrivateKey=signatureAuthMaterial(provider);
  if(aspiSignatureTarget(url,"auth")){
    if(!portal?.user||!portal.gateway?.hitAspiSignature)throw {error:"Signature Authentication ASPI membutuhkan sesi portal. Jalankan dari Client Simulator.",status:400};
    const hit=await portal.gateway.hitAspiSignature(portal.user,{kind:"auth",timestamp,clientKey,privateKey:signaturePrivateKey});
    return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
  }
  if(snapUtilityKind(url)==="auth"){
    const request=snapUtilityRequest("auth",{timestamp,clientKey,privateKey:signaturePrivateKey});
    const hit=await hitApiSignature({url,headers:request.headers,body:request.body});
    if(!hit.signature)throw {error:signatureHitError("auth",url,hit.httpStatus,hit.response),status:502};
    return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
  }
  const body:Record<string,unknown>={clientKey,timestamp,privateKey:signaturePrivateKey,stringToSign:`${clientKey}|${timestamp}`};
  const hit=await hitApiSignature({url,body,headers:{"X-CLIENT-KEY":clientKey}});
  if(!hit.signature)throw {error:signatureHitError("auth",url,hit.httpStatus,hit.response),status:502};
  return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
}

async function resolveServiceSignature(provider:RecordRow,mode:SignatureMode,input:{method:string;relative:string;token:string;body:string;timestamp:string},portal?:{user:RecordRow;gateway?:ClientSimulatorGateway}){
  if(mode==="NONE")return {signature:"",httpStatus:null as number|null,response:null as unknown,mode};
  if(mode==="FUNCTION"){
    const secret=decrypt(value(provider,"clientSecret"));
    const encoding=encodingOf(provider.data.hmacEncoding,"hex");
    return {signature:getXSignatureServiceFunction(secret,input.method,input.relative,input.token,input.body,input.timestamp,encoding),httpStatus:null,response:null,mode};
  }
  const url=resolveSignerUrl(value(provider,"signatureServiceUrl"),value(provider,"baseUrl"));
  if(!url)throw {error:"Endpoint Signature Service (HIT_API) wajib diisi.",status:400};
  const secret=decrypt(value(provider,"clientSecret"));
  if(!secret)throw {error:"Signature Service membutuhkan Client Secret penyedia.",status:400};
  if(aspiSignatureTarget(url,"service")){
    if(!portal?.user||!portal.gateway?.hitAspiSignature)throw {error:"Signature Service ASPI membutuhkan sesi portal. Jalankan dari Client Simulator.",status:400};
    const hit=await portal.gateway.hitAspiSignature(portal.user,{kind:"service",timestamp:input.timestamp,clientSecret:secret,method:input.method,endpoint:input.relative,accessToken:input.token,bodyText:input.body});
    if(!hit.signature)throw {error:signatureHitError("service",url,hit.httpStatus,hit.response),status:502};
    return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
  }
  if(snapUtilityKind(url)==="service"){
    const request=snapUtilityRequest("service",{timestamp:input.timestamp,clientSecret:secret,method:input.method,endpoint:input.relative,accessToken:input.token,bodyText:input.body});
    const hit=await hitApiSignature({url,headers:request.headers,body:request.body});
    if(!hit.signature)throw {error:signatureHitError("service",url,hit.httpStatus,hit.response),status:502};
    return {signature:hit.signature,httpStatus:hit.httpStatus,response:hit.response,mode};
  }
  throw {error:`Endpoint Signature Service tidak dikenali sebagai signature-service SNAP: ${url}. Contoh: /snapgov/api/v1.0.0/utilities/signature-service`,status:400};
}

function fetchFailure(url:string,error:unknown){
  const cause=(error as {cause?:{code?:string;message?:string}}).cause;
  const code=cause?.code??"";
  const detail=cause?.message||(error as Error).message||"network error";
  if(/CERT|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|SELF_SIGNED/.test(code))return `Gagal menghubungi ${url}: sertifikat TLS tidak dipercaya (${code}).`;
  return `Gagal menghubungi ${url}: ${detail}${code?` (${code})`:""}`;
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
    throw {error:fetchFailure(url,error),status:502};
  }finally{clearTimeout(timer);}
}

function joinUrl(base:string,path:string){
  return joinProviderUrl(base,path);
}

export type AspiSignatureHit={
  kind:"auth"|"service";
  timestamp:string;
  clientKey?:string;
  privateKey?:string;
  clientSecret?:string;
  method?:string;
  endpoint?:string;
  accessToken?:string;
  bodyText?:string;
};
export type ClientSimulatorGateway={
  submit(user:RecordRow,form:ClientSimulatorFormInput):Promise<ClientSimulatorPortalResult>;
  hitAspiSignature?(user:RecordRow,input:AspiSignatureHit):Promise<{signature:string;httpStatus:number|null;response:unknown}>;
};

export async function runClientSimulator(db:DatabaseService,records:RecordRow[],operator:Operator,input:Record<string,unknown>,gateway?:ClientSimulatorGateway,onProgress?:(stage:string,status:"running"|"completed"|"failed",detail?:string)=>Promise<void>,signal?:AbortSignal){
  let stage="preparing";
  const report=async(next:string,status:"running"|"completed"|"failed",detail="")=>{stage=next;await onProgress?.(next,status,detail);};
  const cancelled=()=>signal?.aborted?Promise.reject({error:"Pengujian dibatalkan pengguna.",status:499}):undefined;
  const provider=records.find(row=>row.id===input.providerId&&row.kind==="sim_provider");
  const service=records.find(row=>row.id===input.serviceId&&row.kind==="sim_service");
  if(!provider)throw {error:"Penyedia Client Simulator tidak ditemukan.",status:404};
  if(!service||service.parent_id!==provider.id)throw {error:"API Service tidak milik penyedia yang dipilih.",status:400};
  const providerName=normalizeClientSimulatorComponent(provider.name,"Nama penyedia");
  const registeredServiceName=normalizeClientSimulatorComponent(service.name,"Nama service");
  const scenario=clientSimulatorScenario(input.scenarioId);
  const scenarioName=scenario.label;
  const expectation=resolveScenarioExpectation(scenario,service.data);
  const aspiServiceName=buildClientSimulatorServiceName(providerName,registeredServiceName,scenarioName);
  const overrides=(input.overrides&&typeof input.overrides==="object"&&!Array.isArray(input.overrides)?input.overrides:{}) as SimulatorOverrides;
  const expectedHttp=expectation.expectedHttp;
  const expectedCode=expectation.expectedCode;
  const expectedMessage=expectation.expectedMessage;
  const method=String(service.data.method??"POST").toUpperCase();
  if(!methods.has(method))throw {error:"Method HTTP service tidak valid.",status:400};
  const relative=String(service.data.path??service.data.serviceUrl??"").trim();
  if(!relative.startsWith("/")||relative.startsWith("//"))throw {error:"Service URL harus relative path diawali /.",status:400};
  const baseUrl=value(provider,"baseUrl");
  try{if(new URL(baseUrl).protocol!=="https:")throw new Error();}catch{throw {error:"Base URL penyedia wajib HTTPS.",status:400};}

  const clientKey=value(provider,"clientKey")||value(provider,"clientId");
  if(!clientKey)throw {error:"Client Key / Client ID penyedia wajib diisi.",status:400};

  const tsConfig=timestampConfig(provider,overrides);
  const timestamp=ensureFutureTimestamp(tsConfig,overrides.timestamp,"positive");
  const partnerId=overrides.partnerId?.trim()||value(service,"partnerId")||value(provider,"partnerId")||clientKey;
  const channelId=overrides.channelId?.trim()||value(service,"channelId")||value(provider,"channelId")||"";
  const deviceId=overrides.deviceId?.trim()||value(service,"deviceId")||value(provider,"deviceId")||"";
  let externalId=overrides.externalId?.trim()||value(service,"externalId")||"";
  let sourceRunId:string|null=null;
  const externalDay=timestamp.slice(0,10);
  if(scenario.mutation==="EXTERNAL_ID_REUSE"){
    if(input.confirmDuplicateExternalId!==true)throw {error:"Konfirmasi diperlukan sebelum mengirim ulang X-EXTERNAL-ID yang sudah pernah dikirim.",status:400};
    if(!duplicateExternalIdAllowed(baseUrl,provider.data.allowDuplicateExternalId===true))throw {error:"Skenario X-EXTERNAL-ID duplikat hanya diizinkan pada environment sandbox atau pengujian.",status:400};
    const previousRows=await db.query<{id:string;request_json:Record<string,unknown>;http_status:number|null;response_code:string|null;created_at:string}>("SELECT id, request_json, http_status, response_code, created_at FROM autosnap_runs WHERE mode='client_sim' AND environment_id=$1 AND service_id=$2 ORDER BY created_at DESC LIMIT 40",[provider.id,service.id]);
    const previous=priorExternalIdFromRuns(previousRows.map(row=>({id:row.id,request:row.request_json&&typeof row.request_json==="object"?row.request_json:null,httpStatus:row.http_status,responseCode:row.response_code,createdAt:row.created_at})),{serviceId:service.id,partnerId,day:externalDay});
    if(!previous)throw {error:DUPLICATE_EXTERNAL_ID_MISSING,status:409};
    externalId=previous.externalId;
    sourceRunId=previous.sourceRunId;
  }else{
    if(!externalId||overrides.regenerateExternalId===true)externalId=mintClientSimulatorExternalId();
    const claimedExternal=await db.query("INSERT INTO autosnap_external_ids (environment_id,external_id,day) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING external_id",[provider.id,externalId,externalDay]);
    if(!claimedExternal.length)throw {error:"X-EXTERNAL-ID sudah dipakai pada hari ini. Buat pengujian baru agar ID tidak bertabrakan.",status:409};
  }

  const bodyText=typeof overrides.body==="string"?overrides.body:typeof service.data.defaultBody==="string"?service.data.defaultBody:typeof service.data.requestBody==="string"?String(service.data.requestBody):"{}";
  if(bodyText.includes("replaced_in_prescript"))throw {error:"Request body masih berisi replaced_in_prescript. Di koleksi SNAP Batubara: partnerServiceId dan prefix_real = 9296, additionalInfo.clientid = 51.",status:400};
  if(!channelId.trim())throw {error:"CHANNEL-ID wajib diisi untuk form Client Simulator ASPI.",status:400};
  if(!deviceId.trim())throw {error:"X-DEVICE-ID wajib. Bank Sumut menolak request tanpa header ini. Koleksi SNAP Batubara memakai h2hBatubara.",status:400};
  const minified=method==="GET"||method==="HEAD"?"":minifyJsonBody(bodyText||"{}");

  const accessMode=normalizeSignatureMode(provider.data.signatureAccessTokenMode??"FUNCTION");
  const serviceMode=normalizeSignatureMode(provider.data.signatureServiceMode??"FUNCTION");
  const snapUser=records.find(row=>row.id===input.snapUserId&&row.kind==="snap_user");
  if(!snapUser)throw {error:"Pilih User SNAP untuk login ke portal ASPI.",status:400};
  if(!value(snapUser,"email")&&!value(snapUser,"username"))throw {error:"User SNAP belum punya email login portal ASPI.",status:400};
  if(!value(snapUser,"password"))throw {error:"User SNAP belum punya password portal ASPI.",status:400};
  const signer={user:snapUser,gateway};
  const signatureAuthUrl=accessMode==="HIT_API"?resolveSignerUrl(value(provider,"signatureAccessTokenUrl"),baseUrl):"";
  const signatureServiceUrl=serviceMode==="HIT_API"?resolveSignerUrl(value(provider,"signatureServiceUrl"),baseUrl):"";
  const accessViaAspi=accessMode==="HIT_API"&&!!aspiSignatureTarget(signatureAuthUrl,"auth");
  const serviceViaAspi=serviceMode==="HIT_API"&&!!aspiSignatureTarget(signatureServiceUrl,"service");
  const steps:Record<string,unknown>[]=[];
  const runId=randomUUID();
  const activityName=aspiServiceName;
  const openedAt=new Date().toISOString();
  const started=Date.now();
  let durable=false;
  let dispatch:"NOT_SENT"|"SEND_STARTED"="NOT_SENT";
  const identity={providerId:provider.id,providerName,serviceId:service.id,serviceName:registeredServiceName,scenarioId:scenario.id,scenarioName,aspiServiceName};
  const evaluationPolicy={expectedHttp,expectedCode,expectedMessage,mutation:scenario.mutation};
  try{
  await db.query(
    `INSERT INTO autosnap_runs (id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,scenario_id,mode,status,http_status,response_code,expected_code,duration_ms,request_json,response_json,notes,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)`,
    [runId,operator.id,provider.id,provider.id,provider.id,snapUser.id,service.id,provider.id,scenario.id,"client_sim","RUNNING",null,null,expectedCode,0,JSON.stringify({mode:"client_sim",progressId:typeof input.progressId==="string"?input.progressId:null,activityName,aspiServiceName,scenarioId:scenario.id,scenarioName,identity,evaluationPolicy,scenario:{id:scenario.id,label:scenario.label,mutation:scenario.mutation,mutationApplied:false,sourceRunId},dispatch,idempotency:{externalId,serviceId:service.id,partnerId,timestamp},body:redact(JSON.parse(minified||"{}")),operator:{id:operator.id,name:operator.name,username:operator.username,role:operator.role}}),JSON.stringify({}),`${activityName}. Send belum dikirim.`,openedAt]
  );
  durable=true;

  await cancelled();
  await report("signature_auth","running",accessViaAspi?`${aspiServiceName} — Signature Authentication lewat halaman Keamanan ASPI`:`${aspiServiceName} — Signature Access Token ${accessMode}`);
  const accessSign=await resolveAccessTokenSignature(provider,accessMode,clientKey,timestamp,signer);
  steps.push({stage:"signature_access_token",mode:accessSign.mode,httpStatus:accessSign.httpStatus,response:accessSign.response,ok:true});
  await report("signature_auth","completed",`Signature Access Token ${accessSign.mode}`);

  let accessToken="";
  const tokenPath=normalizeEndpointPath(value(provider,"accessTokenUrl")||"/api/v1.0/access-token/b2b",baseUrl);
  const tokenUrl=joinUrl(baseUrl,tokenPath);
  if(accessMode!=="NONE"||value(provider,"accessTokenUrl")){
    const tokenHeaders:Record<string,string>={"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientKey};
    if(accessSign.signature)tokenHeaders["X-SIGNATURE"]=accessSign.signature;
    const tokenPayload={grantType:"client_credentials",additionalInfo:{}};
    const tokenBody=JSON.stringify(tokenPayload);
    await report("access_token","running",accessSign.signature?`${tokenUrl} — X-SIGNATURE dari Signature Authentication`:`${tokenUrl}`);
    const tokenResult=await httpJson(tokenUrl,"POST",tokenHeaders,tokenBody);
    steps.push({stage:"access_token",uri:tokenUrl,httpStatus:tokenResult.httpStatus,request:{headers:redact(tokenHeaders),body:tokenPayload},response:redact(tokenResult.body)});
    const tokenBodyObj=tokenResult.body&&typeof tokenResult.body==="object"?tokenResult.body as Record<string,unknown>:{};
    accessToken=String(tokenBodyObj.accessToken??tokenBodyObj.access_token??"");
    const tokenCode=String(tokenBodyObj.responseCode??"");
    if(tokenResult.httpStatus<200||tokenResult.httpStatus>=300||(tokenCode&&!tokenCode.startsWith("2"))||!accessToken){
      const code=String(tokenBodyObj.responseCode??"");
      const message=String(tokenBodyObj.responseMessage??"");
      throw {error:`Access Token ditolak (HTTP ${tokenResult.httpStatus}${code?` ${code}`:""}${message?`: ${message}`:""}).`,status:502};
    }
    await report("access_token","completed",`HTTP ${tokenResult.httpStatus} ${String(tokenBodyObj.responseCode??"")}`.trim());
  }else{
    steps.push({stage:"access_token",skipped:true,reason:"Mode NONE tanpa Access Token URL"});
    await report("access_token","completed","Access Token tidak diminta.");
  }

  const signedBody=minified||"{}";
  await report("signature_service","running",serviceViaAspi?`${method} ${relative} — Signature Service lewat halaman Keamanan ASPI`:`${method} ${relative}`);
  let sentToken=accessToken;
  if(scenario.mutation==="ACCESS_TOKEN")sentToken=replacementAccessToken(accessToken);
  // HIT_API / ASPI signature-service validates AccessToken. Negative token mutation must not break signing.
  // Invalid token is applied only on the Client Simulator API Service request.
  const remoteSigning=serviceMode==="HIT_API"||serviceViaAspi;
  const signingToken=scenario.mutation==="ACCESS_TOKEN"&&remoteSigning?accessToken:sentToken;
  const serviceSign=await resolveServiceSignature(provider,serviceMode,{method,relative,token:signingToken,body:signedBody,timestamp},signer);
  steps.push({stage:"signature_service",mode:serviceSign.mode,httpStatus:serviceSign.httpStatus,response:serviceSign.response,ok:true});
  await report("signature_service","completed",scenario.mutation==="ACCESS_TOKEN"&&remoteSigning?`Signature Service ${serviceSign.mode} — token valid untuk signing; token invalid hanya ke API Service`:`Signature Service ${serviceSign.mode}`);
  if(!serviceSign.signature)throw {error:"X-SIGNATURE kosong. Isi Client Secret dengan mode FUNCTION, atau URL signature HIT_API.",status:400};
  let sentSignature=serviceSign.signature;
  if(scenario.mutation==="ACCESS_TOKEN"&&remoteSigning){
    const secret=decrypt(value(provider,"clientSecret"));
    if(!secret)throw {error:"Skenario Access Token Invalid membutuhkan Client Secret agar X-SIGNATURE bisa dihitung untuk token invalid tanpa mengirim token palsu ke signature-service bank.",status:400};
    sentSignature=getXSignatureServiceFunction(secret,method,relative,sentToken,signedBody,timestamp,encodingOf(provider.data.hmacEncoding,"hex"));
  }else if(scenario.mutation==="SIGNATURE")sentSignature=corruptSignature(serviceSign.signature);
  const sentPartner=scenario.mutation==="PARTNER_ID"?unknownPartnerId(partnerId,String(service.data.unknownPartnerId??"")):partnerId;
  steps.push({stage:"scenario_mutation",mutation:scenario.mutation,applied:true,sourceRunId,remoteSigningProtected:scenario.mutation==="ACCESS_TOKEN"&&remoteSigning});
  if(!gateway)throw {error:"Sesi portal ASPI tidak tersedia pada server ini.",status:500};

  const serviceHeaders:Record<string,string>={
    "Content-Type":"application/json",
    "X-TIMESTAMP":timestamp,
    "X-PARTNER-ID":sentPartner,
    "X-EXTERNAL-ID":externalId,
    "X-SIGNATURE":sentSignature,
    "CHANNEL-ID":channelId,
  };
  if(sentToken)serviceHeaders.Authorization=`Bearer ${sentToken}`;
  if(deviceId)serviceHeaders["X-DEVICE-ID"]=deviceId;
  const origin=value(provider,"origin"),ipAddress=value(provider,"ipAddress"),latitude=value(provider,"latitude"),longitude=value(provider,"longitude");
  if(origin)serviceHeaders.ORIGIN=origin;
  if(ipAddress)serviceHeaders["X-IP-ADDRESS"]=ipAddress;
  if(latitude)serviceHeaders["X-LATITUDE"]=latitude;
  if(longitude)serviceHeaders["X-LONGITUDE"]=longitude;

  const serviceUrl=joinUrl(baseUrl,relative);
  await cancelled();
  dispatch="SEND_STARTED";
  await db.query("UPDATE autosnap_runs SET notes=$1, request_json=jsonb_set(request_json,'{dispatch}',$2::jsonb,true) WHERE id=$3",[`${activityName}. Send sudah dimulai. Jika proses terputus, transaksi mungkin sudah terkirim dan tidak boleh dikirim ulang.`,JSON.stringify("SEND_STARTED"),runId]);
  await report("api_request","running",`${aspiServiceName} — mengisi form ASPI lalu menunggu Download.`);
  const portal=await gateway.submit(snapUser,{
    serviceName:aspiServiceName,
    uri:serviceUrl,
    method,
    contentType:"application/json",
    timestamp,
    signature:sentSignature,
    partnerId:sentPartner,
    externalId,
    channelId,
    body:signedBody,
    authorization:sentToken?`Bearer ${sentToken}`:undefined,
    deviceId:deviceId||undefined,
    clientKey:clientKey||undefined,
    origin:origin||undefined,
    ipAddress:ipAddress||undefined,
    latitude:latitude||undefined,
    longitude:longitude||undefined,
  });
  steps.push({stage:"aspi_client_simulator",form:"https://apidevportal.aspi-indonesia.or.id/client-simulator",activityPage:"https://apidevportal.aspi-indonesia.or.id/client-simulator-activity"});
  steps.push(...portal.steps.map(step=>redact(step) as Record<string,unknown>));

  const responseObj=portal.response&&typeof portal.response==="object"&&!Array.isArray(portal.response)?portal.response as Record<string,unknown>:{};
  const responseCode=String(responseObj.responseCode??"");
  const responseMessage=String(responseObj.responseMessage??"");
  const httpSource=portal.httpSource??(isHttpResponse(portal.httpStatus)?"target_api":"unavailable");
  const httpStatus=httpSource==="target_api"&&isHttpResponse(portal.httpStatus)?portal.httpStatus:null;
  const evaluation=evaluateClientSimulator({httpStatus,responseCode,responseMessage,expectedHttp,expectedCode,expectedMessage,httpSource});
  const activity=portal.activity;
  const portalService=activity?clientSimulatorServiceLabel([],activity.serviceSource==="portal"?[activity.service]:[activity.service]):{service:"",serviceSource:"unavailable" as const};
  const evidenceServiceName=(activity?.serviceSource==="portal"&&activity.service?activity.service:portalService.service)||aspiServiceName;
  const serviceSource=evidenceServiceName===aspiServiceName&&portalService.serviceSource!=="portal"?"autosnap_snapshot":"portal";
  let status=finalOutcome(evaluation.evaluation,false);
  const now=new Date().toISOString();
  let pdfReady=false;
  let pdfError=portal.pdfError;
  const officialId=officialActivityId(activity?.activityId);
  const evidence=officialId?buildSimulatorActivityEvidence({runId,activityId:officialId,serviceId:service.id,serviceName:evidenceServiceName,scenarioName,savedAt:activity?.timestamp||null,downloadUrl:activity?.downloadUrl||null,pdfReady:false,evidenceStatus:portal.pdf?"DOWNLOADING":pdfError?"FAILED":"PENDING"}):null;
  const aspiActivities=evidence?[{...evidence,service:evidence.serviceName,serviceSource,timestamp:activity?.timestamp??"",authenticity:undefined as string|undefined}]:[];
  const requestJson={
    mode:"client_sim",
    activityName,
    aspiServiceName,
    provider:{id:provider.id,name:providerName},
    service:{id:service.id,name:registeredServiceName,method,path:relative},
    snapUser:{id:snapUser.id,name:snapUser.name},
    scenarioId:scenario.id,
    scenarioName,
    scenario:{id:scenario.id,label:scenario.label,mutation:scenario.mutation,mutationApplied:true,sourceRunId},
    identity,
    evaluationPolicy,
    actual:{httpStatus,responseCode,responseMessage,httpSource},
    timestamp,
    headers:redact(serviceHeaders),
    dispatch:"SENT",
    idempotency:{externalId,serviceId:service.id,partnerId,timestamp},
    body:redact(JSON.parse(signedBody)),
    uris:{accessToken:tokenUrl,service:serviceUrl,form:"https://apidevportal.aspi-indonesia.or.id/client-simulator",activity:"https://apidevportal.aspi-indonesia.or.id/client-simulator-activity"},
    steps,
    overrides:redact(overrides),
    operator:{id:operator.id,name:operator.name,username:operator.username,role:operator.role},
    outcome:status,
    evaluation:evaluation.evaluation,
    aspiActivities,
    evidenceErrors:pdfError?[pdfError]:[] as string[],
    pdfCounts:{ready:0,required:1},
    reprocess:{retryEvidence:Boolean(officialId)&&!portal.pdf,resumeTesting:false,requireMutatingConfirm:false},
  };
  const noteFor=(ready:boolean,problem:string|null)=>!activity?`${activityName}. ${problem||"Hasil tidak masuk ke Client Simulator Activity."}`:(problem&&!ready?`${activityName}. ${problem}`:activityName);
  await db.query(
    `UPDATE autosnap_runs SET status=$1,http_status=$2,response_code=$3,expected_code=$4,duration_ms=$5,request_json=$6::jsonb,response_json=$7::jsonb,notes=$8 WHERE id=$9`,
    [status,httpStatus,responseCode||null,expectedCode,Date.now()-started,JSON.stringify(requestJson),JSON.stringify(redact(portal.response)),noteFor(false,pdfError),runId]
  );
  if(portal.pdf&&activity){
    try{
      const pdf=validateAspiDownloadPdf(portal.pdf);
      const hash=pdfContentSha256(pdf);
      const fingerprint=pdfEvidenceFingerprint(pdf);
      const provenance=inspectPdfProvenance(pdf);
      await db.query(
        `INSERT INTO autosnap_evidence_pdfs(
           run_id,activity_id,service,pdf_data,byte_size,content_sha256,content_fingerprint,
           verification_status,pdf_producer,source_url,downloaded_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'CAPTURED',$8,$9,$10,$10)
         ON CONFLICT (run_id, activity_id) DO UPDATE SET
           service=EXCLUDED.service, pdf_data=EXCLUDED.pdf_data, byte_size=EXCLUDED.byte_size,
           content_sha256=EXCLUDED.content_sha256, content_fingerprint=EXCLUDED.content_fingerprint,
           verification_status='CAPTURED', pdf_producer=EXCLUDED.pdf_producer, source_url=EXCLUDED.source_url, downloaded_at=EXCLUDED.downloaded_at`,
        [runId,activity.activityId,evidenceServiceName.slice(0,ASPI_SERVICE_NAME_MAX),pdf,pdf.length,hash,fingerprint,provenance.producer||null,activity.downloadUrl,now]
      );
      pdfReady=true;
      pdfError=null;
      if(aspiActivities[0]){aspiActivities[0].pdfReady=true;aspiActivities[0].evidenceStatus="CAPTURED";aspiActivities[0].authenticity="aspi-html2pdf-download";}
      requestJson.evidenceErrors=[];
      requestJson.pdfCounts.ready=1;
      requestJson.reprocess.retryEvidence=false;
      status=finalOutcome(evaluation.evaluation,true);
      requestJson.outcome=status;
      requestJson.evaluation={...evaluation.evaluation,outcome:status,detail:status==="PASSED"?evaluation.evaluation.detail.replace(/Pengumpulan bukti PDF belum selesai\.?/,"Bukti PDF lengkap."):evaluation.evaluation.detail,suggestion:status==="PASSED"?"":evaluation.evaluation.suggestion};
      await db.query("UPDATE autosnap_runs SET status=$1, request_json=$2::jsonb, notes=$3 WHERE id=$4",[status,JSON.stringify(requestJson),noteFor(true,null),runId]);
    }catch(error){
      pdfError=error instanceof Error?error.message:"PDF berhasil diterima tetapi gagal disimpan. Status evidence belum lengkap.";
      requestJson.evidenceErrors=[pdfError];
      requestJson.reprocess.retryEvidence=Boolean(officialId);
      if(aspiActivities[0])aspiActivities[0].evidenceStatus="FAILED";
      await db.query("UPDATE autosnap_runs SET request_json=$1::jsonb, notes=$2 WHERE id=$3",[JSON.stringify(requestJson),noteFor(false,pdfError),runId]);
    }
  }
  const evaluationStep=status==="FAILED"||status==="AUTOMATION_ERROR"||status==="VALIDATION_ERROR"?"failed":"completed";
  await report("evaluation",evaluationStep,`${status} — ${requestJson.evaluation.detail}`);
  if(pdfReady)await report("pdf_store","completed","PDF resmi ASPI tersimpan.");
  else if(pdfError)await report("pdf_store","failed",pdfError);
  return {ok:true,id:runId,status,httpStatus,responseCode,matched:evaluation.matched,activityName,pdfReady,pdfError,aspiActivities,steps:requestJson.steps,request:redact(requestJson),response:redact(portal.response),notes:noteFor(pdfReady,pdfError)};
  }catch(error){
    const message=error instanceof Error?error.message:error&&typeof error==="object"&&"error" in error?String((error as {error:unknown}).error):"Client Simulator gagal.";
    if(durable){
      const outcome=clientSimulatorDispatchOutcome(dispatch,signal?.aborted===true);
      await db.query("UPDATE autosnap_runs SET status=$1, notes=$2, duration_ms=$3, request_json=request_json || $4::jsonb WHERE id=$5",[outcome,message,Date.now()-started,JSON.stringify({dispatch,outcome}),runId]).catch(()=>undefined);
    }
    await onProgress?.(stage,"failed",message).catch(()=>undefined);
    throw error;
  }
}
