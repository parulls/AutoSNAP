"use client";

import { FormEvent, useState } from "react";
import DocumentationImport from "./documentation-import";
import ConnectionForm from "./connection-form";
import type { Api, Item, State } from "./model";
import PasswordInput from "./password-input";
import { can } from "./privileges";
import {fieldOf,linkDevSite} from "./dev-site-link";

type Kind="snap_user"|"dev_site"|"endpoint"|"sim_provider";
const labels:Record<Kind,string>={snap_user:"User SNAP",dev_site:"Dev Site Client",endpoint:"Dev Site Endpoint",sim_provider:"Penyedia Client Simulator"};
const value=(item:Item|undefined,key:string)=>String(item?.data[key]??"");
const asObject=(entry:unknown):entry is Record<string,unknown>=>!!entry&&typeof entry==="object"&&!Array.isArray(entry);

export default function MasterData({state,api,reload,setError,setNotice}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void}){
  const [kind,setKind]=useState<Kind>("snap_user"),[editing,setEditing]=useState<Item|"new"|null>(null),[connection,setConnection]=useState<Item|"new"|null>(null);
  const [draft,setDraft]=useState({name:"",parentId:"",data:{} as Record<string,unknown>}),[busy,setBusy]=useState(false),[modalError,setModalError]=useState("");
  const [importing,setImporting]=useState<{endpoint?:Item;service?:Item}|null>(null);
  const [serviceEditor,setServiceEditor]=useState<{provider:Item;service?:Item}|null>(null);
  const [serviceDraft,setServiceDraft]=useState({name:"",method:"POST",path:"",channelId:"",deviceId:"",partnerId:"",externalId:"",defaultBody:"{}",expectedHttpStatus:"",expectedCode:""});
  const moduleAccess=kind==="sim_provider"?can(state.user,"client_simulator")||can(state.user,"master_data"):can(state.user,"master_data");
  const canCreate=moduleAccess,canUpdate=moduleAccess,canDelete=moduleAccess;
  const canMutate=canCreate||canUpdate;
  const users=state.records.filter(x=>x.kind==="snap_user");
  const sites=state.records.filter(x=>x.kind==="environment"&&value(x,"category").trim().toLowerCase()!=="client simulator");
  const incompleteClients=state.records.filter(client=>client.kind==="client"&&!state.records.some(project=>project.kind==="project"&&project.parentId===client.id&&state.records.some(environment=>environment.kind==="environment"&&environment.parentId===project.id)));
  const services=state.records.filter(x=>x.kind==="service");
  const endpoints=state.records.filter(x=>x.kind==="endpoint");
  const providers=state.records.filter(x=>x.kind==="sim_provider");
  const simServices=state.records.filter(x=>x.kind==="sim_service");
  const rows=kind==="snap_user"?users:kind==="dev_site"?[...sites,...incompleteClients]:kind==="sim_provider"?providers:endpoints;
  function open(item:Item|null){
    setEditing(item??"new");setModalError("");setError("");
    if(kind==="sim_provider"){
      const data=item?{...item.data,clientSecret:"",privateKey:"",signatureAuthPrivateKey:""}:{baseUrl:"",clientKey:"",clientSecret:"",privateKey:"",signatureAuthPrivateKey:"",accessTokenUrl:"/api/v1.0/access-token/b2b",signatureAccessTokenMode:"FUNCTION",signatureServiceMode:"FUNCTION",rsaEncoding:"base64",hmacEncoding:"hex",timestampConfig:{offsetMinutes:420,includeMillis:false},channelId:"",deviceId:"",partnerId:"",origin:"",ipAddress:"",latitude:"",longitude:"",allowPrivateKeyToSigner:false};
      setDraft({name:item?.name??"",parentId:"",data});
      return;
    }
    setDraft(item?{name:item.name,parentId:item.parentId??"",data:{...item.data,email:value(item,"email")||value(item,"username"),password:""}}:{name:"",parentId:"",data:{email:"",password:""}});
  }
  const patch=(key:string,entry:string|boolean|Record<string,unknown>)=>setDraft(old=>({...old,data:{...old.data,[key]:entry}}));
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setModalError("");setError("");
    try{
      const data={...draft.data};if(typeof data.config==="string")data.config=JSON.parse(data.config);
      await api("save",{kind:kind==="sim_provider"?"sim_provider":kind,id:editing&&editing!=="new"?editing.id:undefined,...draft,data});
      await reload();setEditing(null);setNotice("Master Data disimpan.");
    }catch(e){setModalError((e as Error).message);}finally{setBusy(false);}
  }
  async function remove(item:Item){
    if(!window.confirm(item.kind==="endpoint"?`Hapus Dev Site Endpoint ${item.name} beserta konfigurasi layanan dan templatenya? History Testing tetap disimpan.`:item.kind==="sim_provider"?`Hapus penyedia ${item.name}? Hapus service turunannya terlebih dahulu.`:`Hapus ${item.name}?`))return;
    setBusy(true);setError("");
    try{await api(item.kind==="endpoint"?"deleteEndpointConfiguration":"delete",{id:item.id});await reload();setNotice("Data dihapus.");}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  function openService(provider:Item,service?:Item){
    setServiceEditor({provider,service});setModalError("");
    setServiceDraft(service?{name:service.name,method:value(service,"method")||"POST",path:value(service,"path")||value(service,"serviceUrl"),channelId:value(service,"channelId"),deviceId:value(service,"deviceId"),partnerId:value(service,"partnerId"),externalId:value(service,"externalId"),defaultBody:value(service,"defaultBody")||value(service,"requestBody")||"{}",expectedHttpStatus:value(service,"expectedHttpStatus"),expectedCode:value(service,"expectedCode")}:{name:"",method:"POST",path:"",channelId:value(provider,"channelId"),deviceId:value(provider,"deviceId"),partnerId:value(provider,"partnerId"),externalId:"",defaultBody:"{}",expectedHttpStatus:"200",expectedCode:""});
  }
  async function saveService(event:FormEvent){
    event.preventDefault();if(!serviceEditor)return;setBusy(true);setModalError("");
    try{
      await api("save",{kind:"sim_service",id:serviceEditor.service?.id,name:serviceDraft.name,parentId:serviceEditor.provider.id,data:{...serviceDraft,expectedHttpStatus:serviceDraft.expectedHttpStatus?Number(serviceDraft.expectedHttpStatus):null}});
      await reload();setServiceEditor(null);setNotice("API Service penyedia disimpan.");
    }catch(e){setModalError((e as Error).message);}finally{setBusy(false);}
  }
  const selectedRecord=connection&&connection!=="new"?connection:undefined;
  const selectedSite=selectedRecord?.kind==="environment"?selectedRecord:undefined;
  const client=linkDevSite(state.records,selectedSite).client;
  const selectedClient=selectedRecord?.kind==="client"?selectedRecord:client;
  const owner=users.find(x=>x.id===value(selectedSite,"defaultUserId"));
  const field=(key:string,label:string,multiline=false,secret=false,hint="")=><label className={`form-field${multiline?" wide":""}`}><span>{label}</span>{multiline?<textarea rows={6} required={label.endsWith("*")} spellCheck={false} value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>:secret?<PasswordInput autoComplete="off" value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>:<input required={label.endsWith("*")} type={key==="email"?"email":"text"} autoComplete="off" value={String(draft.data[key]??"")} onChange={e=>patch(key,e.target.value)}/>}{hint&&<small className="helper">{hint}</small>}</label>;
  const ts=asObject(draft.data.timestampConfig)?draft.data.timestampConfig as {offsetMinutes?:number;includeMillis?:boolean}:{offsetMinutes:420,includeMillis:false};
  const accessMode=String(draft.data.signatureAccessTokenMode??"FUNCTION");
  const serviceMode=String(draft.data.signatureServiceMode??"FUNCTION");
  const needsPrivateKey=accessMode==="FUNCTION"||accessMode==="HIT_API";
  const needsSecret=serviceMode==="FUNCTION"||serviceMode==="HIT_API";
  const hitApiSigning=accessMode==="HIT_API"||serviceMode==="HIT_API";
  const newProvider=editing==="new";

  return <section className="card master-card">
    <div className="section-header"><div><h2>Master Data</h2><p>User SNAP, Dev Site Client, Dev Site Endpoint, dan Penyedia Client Simulator.</p></div>{canCreate&&<button className="primary-button" disabled={busy||(kind==="dev_site"||kind==="endpoint")&&!users.length} onClick={()=>kind==="endpoint"?setImporting({}):kind==="dev_site"?setConnection("new"):open(null)}>Tambah {labels[kind]}</button>}</div>
    {importing&&<DocumentationImport users={users} endpoint={importing.endpoint} service={importing.service} api={api} reload={reload} onClose={()=>setImporting(null)}/>}
    <div className="tabs" role="tablist">{(Object.keys(labels) as Kind[]).map(key=><button key={key} role="tab" aria-selected={kind===key} className={kind===key?"active":""} onClick={()=>{setKind(key);setEditing(null);setConnection(null);setServiceEditor(null);}}>{labels[key]}</button>)}</div>
    {kind==="dev_site"&&!users.length&&<p className="helper">Tambahkan User SNAP sebelum membuat Dev Site Client.</p>}
    <div className="table-wrap"><table><thead><tr><th>NAMA</th><th>DETAIL</th><th>DIPERBARUI</th>{canMutate&&<th>AKSI</th>}</tr></thead><tbody>{rows.map(item=>{
      const incomplete=item.kind==="client",siteClient=incomplete?item:linkDevSite(state.records,item).client;
      const linkedServices=services.filter(x=>x.parentId===item.id);
      const linkedSim=simServices.filter(x=>x.parentId===item.id);
      return <tr key={item.id}><td><strong>{item.name}</strong>{incomplete&&<span className="cell-caption">Belum dilengkapi</span>}</td><td className="detail-cell">{kind==="snap_user"?(value(item,"email")||"—"):kind==="dev_site"?<>{incomplete?"Pilih Lengkapi untuk menghubungkan User SNAP":users.find(x=>x.id===value(item,"defaultUserId"))?.name??"—"}<span className="cell-caption">{[incomplete?"Client tersimpan":value(item,"mode")==="mock"?"Mock Lokal":value(item,"mode")==="live"?"Live Bank Sumut":"ASPI Sandbox",fieldOf(siteClient,"channelId")&&`CHANNEL-ID ${fieldOf(siteClient,"channelId")}`,fieldOf(siteClient,"deviceId")&&`X-DEVICE-ID ${fieldOf(siteClient,"deviceId")}`].filter(Boolean).join(" · ")}</span></>:kind==="sim_provider"?<>{value(item,"baseUrl")||"—"}<span className="cell-caption">AT {String(item.data.signatureAccessTokenMode??"FUNCTION")} · SVC {String(item.data.signatureServiceMode??"FUNCTION")} · {linkedSim.length} service</span><span className="cell-caption">{linkedSim.map(s=>s.name).join(" · ")||"Belum ada API Service"}</span></>:<>{[value(item,"method"),value(item,"path")].filter(Boolean).join(" ")||"—"}<span className="cell-caption">{value(item,"portalUrl")||"URL Aplikasi Pengujian belum diisi"}</span><span className="cell-caption">{linkedServices.map(service=>service.name).join(" · ")||"Belum ada konfigurasi layanan"}</span></>}</td><td>{new Date(item.updatedAt).toLocaleDateString("id-ID")}</td>{canMutate&&<td><div className="inline-actions">{kind==="endpoint"?linkedServices.length>1?linkedServices.map(service=><button key={service.id} disabled={busy||!canUpdate} onClick={()=>setImporting({endpoint:item,service})}>Edit {service.name}</button>):<button disabled={busy||!canUpdate} onClick={()=>setImporting({endpoint:item,service:linkedServices[0]})}>Edit</button>:kind==="sim_provider"?<>{canUpdate&&<button disabled={busy} onClick={()=>open(item)}>Edit</button>}{canCreate&&<button disabled={busy} onClick={()=>openService(item)}>Tambah Service</button>}{linkedSim.map(s=>canUpdate?<button key={s.id} disabled={busy} onClick={()=>openService(item,s)}>Edit {s.name}</button>:null)}{linkedSim.map(s=>canDelete?<button key={`d-${s.id}`} disabled={busy} className="danger-action" onClick={()=>remove(s)}>Hapus {s.name}</button>:null)}</>: <button disabled={busy||!canUpdate} onClick={()=>kind==="dev_site"?setConnection(item):open(item)}>{incomplete?"Lengkapi":"Edit"}</button>}{canDelete&&<button disabled={busy} className="danger-action" onClick={()=>remove(item)}>Hapus</button>}</div></td>}</tr>;
    })}</tbody></table>{!rows.length&&<p className="empty-note">Belum ada data.</p>}</div>
    {kind==="dev_site"&&<p className="helper">CHANNEL-ID wajib. X-DEVICE-ID, ORIGIN, X-IP-ADDRESS, X-LATITUDE, dan X-LONGITUDE opsional — dikirim otomatis sesuai Master Data.</p>}
    {kind==="endpoint"&&<p className="helper">Dev Site Endpoint terpisah dari Penyedia Client Simulator.</p>}
    {kind==="snap_user"&&<p className="helper">Password SNAP disimpan terenkripsi.</p>}
    {kind==="sim_provider"&&<p className="helper">Client Secret dan Private Key disimpan terenkripsi. Signature memakai fungsi backend terdaftar (bukan eval/skrip DB).</p>}
    {editing&&<div className="modal-backdrop"><form className="card edit-modal" onSubmit={save}>
      <div className="section-header"><div><h2>{editing==="new"?"Tambah":"Edit"} {labels[kind]}</h2><p>{kind==="sim_provider"?"Isian bertanda * wajib. HIT_API mengubah Private Key PEM menjadi base64 secara otomatis.":"Perbaiki isian yang ditandai sebelum menyimpan."}</p></div></div>
      {modalError&&<div className="form-error" role="alert">{modalError}</div>}
      <div className="form-grid">
        <label className="form-field"><span>Nama *</span><input required maxLength={120} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        {kind==="snap_user"&&<>{field("email","Email SNAP")}{field("password","Password SNAP",false,true)}<p className="helper wide">Saat edit, kosongkan password untuk mempertahankan nilai tersimpan. Akun ini terpisah dari username AutoSNAP.</p></>}
        {kind==="sim_provider"&&<>
          {field("baseUrl","Base URL (HTTPS) *",false,false,"Alamat dasar API tujuan. Wajib https://.")}
          {field("clientKey","Client Key / Client ID *")}
          {field("clientSecret",newProvider&&needsSecret?"Client Secret *":"Client Secret",false,true,needsSecret?"Wajib untuk FUNCTION dan HIT_API Signature Service. Kosongkan saat edit jika tidak diubah.":"Opsional selama Signature Service bukan FUNCTION atau HIT_API.")}
          {field("privateKey",newProvider&&needsPrivateKey?"Private Key PEM *":"Private Key PEM",true,false,accessMode==="HIT_API"?"Teks PEM lengkap. Saat HIT_API, PEM ini diubah otomatis menjadi base64 satu baris untuk Private_Key signature-auth. Kosongkan saat edit jika tidak diubah.":needsPrivateKey?"Teks PEM lengkap, termasuk BEGIN/END. Dipakai saat Signature Access Token dihitung di AutoSNAP. Kosongkan saat edit jika tidak diubah.":"Tidak dipakai selama Signature Access Token bukan FUNCTION atau HIT_API.")}
          <details className="advanced-settings wide" open={hitApiSigning||undefined}>
            <summary>Pengaturan opsional</summary>
            <p className="helper">Nilai bawaan sudah cukup untuk pengujian biasa. Buka bagian ini hanya jika kontrak penyedia berbeda.</p>
            <div className="form-grid">
              <label className="form-field wide"><span>URL Access Token</span><input value={String(draft.data.accessTokenUrl??"")} onChange={e=>patch("accessTokenUrl",e.target.value)}/><small className="helper">Kosong berarti /api/v1.0/access-token/b2b.</small></label>
              <div className="signing-pair wide">
                <label className="form-field"><span>Signature Access Token Mode</span><select value={accessMode} onChange={e=>patch("signatureAccessTokenMode",e.target.value)}><option value="FUNCTION">FUNCTION — dihitung di AutoSNAP</option><option value="HIT_API">HIT_API — layanan signing lain</option><option value="NONE">NONE — tanpa signature</option></select></label>
                {accessMode==="HIT_API"?field("signatureAccessTokenUrl","URL Signature Authentication *",false,false,"Dipanggil langsung. Untuk dev Bank Sumut, isi URL di host dev.banksumut.co.id. Private Key dikirim sebagai base64 pada header Private_Key."):<span/>}
                {accessMode==="HIT_API"&&<label className="form-field"><span>Private Key Signature Authentication</span><input spellCheck={false} autoComplete="off" value={String(draft.data.signatureAuthPrivateKey??"")} onChange={e=>patch("signatureAuthPrivateKey",e.target.value)}/><small className="helper">Opsional. Kosongkan untuk memakai Private Key PEM di atas. PEM diubah otomatis menjadi base64.</small></label>}
              </div>
              <div className="signing-pair wide">
                <label className="form-field"><span>Signature Service Mode</span><select value={serviceMode} onChange={e=>patch("signatureServiceMode",e.target.value)}><option value="FUNCTION">FUNCTION — dihitung di AutoSNAP</option><option value="HIT_API">HIT_API — layanan signing lain</option><option value="NONE">NONE — tanpa signature</option></select></label>
                {serviceMode==="HIT_API"?field("signatureServiceUrl","URL Signature Service *",false,false,"Hasilnya menjadi X-SIGNATURE request service."):<span/>}
              </div>
              <label className="form-field"><span>RSA Encoding</span><select value={String(draft.data.rsaEncoding??"base64")} onChange={e=>patch("rsaEncoding",e.target.value)}><option value="base64">Base64</option><option value="hex">Hex</option></select><small className="helper">Bawaan Base64.</small></label>
              <label className="form-field"><span>HMAC Encoding</span><select value={String(draft.data.hmacEncoding??"hex")} onChange={e=>patch("hmacEncoding",e.target.value)}><option value="hex">Hex</option><option value="base64">Base64</option></select><small className="helper">Bank Sumut SNAP Batubara memakai Base64. Hex dibalas 401 Unauthorized Signature.</small></label>
              <label className="form-field"><span>Offset timezone (menit)</span><input type="number" value={Number(ts.offsetMinutes??420)} onChange={e=>patch("timestampConfig",{...ts,offsetMinutes:Number(e.target.value)})}/><small className="helper">420 = WIB (UTC+7).</small></label>
              <label className="form-field"><span>Milidetik timestamp</span><select value={ts.includeMillis?"1":"0"} onChange={e=>patch("timestampConfig",{...ts,includeMillis:e.target.value==="1"})}><option value="0">Tanpa milidetik</option><option value="1">Dengan milidetik</option></select></label>
              {field("partnerId","Default X-PARTNER-ID",false,false,"Kosong berarti memakai Client Key.")}
              {field("channelId","Default CHANNEL-ID")}
              {field("deviceId","Default X-DEVICE-ID",false,false,"Bank Sumut menolak request tanpa header ini. Koleksi SNAP Batubara memakai h2hBatubara.")}
              {field("origin","ORIGIN")}
              {field("ipAddress","X-IP-ADDRESS")}
              {field("latitude","X-LATITUDE")}
              {field("longitude","X-LONGITUDE")}
            </div>
          </details>
        </>}
      </div>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setEditing(null);setModalError("");}}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
    </form></div>}
    {serviceEditor&&<div className="modal-backdrop"><form className="card edit-modal" onSubmit={saveService}>
      <div className="section-header"><div><h2>{serviceEditor.service?"Edit":"Tambah"} API Service — {serviceEditor.provider.name}</h2><p>Service ini yang dipanggil halaman Client Simulator. Path dan body di bawah yang dikirim.</p></div></div>
      {modalError&&<div className="form-error" role="alert">{modalError}</div>}
      <div className="form-grid">
        <label className="form-field"><span>Nama Service *</span><input required maxLength={120} value={serviceDraft.name} onChange={e=>setServiceDraft({...serviceDraft,name:e.target.value})}/></label>
        <label className="form-field"><span>Method *</span><select required value={serviceDraft.method} onChange={e=>setServiceDraft({...serviceDraft,method:e.target.value})}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label>
        <label className="form-field wide"><span>Service URL / Relative Path *</span><input required value={serviceDraft.path} onChange={e=>setServiceDraft({...serviceDraft,path:e.target.value})} placeholder="/api/v1.0/..."/><small className="helper">Path relatif, diawali /. Disambung ke Base URL penyedia saat Client Simulator mengirim request.</small></label>
        <label className="form-field wide"><span>Request Body JSON</span><textarea rows={8} spellCheck={false} value={serviceDraft.defaultBody} onChange={e=>setServiceDraft({...serviceDraft,defaultBody:e.target.value})}/><small className="helper">Inilah body yang dikirim Client Simulator. GET/HEAD tidak mengirim body. Kosongkan dengan {"{}"} jika tidak ada payload.</small></label>
        <details className="advanced-settings wide">
          <summary>Header dan ekspektasi opsional</summary>
          <p className="helper">Kosong berarti memakai nilai penyedia. X-PARTNER-ID kosong memakai Client Key.</p>
          <div className="form-grid">
            <label className="form-field"><span>CHANNEL-ID</span><input value={serviceDraft.channelId} onChange={e=>setServiceDraft({...serviceDraft,channelId:e.target.value})}/></label>
            <label className="form-field"><span>X-DEVICE-ID</span><input value={serviceDraft.deviceId} onChange={e=>setServiceDraft({...serviceDraft,deviceId:e.target.value})}/></label>
            <label className="form-field"><span>X-PARTNER-ID</span><input value={serviceDraft.partnerId} onChange={e=>setServiceDraft({...serviceDraft,partnerId:e.target.value})}/></label>
            <label className="form-field"><span>X-EXTERNAL-ID</span><input value={serviceDraft.externalId} onChange={e=>setServiceDraft({...serviceDraft,externalId:e.target.value})}/></label>
            <label className="form-field"><span>Expected HTTP Status</span><input value={serviceDraft.expectedHttpStatus} onChange={e=>setServiceDraft({...serviceDraft,expectedHttpStatus:e.target.value})}/></label>
            <label className="form-field"><span>Expected SNAP responseCode</span><input value={serviceDraft.expectedCode} onChange={e=>setServiceDraft({...serviceDraft,expectedCode:e.target.value})}/></label>
          </div>
        </details>
      </div>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setServiceEditor(null)}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan Service"}</button></div>
    </form></div>}
    {connection&&<ConnectionForm client={selectedClient} environment={selectedSite} user={owner} users={users} api={api} reload={reload} onClose={()=>setConnection(null)} onSaved={()=>{setConnection(null);setNotice("Dev Site Client disimpan.");}}/>}
  </section>;
}
