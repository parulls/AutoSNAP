import { randomUUID } from "node:crypto";
import type { DatabaseService, RecordRow } from "./database.service";
import type { Operator } from "./accounts";
import { decrypt, redact } from "./security";
import { inspectPdfProvenance, pdfContentSha256, pdfEvidenceFingerprint, validateAspiDownloadPdf } from "./aspi-evidence";
import { clientSimulatorServiceName, evaluateClientSimulator, type ClientSimulatorFormInput, type ClientSimulatorPortalResult } from "./aspi-client-simulator";
import {
  getXSignatureAccessTokenFunction,
  getXSignatureServiceFunction,
  hitApiSignature,
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
  const root=base.replace(/\/$/,"");
  const rel=path.startsWith("/")?path:`/${path}`;
  return `${root}${rel}`;
}

export type ClientSimulatorGateway={
  submit(user:RecordRow,form:ClientSimulatorFormInput):Promise<ClientSimulatorPortalResult>;
};

export async function runClientSimulator(db:DatabaseService,records:RecordRow[],operator:Operator,input:Record<string,unknown>,gateway?:ClientSimulatorGateway,onProgress?:(stage:string,status:"running"|"completed"|"failed",detail?:string)=>Promise<void>,signal?:AbortSignal){
  let stage="preparing";
  const report=async(next:string,status:"running"|"completed"|"failed",detail="")=>{stage=next;await onProgress?.(next,status,detail);};
  const cancelled=()=>signal?.aborted?Promise.reject({error:"Pengujian dibatalkan pengguna.",status:499}):undefined;
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
  const timestamp=ensureFutureTimestamp(tsConfig,overrides.timestamp,testType);
  const partnerId=overrides.partnerId?.trim()||value(service,"partnerId")||value(provider,"partnerId")||clientKey;
  const channelId=overrides.channelId?.trim()||value(service,"channelId")||value(provider,"channelId")||"";
  const deviceId=overrides.deviceId?.trim()||value(service,"deviceId")||value(provider,"deviceId")||"";
  let externalId=overrides.externalId?.trim()||value(service,"externalId")||"";
  if(!externalId||overrides.regenerateExternalId===true)externalId=String(Date.now()).slice(-16);

  const bodyText=typeof overrides.body==="string"?overrides.body:typeof service.data.defaultBody==="string"?service.data.defaultBody:typeof service.data.requestBody==="string"?String(service.data.requestBody):"{}";
  if(bodyText.includes("replaced_in_prescript"))throw {error:"Request body masih berisi replaced_in_prescript. Di koleksi SNAP Batubara: partnerServiceId dan prefix_real = 9296, additionalInfo.clientid = 51.",status:400};
  if(!channelId.trim())throw {error:"CHANNEL-ID wajib diisi untuk form Client Simulator ASPI.",status:400};
  if(!deviceId.trim())throw {error:"X-DEVICE-ID wajib. Bank Sumut menolak request tanpa header ini. Koleksi SNAP Batubara memakai h2hBatubara.",status:400};
  const minified=method==="GET"||method==="HEAD"?"":minifyJsonBody(bodyText||"{}");

  const accessMode=normalizeSignatureMode(provider.data.signatureAccessTokenMode??"FUNCTION");
  const serviceMode=normalizeSignatureMode(provider.data.signatureServiceMode??"FUNCTION");
  const steps:Record<string,unknown>[]=[];
  try{

  await cancelled();
  await report("signature_auth","running",`${service.name} — Signature Access Token ${accessMode}`);
  const accessSign=await resolveAccessTokenSignature(provider,accessMode,clientKey,timestamp);
  steps.push({stage:"signature_access_token",mode:accessSign.mode,httpStatus:accessSign.httpStatus,response:accessSign.response,ok:true});
  await report("signature_auth","completed",`Signature Access Token ${accessSign.mode}`);

  let accessToken="";
  const tokenPath=value(provider,"accessTokenUrl")||"/api/v1.0/access-token/b2b";
  const tokenUrl=tokenPath.startsWith("http")?tokenPath:joinUrl(baseUrl,tokenPath);
  if(accessMode!=="NONE"||value(provider,"accessTokenUrl")){
    const tokenHeaders:Record<string,string>={"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientKey};
    if(accessSign.signature)tokenHeaders["X-SIGNATURE"]=accessSign.signature;
    const tokenPayload={grantType:"client_credentials",additionalInfo:{}};
    const tokenBody=JSON.stringify(tokenPayload);
    await report("access_token","running",tokenUrl);
    const tokenResult=await httpJson(tokenUrl,"POST",tokenHeaders,tokenBody);
    steps.push({stage:"access_token",uri:tokenUrl,httpStatus:tokenResult.httpStatus,request:{headers:redact(tokenHeaders),body:tokenPayload},response:redact(tokenResult.body)});
    const tokenBodyObj=tokenResult.body&&typeof tokenResult.body==="object"?tokenResult.body as Record<string,unknown>:{};
    accessToken=String(tokenBodyObj.accessToken??tokenBodyObj.access_token??"");
    if(!accessToken){
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
  await report("signature_service","running",`${method} ${relative}`);
  const serviceSign=await resolveServiceSignature(provider,serviceMode,{method,relative,token:accessToken,body:signedBody,timestamp});
  steps.push({stage:"signature_service",mode:serviceSign.mode,httpStatus:serviceSign.httpStatus,response:serviceSign.response,ok:true});
  await report("signature_service","completed",`Signature Service ${serviceSign.mode}`);
  if(!serviceSign.signature)throw {error:"X-SIGNATURE kosong. Isi Client Secret dengan mode FUNCTION, atau URL signature HIT_API.",status:400};
  const snapUser=records.find(row=>row.id===input.snapUserId&&row.kind==="snap_user");
  if(!snapUser)throw {error:"Pilih User SNAP untuk login ke portal ASPI.",status:400};
  if(!value(snapUser,"email")&&!value(snapUser,"username"))throw {error:"User SNAP belum punya email login portal ASPI.",status:400};
  if(!value(snapUser,"password"))throw {error:"User SNAP belum punya password portal ASPI.",status:400};
  if(!gateway)throw {error:"Sesi portal ASPI tidak tersedia pada server ini.",status:500};

  const serviceHeaders:Record<string,string>={
    "Content-Type":"application/json",
    "X-TIMESTAMP":timestamp,
    "X-PARTNER-ID":partnerId,
    "X-EXTERNAL-ID":externalId,
    "X-SIGNATURE":serviceSign.signature,
    "CHANNEL-ID":channelId,
  };
  if(accessToken)serviceHeaders.Authorization=`Bearer ${accessToken}`;
  if(deviceId)serviceHeaders["X-DEVICE-ID"]=deviceId;
  const origin=value(provider,"origin"),ipAddress=value(provider,"ipAddress"),latitude=value(provider,"latitude"),longitude=value(provider,"longitude");
  if(origin)serviceHeaders.ORIGIN=origin;
  if(ipAddress)serviceHeaders["X-IP-ADDRESS"]=ipAddress;
  if(latitude)serviceHeaders["X-LATITUDE"]=latitude;
  if(longitude)serviceHeaders["X-LONGITUDE"]=longitude;

  const serviceUrl=joinUrl(baseUrl,relative);
  const aspiServiceName=clientSimulatorServiceName(service.name,testType);
  const started=Date.now();
  await cancelled();
  await report("api_request","running",`${aspiServiceName} — mengisi form ASPI lalu menunggu Download.`);
  const portal=await gateway.submit(snapUser,{
    serviceName:aspiServiceName,
    uri:serviceUrl,
    method,
    contentType:"application/json",
    timestamp,
    signature:serviceSign.signature,
    partnerId,
    externalId,
    channelId,
    body:signedBody,
    authorization:accessToken?`Bearer ${accessToken}`:undefined,
    deviceId:deviceId||undefined,
    clientKey:clientKey||undefined,
    origin:origin||undefined,
    ipAddress:ipAddress||undefined,
    latitude:latitude||undefined,
    longitude:longitude||undefined,
  });
  steps.push({stage:"aspi_client_simulator",form:"https://apidevportal.aspi-indonesia.or.id/client-simulator",activityPage:"https://apidevportal.aspi-indonesia.or.id/client-simulator-activity"});
  steps.push(...portal.steps.map(step=>redact(step) as Record<string,unknown>));

  const expectedHttp=Number(service.data.expectedHttpStatus??0)||null;
  const expectedCode=String(service.data.expectedCode??service.data.expectedSnapCode??"").trim()||null;
  const responseObj=portal.response&&typeof portal.response==="object"&&!Array.isArray(portal.response)?portal.response as Record<string,unknown>:{};
  const responseCode=String(responseObj.responseCode??"");
  const httpStatus=portal.httpStatus??(typeof responseObj.httpStatus==="number"?responseObj.httpStatus:null);
  const evaluation=evaluateClientSimulator({testType,httpStatus,responseCode,expectedHttp,expectedCode});
  const activity=portal.activity;
  const status=activity?evaluation.status:"FAILED";
  const activityName=`${provider.name} - ${service.name} - ${testType==="positive"?"Positif":"Negatif"}`;
  const runId=randomUUID();
  const now=new Date().toISOString();
  let pdfReady=false;
  let pdfError=portal.pdfError;
  const aspiActivities=activity?[{
    activityId:activity.activityId,
    service:activity.service,
    timestamp:activity.timestamp,
    downloadUrl:activity.downloadUrl,
    pdfReady:false,
    authenticity:undefined as string|undefined,
  }]:[];
  const requestJson={
    mode:"client_sim",
    activityName,
    aspiServiceName,
    provider:{id:provider.id,name:provider.name},
    service:{id:service.id,name:service.name,method,path:relative},
    snapUser:{id:snapUser.id,name:snapUser.name},
    testType,
    timestamp,
    headers:redact(serviceHeaders),
    body:JSON.parse(signedBody),
    uris:{accessToken:tokenUrl,service:serviceUrl,form:"https://apidevportal.aspi-indonesia.or.id/client-simulator",activity:"https://apidevportal.aspi-indonesia.or.id/client-simulator-activity"},
    steps,
    overrides:redact(overrides),
    operator:{id:operator.id,name:operator.name,username:operator.username,role:operator.role},
    evaluation:{matched:evaluation.matched,expectedHttp,expectedCode,httpStatus,responseCode,testType},
    aspiActivities,
    evidenceErrors:pdfError?[pdfError]:[] as string[],
    pdfCounts:{ready:0,required:1},
  };
  const noteFor=(ready:boolean,problem:string|null)=>!activity?`${activityName}. ${problem||"Hasil tidak masuk ke Client Simulator Activity."}`:(problem&&!ready?`${activityName}. ${problem}`:activityName);
  await db.query(
    `INSERT INTO autosnap_runs (id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,scenario_id,mode,status,http_status,response_code,expected_code,duration_ms,request_json,response_json,notes,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)`,
    [runId,operator.id,provider.id,provider.id,provider.id,snapUser.id,service.id,provider.id,null,"client_sim",status,httpStatus,responseCode||null,expectedCode,Date.now()-started,JSON.stringify(requestJson),JSON.stringify(redact(portal.response)),noteFor(false,pdfError),now]
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
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'CAPTURED',$8,$9,$10,$10)`,
        [runId,activity.activityId,activity.service.slice(0,120),pdf,pdf.length,hash,fingerprint,provenance.producer||null,activity.downloadUrl,now]
      );
      pdfReady=true;
      pdfError=null;
      if(aspiActivities[0]){aspiActivities[0].pdfReady=true;aspiActivities[0].authenticity="aspi-html2pdf-download";}
      requestJson.evidenceErrors=[];
      requestJson.pdfCounts.ready=1;
      await db.query("UPDATE autosnap_runs SET request_json=$1::jsonb, notes=$2 WHERE id=$3",[JSON.stringify(requestJson),noteFor(true,null),runId]);
    }catch(error){
      pdfError=error instanceof Error?error.message:"PDF Client Simulator gagal disimpan.";
      requestJson.evidenceErrors=[pdfError];
      await db.query("UPDATE autosnap_runs SET request_json=$1::jsonb, notes=$2 WHERE id=$3",[JSON.stringify(requestJson),noteFor(false,pdfError),runId]);
    }
  }
  await report("evaluation",status==="FAILED"?"failed":"completed",`${activityName}. HTTP ${httpStatus??"—"}. Response ${responseCode||"—"}.`);
  if(pdfReady)await report("pdf_store","completed","PDF resmi ASPI tersimpan.");
  else if(pdfError)await report("pdf_store","failed",pdfError);
  return {ok:true,id:runId,status,httpStatus,responseCode,matched:evaluation.matched,activityName,pdfReady,pdfError,aspiActivities,steps:requestJson.steps,request:redact(requestJson),response:redact(portal.response),notes:noteFor(pdfReady,pdfError)};
  }catch(error){
    const message=error instanceof Error?error.message:error&&typeof error==="object"&&"error" in error?String((error as {error:unknown}).error):"Client Simulator gagal.";
    await onProgress?.(stage,"failed",message).catch(()=>undefined);
    throw error;
  }
}
