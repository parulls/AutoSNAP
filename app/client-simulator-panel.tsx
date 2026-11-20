"use client";

import { FormEvent, useMemo, useState } from "react";
import type { Api, HistoryFilters, Item, Run, State } from "./model";
import HistoryFilter from "./history-filter";
import { rangeForPeriod } from "./history-period";
import { useHistory } from "./use-history";
import { can } from "./privileges";

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
  const canViewAll=can(state.user,"history","view_all");
  const [providerId,setProviderId]=useState(""),[serviceId,setServiceId]=useState(""),[testType,setTestType]=useState<"positive"|"negative">("positive");
  const provider=providers.find(p=>p.id===providerId);
  const services=allServices.filter(s=>s.parentId===providerId);
  const service=services.find(s=>s.id===serviceId);
  const tsCfg=object(provider?.data.timestampConfig)?provider!.data.timestampConfig as {offsetMinutes?:number;includeMillis?:boolean}:{};
  const offsetMinutes=Number(tsCfg.offsetMinutes??420),defaultMillis=tsCfg.includeMillis===true;
  const [includeMillis,setIncludeMillis]=useState(defaultMillis);
  const [timestamp,setTimestamp]=useState(()=>buildTimestamp(offsetMinutes,defaultMillis));
  const [body,setBody]=useState("{}");
  const [partnerId,setPartnerId]=useState(""),[externalId,setExternalId]=useState(""),[deviceId,setDeviceId]=useState(""),[channelId,setChannelId]=useState("");
  const [busy,setBusy]=useState(false),[result,setResult]=useState<Record<string,unknown>|null>(null);
  const [historyRange,setHistoryRange]=useState(()=>rangeForPeriod("today"));
  const [historyFilters,setHistoryFilters]=useState<HistoryFilters>({scope:canViewAll?"all":"mine"});
  const [historyQuery,setHistoryQuery]=useState(""),[offset,setOffset]=useState(0);
  const [selectedRun,setSelectedRun]=useState<Run|null>(null);
  const historyData=useHistory(api,historyRange,"simulator",historyQuery,offset,20,state.runs,historyFilters);

  function loadDefaults(nextProvider?:Item,nextService?:Item){
    const p=nextProvider??provider,s=nextService??service;
    const cfg=object(p?.data.timestampConfig)?p!.data.timestampConfig as {offsetMinutes?:number;includeMillis?:boolean}:{};
    const millis=cfg.includeMillis===true;
    setIncludeMillis(millis);
    setTimestamp(buildTimestamp(Number(cfg.offsetMinutes??420),millis));
    setPartnerId(value(s,"partnerId")||value(p,"partnerId")||value(p,"clientKey")||value(p,"clientId"));
    setExternalId(value(s,"externalId"));
    setDeviceId(value(s,"deviceId")||value(p,"deviceId"));
    setChannelId(value(s,"channelId")||value(p,"channelId"));
    setBody(value(s,"defaultBody")||value(s,"requestBody")||"{}");
    setResult(null);
  }

  async function run(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");setResult(null);
    try{
      const response=await api("runClientSimulator",{
        providerId,serviceId,testType,
        overrides:{partnerId,externalId,deviceId,channelId,body,timestamp,includeMillis,offsetMinutes,regenerateExternalId:!externalId.trim()},
      });
      setResult(response);setNotice(`Activity Simulator: ${String(response.activityName??"")} · ${String(response.status??"")}`);
      await reload();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }

  const accessTokenUri=useMemo(()=>{
    if(!provider)return "—";
    const base=value(provider,"baseUrl").replace(/\/$/,"");
    const path=value(provider,"accessTokenUrl")||"/api/v1.0/access-token/b2b";
    return path.startsWith("http")?path:`${base}${path.startsWith("/")?path:`/${path}`}`;
  },[provider]);
  const serviceUri=useMemo(()=>{
    if(!provider||!service)return "—";
    const base=value(provider,"baseUrl").replace(/\/$/,"");
    const path=value(service,"path")||value(service,"serviceUrl");
    return `${base}${path}`;
  },[provider,service]);

  function downloadJson(run:Run){
    const blob=new Blob([JSON.stringify({request:run.request,response:run.response},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=`${String(object(run.request)?run.request.activityName??run.id:run.id)}.json`;a.click();URL.revokeObjectURL(url);
  }

  return <>
    <form className="card test-form" onSubmit={run}>
      <div className="section-header"><div><h2>Client Simulator</h2><p>Uji API melalui Penyedia Client Simulator dinamis. Terpisah dari Dev Site Endpoint ASPI.</p></div></div>
      <div className="form-grid">
        <label className="form-field"><span>Penyedia Client Simulator</span><select required value={providerId} onChange={e=>{const id=e.target.value;setProviderId(id);setServiceId("");const p=providers.find(x=>x.id===id);loadDefaults(p,undefined);}}><option value="">Pilih penyedia</option>{providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="form-field"><span>API Service</span><select required value={serviceId} disabled={!providerId} onChange={e=>{const id=e.target.value;setServiceId(id);loadDefaults(provider,services.find(s=>s.id===id));}}><option value="">Pilih service</option>{services.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="form-field"><span>Jenis Pengujian</span><select value={testType} onChange={e=>setTestType(e.target.value as "positive"|"negative")}><option value="positive">Positif</option><option value="negative">Negatif</option></select></label>
      </div>
      {provider&&service&&<>
        <div className="form-grid">
          <label className="form-field"><span>Access Token URI</span><input readOnly value={accessTokenUri}/></label>
          <label className="form-field"><span>Service URI</span><input readOnly value={serviceUri}/></label>
          <label className="form-field"><span>X-TIMESTAMP</span><input value={timestamp} onChange={e=>setTimestamp(e.target.value)} spellCheck={false}/></label>
          <div className="form-field"><span>Kontrol Timestamp</span><div className="inline-actions">
            <button type="button" className="secondary-button" onClick={()=>setTimestamp(t=>{try{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())-60_000));}catch{return buildTimestamp(offsetMinutes,includeMillis,new Date(Date.now()-60_000));}})}>-1 Menit</button>
            <button type="button" className="secondary-button" onClick={()=>setTimestamp(t=>{const d=Date.parse(t);return buildTimestamp(offsetMinutes,includeMillis,new Date((Number.isFinite(d)?d:Date.now())+60_000));})}>+1 Menit</button>
            <button type="button" className="secondary-button" onClick={()=>setTimestamp(buildTimestamp(offsetMinutes,includeMillis))}>Reset</button>
            <label><input type="checkbox" checked={includeMillis} onChange={e=>{setIncludeMillis(e.target.checked);setTimestamp(buildTimestamp(offsetMinutes,e.target.checked));}}/> Milidetik</label>
          </div></div>
          <label className="form-field"><span>X-PARTNER-ID</span><input value={partnerId} onChange={e=>setPartnerId(e.target.value)}/></label>
          <label className="form-field"><span>X-EXTERNAL-ID</span><input value={externalId} onChange={e=>setExternalId(e.target.value)} placeholder="Kosongkan untuk generate otomatis"/></label>
          <label className="form-field"><span>X-DEVICE-ID</span><input value={deviceId} onChange={e=>setDeviceId(e.target.value)}/></label>
          <label className="form-field"><span>CHANNEL-ID</span><input value={channelId} onChange={e=>setChannelId(e.target.value)}/></label>
          <label className="form-field wide"><span>Request Body (JSON)</span><textarea rows={10} spellCheck={false} value={body} onChange={e=>setBody(e.target.value)}/></label>
        </div>
        <p className="helper">Signature Access Token: {String(provider.data.signatureAccessTokenMode??"FUNCTION")} · Signature Service: {String(provider.data.signatureServiceMode??"FUNCTION")} · Timestamp dipakai sama untuk header dan signature.</p>
        <div className="form-actions"><button className="primary-button" disabled={busy}>{busy?"Menjalankan...":"Jalankan Client Simulator"}</button></div>
      </>}
      {!providers.length&&<p className="helper">Belum ada Penyedia. Tambahkan di Master Data → Penyedia Client Simulator.</p>}
    </form>

    {result&&<section className="card"><div className="section-header"><div><h2>Execution Log</h2><p>{String(result.activityName??"")} · HTTP {String(result.httpStatus??"—")} · {String(result.status??"")}</p></div></div>
      <pre className="code-block">{JSON.stringify({steps:result.steps,evaluation:object(result.request)?result.request.evaluation:undefined,response:result.response},null,2)}</pre>
    </section>}

    <section className="card history-card">
      <div className="section-header"><div><h2>Activity Simulator</h2><p>{historyData.total} hasil · terpisah dari History Dev Site ASPI.</p></div>
        <label className="search-box"><input aria-label="Cari activity" value={historyQuery} onChange={e=>{setHistoryQuery(e.target.value);setOffset(0);}} placeholder="Cari penyedia, service, status..."/></label>
      </div>
      <HistoryFilter value={historyRange} onChange={range=>{setHistoryRange(range);setOffset(0);}} filters={historyFilters} onFiltersChange={next=>{setHistoryFilters(next);setOffset(0);}} isAdmin={canViewAll} operators={state.operators??[]} services={allServices} endpoints={providers}/>
      <div className="table-wrap"><table><thead><tr><th>WAKTU</th>{canViewAll&&<th>PELAKSANA</th>}<th>AKTIVITAS</th><th>STATUS</th><th>HTTP</th><th>AKSI</th></tr></thead>
        <tbody>{historyData.runs.filter(r=>r.mode==="client_sim"||r.mode==="mock").map(run=>{
          const name=object(run.request)?String(run.request.activityName??""):"";
          return <tr key={run.id}>
            <td>{new Date(run.created_at).toLocaleString("id-ID")}</td>
            {canViewAll&&<td>{run.operator?.name??"—"}</td>}
            <td><strong>{name||run.notes||run.id}</strong><span className="cell-caption">{run.mode}</span></td>
            <td><span className={`status-badge ${run.status==="PASSED"?"passed":"failed"}`}>{run.status}</span></td>
            <td>{run.http_status??"—"}</td>
            <td><div className="inline-actions">
              <button type="button" onClick={()=>setSelectedRun(run)}>View</button>
              <button type="button" onClick={()=>downloadJson(run)}>Download JSON</button>
            </div></td>
          </tr>;
        })}</tbody>
      </table>{!historyData.runs.length&&<p className="empty-note">Belum ada Activity Simulator.</p>}</div>
    </section>

    {selectedRun&&<div className="modal-backdrop"><div className="card edit-modal">
      <div className="section-header"><div><h2>Detail Activity Simulator</h2><p>{selectedRun.notes||selectedRun.id}</p></div></div>
      <pre className="code-block">{JSON.stringify({request:selectedRun.request,response:selectedRun.response},null,2)}</pre>
      <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setSelectedRun(null)}>Tutup</button><button type="button" className="primary-button" onClick={()=>downloadJson(selectedRun)}>Download JSON</button></div>
    </div></div>}
  </>;
}
