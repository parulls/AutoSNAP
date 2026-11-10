"use client";

import { FormEvent, useState } from "react";
import type { Item } from "./model";

type Result=Record<string,unknown>;
type Props={client?:Item;environment?:Item;user?:Item;users?:Item[];api:(action:string,payload:Result)=>Promise<Result>;reload:()=>Promise<void>;onSaved:(result:Result)=>void;onClose:()=>void};
const value=(item:Item|undefined,key:string)=>String(item?.data[key]??"");

export default function ConnectionForm({client,environment,user,users=[],api,reload,onSaved,onClose}:Props){
  const [form,setForm]=useState(()=>({
    name:environment?.name??"",userId:user?.id||value(environment,"defaultUserId"),
    mode:value(environment,"mode")||"portal",
    appName:client?.name??"",clientId:value(client,"clientId"),clientSecret:"",privateKey:"",
    partnerIdSource:value(client,"partnerIdSource")||"client_id",partnerId:client?.partnerId??"",
    channelId:value(client,"channelId")||"95221",deviceId:value(client,"deviceId"),origin:value(client,"origin"),
    ipAddress:value(client,"ipAddress"),latitude:value(client,"latitude"),longitude:value(client,"longitude"),
  }));
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const set=(key:keyof typeof form,entry:string)=>setForm(current=>({...current,[key]:entry}));
  const field=(key:keyof typeof form,label:string,hint="",multiline=false,secret=false)=><label className={`form-field${multiline?" wide":""}`}><span>{label}</span>{multiline?<textarea rows={4} value={form[key]} onChange={e=>set(key,e.target.value)} spellCheck={false} autoComplete="off"/>:<input type={secret?"password":"text"} value={form[key]} onChange={e=>set(key,e.target.value)} autoComplete="off"/>}{hint&&<small className="helper">{hint}</small>}</label>;
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{
      const result=await api("saveConnection",{name:form.name,environmentId:environment?.id,userId:form.userId,
        client:{appName:form.appName,clientId:form.clientId,clientSecret:form.clientSecret,privateKey:form.privateKey,partnerIdSource:form.partnerIdSource,partnerId:form.partnerId,channelId:form.channelId,deviceId:form.deviceId,origin:form.origin,ipAddress:form.ipAddress,latitude:form.latitude,longitude:form.longitude},
        environment:{mode:form.mode,executionMode:form.mode==="portal"?"portal":form.mode,authFlow:"token_b2b",useCase:"B2B"}});
      await reload();onSaved(result);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="modal-backdrop"><form className="card edit-modal" onSubmit={save} aria-label="Dev Site Client">
    <div className="section-header"><div><h2>{environment?"Edit":"Tambah"} Dev Site Client</h2></div></div>
    {error&&<div className="form-error" role="alert">{error}</div>}
    <div className="form-grid">
      <label className="form-field"><span>User SNAP *</span><select required value={form.userId} onChange={e=>set("userId",e.target.value)}><option value="">Pilih User SNAP</option>{users.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label className="form-field"><span>Nama Dev Site Client *</span><input required maxLength={120} value={form.name} onChange={e=>set("name",e.target.value)}/></label>
      <label className="form-field"><span>Mode Pengujian *</span><select required value={form.mode} onChange={e=>set("mode",e.target.value)}><option value="portal">ASPI Sandbox</option><option value="mock">Mock Lokal</option><option value="live" disabled={form.mode!=="live"}>Live Bank Sumut (belum dikonfigurasi)</option></select><small className="helper">Sandbox mengirim data uji ke Aplikasi Pengujian ASPI. Mock tidak mengirim request keluar.</small></label>
      {form.mode!=="mock"&&<>{field("clientId","Client ID")}{field("clientSecret","Client Secret",value(client,"clientSecret")?"Sudah tersimpan. Kosongkan untuk mempertahankan.":"Diperlukan untuk signature saat hit API.",false,true)}{field("privateKey","Private Key client",value(client,"privateKey")?"Sudah tersimpan terenkripsi. Kosongkan untuk mempertahankan.":"PEM lengkap termasuk BEGIN/END. Diperlukan untuk signature token.",true)}</>}
      <label className="form-field"><span>CHANNEL-ID *</span><input required maxLength={5} value={form.channelId} onChange={e=>set("channelId",e.target.value)}/><small className="helper">Default resmi 95221. Bisa diubah di Master Data.</small></label>
      <label className="form-field"><span>Sumber X-PARTNER-ID</span><select value={form.partnerIdSource} onChange={e=>set("partnerIdSource",e.target.value)}><option value="client_id">Mengikuti Client ID</option><option value="custom">Client Key / Partner ID tersendiri</option></select></label>
      {form.partnerIdSource==="custom"&&field("partnerId","X-PARTNER-ID / Client Key","Harus unik.")}
    </div>
    <details className="advanced-settings"><summary>Header opsional</summary><div className="form-grid">
      {field("deviceId","X-DEVICE-ID (opsional)")}
      {field("origin","ORIGIN (opsional)")}
      {field("ipAddress","X-IP-ADDRESS (opsional)")}
      {field("latitude","X-LATITUDE (opsional)")}
      {field("longitude","X-LONGITUDE (opsional)")}
    </div></details>
    <p className="helper">Pada ASPI Sandbox, URL Keamanan, timestamp, access token, dan signature diurus otomatis. Data contoh tidak boleh digunakan untuk Live Bank Sumut.</p>
    <div className="form-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
  </form></div>;
}
