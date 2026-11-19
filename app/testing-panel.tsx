"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Api, Item, Run, State } from "./model";
import DynamicRequestFields from "./dynamic-request-fields";
import UiIcon from "./ui-icon";
import PdfPreview from "./pdf-preview";
import HistoryFilter from "./history-filter";
import {rangeForPeriod} from "./history-period";
import {useHistory} from "./use-history";
import TestingProgress, {type TestProgress} from "./testing-progress";
import {ApiError} from "./api-client";

const value=(row:Item|undefined,key:string)=>String(row?.data[key]??"");
const object=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);
type Props={state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void;variant?:"dev_site"|"simulator"};
type TestingError={stage:string;summary:string;technical:string;outcome:string;httpStatus:string;suggestion:string};
type EvidenceChoice={activityId:string;service:string;fileName:string;pdfReady:boolean};
const progressStages=[{key:"preparing",label:"Persiapan"},{key:"signature_auth",label:"Signature Authentication"},{key:"access_token",label:"Access Token"},{key:"signature_service",label:"Signature Service"},{key:"customer_token",label:"Customer Token"},{key:"registration",label:"Registrasi"},{key:"api_request",label:"Kirim Request API"},{key:"evaluation",label:"Validasi HTTP"},{key:"evidence",label:"Bukti PDF ASPI"},{key:"pdf_reprocessing",label:"Proses Ulang Bukti"},{key:"finished",label:"Selesai"}];
const reprocessOf=(run:Run)=>{const r=object(run.request)&&object(run.request.reprocess)?run.request.reprocess:{};return {retryEvidence:r.retryEvidence===true,resumeTesting:r.resumeTesting===true,requireMutatingConfirm:r.requireMutatingConfirm===true};};
const pdfCountsOf=(run:Run)=>{const counts=object(run.request)&&object(run.request.pdfCounts)?run.request.pdfCounts:{};return {ready:Number(counts.ready??0),required:Number(counts.required??0)};};

