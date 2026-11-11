"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { Api, Item, Run, State } from "./model";

const value=(row:Item|undefined,key:string)=>String(row?.data[key]??"");
const object=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);
const sandboxBody=JSON.stringify({partnerReferenceNo:"2020102900000000000001",bankCardToken:"6d7963617264746f6b656e",accountNo:"2000100101",balanceTypes:["Cash","Coins"],additionalInfo:{deviceId:"12345679237",channel:"mobilephone"}},null,2);
type Props={state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void};

export default function Testing({state,api,reload,setError,setNotice}:Props){
  const records=state.records,activeServices=records.filter(x=>x.kind==="service"&&value(x,"module")==="Informasi Saldo"&&value(x,"code")==="11");
  const endpoints=records.filter(x=>x.kind==="endpoint"&&activeServices.some(service=>service.parentId===x.id||x.parentId===service.id));
  const [endpointId,setEndpointId]=useState(""),[serviceId,setServiceId]=useState(""),[userId,setUserId]=useState(""),[siteId,setSiteId]=useState("");
  const [testType,setTestType]=useState<"positive"|"invalid_access_token">("positive");
  const endpoint=endpoints.find(x=>x.id===endpointId);
  const services=activeServices.filter(x=>x.parentId===endpoint?.id||endpoint?.parentId===x.id);
  const service=services.find(x=>x.id===serviceId);
  const template=records.find(x=>x.kind==="template"&&x.parentId===endpoint?.id);
  const [draft,setDraft]=useState<{context:string;text:string}|null>(null);
  const users=records.filter(x=>x.kind==="snap_user"),user=users.find(x=>x.id===userId);
  const sites=records.filter(x=>x.kind==="environment"&&value(x,"category")==="Dev Site"&&!!user&&(value(x,"defaultUserId")?value(x,"defaultUserId")===user.id:user.parentId===x.parentId));
  const site=sites.find(x=>x.id===siteId),project=records.find(x=>x.id===site?.parentId),client=records.find(x=>x.id===project?.parentId);
  const bodyContext=endpointId+"|"+serviceId+"|"+siteId;
  const defaultBody=value(site,"mode")==="portal"?sandboxBody:typeof service?.data.requestBody==="string"?service.data.requestBody:value(template,"body")||"{}";
  const body=draft?.context===bodyContext?draft.text:defaultBody;
  const [running,setRunning]=useState(false),[selectedRun,setSelectedRun]=useState<Run|null>(null),[pdfRun,setPdfRun]=useState<Run|null>(null),[downloadingId,setDownloadingId]=useState(""),[historyQuery,setHistoryQuery]=useState(""),[limit,setLimit]=useState(20);
  const history=state.runs.filter(run=>`${run.status} ${run.response_code??""} ${nameOf(run,"environment")} ${nameOf(run,"service")}`.toLowerCase().includes(historyQuery.toLowerCase()));
  const latest=state.runs.find(run=>run.environment_id===site?.id&&run.service_id===service?.id&&run.endpoint_id===endpoint?.id&&run.user_id===user?.id);
  let jsonError="";
  try{if(!object(JSON.parse(body)))throw Error();}catch{jsonError="Request Body harus object JSON yang valid.";}
  const missing:string[]=[];
  if(site&&value(site,"mode")==="portal"){
    for(const [key,label] of [["clientId","Client ID"],["clientSecret","Client Secret"],["privateKey","Private Key"],["channelId","CHANNEL-ID"]])if(!value(client,key))missing.push(label);
    if(!client?.partnerId)missing.push("X-PARTNER-ID");
  }
  if(endpoint&&!value(endpoint,"path"))missing.push("Path endpoint Informasi Saldo");
  if(endpoint&&value(site,"mode")==="portal"&&!value(endpoint,"portalUrl"))missing.push("URL Aplikasi Pengujian ASPI pada Endpoint");
  const ready=!!endpoint&&!!service&&!!user&&!!site&&!jsonError&&!missing.length;
  function nameOf(run:Run,key:"environment"|"service"){
    const context=object(run.request)&&object(run.request.context)?run.request.context:{};
    return String(context[key]??records.find(row=>row.id===run[key+"_id" as keyof Run])?.name??"—");
  }
  async function run(event:FormEvent){
    event.preventDefault();if(!ready)return;setRunning(true);setError("");setNotice("");
    try{
      const result=await api("run",{clientId:client?.id,projectId:project?.id,environmentId:site?.id,userId:user?.id,serviceId:service?.id,endpointId:endpoint?.id,useCase:"B2B",testType,body});
      await reload();setNotice(`${result.status} · HTTP ${result.httpStatus}`);
    }catch(e){setError((e as Error).message);}finally{setRunning(false);}
  }
  async function downloadPdf(run:Run){
    setDownloadingId(run.id);setError("");
    try{
      const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadRunPdf",id:run.id})});
      if(!response.ok){const error=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw Error(String(error.error));}
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement("a");
      link.href=url;link.download=`AutoSNAP-${run.id}.pdf`;document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
    }catch(error){setError((error as Error).message);}finally{setDownloadingId("");}
  }
  function activitiesOf(run:Run){
    if(!object(run.request)||!Array.isArray(run.request.aspiActivities))return [];
    return run.request.aspiActivities.filter(object).map(item=>({activityId:String(item.activityId??""),service:String(item.service??"Service ASPI"),timestamp:String(item.timestamp??"")})).filter(item=>item.activityId);
  }
  async function downloadAspiPdf(run:Run,activity:{activityId:string;service:string}){
    const downloadKey=`${run.id}:${activity.activityId}`;setDownloadingId(downloadKey);setError("");
    try{
      const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadAspiActivityPdf",id:run.id,activityId:activity.activityId}),signal:AbortSignal.timeout(120000)});
      if(!response.ok){const error=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw Error(String(error.error));}
      const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement("a");
      link.href=url;link.download=`ASPI-${activity.service.replace(/[^A-Za-z0-9_-]+/g,"-")}.pdf`;document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
      setNotice("PDF siap diunduh.");
    }catch(error){setError(error instanceof Error&&error.name==="TimeoutError"?"PDF belum siap. Silakan coba lagi.":(error as Error).message);}finally{setDownloadingId("");}
  }
  const headers=[
    ["Content-Type","application/json"],
    ["Authorization",value(site,"mode")==="mock"?"Simulasi lokal":"Otomatis dari API Keamanan"],
    ["X-TIMESTAMP","Waktu eksekusi; sama dengan waktu pada signature"],
    ["X-SIGNATURE","Dihitung otomatis untuk request ini"],
    ["X-PARTNER-ID",client?.partnerId||"Dari Master Data Dev Site Client"],
    ["X-EXTERNAL-ID","Angka unik otomatis setiap request"],
  ];
  return <div className="testing-page">
    <form className="card test-form" onSubmit={run}>
      <div className="section-header"><div><h2>Pengujian API</h2></div></div>
      <div className="form-grid">
        <label className="form-field wide"><span>Jenis pengujian *</span><select disabled={running} value={testType} onChange={e=>setTestType(e.target.value as "positive"|"invalid_access_token")}><option value="positive">Positif — token valid</option><option value="invalid_access_token">Negatif — token tidak valid</option></select></label>
        <Select label="Endpoint URL" value={endpointId} options={endpoints} onChange={id=>{setEndpointId(id);setServiceId("");}} disabled={running}/>
        <Select label="API Service" value={serviceId} options={services} onChange={setServiceId} disabled={running||!endpoint}/>
        {service&&<label className="form-field wide"><span>Request Body *</span><textarea disabled={running} className="code-editor" rows={8} spellCheck={false} value={body} onChange={e=>setDraft({context:bodyContext,text:e.target.value})}/>{jsonError&&<small className="field-error">{jsonError}</small>}</label>}
        <label className="form-field"><span>CHANNEL-ID *</span><input disabled={running} readOnly value={value(client,"channelId")||(site?"95221":"")} placeholder="95221 — dari Dev Site Client"/><small className="helper">Ubah nilainya melalui Master Data Dev Site Client.</small></label>
        <label className="form-field"><span>Content-Type *</span><input disabled={running} readOnly value="application/json"/></label>
        <Select label="User SNAP" value={userId} options={users} onChange={id=>{setUserId(id);setSiteId("");}} disabled={running}/>
        <Select label="Dev Site Client" value={siteId} options={sites} onChange={id=>{setSiteId(id);setDraft(null);}} disabled={running||!user}/>
      </div>
      {site&&<div className="connection-summary"><span className="mode-badge blue">{value(site,"mode")==="mock"?"Mock Lokal":value(site,"mode")==="live"?"Bank Sumut":"ASPI Sandbox"}</span></div>}
      <details className="header-details"><summary>Header otomatis</summary><dl>{headers.map(([key,entry])=><div key={key}><dt>{key}</dt><dd>{entry}</dd></div>)}</dl></details>
      {missing.length>0&&<div className="validation-box"><strong>Lengkapi di Master Data sebelum hit API</strong><p>{missing.join(", ")}.</p></div>}
      {(!users.length||!endpoints.length)&&<p className="helper">Siapkan User SNAP, Dev Site Client, Endpoint URL, dan API Service di Master Data terlebih dahulu.</p>}
      <div className="form-actions"><button type="button" className="secondary-button" disabled={running||!service} onClick={()=>setDraft(null)}>Reset Body</button><button className="primary-button" disabled={running||!ready}>{running?<span className="button-spinner" role="status" aria-label="Testing sedang berjalan"/>:"Jalankan Testing"}</button></div>
    </form>
    <section className="card response-card" aria-live="polite">
      <div className="section-header"><div><h2>Hasil Testing</h2><p>{latest?new Date(latest.created_at).toLocaleString("id-ID"):"Hasil muncul setelah testing dijalankan."}</p></div>{latest&&<span className={`status-badge ${latest.status.toLowerCase()}`}>{latest.status}</span>}</div>
      <div className="response-summary"><div><span>HTTP</span><strong>{latest?.http_status??"—"}</strong></div><div><span>RESPONSE CODE</span><strong>{latest?.response_code??"—"}</strong></div><div><span>WAKTU</span><strong>{latest?`${latest.duration_ms} ms`:"—"}</strong></div></div>
      <pre className="response-code">{JSON.stringify(latest?.response??{message:"Belum ada hasil untuk pilihan ini."},null,2)}</pre>
      {latest&&<button type="button" className="text-button" onClick={()=>setSelectedRun(latest)}>Detail validasi</button>}
    </section>
    <section className="card history-card">
      <div className="section-header"><div><h2>History Testing</h2><p>{history.length} hasil tersimpan.</p></div><label className="search-box"><input aria-label="Cari history" value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setLimit(20);}} placeholder="Cari Dev Site, service, atau status..."/></label></div>
      <div className="table-wrap"><table><thead><tr><th>WAKTU</th><th>SERVICE / DEV SITE</th><th>STATUS</th><th>HTTP / RESPONSE</th><th>DURASI</th><th>AKSI</th></tr></thead><tbody>{history.slice(0,limit).map(run=><tr key={run.id}>
        <td>{new Date(run.created_at).toLocaleString("id-ID")}</td><td>{nameOf(run,"service")}<span className="cell-caption">{nameOf(run,"environment")} · {run.mode==="portal"?"ASPI Sandbox":run.mode==="live"?"Live Bank Sumut":"Mock Lokal"}</span></td>
        <td><span className={`status-badge ${run.status.toLowerCase()}`}>{run.status}</span></td><td>{run.http_status??"—"} / {run.response_code??"—"}</td><td>{run.duration_ms??0} ms</td><td><div className="inline-actions"><button type="button" className="text-button" onClick={()=>setSelectedRun(run)}>Detail</button>{state.user?.role==="admin"&&<button type="button" className="text-button" disabled={!activitiesOf(run).length||!!downloadingId} onClick={()=>setPdfRun(run)}>PDF ASPI</button>}</div></td>
      </tr>)}</tbody></table>{!history.length&&<p className="empty-note">Belum ada history yang cocok.</p>}</div>
      {history.length>limit&&<button className="text-button" onClick={()=>setLimit(limit+20)}>Tampilkan lebih banyak</button>}
    </section>
    {selectedRun&&<div className="modal-backdrop"><div className="card edit-modal run-modal"><div className="section-header"><div><h2>Detail Testing</h2><p>{selectedRun.notes}</p></div><button className="secondary-button" onClick={()=>setSelectedRun(null)}>Tutup</button></div><h3>Request dan validasi tersanitasi</h3><pre className="snippet-code">{JSON.stringify(selectedRun.request,null,2)}</pre><h3>Response tersanitasi</h3><pre className="snippet-code">{JSON.stringify(selectedRun.response,null,2)}</pre></div></div>}
    {pdfRun&&<PdfDownloadDialog activities={activitiesOf(pdfRun)} downloadingId={downloadingId} runId={pdfRun.id} onClose={()=>setPdfRun(null)} onDownload={activity=>downloadAspiPdf(pdfRun,activity)} onSummary={()=>downloadPdf(pdfRun)}/>}
  </div>;
}

