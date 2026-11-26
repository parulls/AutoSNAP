"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Api, HistoryFilters, Item, Run, State } from "./model";
import HistoryFilter from "./history-filter";
import { rangeForPeriod } from "./history-period";
import { operatorLabel, useHistory } from "./use-history";
import { can } from "./privileges";
import TestingProgress, { type TestProgress } from "./testing-progress";
import PdfPreview from "./pdf-preview";
import UiIcon from "./ui-icon";
import { ApiError, fetchState } from "./api-client";
import { buildClientSimulatorServiceName, thrownMessage } from "./client-simulator-name";
import { CLIENT_SIMULATOR_SCENARIOS, clientSimulatorScenario, presentScenarioExpectation } from "./client-simulator-scenarios";
import { evidencePdfFilenameForRun } from "./evidence-filename";
import EvaluationNotice from "./evaluation-notice";

const value=(row:Item|undefined,key:string)=>String(row?.data[key]??"");
const fieldValue=(row:Item|undefined,key:string)=>value(row,key).trim();
const object=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);
/** Service override wins when non-empty; otherwise inherit from penyedia Master Data. */
const headerFrom=(provider:Item|undefined,service:Item|undefined,key:string)=>fieldValue(service,key)||fieldValue(provider,key);

function pad(n:number){return String(n).padStart(2,"0");}
function buildTimestamp(offsetMinutes:number,includeMillis:boolean,at=new Date()){
  const local=new Date(at.getTime()+offsetMinutes*60_000);
  const ms=includeMillis?`.${String(local.getUTCMilliseconds()).padStart(3,"0")}`:"";
  const sign=offsetMinutes>=0?"+":"-",abs=Math.abs(offsetMinutes);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${ms}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}

