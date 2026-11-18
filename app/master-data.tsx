"use client";

import { FormEvent, useState } from "react";
import DocumentationImport from "./documentation-import";
import ConnectionForm from "./connection-form";
import type { Api, Item, State } from "./model";
import PasswordInput from "./password-input";

type Kind="snap_user"|"dev_site"|"endpoint";
const labels:Record<Kind,string>={snap_user:"User SNAP",dev_site:"Dev Site Client",endpoint:"Endpoint URL"};
const value=(item:Item|undefined,key:string)=>String(item?.data[key]??"");

export default function MasterData({state,api,reload,setError,setNotice}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void}){
  const [kind,setKind]=useState<Kind>("snap_user"),[editing,setEditing]=useState<Item|"new"|null>(null),[connection,setConnection]=useState<Item|"new"|null>(null);
  const [draft,setDraft]=useState({name:"",parentId:"",data:{} as Record<string,unknown>}),[busy,setBusy]=useState(false);
  const [importing,setImporting]=useState<{endpoint?:Item;service?:Item}|null>(null);
  const admin=state.user?.role==="admin";
  const users=state.records.filter(x=>x.kind==="snap_user");
  const sites=state.records.filter(x=>x.kind==="environment"&&value(x,"category").trim().toLowerCase()!=="client simulator");
  const incompleteClients=state.records.filter(client=>client.kind==="client"&&!state.records.some(project=>project.kind==="project"&&project.parentId===client.id&&state.records.some(environment=>environment.kind==="environment"&&environment.parentId===project.id)));
  const services=state.records.filter(x=>x.kind==="service");
  const endpoints=state.records.filter(x=>x.kind==="endpoint");
  const rows=kind==="snap_user"?users:kind==="dev_site"?[...sites,...incompleteClients]:endpoints;
  function open(item:Item|null){
    setEditing(item??"new");
    setDraft(item?{name:item.name,parentId:item.parentId??"",data:{...item.data,email:value(item,"email")||value(item,"username"),password:""}}:{name:"",parentId:"",data:{email:"",password:""}});
  }
  const patch=(key:string,entry:string)=>setDraft(old=>({...old,data:{...old.data,[key]:entry}}));
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{const data={...draft.data};if(typeof data.config==="string")data.config=JSON.parse(data.config);await api("save",{kind,id:editing&&editing!=="new"?editing.id:undefined,...draft,data});await reload();setEditing(null);setNotice("Master Data disimpan.");}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function remove(item:Item){
    if(!window.confirm(item.kind==="endpoint"?`Hapus endpoint ${item.name} beserta konfigurasi layanan dan templatenya? History Testing tetap disimpan.`:`Hapus ${item.name}?`))return;
    setBusy(true);setError("");
    try{await api(item.kind==="endpoint"?"deleteEndpointConfiguration":"delete",{id:item.id});await reload();setNotice("Data dihapus.");}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const selectedRecord=connection&&connection!=="new"?connection:undefined;
  const selectedSite=selectedRecord?.kind==="environment"?selectedRecord:undefined;
  const project=state.records.find(x=>x.id===selectedSite?.parentId),client=state.records.find(x=>x.id===project?.parentId);
  const selectedClient=selectedRecord?.kind==="client"?selectedRecord:client;
  const owner=users.find(x=>x.id===value(selectedSite,"defaultUserId"));
  const field=(key:string,label:string,multiline=false,secret=false)=><label className={`form-field${multiline?" wide":""}`}><span>{label}</span>{multiline?<textarea rows={9} spellCheck={false} value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>:secret?<PasswordInput autoComplete="off" value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>:<input type={key==="email"?"email":"text"} autoComplete="off" value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>}</label>;

  return <section className="card master-card">
    <div className="section-header"><div><h2>Master Data</h2><p>Siapkan User SNAP, Dev Site Client, lalu tambahkan URL endpoint ASPI.</p></div>{admin&&<button className="primary-button" disabled={busy||(kind==="dev_site"||kind==="endpoint")&&!users.length} onClick={()=>kind==="endpoint"?setImporting({}):kind==="dev_site"?setConnection("new"):open(null)}>Tambah {labels[kind]}</button>}</div>
    {importing&&<DocumentationImport users={users} endpoint={importing.endpoint} service={importing.service} api={api} reload={reload} onClose={()=>setImporting(null)}/>}
    <div className="tabs" role="tablist">{(Object.keys(labels) as Kind[]).map(key=><button key={key} role="tab" aria-selected={kind===key} className={kind===key?"active":""} onClick={()=>{setKind(key);setEditing(null);setConnection(null);}}>{labels[key]}</button>)}</div>
    {kind==="dev_site"&&!users.length&&<p className="helper">Tambahkan User SNAP sebelum membuat Dev Site Client.</p>}
    <div className="table-wrap"><table><thead><tr><th>NAMA</th><th>DETAIL</th><th>DIPERBARUI</th>{admin&&<th>AKSI</th>}</tr></thead><tbody>{rows.map(item=>{
      const incomplete=item.kind==="client",siteProject=incomplete?undefined:state.records.find(x=>x.id===item.parentId),siteClient=incomplete?item:state.records.find(x=>x.id===siteProject?.parentId);
      const linkedServices=services.filter(x=>x.parentId===item.id);
      return <tr key={item.id}><td><strong>{item.name}</strong>{incomplete&&<span className="cell-caption">Belum dilengkapi</span>}</td><td className="detail-cell">{kind==="snap_user"?(value(item,"email")||"—"):kind==="dev_site"?<>{incomplete?"Pilih Lengkapi untuk menghubungkan User SNAP":users.find(x=>x.id===value(item,"defaultUserId"))?.name??"—"}<span className="cell-caption">{[incomplete?"Client tersimpan":value(item,"mode")==="mock"?"Mock Lokal":value(item,"mode")==="live"?"Live Bank Sumut":"ASPI Sandbox",value(siteClient,"channelId")&&`CHANNEL-ID ${value(siteClient,"channelId")}`].filter(Boolean).join(" · ")}</span></>:<>{[value(item,"method"),value(item,"path")].filter(Boolean).join(" ")||"—"}<span className="cell-caption">{value(item,"portalUrl")||"URL Aplikasi Pengujian belum diisi"}</span><span className="cell-caption">{linkedServices.map(service=>service.name).join(" · ")||"Belum ada konfigurasi layanan"}</span></>}</td><td>{new Date(item.updatedAt).toLocaleDateString("id-ID")}</td>{admin&&<td><div className="inline-actions">{kind==="endpoint"?linkedServices.length>1?linkedServices.map(service=><button key={service.id} disabled={busy} onClick={()=>setImporting({endpoint:item,service})}>Edit {service.name}</button>):<button disabled={busy} onClick={()=>setImporting({endpoint:item,service:linkedServices[0]})}>Edit</button>:<button disabled={busy} onClick={()=>kind==="dev_site"?setConnection(item):open(item)}>{incomplete?"Lengkapi":"Edit"}</button>}<button disabled={busy} className="danger-action" onClick={()=>remove(item)}>Hapus</button></div></td>}</tr>;
    })}</tbody></table>{!rows.length&&<p className="empty-note">Belum ada data.</p>}</div>
    {kind==="dev_site"&&<p className="helper">CHANNEL-ID wajib. X-DEVICE-ID, ORIGIN, X-IP-ADDRESS, X-LATITUDE, dan X-LONGITUDE opsional.</p>}
    {kind==="snap_user"&&<p className="helper">Password SNAP disimpan terenkripsi.</p>}
    {editing&&<div className="modal-backdrop"><form className="card edit-modal" onSubmit={save}>
      <div className="section-header"><div><h2>{editing==="new"?"Tambah":"Edit"} {labels[kind]}</h2></div></div>
      <div className="form-grid">
        <label className="form-field"><span>Nama *</span><input required maxLength={120} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        {kind==="snap_user"&&<>{field("email","Email SNAP")}{field("password","Password SNAP",false,true)}<p className="helper wide">Saat edit, kosongkan password untuk mempertahankan nilai tersimpan. Akun ini terpisah dari username AutoSNAP.</p></>}
      </div>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEditing(null)}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
    </form></div>}
    {connection&&<ConnectionForm client={selectedClient} environment={selectedSite} user={owner} users={users} api={api} reload={reload} onClose={()=>setConnection(null)} onSaved={()=>{setConnection(null);setNotice("Dev Site Client disimpan.");}}/>}
  </section>;
}
