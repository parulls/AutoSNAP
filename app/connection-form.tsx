"use client";

import { FormEvent, useState } from "react";
import type { Item } from "./model";
import PasswordInput from "./password-input";
import UiIcon from "./ui-icon";

type Result=Record<string,unknown>;
type Props={client?:Item;environment?:Item;user?:Item;users?:Item[];api:(action:string,payload:Result)=>Promise<Result>;reload:()=>Promise<void>;onSaved:(result:Result)=>void;onClose:()=>void};
const value=(item:Item|undefined,key:string)=>String(item?.data[key]??"");

export default function ConnectionForm({client,environment,user,users=[],api,reload,onSaved,onClose}:Props){
  const [form,setForm]=useState(()=>({
    name:environment?.name??"",userId:user?.id||value(environment,"defaultUserId"),
    appName:client?.name??"",clientId:value(client,"clientId"),clientSecret:"",privateKey:"",
    partnerIdSource:value(client,"partnerIdSource")||"client_id",partnerId:client?.partnerId??"",
    channelId:value(client,"channelId")||"95221",deviceId:value(client,"deviceId"),origin:value(client,"origin"),
    ipAddress:value(client,"ipAddress"),latitude:value(client,"latitude"),longitude:value(client,"longitude"),
  }));
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const set=(key:keyof typeof form,entry:string)=>setForm(current=>({...current,[key]:entry}));
  const field=(key:keyof typeof form,label:string,multiline=false,secret=false)=><label className={`form-field${multiline?" wide":""}`}><span>{label}</span>{multiline?<textarea rows={4} required={label.endsWith("*")} value={form[key]} onChange={e=>set(key,e.target.value)} spellCheck={false} autoComplete="off"/>:secret?<PasswordInput value={form[key]} onChange={e=>set(key,e.target.value)} autoComplete="off"/>:<input type="text" required={label.endsWith("*")} value={form[key]} onChange={e=>set(key,e.target.value)} autoComplete="off"/>}</label>;
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{
      const result=await api("saveConnection",{name:form.name,environmentId:environment?.id,userId:form.userId,
        client:{appName:form.appName,clientId:form.clientId,clientSecret:form.clientSecret,privateKey:form.privateKey,partnerIdSource:form.partnerIdSource,partnerId:form.partnerId,channelId:form.channelId,deviceId:form.deviceId,origin:form.origin,ipAddress:form.ipAddress,latitude:form.latitude,longitude:form.longitude},
        environment:{mode:"portal",executionMode:"portal",authFlow:"token_b2b",useCase:"B2B"}});
      await reload();onSaved(result);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="modal-backdrop"><form className="card edit-modal" onSubmit={save} aria-label="Dev Site Client" aria-modal="true" role="dialog">
    <div className="modal-header"><div><h2>{environment?"Edit":"Tambah"} Dev Site Client</h2></div><button type="button" className="close-button" aria-label="Tutup" title="Tutup" disabled={busy} onClick={onClose}><UiIcon name="close"/></button></div>
    <div className="modal-body">
      {error&&<div className="form-error" role="alert">{error}</div>}
      <div className="form-grid">
        <label className="form-field"><span>User SNAP *</span><select required value={form.userId} onChange={e=>set("userId",e.target.value)}><option value="">Pilih User SNAP</option>{users.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="form-field"><span>Nama Dev Site Client *</span><input required maxLength={120} value={form.name} onChange={e=>set("name",e.target.value)}/></label>
        {field("clientId","Client ID *")}
        {field("clientSecret","Client Secret",false,true)}
        {field("privateKey","Private Key",true)}
        <label className="form-field"><span>CHANNEL-ID *</span><input required maxLength={5} value={form.channelId} onChange={e=>set("channelId",e.target.value)}/></label>
        <label className="form-field"><span>Sumber X-PARTNER-ID</span><select value={form.partnerIdSource} onChange={e=>set("partnerIdSource",e.target.value)}><option value="client_id">Mengikuti Client ID</option><option value="custom">Custom</option></select></label>
        {form.partnerIdSource==="custom"&&field("partnerId","X-PARTNER-ID *")}
      </div>
      <details className="advanced-settings"><summary>Header opsional</summary><div className="form-grid">
        {field("deviceId","X-DEVICE-ID")}
        {field("origin","ORIGIN")}
        {field("ipAddress","X-IP-ADDRESS")}
        {field("latitude","X-LATITUDE")}
        {field("longitude","X-LONGITUDE")}
      </div></details>
      <p className="helper form-footnote">* wajib diisi</p>
    </div>
    <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
  </form></div>;
}
