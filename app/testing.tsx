"use client";

import { FormEvent, useState } from "react";
import type { Api, Item, Run, State } from "./model";

const value=(row:Item|undefined,key:string)=>String(row?.data[key]??"");
const object=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);
const sandboxBody=JSON.stringify({partnerReferenceNo:"{{partner_reference_no}}",bankCardToken:"6d7963617264746f6b656e",accountNo:"2000100101",balanceTypes:["Cash","Coins"],additionalInfo:{deviceId:"12345679237",channel:"mobilephone"}},null,2);
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
  const [running,setRunning]=useState(false),[selectedRun,setSelectedRun]=useState<Run|null>(null),[downloadingId,setDownloadingId]=useState(""),[historyQuery,setHistoryQuery]=useState(""),[limit,setLimit]=useState(20);
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
      await reload();setNotice(`${result.status} · HTTP ${result.httpStatus}. ${result.notes}`);
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
      <div className="section-header"><div><h2>API Testing Dev Site</h2><p>{value(site,"mode")==="mock"?"Mock Lokal memvalidasi alur tanpa mengirim request keluar.":"ASPI Sandbox menjalankan Balance Inquiry menggunakan data uji resmi."}</p></div></div>
      <div className="form-grid">
        <label className="form-field wide"><span>Jenis Testing *</span><select value={testType} onChange={e=>setTestType(e.target.value as "positive"|"invalid_access_token")}><option value="positive">Tes Positif — access token valid</option><option value="invalid_access_token">Tes Negatif — access token sengaja dibuat tidak valid</option></select><small className="helper">Tes negatif dinyatakan PASS jika API menolak token dengan response code 4011100.</small></label>
        <Select label="Endpoint URL" value={endpointId} options={endpoints} onChange={id=>{setEndpointId(id);setServiceId("");}}/>
        <Select label="API Service" value={serviceId} options={services} onChange={setServiceId} disabled={!endpoint}/>
        {service&&<label className="form-field wide"><span>Request Body *</span><textarea className="code-editor" rows={8} spellCheck={false} value={body} onChange={e=>setDraft({context:bodyContext,text:e.target.value})}/>{jsonError&&<small className="field-error">{jsonError}</small>}</label>}
        <label className="form-field"><span>CHANNEL-ID *</span><input readOnly value={value(client,"channelId")||(site?"95221":"")} placeholder="95221 — dari Dev Site Client"/><small className="helper">Ubah nilainya melalui Master Data Dev Site Client.</small></label>
        <label className="form-field"><span>Content-Type *</span><input readOnly value="application/json"/><small className="helper">Dikirim otomatis oleh backend.</small></label>
        <Select label="User SNAP" value={userId} options={users} onChange={id=>{setUserId(id);setSiteId("");}}/>
        <Select label="Dev Site Client" value={siteId} options={sites} onChange={id=>{setSiteId(id);setDraft(null);}} disabled={!user}/>
      </div>
      {site&&<div className="connection-summary"><span className="mode-badge blue">{value(site,"mode")==="mock"?"Mock Lokal":value(site,"mode")==="live"?"Live Bank Sumut":"ASPI Sandbox"}</span>{value(site,"mode")==="portal"&&endpoint&&value(endpoint,"portalUrl")&&<span>{value(endpoint,"portalUrl")}</span>}</div>}
      <details className="header-details"><summary>Header wajib — disiapkan otomatis</summary><dl>{headers.map(([key,entry])=><div key={key}><dt>{key}</dt><dd>{entry}</dd></div>)}</dl></details>
      {missing.length>0&&<div className="validation-box"><strong>Lengkapi di Master Data sebelum hit API</strong><p>{missing.join(", ")}.</p></div>}
      {(!users.length||!endpoints.length)&&<p className="helper">Siapkan User SNAP, Dev Site Client, Endpoint URL, dan API Service di Master Data terlebih dahulu.</p>}
      <div className="form-actions"><button type="button" className="secondary-button" disabled={running||!service} onClick={()=>setDraft(null)}>Reset Body</button><button className="primary-button" disabled={running||!ready}>{running?<span className="button-spinner" role="status" aria-label="Testing sedang berjalan"/>:"Jalankan Testing"}</button></div>
    </form>
    <section className="card response-card" aria-live="polite">
      <div className="section-header"><div><h2>Hasil Testing</h2><p>{latest?new Date(latest.created_at).toLocaleString("id-ID"):"Hasil muncul setelah testing dijalankan."}</p></div>{latest&&<span className={`status-badge ${latest.status.toLowerCase()}`}>{latest.status}</span>}</div>
      <div className="response-summary"><div><span>HTTP</span><strong>{latest?.http_status??"—"}</strong></div><div><span>RESPONSE CODE</span><strong>{latest?.response_code??"—"}</strong></div><div><span>WAKTU</span><strong>{latest?`${latest.duration_ms} ms`:"—"}</strong></div></div>
      <pre className="response-code">{JSON.stringify(latest?.response??{message:"Belum ada hasil untuk pilihan ini."},null,2)}</pre>
      {latest&&<><p className="helper">{latest.notes}</p><button type="button" className="text-button" onClick={()=>setSelectedRun(latest)}>Lihat request dan validasi</button></>}
    </section>
    <section className="card history-card">
      <div className="section-header"><div><h2>History Testing</h2><p>{history.length} hasil tersimpan.</p></div><label className="search-box"><input aria-label="Cari history" value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setLimit(20);}} placeholder="Cari Dev Site, service, atau status..."/></label></div>
      <div className="table-wrap"><table><thead><tr><th>WAKTU</th><th>SERVICE / DEV SITE</th><th>STATUS</th><th>HTTP / RESPONSE</th><th>DURASI</th><th>AKSI</th></tr></thead><tbody>{history.slice(0,limit).map(run=><tr key={run.id}>
        <td>{new Date(run.created_at).toLocaleString("id-ID")}</td><td>{nameOf(run,"service")}<span className="cell-caption">{nameOf(run,"environment")} · {run.mode==="portal"?"ASPI Sandbox":run.mode==="live"?"Live Bank Sumut":"Mock Lokal"}</span></td>
        <td><span className={`status-badge ${run.status.toLowerCase()}`}>{run.status}</span></td><td>{run.http_status??"—"} / {run.response_code??"—"}</td><td>{run.duration_ms??0} ms</td><td><div className="inline-actions"><button type="button" className="text-button" onClick={()=>setSelectedRun(run)}>Detail</button><button type="button" className="text-button" disabled={!!downloadingId} onClick={()=>downloadPdf(run)}>{downloadingId===run.id?"Mengunduh...":"Download PDF"}</button></div></td>
      </tr>)}</tbody></table>{!history.length&&<p className="empty-note">Belum ada history yang cocok.</p>}</div>
      {history.length>limit&&<button className="text-button" onClick={()=>setLimit(limit+20)}>Tampilkan lebih banyak</button>}
    </section>
    {selectedRun&&<div className="modal-backdrop"><div className="card edit-modal run-modal"><div className="section-header"><div><h2>Detail Testing</h2><p>{selectedRun.notes}</p></div><button className="secondary-button" onClick={()=>setSelectedRun(null)}>Tutup</button></div><h3>Request dan validasi tersanitasi</h3><pre className="snippet-code">{JSON.stringify(selectedRun.request,null,2)}</pre><h3>Response tersanitasi</h3><pre className="snippet-code">{JSON.stringify(selectedRun.response,null,2)}</pre></div></div>}
  </div>;
}

function Select({label,value,options,onChange,disabled=false}:{label:string;value:string;options:Item[];onChange:(id:string)=>void;disabled?:boolean}){
  return <label className="form-field"><span>{label} *</span><select required value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}><option value="">Pilih {label}</option>{options.map(x=><option key={x.id} value={x.id}>{x.name}{x.kind==="endpoint"?` — ${[String(x.data.method??"POST"),String(x.data.path??"")].filter(Boolean).join(" ")}`:""}</option>)}</select></label>;
}
