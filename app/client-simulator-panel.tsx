"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Api, HistoryFilters, Item, Run, State } from "./model";
import HistoryFilter from "./history-filter";
import { rangeForPeriod } from "./history-period";
import { useHistory } from "./use-history";
import { can } from "./privileges";
import TestingProgress, { type TestProgress } from "./testing-progress";
import PdfPreview from "./pdf-preview";
import UiIcon from "./ui-icon";
import { ApiError } from "./api-client";
import { buildClientSimulatorServiceName, thrownMessage } from "./client-simulator-name";
import { CLIENT_SIMULATOR_SCENARIOS, clientSimulatorScenario, presentScenarioExpectation } from "./client-simulator-scenarios";
import EvaluationNotice from "./evaluation-notice";

const value=(row:Item|undefined,key:string)=>String(row?.data[key]??"");
const object=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);

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
  const [busy,setBusy]=useState(false),[running,setRunning]=useState(false),[progress,setProgress]=useState<TestProgress|null>(null);
  const progressIdRef=useRef("");
  const [historyRange,setHistoryRange]=useState(()=>rangeForPeriod("today"));
  const [historyFilters,setHistoryFilters]=useState<HistoryFilters>({scope:canViewAll?"all":"mine"});
  const [historyQuery,setHistoryQuery]=useState(""),[offset,setOffset]=useState(0);
  const [selectedRun,setSelectedRun]=useState<Run|null>(null),[downloadingId,setDownloadingId]=useState(""),[preview,setPreview]=useState<{runId:string;activityId:string;fileName:string}|null>(null),[testingError,setTestingError]=useState<{summary:string;technical:string;suggestion:string}|null>(null),[reprocessingId,setReprocessingId]=useState("");
  const retryLock=useRef(false);
  useEffect(()=>{
    if(!selectedRun&&!testingError)return;
    function onKey(event:KeyboardEvent){if(event.key==="Escape"&&!running){setSelectedRun(null);setTestingError(null);}}
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[selectedRun,testingError,running]);
  const historyData=useHistory(api,historyRange,"simulator",historyQuery,offset,20,state.runs,historyFilters);

  function loadDefaults(nextProvider?:Item,nextService?:Item){
    const p=nextProvider??provider,s=nextService??service;
    const cfg=object(p?.data.timestampConfig)?p!.data.timestampConfig as {offsetMinutes?:number;includeMillis?:boolean}:{};
    const millis=cfg.includeMillis===true;
    const offset=Number(cfg.offsetMinutes??420);
    setIncludeMillis(millis);
    setTimestamp(()=>buildTimestamp(offset,millis,new Date(Date.now()+120_000)));
    setPartnerId(value(s,"partnerId")||value(p,"partnerId")||value(p,"clientKey")||value(p,"clientId"));
    setExternalId(value(s,"externalId"));
    setDeviceId(value(s,"deviceId")||value(p,"deviceId"));
    setChannelId(value(s,"channelId")||value(p,"channelId"));
    setBody(value(s,"defaultBody")||value(s,"requestBody")||"{}");
  }
  function resetRequest(){
    if(running)return;
    setScenarioId("");setScenarioAttempted(false);setConfirmDuplicate(false);loadDefaults(provider,service);
  }
  function snapUserLabel(user:Item){
    const display=value(user,"displayUsername").trim();
    if(display&&!display.includes("@"))return display;
    const name=user.name.trim();
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
    if(chosen.id==="DUPLICATE_EXTERNAL_ID"&&!confirmDuplicate){setError("Konfirmasi diperlukan sebelum mengirim ulang X-EXTERNAL-ID yang sudah pernah dikirim.");return;}
    try{buildClientSimulatorServiceName(provider.name,service.name,chosen.label);}catch(error){setError(thrownMessage(error));return;}
    if(!channelId.trim()){setError("CHANNEL-ID wajib diisi. Form ASPI mengirim header ini.");return;}
    const progressId=crypto.randomUUID();
    progressIdRef.current=progressId;
    setBusy(true);setRunning(true);setError("");setProgress({status:"queued",stage:"preparing",steps:[]});
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
        overrides:{partnerId,externalId,deviceId,channelId,body,timestamp,includeMillis,offsetMinutes,regenerateExternalId:scenarioId!=="DUPLICATE_EXTERNAL_ID"&&!externalId.trim()},
      });
      try{setProgress(await api("getProgress",{id:progressId}) as unknown as TestProgress);}catch{/* the modal already has the last poll */}
      setNotice(`${String(response.activityName??"Client Simulator")} · ${String(response.status??"")} · PDF ${response.pdfReady?"tersimpan":"belum tersimpan"}`);
      await reload();
    }catch(e){
      try{setProgress(await api("getProgress",{id:progressId}) as unknown as TestProgress);}catch{/* keep the last visible log */}
      setError((e as Error).message);
    }finally{polling=false;clearInterval(timer);setRunning(false);setBusy(false);}
  }

  const accessTokenUri=(()=>{
    if(!provider)return "—";
    const base=value(provider,"baseUrl").replace(/\/$/,"");
    const path=value(provider,"accessTokenUrl")||"/api/v1.0/access-token/b2b";
    return path.startsWith("http")?path:`${base}${path.startsWith("/")?path:`/${path}`}`;
  })();
  const serviceUri=(()=>{
    if(!provider||!service)return "—";
    const base=value(provider,"baseUrl").replace(/\/$/,"");
    const path=value(service,"path")||value(service,"serviceUrl");
    return `${base}${path}`;
  })();

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
    return object(run.request)&&Array.isArray(run.request.aspiActivities)?run.request.aspiActivities.filter(object).map(item=>({activityId:String(item.activityId??""),service:String(item.service??"ASPI"),fileName:`ASPI-${String(item.service??"Activity").replace(/[^A-Za-z0-9_-]/g,"-")}-${String(item.activityId)}.pdf`,pdfReady:item.pdfReady===true})).filter(item=>item.activityId):[];
  }
  async function downloadPdf(run:Run,activityId:string,fileName:string){
    setDownloadingId(`${run.id}:${activityId}`);setError("");
    try{
      const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadAspiActivityPdf",id:run.id,activityId}),signal:AbortSignal.timeout(1000000)});
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

  return <>
    <form className="card test-form" onSubmit={run}>
      <div className="section-header"><div><h2>Client Simulator</h2><p>Pilih User SNAP, penyedia, API Service, dan skenario pengujian.</p></div></div>
      <h3>Identitas pengujian</h3>
      <div className="form-grid">
        <label className="form-field"><span>User SNAP</span><select required aria-label="User SNAP" disabled={running} value={snapUserId} onChange={e=>setSnapUserId(e.target.value)}><option value="">Pilih User SNAP</option>{snapUsers.map(user=><option key={user.id} value={user.id}>{snapUserLabel(user)}</option>)}</select></label>
        <label className="form-field"><span>Penyedia Client Simulator</span><select required disabled={running} value={providerId} onChange={e=>{const id=e.target.value;setProviderId(id);setServiceId("");loadDefaults(providers.find(x=>x.id===id),undefined);}}><option value="">Pilih penyedia</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="form-field"><span>API Service</span><select required aria-label="API Service" disabled={running||!providerId||!services.length} value={serviceId} onChange={e=>{const id=e.target.value;setServiceId(id);loadDefaults(provider,services.find(s=>s.id===id));}}><option value="">{services.length?"Pilih service":"Belum ada service"}</option>{services.map(s=><option key={s.id} value={s.id}>{s.name} — {value(s,"method")||"POST"} {value(s,"path")||value(s,"serviceUrl")}</option>)}</select></label>
        <label className="form-field"><span>Skenario Pengujian *</span><select aria-label="Skenario Pengujian" aria-invalid={scenarioError?true:undefined} disabled={running} value={scenarioId} onChange={e=>{setScenarioId(e.target.value);setConfirmDuplicate(false);}}><option value="">Pilih Skenario</option>{CLIENT_SIMULATOR_SCENARIOS.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select>{scenarioError&&<small className="field-error" role="alert">{scenarioError}</small>}</label>
      </div>
      {provider&&!services.length&&<p className="helper">Penyedia ini belum mempunyai API Service. Tambahkan API Service melalui Master Data → API Service Client Simulator.{onOpenMasterData&&<> <button type="button" className="text-button" onClick={onOpenMasterData}>Buka API Service Client Simulator</button></>}</p>}
      <h3>Service Name ASPI</h3>
      <label className="form-field wide"><span>Service Name ASPI</span><input readOnly aria-label="Service Name ASPI" value={aspiServiceName} placeholder="Pilih penyedia, API Service, dan skenario."/></label>
      {expectation&&<section aria-label="Expected Result"><h3>Expected Result</h3><dl className="expected-result"><div><dt>HTTP Status</dt><dd>{expectation.http}</dd></div><div><dt>SNAP Code</dt><dd>{expectation.ready&&expectation.code?expectation.code:`${expectation.pattern} · konfigurasi belum lengkap`}</dd></div><div><dt>Response Message</dt><dd>{expectation.message||"—"}</dd></div></dl><p className="helper">{selectedScenario?selectedScenario.summary:"Pilih skenario pengujian terlebih dahulu."}</p></section>}
      {!selectedScenario&&<p className="helper">Pilih skenario pengujian terlebih dahulu.</p>}
      {provider&&service&&<>
        <h3>Konfigurasi request</h3>
        <div className="form-grid">
          <label className="form-field"><span>Access Token URI</span><input readOnly value={accessTokenUri}/></label>
          <label className="form-field"><span>Service URI</span><input readOnly value={serviceUri}/></label>
          <div className="timestamp-field wide">
            <label className="form-field"><span>X-TIMESTAMP</span><input disabled={running} value={timestamp} onChange={e=>setTimestamp(e.target.value)} spellCheck={false}/></label>
            <div className="timestamp-controls">
              <div className="timestamp-buttons">
                <button type="button" className="secondary-button" disabled={running} onClick={()=>setTimestamp(t=>{try{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())-60_000));}catch{return buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()-60_000));}})}>-1 Menit</button>
                <button type="button" className="secondary-button" disabled={running} onClick={()=>setTimestamp(t=>{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())+60_000));})}>+1 Menit</button>
                <button type="button" className="secondary-button" disabled={running} onClick={()=>setTimestamp(buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()+120_000)))}>Reset</button>
              </div>
              <label className="timestamp-millis"><input type="checkbox" disabled={running} checked={includeMillis} onChange={e=>{setIncludeMillis(e.target.checked);setTimestamp(buildTimestamp(offsetMinutes,e.target.checked,new Date(Date.now()+120_000)));}}/><span>Milidetik</span></label>
            </div>
            <small className="helper">Bank Sumut menolak jam yang tidak di depan servernya. Timestamp yang terlalu dekat dengan waktu sekarang dikirim sebagai sekarang + 2 menit.</small>
          </div>
          <label className="form-field"><span>X-PARTNER-ID</span><input disabled={running} value={partnerId} onChange={e=>setPartnerId(e.target.value)}/></label>
          <label className="form-field"><span>X-EXTERNAL-ID</span><input readOnly={scenarioId==="DUPLICATE_EXTERNAL_ID"} disabled={running||scenarioId==="DUPLICATE_EXTERNAL_ID"} value={scenarioId==="DUPLICATE_EXTERNAL_ID"?"Diambil dari pengujian sebelumnya":externalId} onChange={e=>setExternalId(e.target.value)} placeholder="Kosongkan untuk generate otomatis"/>{scenarioId==="DUPLICATE_EXTERNAL_ID"&&<small className="helper">ID sumber dipilih di server dari run yang sudah terkirim pada penyedia, service, dan partner yang sama.</small>}</label>
          <label className="form-field"><span>X-DEVICE-ID</span><input disabled={running} value={deviceId} onChange={e=>setDeviceId(e.target.value)}/></label>
          <label className="form-field"><span>CHANNEL-ID</span><input disabled={running} value={channelId} onChange={e=>setChannelId(e.target.value)}/></label>
          <label className="form-field wide"><span>Request Body (JSON)</span><textarea rows={10} spellCheck={false} disabled={running} value={body} onChange={e=>setBody(e.target.value)}/><small className="helper">Diisi dari Request Body API Service {service.name}. Perubahan di sini hanya untuk pengujian kali ini. URI yang diisi: {serviceUri}.</small></label>
        </div>
        {scenarioId==="DUPLICATE_EXTERNAL_ID"&&<label className="form-field wide"><span>Konfirmasi</span><span><input type="checkbox" checked={confirmDuplicate} disabled={running} onChange={e=>setConfirmDuplicate(e.target.checked)}/> Request ini memakai kembali X-EXTERNAL-ID yang sudah dikirim pada pengujian sebelumnya.</span></label>}
        {(scenarioId==="INVALID_ACCESS_TOKEN"||scenarioId==="INVALID_SIGNATURE"||scenarioId==="UNKNOWN_CLIENT")&&<p className="helper">Perubahan hanya terjadi pada request API Service. Kredensial Master Data dan token asli tidak ditampilkan.</p>}
        <div className="form-actions"><button type="button" className="secondary-button" disabled={running} onClick={resetRequest}>Reset Form</button><button className="primary-button" disabled={busy}>{busy?"Menjalankan...":"Jalankan Client Simulator"}</button></div>
      </>}
      {!snapUsers.length&&<p className="helper">Belum ada User SNAP. Tambahkan di Master Data beserta email dan password portal ASPI.</p>}
      {!providers.length&&<p className="helper">Belum ada Penyedia. Tambahkan di Master Data → Penyedia Client Simulator.</p>}
    </form>

    {progress&&<TestingProgress product="Client Simulator" progress={progress} running={running} formReady={!running} onCancel={async()=>{await api("cancelRun",{id:progressIdRef.current});}} onClose={()=>setProgress(null)} onRetryEvidence={undefined}/>}

    <section className="card history-card">
      <div className="section-header"><div><h2>History Testing</h2><p>{historyData.total} hasil Client Simulator pada periode terpilih.</p></div>
        <label className="search-box"><input aria-label="Cari history" value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setOffset(0);}} placeholder="Cari penyedia, service, status..."/></label>
      </div>
      <HistoryFilter value={historyRange} onChange={range=>{setHistoryRange(range);setOffset(0);}} filters={historyFilters} onFiltersChange={next=>{setHistoryFilters(next);setOffset(0);}} isAdmin={canViewAll}/>
      <div className="table-wrap" aria-busy={historyData.loading}><table><thead><tr><th>WAKTU</th>{canViewAll&&<th>PELAKSANA</th>}<th>SERVICE / PENYEDIA</th><th>STATUS</th><th>HTTP / PDF</th><th>DURASI</th><th>AKSI</th></tr></thead>
        <tbody>{historyData.runs.filter(r=>r.mode==="client_sim"||r.mode==="mock").map(run=>{
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
              <button type="button" className="text-button" onClick={()=>downloadJson(run)}>JSON</button>
              {evidence&&<button type="button" className="text-button" disabled={!!downloadingId} onClick={()=>setPreview({runId:run.id,activityId:evidence.activityId,fileName:evidence.fileName})}>View PDF</button>}
              {evidence&&<button type="button" className="text-button" disabled={downloadingId===`${run.id}:${evidence.activityId}`} onClick={()=>void downloadPdf(run,evidence.activityId,evidence.fileName)}>{downloadingId===`${run.id}:${evidence.activityId}`?"Mengunduh...":"Download PDF"}</button>}
              {pendingEvidence(run).map(item=><button type="button" className="text-button" key={item.activityId} disabled={running||reprocessingId===`${run.id}:${item.activityId}`} onClick={()=>void retryEvidence(run,item.activityId)}>{reprocessingId===`${run.id}:${item.activityId}`?"Mengambil bukti...":"Proses Ulang Bukti"}</button>)}
            </div></td>
          </tr>;
        })}</tbody>
      </table>{!historyData.runs.length&&<p className="empty-note">{historyData.loading?"Memuat history…":"Belum ada history yang cocok."}</p>}</div>
      <div className="history-pagination"><button className="secondary-button" disabled={!offset||historyData.loading} onClick={()=>setOffset(Math.max(0,offset-20))}>Sebelumnya</button><span>{historyData.total?`${offset+1}–${Math.min(offset+historyData.runs.length,historyData.total)} dari ${historyData.total}`:"0 hasil"}</span><button className="secondary-button" disabled={offset+20>=historyData.total||historyData.loading} onClick={()=>setOffset(offset+20)}>Berikutnya</button></div>
    </section>

    {preview&&<PdfPreview runId={preview.runId} activityId={preview.activityId} fileName={preview.fileName} onClose={()=>setPreview(null)}/>}
    {testingError&&<div className="modal-backdrop error-layer"><section className="card error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sim-error-title"><button type="button" className="close-button" aria-label="Tutup" onClick={()=>setTestingError(null)}><UiIcon name="close"/></button><h2 id="sim-error-title">{testingError.summary}</h2><dl><div><dt>Detail</dt><dd>{testingError.technical}</dd></div><div><dt>Saran</dt><dd>{testingError.suggestion}</dd></div></dl></section></div>}
    {selectedRun&&<div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget)setSelectedRun(null);}}><div className="card edit-modal run-modal" onClick={event=>event.stopPropagation()}>
      <div className="section-header"><div><h2>Detail Testing</h2><p>{selectedRun.notes||selectedRun.id}</p></div><button type="button" className="close-button" aria-label="Tutup" onClick={()=>setSelectedRun(null)}><UiIcon name="close"/></button></div>
      <EvaluationNotice run={selectedRun}/>
      <p className="helper">Nama Skenario: {String(object(selectedRun.request)?selectedRun.request.scenarioName??"—":"—")}</p>
      <p className="helper">Service Name ASPI: {String(object(selectedRun.request)?selectedRun.request.aspiServiceName??selectedRun.request.activityName??"—":"—")}</p>
      <p className="helper">PDF ASPI: {countsOf(selectedRun).ready}/{countsOf(selectedRun).required||0}{countsOf(selectedRun).required>countsOf(selectedRun).ready?" · bukti belum lengkap":""}</p>
      {(()=>{const request=object(selectedRun.request)?selectedRun.request:null;const errors=request&&Array.isArray(request.evidenceErrors)?request.evidenceErrors:[];if(!errors.length)return null;return <div className="validation-box"><strong>Bukti yang belum tersedia</strong><p>{errors.map(item=>typeof item==="string"?item:object(item)?String(item.error??""):"").filter(Boolean).join(" · ")}</p></div>;})()}
      <div className="inline-actions">{pendingEvidence(selectedRun).map(item=><button type="button" className="secondary-button" key={item.activityId} disabled={running||!!reprocessingId} onClick={()=>void retryEvidence(selectedRun,item.activityId)}>{reprocessingId===`${selectedRun.id}:${item.activityId}`?"Mengambil bukti...":`Proses Ulang Bukti ${item.activityId.slice(0,8)}`}</button>)}{pdfsOf(selectedRun).filter(item=>item.pdfReady&&officialActivity(item.activityId)).map(item=><button type="button" className="secondary-button" key={item.activityId} disabled={!!downloadingId} onClick={()=>setPreview({runId:selectedRun.id,activityId:item.activityId,fileName:item.fileName})}>View PDF</button>)}</div>
      <h3>Request</h3><pre className="snippet-code">{JSON.stringify(selectedRun.request,null,2)}</pre><h3>Response</h3><pre className="snippet-code">{JSON.stringify(selectedRun.response,null,2)}</pre>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setSelectedRun(null)}>Tutup</button><button type="button" className="primary-button" onClick={()=>downloadJson(selectedRun)}>Download JSON</button></div>
    </div></div>}
  </>;
}