export default function ClientSimulatorPanel({state,api,reload,setError,setNotice,onOpenMasterData}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void;onOpenMasterData?:()=>void}){
  const providers=state.records.filter(r=>r.kind==="sim_provider");
  const allServices=state.records.filter(r=>r.kind==="sim_service");
  const snapUsers=state.records.filter(r=>r.kind==="snap_user");
  const canViewAll=can(state.user,"history","view_all");
  const [providerId,setProviderId]=useState(""),[serviceId,setServiceId]=useState(""),[snapUserId,setSnapUserId]=useState(""),[scenarioId,setScenarioId]=useState(""),[scenarioAttempted,setScenarioAttempted]=useState(false),[confirmDuplicate,setConfirmDuplicate]=useState(false);
  const provider=providers.find(p=>p.id===providerId);
  const services=allServices.filter(s=>s.parentId===providerId);
  const service=services.find(s=>s.id===serviceId);
  const tsCfg=object(provider?.data.timestampConfig)?provider!.data.timestampConfig as {offsetMinutes?:number;includeMillis?:boolean}:{};
  const offsetMinutes=Number(tsCfg.offsetMinutes??420),defaultMillis=tsCfg.includeMillis===true;
  const [includeMillis,setIncludeMillis]=useState(defaultMillis);
  const [timestamp,setTimestamp]=useState(()=>buildTimestamp(offsetMinutes,defaultMillis,new Date(Date.now()+120_000)));
  const [body,setBody]=useState("{}");
  const [partnerId,setPartnerId]=useState(""),[externalId,setExternalId]=useState(""),[deviceId,setDeviceId]=useState(""),[channelId,setChannelId]=useState("");
  const [headerTouched,setHeaderTouched]=useState({partnerId:false,deviceId:false,channelId:false,externalId:false,body:false});
  const appliedDefaults=useRef({partnerId:"",deviceId:"",channelId:"",externalId:"",body:"{}"});
  const [busy,setBusy]=useState(false),[running,setRunning]=useState(false),[refreshing,setRefreshing]=useState(false),[progress,setProgress]=useState<TestProgress|null>(null);
  const progressIdRef=useRef("");
  const [resultId,setResultId]=useState<string|null>(null);
  const [historyRange,setHistoryRange]=useState(()=>rangeForPeriod("today"));
  const [historyFilters,setHistoryFilters]=useState<HistoryFilters>({scope:canViewAll?"all":"mine"});
  const [historyQuery,setHistoryQuery]=useState(""),[offset,setOffset]=useState(0);
  const [selectedRun,setSelectedRun]=useState<Run|null>(null),[downloadingId,setDownloadingId]=useState(""),[preview,setPreview]=useState<{runId:string;activityId:string;fileName:string;confirmCrossUser?:boolean}|null>(null),[testingError,setTestingError]=useState<{summary:string;technical:string;suggestion:string}|null>(null),[reprocessingId,setReprocessingId]=useState("");
  const confirmCrossUser=(run:Run,action:string)=>{
    if(!run.operator_id||run.operator_id===state.user?.id)return true;
    if(!canViewAll){setError("Anda tidak berwenang mengakses History pengguna lain.");return false;}
    return window.confirm(`${action} milik ${operatorLabel(run).text}. Tindakan akan dicatat pada audit log. Lanjutkan?`);
  };
  const retryLock=useRef(false);
  const formLocked=running||refreshing;
  useEffect(()=>{
    if(!selectedRun&&!testingError)return;
    function onKey(event:KeyboardEvent){if(event.key==="Escape"&&!running){setSelectedRun(null);setTestingError(null);}}
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[selectedRun,testingError,running]);
  const historyData=useHistory(api,historyRange,"simulator",historyQuery,offset,20,state.runs,historyFilters);

  function defaultsFrom(p:Item|undefined,s:Item|undefined){
    return {
      partnerId:headerFrom(p,s,"partnerId"),
      externalId:fieldValue(s,"externalId"),
      deviceId:headerFrom(p,s,"deviceId"),
      channelId:headerFrom(p,s,"channelId"),
      body:fieldValue(s,"defaultBody")||fieldValue(s,"requestBody")||"{}",
    };
  }
  const masterDefaults=defaultsFrom(provider,serviceId?service:undefined);
  const shownPartnerId=headerTouched.partnerId?partnerId:masterDefaults.partnerId;
  const shownExternalId=headerTouched.externalId?externalId:masterDefaults.externalId;
  const shownDeviceId=headerTouched.deviceId?deviceId:masterDefaults.deviceId;
  const shownChannelId=headerTouched.channelId?channelId:masterDefaults.channelId;
  const shownBody=headerTouched.body?body:masterDefaults.body;
  function applyTimestampDefaults(p:Item|undefined){
    const cfg=object(p?.data.timestampConfig)?p!.data.timestampConfig as {offsetMinutes?:number;includeMillis?:boolean}:{};
    const millis=cfg.includeMillis===true;
    const offset=Number(cfg.offsetMinutes??420);
    setIncludeMillis(millis);
    setTimestamp(()=>buildTimestamp(offset,millis,new Date(Date.now()+120_000)));
  }
  function loadDefaults(p:Item|undefined,s:Item|undefined){
    const next=defaultsFrom(p,s);
    applyTimestampDefaults(p);
    setPartnerId(next.partnerId);
    setExternalId(next.externalId);
    setDeviceId(next.deviceId);
    setChannelId(next.channelId);
    setBody(next.body);
    appliedDefaults.current=next;
    setHeaderTouched({partnerId:false,deviceId:false,channelId:false,externalId:false,body:false});
  }
  function resetRequest(){
    if(running)return;
    setScenarioId("");setScenarioAttempted(false);setConfirmDuplicate(false);loadDefaults(provider,service);
  }
  function snapUserLabel(user:Item){
    const display=value(user,"displayUsername").trim();
    if(display&&!display.includes("@"))return display;
    const name=user.name.trim().replace(/\s*\([^)]*@[^)]*\)\s*/g,"").trim();
    if(name&&!name.includes("@"))return name;
    return "Username belum diisi";
  }

  async function run(event:FormEvent){
    event.preventDefault();
    setScenarioAttempted(true);
    if(!providerId||!serviceId||!provider||!service){setError("Pilih penyedia dan API Service sebelum menjalankan.");return;}
    if(!snapUserId){setError("Pilih User SNAP untuk login ke form Client Simulator ASPI.");return;}
    const chosen=clientSimulatorScenario(scenarioId);
    if(!chosen){setError("Pilih skenario pengujian terlebih dahulu.");return;}
    if(chosen.id==="DUPLICATE_EXTERNAL_ID"&&!confirmDuplicate){setError("Konfirmasi diperlukan sebelum baseline bank dan uji duplikat lewat ASPI.");return;}
    try{buildClientSimulatorServiceName(provider.name,service.name,chosen.label);}catch(error){setError(thrownMessage(error));return;}
    if(!shownChannelId.trim()){setError("CHANNEL-ID wajib diisi. Form ASPI mengirim header ini.");return;}
    if(!shownDeviceId.trim()){setError("X-DEVICE-ID wajib diisi. Bank Sumut menolak request tanpa header ini.");return;}
    if(!shownPartnerId.trim()){setError("X-PARTNER-ID wajib diisi pada penyedia atau API Service.");return;}
    const progressId=crypto.randomUUID();
    progressIdRef.current=progressId;
    setBusy(true);setRunning(true);setResultId(null);setError("");setProgress({status:"queued",stage:"preparing",steps:[]});
    let polling=true,pollBusy=false;
    const timer=setInterval(async()=>{
      if(!polling||pollBusy)return;
      pollBusy=true;
      try{const next=await api("getProgress",{id:progressId}) as unknown as TestProgress;if(polling)setProgress(next);}catch{/* progress row appears after the run is accepted */}
      finally{pollBusy=false;}
    },700);
    try{
      const response=await api("runClientSimulator",{
        progressId,providerId,serviceId,snapUserId,scenarioId,confirmDuplicateExternalId:confirmDuplicate,
        overrides:{partnerId:shownPartnerId,externalId:shownExternalId,deviceId:shownDeviceId,channelId:shownChannelId,body:shownBody,timestamp,includeMillis,offsetMinutes,regenerateExternalId:scenarioId!=="DUPLICATE_EXTERNAL_ID"&&!shownExternalId.trim()},
      });
      try{setProgress(await api("getProgress",{id:progressId}) as unknown as TestProgress);}catch{/* the modal already has the last poll */}
      setNotice(`${String(response.activityName??"Client Simulator")} · ${String(response.status??"")} · PDF ${response.pdfReady?"tersimpan":"belum tersimpan"}`);
      setResultId(String(response.id??""));
      await reload();
      historyData.refresh();
    }catch(e){
      try{setProgress(await api("getProgress",{id:progressId}) as unknown as TestProgress);}catch{/* keep the last visible log */}
      setError((e as Error).message);
    }finally{polling=false;clearInterval(timer);setRunning(false);setBusy(false);}
  }

  async function refreshPage(){
    if(running||refreshing)return;
    setRefreshing(true);setResultId(null);setSelectedRun(null);setTestingError(null);setError("");setNotice("");
    try{
      // Reload Master Data + History + PDF status. Never re-run the API request.
      const next=await fetchState();
      await reload();
      historyData.refresh();
      const nextProvider=next.records.find(item=>item.id===providerId&&item.kind==="sim_provider");
      const nextService=next.records.find(item=>item.id===serviceId&&item.kind==="sim_service"&&item.parentId===providerId);
      if(nextProvider){
        applyTimestampDefaults(nextProvider);
        const nextDefaults=defaultsFrom(nextProvider,nextService);
        if(!headerTouched.partnerId||partnerId===appliedDefaults.current.partnerId)setPartnerId(nextDefaults.partnerId);
        if(!headerTouched.externalId||externalId===appliedDefaults.current.externalId)setExternalId(nextDefaults.externalId);
        if(!headerTouched.deviceId||deviceId===appliedDefaults.current.deviceId)setDeviceId(nextDefaults.deviceId);
        if(!headerTouched.channelId||channelId===appliedDefaults.current.channelId)setChannelId(nextDefaults.channelId);
        if(!headerTouched.body||body===appliedDefaults.current.body)setBody(nextDefaults.body);
        appliedDefaults.current=nextDefaults;
      }
    }finally{setRefreshing(false);}
  }

  const joinEndpoint=(baseRaw:string,pathRaw:string)=>{
    const base=baseRaw.trim().replace(/\/$/,"");
    const path=pathRaw.trim();
    if(!path)return base||"—";
    if(/^https?:\/\//i.test(path))return path;
    if(!base)return path;
    return `${base}${path.startsWith("/")?path:`/${path}`}`;
  };
  const accessTokenUri=provider?joinEndpoint(value(provider,"baseUrl"),value(provider,"accessTokenUrl")||"/api/v1.0/access-token/b2b"):"—";
  const serviceUri=provider&&service?joinEndpoint(value(provider,"baseUrl"),value(service,"path")||value(service,"serviceUrl")):"—";

  function countsOf(run:Run){const counts=object(run.request)&&object(run.request.pdfCounts)?run.request.pdfCounts:{};return {ready:Number(counts.ready??0),required:Number(counts.required??0)};}
  function officialActivity(value:string){return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)||/^\d{4,18}$/.test(value);}
  function pendingEvidence(run:Run){return pdfsOf(run).filter(item=>officialActivity(item.activityId)&&!item.pdfReady);}
  async function retryEvidence(run:Run,activityId:string){
    if(retryLock.current||running||!officialActivity(activityId))return;
    retryLock.current=true;setReprocessingId(`${run.id}:${activityId}`);setTestingError(null);
    try{
      const result=await api("retryAspiEvidence",{id:run.id,activityId,confirmCrossUser:run.operator_id!==state.user?.id});
      const stored=Number(result.stored??0),required=Number(result.required??0);
      setNotice(result.status==="FAILED"?`PDF ${stored}/${required} tersimpan. Status tetap FAILED karena validasi sebelumnya gagal.`:`Bukti PDF ${stored}/${required}. Status pengujian tetap ${String(result.status??run.status)}. Transaksi tidak dikirim ulang.`);
      await reload();historyData.refresh();
    }catch(error){
      const message=(error as Error).message;
      const unresolved=error instanceof ApiError&&(error.code==="ACTIVITY_ID_UNRESOLVED"||error.code==="ASPI_ACTIVITY_NOT_FOUND");
      setTestingError({summary:unresolved?"Activity ID belum dapat diverifikasi.":"Proses ulang bukti gagal.",technical:message,suggestion:error instanceof ApiError&&error.code==="ASPI_SESSION_EXPIRED"?"Login ulang diperlukan sebelum mengambil bukti. Transaksi tidak dijalankan ulang.":"PDF yang sudah tersimpan tetap aman. Transaksi tidak dijalankan ulang."});
    }finally{retryLock.current=false;setReprocessingId("");}
  }
  function pdfsOf(run:Run){
    const request=object(run.request)?run.request:null;
    return request&&Array.isArray(request.aspiActivities)?request.aspiActivities.filter(object).map(item=>({activityId:String(item.activityId??""),service:String(item.service??"ASPI"),fileName:evidencePdfFilenameForRun(request,item),pdfReady:item.pdfReady===true})).filter(item=>item.activityId):[];
  }
  async function downloadPdf(run:Run,activityId:string,fileName:string){
    if(!confirmCrossUser(run,"Unduh PDF"))return;
    setDownloadingId(`${run.id}:${activityId}`);setError("");
    try{
      const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadAspiActivityPdf",id:run.id,activityId,confirmCrossUser:run.operator_id!==state.user?.id}),signal:AbortSignal.timeout(1000000)});
      if(!response.ok){const error=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw Error(String(error.error));}
      const type=response.headers.get("content-type")??"";
      if(/json|html/i.test(type))throw Error("File yang diterima bukan PDF resmi ASPI yang valid.");
      const bytes=new Uint8Array(await response.arrayBuffer());
      const header=String.fromCharCode(...bytes.slice(0,5));
      if(bytes.length<5||header!=="%PDF-")throw Error("File yang diterima bukan PDF resmi ASPI yang valid.");
      const blob=new Blob([bytes],{type:"application/pdf"}),url=URL.createObjectURL(blob),link=document.createElement("a");
      link.href=url;link.download=fileName;document.body.appendChild(link);link.click();link.remove();
      window.setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(e){setError((e as Error).message);}finally{setDownloadingId("");}
  }
  function openPdfPreview(run:Run,activityId:string,fileName:string){
    if(!confirmCrossUser(run,"Preview PDF"))return;
    setPreview({runId:run.id,activityId,fileName,confirmCrossUser:run.operator_id!==state.user?.id});
  }
  function downloadJson(run:Run){
    const blob=new Blob([JSON.stringify({request:run.request,response:run.response},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`${String(object(run.request)?run.request.activityName??run.id:run.id)}.json`;a.click();URL.revokeObjectURL(url);
  }

  const selectedScenario=clientSimulatorScenario(scenarioId);
  let aspiServiceName="";
  let scenarioError="";
  if(provider&&service&&selectedScenario){
    try{aspiServiceName=buildClientSimulatorServiceName(provider.name,service.name,selectedScenario.label);}catch(error){scenarioError=thrownMessage(error);}
  }else if(scenarioAttempted&&!selectedScenario)scenarioError="Pilih skenario pengujian terlebih dahulu.";
  const expectation=selectedScenario&&service?presentScenarioExpectation(selectedScenario.id,service.data):null;
  const historyRuns=historyData.runs.filter(r=>r.mode==="client_sim");
  // Session-only: Hasil Testing never falls back to History.
  const latest=resultId?historyRuns.find(run=>run.id===resultId)??state.runs.find(run=>run.id===resultId&&run.mode==="client_sim")??null:null;
  const latestPdf=latest?countsOf(latest):{ready:0,required:0};

  return <div className="testing-page">
    <div className="testing-toolbar"><button type="button" className="secondary-button" disabled={formLocked} onClick={()=>refreshPage().catch(error=>setError((error as Error).message))}>{refreshing?"Memuat...":"Refresh"}</button></div>
    <form className="card test-form" onSubmit={run}>
      <div className="section-header"><div><h2>Form Testing</h2><p>Pilih User SNAP, penyedia, API Service, dan skenario.</p></div></div>
      <div className="form-grid">
        <label className="form-field"><span>User SNAP</span><select required aria-label="User SNAP" disabled={formLocked} value={snapUserId} onChange={e=>setSnapUserId(e.target.value)}><option value="">Pilih User SNAP</option>{snapUsers.map(user=><option key={user.id} value={user.id}>{snapUserLabel(user)}</option>)}</select></label>
        <label className="form-field"><span>Penyedia Client Simulator</span><select required aria-label="Penyedia Client Simulator" disabled={formLocked} value={providerId} onChange={e=>{const id=e.target.value;const nextProvider=providers.find(x=>x.id===id);setProviderId(id);setServiceId("");loadDefaults(nextProvider,undefined);}}><option value="">Pilih penyedia</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="form-field"><span>API Service</span><select required aria-label="API Service" disabled={formLocked||!providerId||!services.length} value={serviceId} onChange={e=>{const id=e.target.value;const nextProvider=providers.find(x=>x.id===providerId);const nextService=services.find(s=>s.id===id);setServiceId(id);loadDefaults(nextProvider,nextService);}}><option value="">{services.length?"Pilih service":"Belum ada service"}</option>{services.map(s=><option key={s.id} value={s.id}>{s.name} - {value(s,"method")||"POST"} {value(s,"path")||value(s,"serviceUrl")}</option>)}</select></label>
        <label className="form-field"><span>Skenario Pengujian *</span><select aria-label="Skenario Pengujian" aria-invalid={scenarioError?true:undefined} disabled={formLocked} value={scenarioId} onChange={e=>{setScenarioId(e.target.value);setConfirmDuplicate(false);}}><option value="">Pilih Skenario</option>{CLIENT_SIMULATOR_SCENARIOS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select>{scenarioError&&<small className="field-error" role="alert">{scenarioError}</small>}</label>
      </div>
      {provider&&!services.length&&<p className="helper">Penyedia ini belum mempunyai API Service. Tambahkan API Service melalui Master Data → API Service Client Simulator.{onOpenMasterData&&<> <button type="button" className="text-button" onClick={onOpenMasterData}>Buka API Service Client Simulator</button></>}</p>}
      <h3>Service Name ASPI</h3>
      <label className="form-field wide"><span>Service Name ASPI</span><input readOnly aria-label="Service Name ASPI" value={aspiServiceName} placeholder="Pilih penyedia, API Service, dan skenario."/></label>
      {expectation&&<section aria-label="Expected Result"><h3>Expected Result</h3><dl className="expected-result"><div><dt>HTTP Status</dt><dd>{expectation.http}</dd></div><div><dt>SNAP Code</dt><dd>{expectation.code||`${expectation.pattern} · opsional`}</dd></div><div><dt>Response Message</dt><dd>{expectation.message||"—"}</dd></div></dl><p className="helper">{selectedScenario?selectedScenario.summary:"Pilih skenario pengujian terlebih dahulu."}</p></section>}
      {!selectedScenario&&<p className="helper">Pilih skenario pengujian terlebih dahulu.</p>}
      {provider&&<>
        <h3>Konfigurasi request</h3>
        <div className="form-grid">
          <label className="form-field"><span>Access Token URI</span><input readOnly value={accessTokenUri}/></label>
          <label className="form-field"><span>Service URI</span><input readOnly value={service?serviceUri:"Pilih API Service"}/></label>
          <div className="timestamp-field wide">
            <label className="form-field"><span>X-TIMESTAMP</span><input disabled={formLocked} value={timestamp} onChange={e=>setTimestamp(e.target.value)} spellCheck={false}/></label>
            <div className="timestamp-controls">
              <div className="timestamp-buttons">
                <button type="button" className="secondary-button" disabled={formLocked} onClick={()=>setTimestamp(t=>{try{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())-60_000));}catch{return buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()-60_000));}})}>-1 Menit</button>
                <button type="button" className="secondary-button" disabled={formLocked} onClick={()=>setTimestamp(t=>{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())+60_000));})}>+1 Menit</button>
                <button type="button" className="secondary-button" disabled={formLocked} onClick={()=>setTimestamp(buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()+120_000)))}>Reset</button>
              </div>
              <label className="timestamp-millis"><input type="checkbox" disabled={formLocked} checked={includeMillis} onChange={e=>{setIncludeMillis(e.target.checked);setTimestamp(buildTimestamp(offsetMinutes,e.target.checked,new Date(Date.now()+120_000)));}}/><span>Milidetik</span></label>
            </div>
          </div>
          <label className="form-field"><span>X-PARTNER-ID</span><input aria-label="X-PARTNER-ID" disabled={formLocked} value={shownPartnerId} onChange={e=>{setHeaderTouched(old=>({...old,partnerId:true}));setPartnerId(e.target.value);}}/></label>
          <label className="form-field"><span>X-EXTERNAL-ID</span><input aria-label="X-EXTERNAL-ID" readOnly={scenarioId==="DUPLICATE_EXTERNAL_ID"} disabled={formLocked||scenarioId==="DUPLICATE_EXTERNAL_ID"} value={scenarioId==="DUPLICATE_EXTERNAL_ID"?"Dibuat otomatis saat dijalankan":shownExternalId} onChange={e=>{setHeaderTouched(old=>({...old,externalId:true}));setExternalId(e.target.value);}} placeholder="Kosongkan untuk generate otomatis" title={scenarioId==="DUPLICATE_EXTERNAL_ID"?"Baseline bank lalu request ASPI memakai External ID yang sama.":undefined}/></label>
          <label className="form-field"><span>X-DEVICE-ID</span><input aria-label="X-DEVICE-ID" disabled={formLocked} value={shownDeviceId} onChange={e=>{setHeaderTouched(old=>({...old,deviceId:true}));setDeviceId(e.target.value);}}/></label>
          <label className="form-field"><span>CHANNEL-ID</span><input aria-label="CHANNEL-ID" disabled={formLocked} value={shownChannelId} onChange={e=>{setHeaderTouched(old=>({...old,channelId:true}));setChannelId(e.target.value);}}/></label>
          {service&&<label className="form-field wide"><span>Request Body (JSON)</span><textarea aria-label="Request Body (JSON)" rows={8} spellCheck={false} disabled={formLocked} value={shownBody} onChange={e=>{setHeaderTouched(old=>({...old,body:true}));setBody(e.target.value);}}/></label>}
        </div>
        {scenarioId==="DUPLICATE_EXTERNAL_ID"&&<label className="check-row wide"><input type="checkbox" checked={confirmDuplicate} disabled={formLocked} onChange={e=>setConfirmDuplicate(e.target.checked)}/><span>Konfirmasi<small className="helper">Satu baseline ke bank, lalu satu request ASPI dengan External ID yang sama.</small></span></label>}
        {(scenarioId==="INVALID_ACCESS_TOKEN"||scenarioId==="INVALID_SIGNATURE"||scenarioId==="UNKNOWN_CLIENT")&&<p className="helper">Mutasi hanya pada request API Service.</p>}
        <div className="form-actions"><button type="button" className="secondary-button" disabled={formLocked} onClick={resetRequest}>Reset Form</button><button className="primary-button" disabled={busy||refreshing}>{busy?"Menjalankan...":"Jalankan Testing"}</button></div>
      </>}
      {!snapUsers.length&&<p className="helper">Belum ada User SNAP. Tambahkan di Master Data beserta email dan password portal ASPI.</p>}
      {!providers.length&&<p className="helper">Belum ada Penyedia. Tambahkan di Master Data → Penyedia Client Simulator.</p>}
    </form>

    <section className="card response-card" aria-live="polite">
      <div className="section-header"><div><h2>Hasil Testing</h2><p>{latest?new Date(latest.created_at).toLocaleString("id-ID"):"Hasil testing akan muncul setelah pengujian dijalankan."}</p></div>{latest&&<span className={`status-badge ${latest.status.toLowerCase()}`}>{latest.status}</span>}</div>
      <div className="response-summary">
        <div><span>HTTP Status</span><strong>{latest?.http_status??"—"}</strong></div>
        <div><span>SNAP Code</span><strong>{latest?.response_code??"—"}</strong></div>
        <div><span>PDF ASPI</span><strong>{latest?`${latestPdf.ready}/${latestPdf.required||"—"}`:"—"}</strong></div>
      </div>
      <EvaluationNotice run={latest}/>
      <pre className="response-code">{JSON.stringify(latest?.response??{message:"Hasil testing akan muncul setelah pengujian dijalankan."},null,2)}</pre>
      {latest&&<div className="inline-actions">
        <button type="button" className="text-button" onClick={()=>setSelectedRun(latest)}>Detail</button>
        {pdfsOf(latest).some(item=>item.pdfReady)&&<button type="button" className="text-button" onClick={()=>{const evidence=pdfsOf(latest).find(item=>item.pdfReady);if(evidence)openPdfPreview(latest,evidence.activityId,evidence.fileName);}}>Preview PDF</button>}
        {pendingEvidence(latest).map(item=><button type="button" className="text-button" key={item.activityId} disabled={formLocked||reprocessingId===`${latest.id}:${item.activityId}`} onClick={()=>void retryEvidence(latest,item.activityId)}>{reprocessingId===`${latest.id}:${item.activityId}`?"Mengambil bukti...":"Proses Ulang Bukti"}</button>)}
      </div>}
    </section>

    {progress&&<TestingProgress product="Client Simulator" progress={progress} running={running} formReady={!running} onCancel={async()=>{await api("cancelRun",{id:progressIdRef.current});}} onClose={()=>setProgress(null)} onRetryEvidence={undefined}/>}

    <section className="card history-card">
      <div className="section-header"><div><h2>History Testing</h2><p>{historyData.total} hasil Client Simulator pada periode terpilih.</p></div>
        <label className="search-box"><input aria-label="Cari history" value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setOffset(0);}} placeholder="Cari penyedia, service, status..."/></label>
      </div>
      <HistoryFilter value={historyRange} onChange={range=>{setHistoryRange(range);setOffset(0);}} filters={historyFilters} onFiltersChange={next=>{setHistoryFilters(next);setOffset(0);}} isAdmin={canViewAll}/>
      <div className="table-wrap" aria-busy={historyData.loading}><table><thead><tr><th>WAKTU</th>{canViewAll&&<th>PELAKSANA</th>}<th>SERVICE / PENYEDIA</th><th>STATUS</th><th>HTTP / PDF</th><th>DURASI</th><th>AKSI</th></tr></thead>
        <tbody>{historyRuns.map(run=>{
          const name=object(run.request)?String(run.request.activityName??""):"";
          const pdf=countsOf(run);
          const evidence=pdfsOf(run).find(item=>item.pdfReady&&officialActivity(item.activityId));
          return <tr key={run.id}>
            <td>{new Date(run.created_at).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}</td>
            {canViewAll&&<td>{run.operator?.name??"—"}</td>}
            <td>{name||run.notes||run.id}<span className="cell-caption">{pdfsOf(run).filter(item=>officialActivity(item.activityId)).map(item=>item.activityId).join(", ")||(run.mode==="client_sim"?"Activity ID belum tersedia":run.mode)}</span></td>
            <td><span className={`status-badge ${run.status.toLowerCase()}`}>{run.status}</span>{pdf.required>0&&pdf.ready<pdf.required&&<span className="cell-caption">Bukti belum lengkap</span>}</td>
            <td>{run.http_status??"—"} / {pdf.required?`${pdf.ready}/${pdf.required}`:"—"}</td>
            <td>{run.duration_ms??0} ms</td>
            <td><div className="inline-actions">
              <button type="button" className="text-button" onClick={()=>setSelectedRun(run)}>Detail</button>
              {evidence&&<button type="button" className="text-button" disabled={!!downloadingId} onClick={()=>openPdfPreview(run,evidence.activityId,evidence.fileName)}>Preview PDF</button>}
              {evidence&&<button type="button" className="text-button" disabled={downloadingId===`${run.id}:${evidence.activityId}`} onClick={()=>void downloadPdf(run,evidence.activityId,evidence.fileName)}>{downloadingId===`${run.id}:${evidence.activityId}`?"Mengunduh...":"Download PDF"}</button>}
              {pendingEvidence(run).map(item=><button type="button" className="text-button" key={item.activityId} disabled={running||reprocessingId===`${run.id}:${item.activityId}`} onClick={()=>void retryEvidence(run,item.activityId)}>{reprocessingId===`${run.id}:${item.activityId}`?"Mengambil bukti...":"Proses Ulang Bukti"}</button>)}
            </div></td>
          </tr>;
        })}</tbody>
      </table>{!historyRuns.length&&<p className="empty-note">{historyData.loading?"Memuat history…":"Belum ada history yang cocok."}</p>}</div>
      <div className="history-pagination"><button className="secondary-button" disabled={!offset||historyData.loading} onClick={()=>setOffset(Math.max(0,offset-20))}>Sebelumnya</button><span>{historyData.total?`${offset+1}-${Math.min(offset+historyRuns.length,historyData.total)} dari ${historyData.total}`:"0 hasil"}</span><button className="secondary-button" disabled={offset+20>=historyData.total||historyData.loading} onClick={()=>setOffset(offset+20)}>Berikutnya</button></div>
    </section>

    {preview&&<PdfPreview runId={preview.runId} activityId={preview.activityId} fileName={preview.fileName} confirmCrossUser={preview.confirmCrossUser===true} onClose={()=>setPreview(null)}/>}
    {testingError&&<div className="modal-backdrop error-layer"><section className="card edit-modal error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sim-error-title"><div className="modal-header"><div><h2 id="sim-error-title">{testingError.summary}</h2></div><button type="button" className="close-button" aria-label="Tutup" title="Tutup" onClick={()=>setTestingError(null)}><UiIcon name="close"/></button></div><div className="modal-body"><dl><div><dt>Detail</dt><dd>{testingError.technical}</dd></div><div><dt>Saran</dt><dd>{testingError.suggestion}</dd></div></dl></div></section></div>}
    {selectedRun&&<ClientSimulatorDetailModal
      run={selectedRun}
      running={running}
      reprocessingId={reprocessingId}
      downloadingId={downloadingId}
      onClose={()=>setSelectedRun(null)}
      onRetryEvidence={(activityId)=>void retryEvidence(selectedRun,activityId)}
      onPreview={(activityId,fileName)=>openPdfPreview(selectedRun,activityId,fileName)}
      onDownloadPdf={(activityId,fileName)=>void downloadPdf(selectedRun,activityId,fileName)}
      onDownloadJson={()=>downloadJson(selectedRun)}
      pdfs={pdfsOf(selectedRun)}
      pending={pendingEvidence(selectedRun)}
      counts={countsOf(selectedRun)}
      officialActivity={officialActivity}
    />}
  </div>;
}


