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

const value=(row:Item|undefined,key:string)=>String(row?.data[key]??"");
const object=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);

function pad(n:number){return String(n).padStart(2,"0");}
function buildTimestamp(offsetMinutes:number,includeMillis:boolean,at=new Date()){
  const local=new Date(at.getTime()+offsetMinutes*60_000);
  const ms=includeMillis?`.${String(local.getUTCMilliseconds()).padStart(3,"0")}`:"";
  const sign=offsetMinutes>=0?"+":"-",abs=Math.abs(offsetMinutes);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${ms}${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}

export default function ClientSimulatorPanel({state,api,reload,setError,setNotice}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void}){
  const providers=state.records.filter(r=>r.kind==="sim_provider");
  const allServices=state.records.filter(r=>r.kind==="sim_service");
  const snapUsers=state.records.filter(r=>r.kind==="snap_user");
  const canViewAll=can(state.user,"history","view_all");
  const [providerId,setProviderId]=useState(""),[serviceId,setServiceId]=useState(""),[snapUserId,setSnapUserId]=useState(""),[testType,setTestType]=useState<"positive"|"negative">("positive");
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
  const [adding,setAdding]=useState(false);
  const emptyService={name:"",method:"POST",path:"",defaultBody:"{}",channelId:"",deviceId:"",partnerId:"",externalId:"",expectedHttpStatus:"200",expectedCode:""};
  const [serviceDraft,setServiceDraft]=useState(emptyService);
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

  async function addService(){
    if(!provider)return;
    const path=serviceDraft.path.trim();
    if(!serviceDraft.name.trim()){setError("Isi nama API Service.");return;}
    if(!path.startsWith("/")||path.startsWith("//")){setError("Service URL harus path relatif diawali /.");return;}
    const bodyText=serviceDraft.defaultBody.trim()||"{}";
    try{const parsed=JSON.parse(bodyText);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error();}catch{setError("Request Body harus object JSON.");return;}
    setBusy(true);setError("");
    try{
      const saved=await api("save",{kind:"sim_service",name:serviceDraft.name.trim(),parentId:provider.id,data:{...serviceDraft,path,defaultBody:bodyText,expectedHttpStatus:serviceDraft.expectedHttpStatus?Number(serviceDraft.expectedHttpStatus):null}});
      const id=String(saved.id??"");
      setServiceId(id);
      setBody(bodyText);
      setPartnerId(serviceDraft.partnerId||value(provider,"partnerId")||value(provider,"clientKey")||value(provider,"clientId"));
      setExternalId(serviceDraft.externalId);
      setDeviceId(serviceDraft.deviceId||value(provider,"deviceId"));
      setChannelId(serviceDraft.channelId||value(provider,"channelId"));
      setAdding(false);setServiceDraft(emptyService);
      setNotice("API Service disimpan dan siap dijalankan.");
      await reload();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }

  async function run(event:FormEvent){
    event.preventDefault();
    if(adding){await addService();return;}
    if(!providerId||!serviceId){setError("Pilih penyedia dan API Service sebelum menjalankan.");return;}
    if(!snapUserId){setError("Pilih User SNAP untuk login ke form Client Simulator ASPI.");return;}
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
        progressId,providerId,serviceId,snapUserId,testType,
        overrides:{partnerId,externalId,deviceId,channelId,body,timestamp,includeMillis,offsetMinutes,regenerateExternalId:!externalId.trim()},
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

  return <>
    <form className="card test-form" onSubmit={run}>
      <div className="section-header"><div><h2>Client Simulator</h2><p>AutoSNAP login ke portal ASPI, mengisi form Client Simulator, menekan Send lalu Save Result, dan mengunduh PDF dari Client Simulator Activity. Access Token diambil ke penyedia supaya X-SIGNATURE bisa diisi. Request service dikirim satu kali, lewat tombol Send di form ASPI.</p></div></div>
      <div className="form-grid">
        <label className="form-field"><span>User SNAP</span><select required value={snapUserId} onChange={e=>setSnapUserId(e.target.value)}><option value="">Pilih akun portal ASPI</option>{snapUsers.map(user=><option key={user.id} value={user.id}>{user.name}{value(user,"email")?` (${value(user,"email")})`:""}</option>)}</select><small className="helper">Email dan password User SNAP dipakai untuk login https://apidevportal.aspi-indonesia.or.id/client-simulator.</small></label>
        <label className="form-field"><span>Penyedia Client Simulator</span><select required value={providerId} onChange={e=>{const id=e.target.value;setProviderId(id);setServiceId("");setAdding(false);loadDefaults(providers.find(x=>x.id===id),undefined);}}><option value="">Pilih penyedia</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <div className="form-field"><span>API Service</span><select required={!adding} aria-label="API Service" value={serviceId} disabled={!providerId||!services.length} onChange={e=>{const id=e.target.value;setServiceId(id);loadDefaults(provider,services.find(s=>s.id===id));}}><option value="">{services.length?"Pilih service":"Belum ada service"}</option>{services.map(s=><option key={s.id} value={s.id}>{s.name} — {value(s,"method")||"POST"} {value(s,"path")||value(s,"serviceUrl")}</option>)}</select>{provider&&<button type="button" className="text-button" disabled={busy} onClick={()=>{setAdding(value=>!value);setServiceDraft({...emptyService,channelId:value(provider,"channelId"),deviceId:value(provider,"deviceId"),partnerId:value(provider,"partnerId")||value(provider,"clientKey")});}}>{adding?"Tutup form service":"Tambah API Service"}</button>}</div>
        <label className="form-field"><span>Jenis Pengujian</span><select value={testType} onChange={e=>setTestType(e.target.value as "positive"|"negative")}><option value="positive">Positif</option><option value="negative">Negatif</option></select></label>
      </div>
      {provider&&!services.length&&!adding&&<p className="helper">Penyedia ini belum punya API Service, jadi belum ada request yang bisa dikirim. Isi Tambah API Service.</p>}
      {adding&&provider&&<div className="form-grid">
        <p className="helper wide">Service baru melekat pada {provider.name}. Path disambung ke {value(provider,"baseUrl")||"Base URL penyedia"}.</p>
        <label className="form-field"><span>Nama Service *</span><input required={adding} maxLength={120} value={serviceDraft.name} onChange={e=>setServiceDraft({...serviceDraft,name:e.target.value})}/></label>
        <label className="form-field"><span>Method *</span><select value={serviceDraft.method} onChange={e=>setServiceDraft({...serviceDraft,method:e.target.value})}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label>
        <label className="form-field wide"><span>Service URL / Relative Path *</span><input required={adding} value={serviceDraft.path} onChange={e=>setServiceDraft({...serviceDraft,path:e.target.value})} placeholder="/api/v1.0/..."/></label>
        <label className="form-field wide"><span>Request Body JSON</span><textarea rows={8} spellCheck={false} value={serviceDraft.defaultBody} onChange={e=>setServiceDraft({...serviceDraft,defaultBody:e.target.value})}/><small className="helper">Body ini diisi ke form ASPI dan ikut dihitung pada X-SIGNATURE. Kalau kosong, form menerima {}.</small></label>
        <div className="form-actions wide"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setAdding(false)}>Batal</button><button type="button" className="primary-button" disabled={busy} onClick={()=>void addService()}>{busy?"Menyimpan...":"Simpan API Service"}</button></div>
      </div>}
      {provider&&service&&<>
        <div className="form-grid">
          <label className="form-field"><span>Access Token URI</span><input readOnly value={accessTokenUri}/></label>
          <label className="form-field"><span>Service URI</span><input readOnly value={serviceUri}/></label>
          <div className="timestamp-field wide">
            <label className="form-field"><span>X-TIMESTAMP</span><input value={timestamp} onChange={e=>setTimestamp(e.target.value)} spellCheck={false}/></label>
            <div className="timestamp-controls">
              <div className="timestamp-buttons">
                <button type="button" className="secondary-button" onClick={()=>setTimestamp(t=>{try{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())-60_000));}catch{return buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()-60_000));}})}>-1 Menit</button>
                <button type="button" className="secondary-button" onClick={()=>setTimestamp(t=>{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())+60_000));})}>+1 Menit</button>
                <button type="button" className="secondary-button" onClick={()=>setTimestamp(buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()+120_000)))}>Reset</button>
              </div>
              <label className="timestamp-millis"><input type="checkbox" checked={includeMillis} onChange={e=>{setIncludeMillis(e.target.checked);setTimestamp(buildTimestamp(offsetMinutes,e.target.checked,new Date(Date.now()+120_000)));}}/><span>Milidetik</span></label>
            </div>
            <small className="helper">Bank Sumut menolak jam yang tidak di depan servernya. Pengujian positif yang masih dekat dengan waktu sekarang dikirim sebagai sekarang + 2 menit.</small>
          </div>
          <label className="form-field"><span>X-PARTNER-ID</span><input value={partnerId} onChange={e=>setPartnerId(e.target.value)}/></label>
          <label className="form-field"><span>X-EXTERNAL-ID</span><input value={externalId} onChange={e=>setExternalId(e.target.value)} placeholder="Kosongkan untuk generate otomatis"/></label>
          <label className="form-field"><span>X-DEVICE-ID</span><input value={deviceId} onChange={e=>setDeviceId(e.target.value)}/></label>
          <label className="form-field"><span>CHANNEL-ID</span><input value={channelId} onChange={e=>setChannelId(e.target.value)}/></label>
          <label className="form-field wide"><span>Request Body (JSON)</span><textarea rows={10} spellCheck={false} value={body} onChange={e=>setBody(e.target.value)}/><small className="helper">Diisi dari Request Body API Service {service?.name}. Perubahan di sini hanya untuk pengujian kali ini.</small></label>
        </div>
        <p className="helper">Service Name di form ASPI: {/positive case|negative case/i.test(service.name)?service.name:`${service.name} - ${testType==="positive"?"Positive Case":"Negative Case"}`}. URI yang diisi: {serviceUri}. Signature Access Token: {String(provider.data.signatureAccessTokenMode??"FUNCTION")} · Signature Service: {String(provider.data.signatureServiceMode??"FUNCTION")}.</p>
        <div className="form-actions"><button className="primary-button" disabled={busy}>{busy?"Menjalankan...":"Jalankan Client Simulator"}</button></div>
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
      <p className="helper">PDF ASPI: {countsOf(selectedRun).ready}/{countsOf(selectedRun).required||0}{countsOf(selectedRun).required>countsOf(selectedRun).ready?" · bukti belum lengkap":""}</p>
      {(()=>{const request=object(selectedRun.request)?selectedRun.request:null;const errors=request&&Array.isArray(request.evidenceErrors)?request.evidenceErrors:[];if(!errors.length)return null;return <div className="validation-box"><strong>Bukti yang belum tersedia</strong><p>{errors.map(item=>typeof item==="string"?item:object(item)?String(item.error??""):"").filter(Boolean).join(" · ")}</p></div>;})()}
      <div className="inline-actions">{pendingEvidence(selectedRun).map(item=><button type="button" className="secondary-button" key={item.activityId} disabled={running||!!reprocessingId} onClick={()=>void retryEvidence(selectedRun,item.activityId)}>{reprocessingId===`${selectedRun.id}:${item.activityId}`?"Mengambil bukti...":`Proses Ulang Bukti ${item.activityId.slice(0,8)}`}</button>)}{pdfsOf(selectedRun).filter(item=>item.pdfReady&&officialActivity(item.activityId)).map(item=><button type="button" className="secondary-button" key={item.activityId} disabled={!!downloadingId} onClick={()=>setPreview({runId:selectedRun.id,activityId:item.activityId,fileName:item.fileName})}>View PDF</button>)}</div>
      <h3>Request</h3><pre className="snippet-code">{JSON.stringify(selectedRun.request,null,2)}</pre><h3>Response</h3><pre className="snippet-code">{JSON.stringify(selectedRun.response,null,2)}</pre>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setSelectedRun(null)}>Tutup</button><button type="button" className="primary-button" onClick={()=>downloadJson(selectedRun)}>Download JSON</button></div>
    </div></div>}
  </>;
}
