"use client";

import { FormEvent, useState } from "react";
import ConnectionForm from "./connection-form";
import type { Api, Item, State } from "./model";

type Kind="snap_user"|"dev_site"|"endpoint"|"service";
const labels:Record<Kind,string>={snap_user:"User SNAP",dev_site:"Dev Site Client",endpoint:"Endpoint URL",service:"API Service"};
const value=(item:Item|undefined,key:string)=>String(item?.data[key]??"");
const defaultBody=JSON.stringify({partnerReferenceNo:"{{partner_reference_no}}",accountNo:"",additionalInfo:{}},null,2);

export default function MasterData({state,api,reload,setError,setNotice}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void}){
  const [kind,setKind]=useState<Kind>("snap_user"),[editing,setEditing]=useState<Item|"new"|null>(null),[connection,setConnection]=useState<Item|"new"|null>(null);
  const [draft,setDraft]=useState({name:"",parentId:"",data:{} as Record<string,unknown>}),[busy,setBusy]=useState(false);
  const admin=state.user?.role==="admin";
  const users=state.records.filter(x=>x.kind==="snap_user");
  const sites=state.records.filter(x=>x.kind==="environment"&&value(x,"category")==="Dev Site");
  const services=state.records.filter(x=>x.kind==="service"&&["Registrasi","Informasi Saldo"].includes(value(x,"module")));
  const endpoints=state.records.filter(x=>x.kind==="endpoint"&&(services.some(service=>service.parentId===x.id||x.parentId===service.id)||!state.records.some(service=>service.kind==="service"&&(service.parentId===x.id||x.parentId===service.id))));
  const rows=kind==="snap_user"?users:kind==="dev_site"?sites:kind==="service"?services:endpoints;
  function open(item:Item|null){
    setEditing(item??"new");
    const endpoint=item&&kind==="service"?state.records.find(x=>x.id===item.parentId&&x.kind==="endpoint")??endpoints.find(x=>x.parentId===item.id):undefined;
    const template=endpoint?state.records.find(x=>x.kind==="template"&&x.parentId===endpoint.id):undefined;
    setDraft(item?{name:item.name,parentId:kind==="service"?endpoint?.id??"":item.parentId??"",data:{...item.data,...(kind==="snap_user"?{email:value(item,"email")||value(item,"username"),password:""}:{}),...(kind==="service"?{requestBody:typeof item.data.requestBody==="string"?item.data.requestBody:value(template,"body")||"{}"}:{})}}:
      {name:"",parentId:"",data:kind==="snap_user"?{email:"",password:""}:kind==="endpoint"?{method:"POST",path:"",portalUrl:""}:{module:"Informasi Saldo",code:"11",requestBody:defaultBody}});
  }
  const patch=(key:string,entry:string)=>setDraft(old=>({...old,data:{...old.data,[key]:entry}}));
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{await api("save",{kind,id:editing&&editing!=="new"?editing.id:undefined,...draft});await reload();setEditing(null);setNotice("Master Data disimpan.");}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function remove(item:Item){
    if(!window.confirm(`Hapus ${item.name}?`))return;
    setBusy(true);setError("");
    try{await api("delete",{id:item.id});await reload();setNotice("Data dihapus.");}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const selectedSite=connection&&connection!=="new"?connection:undefined;
  const project=state.records.find(x=>x.id===selectedSite?.parentId),client=state.records.find(x=>x.id===project?.parentId);
  const owner=users.find(x=>x.id===value(selectedSite,"defaultUserId"));
  const field=(key:string,label:string,multiline=false,secret=false)=><label className={`form-field${multiline?" wide":""}`}><span>{label}</span>{multiline?<textarea rows={9} spellCheck={false} value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>:<input type={secret?"password":key==="email"?"email":"text"} autoComplete="off" value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>}</label>;

  return <section className="card master-card">
    <div className="section-header"><div><h2>Master Data</h2><p>Siapkan User SNAP, Dev Site Client, endpoint, kemudian service.</p></div>{admin&&<button className="primary-button" disabled={busy||kind==="dev_site"&&!users.length||kind==="service"&&!endpoints.length} onClick={()=>kind==="dev_site"?setConnection("new"):open(null)}>Tambah {labels[kind]}</button>}</div>
    <div className="tabs" role="tablist">{(Object.keys(labels) as Kind[]).map(key=><button key={key} role="tab" aria-selected={kind===key} className={kind===key?"active":""} onClick={()=>{setKind(key);setEditing(null);setConnection(null);}}>{labels[key]}</button>)}</div>
    {kind==="dev_site"&&!users.length&&<p className="helper">Tambahkan User SNAP sebelum membuat Dev Site Client.</p>}
    {kind==="service"&&!endpoints.length&&<p className="helper">Tambahkan Endpoint URL sebelum membuat service.</p>}
    <div className="table-wrap"><table><thead><tr><th>NAMA</th><th>DETAIL</th><th>DIPERBARUI</th>{admin&&<th>AKSI</th>}</tr></thead><tbody>{rows.map(item=>{
      const siteProject=state.records.find(x=>x.id===item.parentId),siteClient=state.records.find(x=>x.id===siteProject?.parentId);
      const linkedEndpoint=endpoints.find(x=>x.id===item.parentId||x.parentId===item.id);
      return <tr key={item.id}><td><strong>{item.name}</strong></td><td className="detail-cell">{kind==="snap_user"?(value(item,"email")||"—"):kind==="dev_site"?<>{users.find(x=>x.id===value(item,"defaultUserId"))?.name??"—"}<span className="cell-caption">{[`Portal ASPI`,value(siteClient,"channelId")&&`CHANNEL-ID ${value(siteClient,"channelId")}`].filter(Boolean).join(" · ")}</span></>:kind==="endpoint"?<>{[value(item,"method"),value(item,"path")].filter(Boolean).join(" ")||"—"}<span className="cell-caption">{value(item,"portalUrl")||"URL Aplikasi Pengujian belum diisi"}</span></>:(linkedEndpoint?value(linkedEndpoint,"path")||linkedEndpoint.name:"—")}</td><td>{new Date(item.updatedAt).toLocaleDateString("id-ID")}</td>{admin&&<td><div className="inline-actions"><button disabled={busy} onClick={()=>kind==="dev_site"?setConnection(item):open(item)}>Edit</button><button disabled={busy} className="danger-action" onClick={()=>remove(item)}>Hapus</button></div></td>}</tr>;
    })}</tbody></table>{!rows.length&&<p className="empty-note">Belum ada data.</p>}</div>
    {kind==="dev_site"&&<p className="helper">CHANNEL-ID wajib. X-DEVICE-ID, ORIGIN, X-IP-ADDRESS, X-LATITUDE, dan X-LONGITUDE opsional.</p>}
    {kind==="snap_user"&&<p className="helper">Password SNAP disimpan terenkripsi.</p>}
    {editing&&<div className="modal-backdrop"><form className="card edit-modal" onSubmit={save}>
      <div className="section-header"><div><h2>{editing==="new"?"Tambah":"Edit"} {labels[kind]}</h2></div></div>
      <div className="form-grid">
        {kind==="service"&&<label className="form-field wide"><span>Endpoint URL *</span><select required value={draft.parentId} onChange={e=>setDraft({...draft,parentId:e.target.value})}><option value="">Pilih endpoint</option>{endpoints.map(x=><option key={x.id} value={x.id}>{x.name}{value(x,"path")?` — ${value(x,"path")}`:""}</option>)}</select></label>}
        <label className="form-field"><span>Nama *</span><input required maxLength={120} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        {kind==="snap_user"&&<>{field("email","Email SNAP")}{field("password","Password SNAP",false,true)}<p className="helper wide">Saat edit, kosongkan password untuk mempertahankan nilai tersimpan. Akun ini terpisah dari username AutoSNAP.</p></>}
        {kind==="endpoint"&&<><label className="form-field"><span>HTTP Method *</span><select required value={String(draft.data.method??"POST")} onChange={e=>patch("method",e.target.value)}><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option></select></label>{field("path","Path endpoint")}{field("portalUrl","URL Aplikasi Pengujian ASPI")}<p className="helper wide">Contoh: https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry</p></>}
        {kind==="service"&&<><label className="form-field"><span>Jenis layanan</span><select value={String(draft.data.module??"Informasi Saldo")} onChange={e=>patch("module",e.target.value)}><option value="Registrasi">Registrasi</option><option value="Informasi Saldo">Informasi Saldo</option></select></label><label className="form-field"><span>Service Code</span><input value={String(draft.data.code??"")} maxLength={2} onChange={e=>patch("code",e.target.value)}/></label>{field("requestBody","Default Request Body",true)}</>}
      </div>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEditing(null)}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
    </form></div>}
    {connection&&<ConnectionForm client={client} environment={selectedSite} user={owner} users={users} api={api} reload={reload} onClose={()=>setConnection(null)} onSaved={()=>{setConnection(null);setNotice("Dev Site Client disimpan.");}}/>}
  </section>;
}