export default function TestingPanel({state,api,reload,setError,setNotice,variant="dev_site"}:Props){
  const records=state.records,activeServices=records.filter(item=>{
    if(item.kind!=="service")return false;
    if(object(item.data.config)&&item.data.config.reviewed===true)return true;
    const caps=object(item.data.capabilities)?item.data.capabilities:null;
    return caps?.allowUnreviewed===true||(!caps&&value(item,"code")==="11");
  });
  const endpoints=records.filter(item=>item.kind==="endpoint"&&!item.parentId&&activeServices.some(service=>service.parentId===item.id));
  const [endpointId,setEndpointId]=useState(""),[serviceId,setServiceId]=useState(""),[userId,setUserId]=useState(""),[siteId,setSiteId]=useState("");
  const [testType,setTestType]=useState<"positive"|"invalid_access_token">("positive");
  const endpoint=endpoints.find(item=>item.id===endpointId),services=activeServices.filter(item=>item.parentId===endpoint?.id),service=services.find(item=>item.id===serviceId);
  const config=object(service?.data.config)?service.data.config:null;
  const [parameters,setParameters]=useState<Record<string,string>>({});
  const template=records.find(item=>item.kind==="template"&&item.parentId===endpoint?.id),users=records.filter(item=>item.kind==="snap_user"),user=users.find(item=>item.id===userId);
  const sites=records.filter(item=>item.kind==="environment"&&value(item,"category")==="Dev Site"&&(variant==="simulator"?value(item,"mode")==="mock":value(item,"mode")!=="mock")&&!!user&&value(item,"defaultUserId")===user.id);
  const site=sites.find(item=>item.id===siteId),project=records.find(item=>item.id===site?.parentId),client=records.find(item=>item.id===project?.parentId);
  const bodyContext=`${endpointId}|${serviceId}|${siteId}`,[draft,setDraft]=useState<{context:string;text:string}|null>(null);
  const defaultBody=typeof service?.data.requestBody==="string"?service.data.requestBody:value(template,"body"),body=["GET","HEAD"].includes(value(endpoint,"method"))||config?.requestBodyMode==="none"?"":draft?.context===bodyContext?draft.text:defaultBody;
  const [historyRange,setHistoryRange]=useState(()=>rangeForPeriod("today"));
  const [resultId,setResultId]=useState<string|null>(null),[refreshing,setRefreshing]=useState(false);
  const [running,setRunning]=useState(false),[progress,setProgress]=useState<TestProgress|null>(null),[testingError,setTestingError]=useState<TestingError|null>(null),[selectedRun,setSelectedRun]=useState<Run|null>(null),[evidenceRun,setEvidenceRun]=useState<Run|null>(null),[downloadingId,setDownloadingId]=useState(""),[historyQuery,setHistoryQuery]=useState(""),[offset,setOffset]=useState(0);
  const [reprocessingId,setReprocessingId]=useState("");
  const [busyUserIds,setBusyUserIds]=useState<string[]>([]);
  const refreshAspiBusy=useRef<(()=>Promise<void>)|null>(null);
  const busyPollEpoch=useRef(0);
  useEffect(()=>{
    if(variant!=="dev_site")return;
    let stop=false;
    const idle=!running&&!reprocessingId;
    const load=async()=>{
      const epoch=++busyPollEpoch.current;
      try{
        const result=await api("aspiBusy");
        // Ignore stale in-flight polls so an older "busy" response cannot re-lock after unlock.
        if(!stop&&epoch===busyPollEpoch.current)setBusyUserIds(Array.isArray(result.busyUserIds)?result.busyUserIds.map(String):[]);
      }catch{
        // On poll failure while idle, drop only this selection so a stale busy list cannot lock the form forever.
        if(!stop&&idle&&userId&&epoch===busyPollEpoch.current)setBusyUserIds(current=>current.filter(id=>id!==userId));
      }
    };
    refreshAspiBusy.current=load;
    void load();
    const timer=window.setInterval(()=>void load(),2000);
    return ()=>{stop=true;window.clearInterval(timer);};
  },[variant,api,running,reprocessingId,userId]);
  const [preview,setPreview]=useState<{runId:string;evidence:EvidenceChoice}|null>(null);
  const activeProgressId=useRef(""),reprocessLock=useRef(false);
  const lastStage=useRef("preparing"),canDownloadEvidence=state.user?.role==="admin"||(state.user?.privileges??[]).includes("dev_site");
  const nameOf=(run:Run,key:"environment"|"service")=>{const context=object(run.request)&&object(run.request.context)?run.request.context:{};return String(context[key]??records.find(row=>row.id===run[`${key}_id` as keyof Run])?.name??"—");};
  const historyData=useHistory(api,historyRange,variant==="simulator"?"simulator":"dev_site",historyQuery,offset,20,state.runs),history=historyData.runs;
  const latest=state.runs.find(run=>run.id===resultId&&run.environment_id===site?.id&&run.service_id===service?.id&&run.endpoint_id===endpoint?.id&&run.user_id===user?.id);
  const sendsBody=!["GET","HEAD"].includes(value(endpoint,"method"))&&config?.requestBodyMode!=="none";
  let jsonError="";try{if(sendsBody&&!body.trim()&&config?.requestBodyMode!=="optional")jsonError="Template request belum tersedia. Isi body sesuai dokumentasi.";else if(body.trim()&&!object(JSON.parse(body)))throw Error();}catch{jsonError="Request Body harus object JSON yang valid.";}
  const missing:string[]=[];
  const configuredWorkflow=object(config?.workflow)?config.workflow:null;
  if(site&&value(site,"mode")==="portal"&&config?.authFlow!=="none"){for(const [key,label] of [["clientId","Client ID"],["channelId","CHANNEL-ID"],...(configuredWorkflow?.token==="provided"?[["accessToken","Access token tersimpan"]]:[["privateKey","Private Key"]]),...(configuredWorkflow?.signature!=="none"?[["clientSecret","Client Secret"]]:[])])if(!value(client,key))missing.push(label);if(!client?.partnerId)missing.push("X-PARTNER-ID");}
  if(endpoint&&!value(endpoint,"path"))missing.push("Path endpoint");
  if(endpoint&&value(site,"mode")==="portal"&&!value(endpoint,"portalUrl"))missing.push("URL Aplikasi Pengujian ASPI pada Endpoint");
  if(config?.authFlow==="unknown")missing.push("Autentikasi endpoint belum ditinjau");
  const negativeConfigured=!!service&&config?.authFlow!=="none";
  const ready=!!endpoint&&!!service&&!!user&&!!site&&!jsonError&&!missing.length;
  const accountBusy=variant==="dev_site"&&!!userId&&busyUserIds.includes(userId);
  const ownProcessActive=running||!!reprocessingId;
  const formLocked=ownProcessActive||accountBusy;
  const formReady=!formLocked;
  const applyBusyFromResult=(result:Record<string,unknown>)=>{
    busyPollEpoch.current+=1;
    if(Array.isArray(result.busyUserIds))setBusyUserIds(result.busyUserIds.map(String));
    else if(result.aspiReady===true||result.formReady===true)setBusyUserIds(current=>userId?current.filter(id=>id!==userId):current);
  };
  const endOwnProcess=()=>{setRunning(false);setReprocessingId("");activeProgressId.current="";};
  const pdfsOf=(run:Run):EvidenceChoice[]=>object(run.request)&&Array.isArray(run.request.aspiActivities)?run.request.aspiActivities.filter(object).map(item=>({activityId:String(item.activityId??""),service:String(item.service??"ASPI"),fileName:`ASPI-${String(item.service??"Activity").replace(/[^A-Za-z0-9_-]/g,"-")}-${String(item.activityId)}.pdf`,pdfReady:item.pdfReady===true})).filter(item=>item.activityId):[];

  async function run(event:FormEvent){
    event.preventDefault();if(!ready||formLocked)return;setRunning(true);setResultId(null);setError("");setNotice("");setTestingError(null);lastStage.current="preparing";
    const progressId=crypto.randomUUID();activeProgressId.current=progressId;setProgress({status:"queued",stage:"preparing",steps:[]});
    let polling=true,pollBusy=false,unlocked=false;
    const timer=setInterval(async()=>{if(!polling||pollBusy)return;pollBusy=true;try{const next=await api("getProgress",{id:progressId}) as unknown as TestProgress;if(polling){lastStage.current=next.stage;setProgress(next);}}catch{}finally{pollBusy=false;}},700);
    const unlockForm=async(result?:Record<string,unknown>)=>{
      if(unlocked)return;unlocked=true;
      polling=false;clearInterval(timer);
      if(result)applyBusyFromResult(result);
      else await refreshAspiBusy.current?.().catch(()=>undefined);
      // Unlock immediately after backend finished — do not wait for reload()/history refresh.
      endOwnProcess();
    };
    try{
      const result=await api("run",{progressId,clientId:client?.id,projectId:project?.id,environmentId:site?.id,userId:user?.id,serviceId:service?.id,endpointId:endpoint?.id,useCase:"B2B",testType,body,parameters});
      try{const current=await api("getProgress",{id:progressId}) as unknown as TestProgress;lastStage.current=current.stage;setProgress(current);}catch{}
      await unlockForm(result);
      await reload();setResultId(String(result.id??""));
      if(["FAILED","AUTOMATION_ERROR","VALIDATION_ERROR"].includes(String(result.status))){const response=object(result.response)?result.response:{};setTestingError({stage:String(result.failedStage??lastStage.current),summary:"Pengujian tidak berhasil.",technical:String(response.error??result.notes??"HTTP tidak sesuai expected."),outcome:String(result.outcome??result.status??"FAILED"),httpStatus:result.httpStatus===null||result.httpStatus===undefined?"Tidak ada":String(result.httpStatus),suggestion:result.httpStatus===null||result.httpStatus===undefined?"Periksa tahap gagal, sesi ASPI, dan konfigurasi Master Data lalu coba Lanjutkan Testing.":"Periksa expected HTTP status pada detail History."});}
      else setNotice(`${result.status} · HTTP ${result.httpStatus??"—"}`);
    }catch(error){
      const timeout=error instanceof ApiError&&(error.code==="UPSTREAM_TIMEOUT"||error.status===504);
      const outcome=timeout?"TIMEOUT":error instanceof ApiError?error.code:error instanceof TypeError?"NETWORK_ERROR":"AUTOMATION_ERROR";
      const busy=outcome==="ASPI_SESSION_BUSY";
      // A proxy timeout says nothing about whether the target API already ran.
      // Refresh saved History, but never resend the test automatically.
      try{const current=await api("getProgress",{id:progressId}) as unknown as TestProgress;lastStage.current=current.stage;setProgress(current);}catch{}
      if(timeout)setProgress(current=>current?{...current,status:"unknown"}:null);
      await unlockForm();
      await reload().catch(()=>undefined);historyData.refresh();
      setTestingError({stage:busy?"pdf_reprocessing":lastStage.current,summary:busy?"Sesi ASPI sedang dipakai.":timeout?"Waktu tunggu habis; status proses belum dapat dipastikan.":"Proses testing tidak dapat diselesaikan.",technical:(error as Error).message,outcome,httpStatus:"Tidak ada",suggestion:busy?"Tunggu hingga pengambilan bukti pada akun ASPI ini selesai. Pengujian baru tidak dijalankan.":timeout?"Periksa History Testing. Jika PDF sudah tersimpan, status di history tetap berlaku dan tidak perlu diunduh ulang.":outcome==="VALIDATION_ERROR"?"Periksa input yang disebutkan.":"Periksa tahap yang gagal pada detail History sebelum mencoba kembali."});
    }
    finally{
      await unlockForm();
    }
  }
  async function refreshPage(){
    if(formLocked||refreshing)return;
    setRefreshing(true);setEndpointId("");setServiceId("");setUserId("");setSiteId("");setDraft(null);setParameters({});setTestType("positive");setResultId(null);
    setProgress(null);setTestingError(null);setSelectedRun(null);setEvidenceRun(null);setError("");setNotice("");
    try{await reload();historyData.refresh();}finally{setRefreshing(false);}
  }
  async function saveDownload(response:Response,fileName:string){if(!response.ok){const error=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw Error(String(error.error));}const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=fileName;document.body.appendChild(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),60000);}
  const showDownloadError=(summary:string,error:unknown)=>{setEvidenceRun(null);setTestingError({stage:"download_evidence",summary,technical:(error as Error).message,outcome:"NETWORK_ERROR",httpStatus:"Tidak ada",suggestion:"Coba ulangi unduhan dari History Testing."});};
  async function downloadPdf(run:Run,evidence:EvidenceChoice){setDownloadingId(`${run.id}:${evidence.activityId}`);setTestingError(null);try{await saveDownload(await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadAspiActivityPdf",id:run.id,activityId:evidence.activityId}),signal:AbortSignal.timeout(1000000)}),evidence.fileName);}catch(error){showDownloadError("PDF gagal diunduh.",error);}finally{setDownloadingId("");}}
  async function downloadEvidenceZip(run:Run){setDownloadingId(`${run.id}:zip`);setTestingError(null);try{await saveDownload(await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadAspiActivitiesZip",id:run.id}),signal:AbortSignal.timeout(60000)}),`ASPI-PDF-${run.id}.zip`);}catch(error){showDownloadError("ZIP gagal diunduh.",error);}finally{setDownloadingId("");}}
  async function retryEvidence(run:Run){
    if(reprocessLock.current)return;
    if(accountBusy){setNotice("Sesi ASPI ini sedang dipakai untuk pengambilan bukti. Proses yang sedang berjalan ditampilkan; API tidak dijalankan ulang.");return;}
    reprocessLock.current=true;setReprocessingId(run.id);setTestingError(null);
    try{
      const result=await api("retryAspiEvidence",{id:run.id});
      applyBusyFromResult(result);
      setReprocessingId("");
      const stored=Number(result.stored??0),required=Number(result.required??0);
      if(result.processing===true)setNotice("Proses bukti sedang berjalan. PDF yang sudah tersimpan tetap aman. Request API tidak dijalankan ulang.");
      else if(result.status==="PASSED")setNotice(`Bukti lengkap. Status PASSED. ${stored}/${required} PDF.`);
      else if(result.status==="FAILED")setNotice(`PDF ${stored}/${required} tersimpan. Status tetap FAILED karena validasi HTTP sebelumnya gagal.`);
      else {const reasons=Array.isArray(result.missing)?result.missing.flatMap(item=>object(item)&&item.error?[String(item.error)]:[]).slice(0,2):[];setNotice(`Bukti: ${String(result.status)}. ${stored}/${required} PDF.${reasons.length?` ${reasons.join(" ")}`:""}`);}
      await reload();historyData.refresh();
      setSelectedRun(current=>{
        if(!current||current.id!==run.id||result.processing===true)return current;
        const request=object(current.request)?{...current.request}:{};
        const prior=Array.isArray(request.reprocessAudit)?request.reprocessAudit:[];
        if(Array.isArray(result.reprocessAudit))request.reprocessAudit=[...prior,...result.reprocessAudit];
        if(result.pdfCounts)request.pdfCounts=result.pdfCounts;
        if(Array.isArray(result.missing))request.evidenceErrors=result.missing;
        if(result.reprocess)request.reprocess=result.reprocess;
        return {...current,status:String(result.status??current.status),notes:String(result.notes??current.notes),request};
      });
    }catch(error){
      const message=(error as Error).message;
      if(/sedang diproses/i.test(message)){setNotice("Proses bukti sedang berjalan. Tidak ada proses duplikat dan API tidak dijalankan ulang.");await reload();historyData.refresh();return;}
      const outcome=error instanceof ApiError?error.code:"REQUEST_ERROR";
      setTestingError({stage:"pdf_reprocessing",summary:"Proses ulang bukti gagal.",technical:message,outcome,httpStatus:"Tidak ada",suggestion:"PDF yang sudah tersimpan tetap aman. Coba lagi setelah proses yang sedang berjalan selesai."});
    }finally{
      reprocessLock.current=false;
      await refreshAspiBusy.current?.().catch(()=>undefined);
      setReprocessingId("");
    }
  }
  async function resumeRun(run:Run){
    const reprocess=reprocessOf(run);
    if(reprocess.requireMutatingConfirm&&!window.confirm("Eksekusi ulang API berpotensi menduplikasi transaksi/aktivitas. Lanjutkan pada history yang sama?"))return;
    setReprocessingId(run.id);setTestingError(null);
    try{
      const result=await api("resumeTesting",{id:run.id,confirmMutatingRetry:reprocess.requireMutatingConfirm===true});
      applyBusyFromResult(result);
      setReprocessingId("");
      setNotice(`Resume: ${String(result.status)} · HTTP ${String(result.httpStatus??"—")}`);
      await reload();historyData.refresh();
    }
    catch(error){setTestingError({stage:"api_request",summary:"Lanjutkan Testing gagal.",technical:(error as Error).message,outcome:"AUTOMATION_ERROR",httpStatus:"Tidak ada",suggestion:"Periksa checkpoint dan jangan mengulang transaksi yang sudah berhasil."});}
    finally{
      await refreshAspiBusy.current?.().catch(()=>undefined);
      setReprocessingId("");
    }
  }
  const headers=[["Content-Type","application/json"],["Authorization",value(site,"mode")==="mock"?"Simulasi lokal":"Otomatis dari API Keamanan"],["X-TIMESTAMP","Waktu eksekusi; sama dengan waktu pada signature"],["X-SIGNATURE","Dihitung otomatis untuk request ini"],["X-PARTNER-ID",client?.partnerId||"Dari Master Data Dev Site Client"],["X-EXTERNAL-ID","Angka unik otomatis setiap request"]];

  return <div className="testing-page">
    <div className="testing-toolbar"><button type="button" className="secondary-button" disabled={formLocked||refreshing} onClick={()=>refreshPage().catch(error=>setError((error as Error).message))}>Refresh</button></div>
    <form className="card test-form" onSubmit={run}><div className="section-header"><div><h2>{variant==="simulator"?"Client Simulator":"Dev Site Client"}</h2><p>{variant==="simulator"?"Simulasikan request dan response tanpa mengirim ke portal ASPI.":"Jalankan pengujian melalui Aplikasi Pengujian ASPI."}</p></div></div>{variant==="dev_site"&&formLocked&&<p className="helper" role="status"><span className="button-spinner" aria-hidden="true"/> {ownProcessActive?"Pengujian/bukti sedang berlangsung. Form dikunci sampai proses milik Anda selesai.":"Akun ASPI ini sedang dipakai proses lain. Form dikunci sampai sesi tersebut dilepas."}</p>}<div className="form-grid">
      <Select label="User SNAP" value={userId} options={users} onChange={id=>{setUserId(id);setSiteId("");}} disabled={formLocked}/><Select label="Dev Site Client" value={siteId} options={sites} onChange={id=>{setSiteId(id);setDraft(null);}} disabled={formLocked||!user}/><Select label="Endpoint URL" value={endpointId} options={endpoints} onChange={id=>{setEndpointId(id);setServiceId("");}} disabled={formLocked}/><Select label="API Service" value={serviceId} options={services} onChange={id=>{setServiceId(id);setParameters({});setDraft(null);setTestType("positive");}} disabled={formLocked||!endpoint}/>
      <label className="form-field"><span>Content-Type</span><input disabled={formLocked} readOnly value="application/json"/></label><label className="form-field"><span>CHANNEL-ID</span><input disabled={formLocked} readOnly value={value(client,"channelId")||(site?"95221":"")} placeholder="95221 — dari Dev Site Client"/><small className="helper">Diatur melalui Master Data.</small></label><label className="form-field wide"><span>Jenis pengujian</span><select disabled={formLocked} value={testType} onChange={event=>setTestType(event.target.value as "positive"|"invalid_access_token")}><option value="positive">Positif — token valid</option>{negativeConfigured&&config?.authFlow!=="none"&&<option value="invalid_access_token">Negatif — token tidak valid</option>}</select></label>{service&&sendsBody&&<label className="form-field wide"><span>Request Body</span><textarea aria-label="Request Body" required={config?.requestBodyMode!=="optional"} disabled={formLocked} className="code-editor" rows={8} spellCheck={false} value={body} onChange={event=>setDraft({context:bodyContext,text:event.target.value})}/>{jsonError&&<small className="field-error">{jsonError}</small>}</label>}
    </div>{config&&<div className="form-grid"><p className="helper wide">Autentikasi: {String(config.authFlow)} · Expected HTTP {String(config.expectedHttpStatus??"belum diisi")} · SNAP {String(config.expectedCode??"belum diisi")}</p>{Array.isArray(config.parameters)&&config.parameters.filter(object).filter(p=>!["content-type","authorization","authorization-customer","x-timestamp","x-signature","x-partner-id","x-external-id","channel-id","x-device-id"].includes(String(p.name).toLowerCase())).map(p=><label key={String(p.name)} className="form-field"><span>{String(p.name)} ({String(p.in)}){p.required?" *":""}</span><input disabled={formLocked} value={parameters[String(p.name)]??""} onChange={e=>setParameters(old=>({...old,[String(p.name)]:e.target.value}))}/><small className="helper">{String(p.description??"")}</small></label>)}{sendsBody&&object(config.requestSchema)&&<DynamicRequestFields schema={config.requestSchema} body={body} onChange={text=>setDraft({context:bodyContext,text})} disabled={formLocked}/>}</div>}{site&&<div className="connection-summary"><span className="mode-badge blue">{value(site,"mode")==="mock"?"Mock Lokal":value(site,"mode")==="live"?"Bank Sumut":"ASPI Sandbox"}</span></div>}<details className="header-details"><summary>Header otomatis</summary><dl>{headers.filter(([key])=>config?.authFlow!=="none"||key==="Content-Type").map(([key,entry])=><div key={key}><dt>{key}</dt><dd>{entry}</dd></div>)}</dl></details>{missing.length>0&&<div className="validation-box"><strong>Konfigurasi belum lengkap</strong><p>{missing.join(", ")}.</p></div>}{(!users.length||!endpoints.length)&&<p className="helper">Lengkapi User SNAP, Dev Site Client, Endpoint URL, dan API Service di Master Data.</p>}<div className="form-actions"><button type="button" className="secondary-button" disabled={formLocked||!service} onClick={()=>setDraft(null)}>Reset Body</button><button className="primary-button" disabled={formLocked||!ready}>{formLocked?<span className="button-spinner" role="status" aria-label={ownProcessActive?(variant==="dev_site"?"Pengujian sedang berlangsung":"Testing sedang berjalan"):"Akun ASPI sedang dipakai proses lain"}/>:"Jalankan Testing"}</button></div></form>
    <section className="card response-card" aria-live="polite"><div className="section-header"><div><h2>Hasil Testing</h2><p>{latest?new Date(latest.created_at).toLocaleString("id-ID"):"Hasil muncul setelah testing dijalankan."}</p></div>{latest&&<span className={`status-badge ${latest.status.toLowerCase()}`}>{latest.status}</span>}</div><div className="response-summary"><div><span>HTTP</span><strong>{latest?.http_status??"—"}</strong></div><div><span>PDF ASPI</span><strong>{latest?`${pdfCountsOf(latest).ready}/${pdfCountsOf(latest).required||"—"}`:"—"}</strong></div><div><span>WAKTU</span><strong>{latest?`${latest.duration_ms} ms`:"—"}</strong></div></div><EvaluationNotice run={latest}/><pre className="response-code">{JSON.stringify(latest?.response??{message:"Belum ada hasil untuk pilihan ini."},null,2)}</pre>{latest&&<div className="inline-actions"><button type="button" className="text-button" onClick={()=>setSelectedRun(latest)}>Detail validasi</button>{canDownloadEvidence&&pdfsOf(latest).length>0&&<button type="button" className="text-button" onClick={()=>setEvidenceRun(latest)}>Bukti ASPI</button>}{reprocessOf(latest).retryEvidence&&<button type="button" className="text-button" disabled={formLocked} onClick={()=>void retryEvidence(latest)}>Proses Ulang Bukti</button>}{reprocessOf(latest).resumeTesting&&<button type="button" className="text-button" disabled={formLocked} onClick={()=>void resumeRun(latest)}>Lanjutkan Testing</button>}</div>}</section>
    <section className="card history-card"><div className="section-header"><div><h2>History Testing</h2><p>{historyData.total} hasil pada periode terpilih.</p></div><label className="search-box"><input aria-label="Cari history" value={historyQuery} onChange={event=>{setHistoryQuery(event.target.value);setOffset(0);}} placeholder="Cari Dev Site, service, atau status..."/></label></div><HistoryFilter value={historyRange} onChange={range=>{setHistoryRange(range);setOffset(0);}}/>{historyData.error&&<p className="field-error" role="alert">{historyData.error}</p>}<div className="table-wrap" aria-busy={historyData.loading}><table><thead><tr><th>WAKTU</th><th>SERVICE / DEV SITE</th><th>STATUS</th><th>HTTP / PDF</th><th>DURASI</th><th>AKSI</th></tr></thead><tbody>{history.map(run=>{const pdf=pdfCountsOf(run),reprocess=reprocessOf(run);return <tr key={run.id}><td>{new Date(run.created_at).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}</td><td>{nameOf(run,"service")}<span className="cell-caption">{nameOf(run,"environment")} · {run.mode==="portal"?"ASPI Sandbox":run.mode==="live"?"Live Bank Sumut":"Mock Lokal"}</span></td><td><span className={`status-badge ${run.status.toLowerCase()}`}>{run.status}</span></td><td>{run.http_status??"—"} / {pdf.required?`${pdf.ready}/${pdf.required}`:"—"}</td><td>{run.duration_ms??0} ms</td><td><div className="inline-actions"><button type="button" className="text-button" onClick={()=>setSelectedRun(run)}>Detail</button>{canDownloadEvidence&&<button type="button" className="text-button" disabled={!pdfsOf(run).length||!!downloadingId} onClick={()=>setEvidenceRun(run)}>Bukti ASPI</button>}{reprocess.retryEvidence&&<button type="button" className="text-button" disabled={formLocked} onClick={()=>void retryEvidence(run)}>Proses Ulang Bukti</button>}{reprocess.resumeTesting&&<button type="button" className="text-button" disabled={formLocked} onClick={()=>void resumeRun(run)}>Lanjutkan</button>}</div></td></tr>;})}</tbody></table>{!history.length&&<p className="empty-note">{historyData.loading?"Memuat history…":"Belum ada history yang cocok."}</p>}</div><div className="history-pagination"><button className="secondary-button" disabled={!offset||historyData.loading} onClick={()=>setOffset(Math.max(0,offset-20))}>Sebelumnya</button><span>{historyData.total?`${offset+1}`:"0 hasil"}</span><button className="secondary-button" disabled={offset+20>=historyData.total||historyData.loading} onClick={()=>setOffset(offset+20)}>Berikutnya</button></div></section>
    {preview&&<PdfPreview runId={preview.runId} activityId={preview.evidence.activityId} fileName={preview.evidence.fileName} onClose={()=>setPreview(null)}/>}
    {progress&&<TestingProgress progress={progress} running={ownProcessActive} formReady={formReady} accountBusy={accountBusy} onCancel={async()=>{await api("cancelRun",{id:activeProgressId.current});}} onClose={()=>setProgress(null)} onRetryEvidence={formReady&&latest&&reprocessOf(latest).retryEvidence?()=>retryEvidence(latest):undefined}/>} {testingError&&<ErrorDialog error={testingError} onClose={()=>setTestingError(null)}/>} {selectedRun&&<div className="modal-backdrop"><div className="card edit-modal run-modal"><div className="section-header"><div><h2>Detail Testing</h2><p>{selectedRun.notes}</p></div><CloseButton onClick={()=>setSelectedRun(null)}/></div><EvaluationNotice run={selectedRun}/><p className="helper">PDF ASPI: {pdfCountsOf(selectedRun).ready}/{pdfCountsOf(selectedRun).required||0}</p><ReprocessHistory run={selectedRun}/><div className="inline-actions">{reprocessOf(selectedRun).retryEvidence&&<button type="button" className="secondary-button" disabled={formLocked} onClick={()=>void retryEvidence(selectedRun)}>Proses Ulang Bukti</button>}{reprocessOf(selectedRun).resumeTesting&&<button type="button" className="secondary-button" disabled={formLocked} onClick={()=>void resumeRun(selectedRun)}>Lanjutkan Testing</button>}</div><h3>Request dan validasi</h3><pre className="snippet-code">{JSON.stringify(selectedRun.request,null,2)}</pre><h3>Response</h3><pre className="snippet-code">{JSON.stringify(selectedRun.response,null,2)}</pre></div></div>} {evidenceRun&&<EvidenceDownloadDialog pdfs={pdfsOf(evidenceRun)} downloadingId={downloadingId} runId={evidenceRun.id} onClose={()=>setEvidenceRun(null)} onView={evidence=>{setPreview({runId:evidenceRun.id,evidence});setEvidenceRun(null);}} onDownload={evidence=>downloadPdf(evidenceRun,evidence)} onZip={()=>downloadEvidenceZip(evidenceRun)}/>}
  </div>;
}

function ReprocessHistory({run}:{run:Run}){
  const request=object(run.request)?run.request:{};
  const audit=Array.isArray(request.reprocessAudit)?request.reprocessAudit.filter(object):[];
  const missing=Array.isArray(request.evidenceErrors)?request.evidenceErrors.filter(object):[];
  const log=Array.isArray(request.progressLog)?request.progressLog.filter(object):[];
  const lines=[
    ...log.map(entry=>({at:String(entry.at??""),text:`[${String(entry.status??"").toUpperCase()}] ${String(entry.stage??"")} — ${String(entry.detail??"")}`})),
    ...audit.map(entry=>({at:String(entry.at??""),text:`[RETRY ${String(entry.result??"")}] ${String(entry.priorStatus??"—")} → ${String(entry.statusAfter??"—")} — ${String(entry.note??entry.priorDetail??"")}`})),
  ].sort((a,b)=>a.at.localeCompare(b.at));
  return <>
    {missing.length>0&&<div className="validation-box"><strong>Bukti yang belum tersedia</strong><p>{missing.map(item=>`${String(item.path??item.key??"PDF")}: ${String(item.error??"belum tersedia")}`).join(" · ")}</p></div>}
    <h3>Riwayat proses</h3>
    <pre className="testing-terminal">{lines.length?lines.map(entry=>`[${entry.at}] ${entry.text}`).join("\n"):"Log belum tersedia untuk history ini."}</pre>
  </>;
}
function ErrorDialog({error,onClose}:{error:TestingError;onClose:()=>void}){return <div className="modal-backdrop error-layer"><section className="card error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="testing-error-title"><CloseButton onClick={onClose}/><h2 id="testing-error-title">{error.summary}</h2><dl><div><dt>Tahap</dt><dd>{progressStages.find(item=>item.key===error.stage)?.label??error.stage}</dd></div><div><dt>Outcome</dt><dd>{error.outcome}</dd></div><div><dt>HTTP Status</dt><dd>{error.httpStatus}</dd></div><div><dt>Detail</dt><dd>{error.technical}</dd></div><div><dt>Saran</dt><dd>{error.suggestion}</dd></div></dl></section></div>;}
function EvaluationNotice({run}:{run:Run|null|undefined}){
  const evaluation=object(run?.request)&&object(run.request.evaluation)?run.request.evaluation:null;
  if(!evaluation||!["COMPLETED","PASSED","FAILED","AUTOMATION_ERROR"].includes(String(evaluation.outcome)))return null;
  const mode=String(evaluation.mode??"HTTP_ONLY")==="SNAP_AND_HTTP"?"SNAP + HTTP":"HTTP Only";
  return <aside className="evaluation-notice" role="status" aria-label="Hasil pengujian"><strong>Outcome: {String(evaluation.outcome)}</strong><p>Validasi: {mode}</p><p>Tahap: {String(evaluation.stageLabel??"Validasi")}</p><p>{String(evaluation.detail)}</p>{evaluation.suggestion?<p>Saran: {String(evaluation.suggestion)}</p>:null}</aside>;
}
function EvidenceDownloadDialog({pdfs,downloadingId,onClose,onDownload,onView,onZip}:{pdfs:EvidenceChoice[];downloadingId:string;runId:string;onClose:()=>void;onDownload:(evidence:EvidenceChoice)=>void;onView:(evidence:EvidenceChoice)=>void;onZip:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),busy=!!downloadingId;
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  return <dialog ref={dialog} onCancel={event=>{if(busy)event.preventDefault();else onClose();}} aria-labelledby="evidence-dialog-title" className="m-auto w-[95vw] max-w-xl rounded-xl border border-slate-200 p-4 backdrop:bg-slate-900/45"><div className="section-header"><h2 id="evidence-dialog-title">PDF resmi ASPI</h2><CloseButton onClick={onClose} disabled={busy}/></div>{pdfs.map(item=><div key={item.activityId} className="flex items-center justify-between gap-3 border-b py-3"><span className="min-w-0 text-sm">{item.service}{!item.pdfReady&&<span className="block text-slate-500">PDF belum tersedia</span>}</span><div className="flex shrink-0 gap-3"><button type="button" className="text-button" disabled={busy||!item.pdfReady} onClick={()=>onView(item)}>View PDF</button><button type="button" className="text-button" disabled={busy||!item.pdfReady} onClick={()=>onDownload(item)}>Download</button></div></div>)}{busy&&<p role="status" className="py-3 text-blue-700">Menyiapkan unduhan…</p>}<button type="button" className="primary-button mt-3" disabled={busy||!pdfs.length||pdfs.some(item=>!item.pdfReady)} onClick={onZip}>Unduh semua (.zip)</button></dialog>;
}
function Select({label,value,options,onChange,disabled=false}:{label:string;value:string;options:Item[];onChange:(id:string)=>void;disabled?:boolean}){return <label className="form-field"><span>{label}</span><select aria-label={label} required value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}><option value="">Pilih {label}</option>{options.map(item=><option key={item.id} value={item.id}>{item.name}{item.kind==="endpoint"?` — ${[String(item.data.method??"POST"),String(item.data.path??"")].filter(Boolean).join(" ")}`:""}</option>)}</select></label>;}
function CloseButton({onClick,disabled=false}:{onClick:()=>void;disabled?:boolean}){return <button type="button" className="close-button" title="Tutup" aria-label="Tutup" disabled={disabled} onClick={onClick}><UiIcon name="close"/></button>;}