function ClientSimulatorDetailModal({run,running,reprocessingId,downloadingId,onClose,onRetryEvidence,onPreview,onDownloadPdf,onDownloadJson,pdfs,pending,counts,officialActivity}:{run:Run;running:boolean;reprocessingId:string;downloadingId:string;onClose:()=>void;onRetryEvidence:(activityId:string)=>void;onPreview:(activityId:string,fileName:string)=>void;onDownloadPdf:(activityId:string,fileName:string)=>void;onDownloadJson:()=>void;pdfs:Array<{activityId:string;service:string;fileName:string;pdfReady:boolean}>;pending:Array<{activityId:string;service:string;fileName:string;pdfReady:boolean}>;counts:{ready:number;required:number};officialActivity:(value:string)=>boolean}){
  const request=object(run.request)?run.request:null;
  const identity=request&&object(request.identity)?request.identity:null;
  const title=String(request?.aspiServiceName??request?.activityName??run.notes??run.id);
  const external=request&&object(request.idempotency)?String(request.idempotency.externalId??""):"";
  const baseline=request&&object(request.baseline)?request.baseline:request&&Array.isArray(request.steps)?request.steps.find(step=>object(step)&&(step.stage==="duplicate_baseline"||step.stage==="duplicate_seed")):null;
  const baselineHttp=object(baseline)?baseline.httpStatus:null;
  const baselineCode=object(baseline)?String(baseline.responseCode??""):"";
  const errors=request&&Array.isArray(request.evidenceErrors)?request.evidenceErrors:[];
  const activityIds=pdfs.filter(item=>officialActivity(item.activityId)).map(item=>item.activityId);
  return <div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget)onClose();}}><div className="card edit-modal run-modal" role="dialog" aria-modal="true" aria-labelledby="sim-detail-title" onClick={event=>event.stopPropagation()}>
    <div className="modal-header"><div><h2 id="sim-detail-title">Detail</h2><p>{title}</p></div><button type="button" className="close-button" aria-label="Tutup" onClick={onClose}><UiIcon name="close"/></button></div>
    <div className="modal-body">
      <EvaluationNotice run={run}/>
      <section className="detail-summary" aria-label="Ringkasan pengujian">
        <dl>
          <dt>Status</dt><dd><span className={`status-badge ${run.status.toLowerCase()}`}>{run.status}</span></dd>
          <dt>Skenario</dt><dd>{String(request?.scenarioName??identity?.scenarioName??"-")}</dd>
          <dt>API Service</dt><dd>{String(identity?.serviceName??(request&&object(request.service)?request.service.name:"-"))}</dd>
          <dt>Service Name ASPI</dt><dd>{String(request?.aspiServiceName??request?.activityName??"-")}</dd>
          <dt>HTTP / SNAP</dt><dd>{run.http_status??"-"}{run.response_code?` / ${run.response_code}`:""}</dd>
          {external?<><dt>X-EXTERNAL-ID</dt><dd>{external}</dd></>:null}
          {baseline?<><dt>Baseline bank</dt><dd>HTTP {baselineHttp==null?"-":String(baselineHttp)}{baselineCode?` / ${baselineCode}`:""}{request?.baselinePhase?` (${String(request.baselinePhase)})`:""}</dd></>:null}
          <dt>PDF</dt><dd>{counts.ready}/{counts.required||0}{counts.required>counts.ready?" - belum lengkap":""}</dd>
          {activityIds.length?<><dt>Activity ID</dt><dd>{activityIds.join(", ")}</dd></>:null}
        </dl>
      </section>
      {errors.length>0&&<div className="validation-box"><strong>Bukti belum tersedia</strong><p>{errors.map(item=>typeof item==="string"?item:object(item)?String(item.error??""):"").filter(Boolean).join(" · ")}</p></div>}
      <div className="inline-actions">{pending.map(item=><button type="button" className="secondary-button" key={item.activityId} disabled={running||!!reprocessingId} onClick={()=>onRetryEvidence(item.activityId)}>{reprocessingId===`${run.id}:${item.activityId}`?"Mengambil bukti...":"Proses Ulang Bukti"}</button>)}{pdfs.filter(item=>item.pdfReady&&officialActivity(item.activityId)).map(item=><button type="button" className="secondary-button" key={item.activityId} disabled={!!downloadingId} onClick={()=>onPreview(item.activityId,item.fileName)}>View PDF</button>)}{pdfs.filter(item=>item.pdfReady&&officialActivity(item.activityId)).map(item=><button type="button" className="secondary-button" key={`dl-${item.activityId}`} disabled={downloadingId===`${run.id}:${item.activityId}`} onClick={()=>onDownloadPdf(item.activityId,item.fileName)}>{downloadingId===`${run.id}:${item.activityId}`?"Mengunduh...":"Download PDF"}</button>)}</div>
      <details className="json-fold"><summary>Request JSON</summary><pre className="snippet-code">{JSON.stringify(run.request,null,2)}</pre></details>
      <details className="json-fold"><summary>Response JSON</summary><pre className="snippet-code">{JSON.stringify(run.response,null,2)}</pre></details>
    </div>
    <div className="modal-footer"><button type="button" className="primary-button" onClick={onDownloadJson}>Download JSON</button></div>
  </div></div>;
}