type ActivityChoice={activityId:string;service:string;timestamp:string};
function PdfDownloadDialog({activities,downloadingId,runId,onClose,onDownload,onSummary}:{activities:ActivityChoice[];downloadingId:string;runId:string;onClose:()=>void;onDownload:(activity:ActivityChoice)=>void;onSummary:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [seconds,setSeconds]=useState(0);
  useEffect(()=>{const node=dialog.current;node?.showModal();return ()=>node?.close();},[]);
  useEffect(()=>{if(!downloadingId)return;const started=Date.now();const timer=setInterval(()=>setSeconds(Math.floor((Date.now()-started)/1000)),1000);return ()=>clearInterval(timer);},[downloadingId]);
  const busy=!!downloadingId;
  return <dialog ref={dialog} aria-labelledby="pdf-dialog-title" aria-busy={busy} onCancel={event=>{if(busy)event.preventDefault();else onClose();}} className="m-auto w-[calc(100%-32px)] max-w-lg rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/45">
    <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h2 id="pdf-dialog-title" className="text-lg font-semibold">Unduh laporan</h2><p className="mt-1 text-sm text-slate-500">Pilih service ASPI.</p></div><button type="button" disabled={busy} onClick={onClose} aria-label="Tutup" className="rounded-md px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-40">Tutup</button></div>
    <div className="grid gap-2 p-4">{activities.map(activity=>{const active=downloadingId===`${runId}:${activity.activityId}`;return <button key={activity.activityId} type="button" disabled={busy} onClick={()=>{setSeconds(0);onDownload(activity);}} className={`flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-wait ${active?"border-blue-300 bg-blue-50":"border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-xs font-semibold text-blue-700">PDF</span><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{activity.service}</span>{activity.timestamp&&<span className="mt-0.5 block text-xs text-slate-500">{activity.timestamp}</span>}</span>{active?<span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600 motion-reduce:animate-none"/>:<span aria-hidden="true" className="text-blue-600">↓</span>}
    </button>;})}</div>
    {busy&&<div role="status" aria-live="polite" className="mx-4 mb-4 flex items-center gap-3 rounded-lg bg-blue-50 px-3 py-3 text-sm text-blue-800"><span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600 motion-reduce:animate-none"/><span className="flex-1">{seconds>=20?"PDF sedang diproses ASPI…":"Menyiapkan PDF…"}</span><span aria-hidden="true" className="text-xs tabular-nums text-blue-600">{seconds} dtk</span></div>}
    <div className="border-t border-slate-200 px-5 py-3"><button type="button" disabled={busy} onClick={()=>{setSeconds(0);onSummary();}} className="text-sm font-medium text-blue-600 hover:text-blue-800 disabled:opacity-40">Laporan AutoSNAP</button></div>
  </dialog>;
}

function Select({label,value,options,onChange,disabled=false}:{label:string;value:string;options:Item[];onChange:(id:string)=>void;disabled?:boolean}){
  return <label className="form-field"><span>{label} *</span><select required value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}><option value="">Pilih {label}</option>{options.map(x=><option key={x.id} value={x.id}>{x.name}{x.kind==="endpoint"?` — ${[String(x.data.method??"POST"),String(x.data.path??"")].filter(Boolean).join(" ")}`:""}</option>)}</select></label>;
}
