"use client";

import { FormEvent, useState } from "react";
import type { Api, Operator, State } from "./model";

export default function UserManagement({state,api,reload,setError,setNotice}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void}){
  const [target,setTarget]=useState<Operator|"new"|null>(null),[busy,setBusy]=useState(false);
  const [form,setForm]=useState({username:"",password:"",currentPassword:"",role:"tester"});
  const admin=state.user?.role==="admin";
  function open(user:Operator|"new"){setTarget(user);setForm({username:user==="new"?"":user.username,password:"",currentPassword:"",role:user==="new"?"tester":user.role});}
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");
    try{
      await api(target==="new"?"userCreate":"userUpdate",{...form,id:target&&target!=="new"?target.id:undefined});
      setTarget(null);setNotice(target==="new"?"Akun petugas dibuat.":"Password diperbarui. Akun tersebut perlu login kembali.");await reload();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function change(user:Operator,action:"active"|"delete"){
    if(action==="delete"&&!window.confirm(`Hapus akun ${user.username}?`))return;
    setBusy(true);setError("");
    try{await api(action==="delete"?"userDelete":"userUpdate",{id:user.id,...(action==="active"?{active:!user.active}:{})});await reload();setNotice("Akun diperbarui.");}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="card master-card">
    <div className="section-header"><div><h2>Akun AutoSNAP</h2><p>Admin mengelola konfigurasi dan akun. Petugas menjalankan testing serta melihat hasil.</p></div>{admin&&<button className="primary-button" onClick={()=>open("new")}>Tambah Petugas</button>}</div>
    <div className="table-wrap"><table><thead><tr><th>USERNAME</th><th>PERAN</th><th>STATUS</th><th>AKSI</th></tr></thead><tbody>{(state.operators??[]).map(user=><tr key={user.id}>
      <td><strong>{user.username}</strong>{user.id===state.user?.id&&<span className="cell-caption">Akun Anda</span>}</td>
      <td>{user.role==="admin"?"Admin":"Petugas"}</td><td><span className={`status-badge ${user.active?"passed":"skipped"}`}>{user.active?"Aktif":"Menunggu aktivasi / nonaktif"}</span></td>
      <td><div className="inline-actions"><button disabled={busy} onClick={()=>open(user)}>Ubah Password</button>{admin&&user.id!==state.user?.id&&<><button disabled={busy} onClick={()=>change(user,"active")}>{user.active?"Nonaktifkan":"Aktifkan"}</button><button disabled={busy} className="danger-action" onClick={()=>change(user,"delete")}>Hapus</button></>}</div></td>
    </tr>)}</tbody></table></div>
    <p className="helper">Pendaftaran mandiri memakai username, password, dan Google reCAPTCHA v2. Admin mengaktifkan akun baru. User SNAP dan kredensial bank dikelola melalui Master Data.</p>
    {target&&<div className="modal-backdrop"><form className="card edit-modal" onSubmit={save}>
      <div className="section-header"><div><h2>{target==="new"?"Tambah Akun":`Ubah Password — ${target.username}`}</h2></div></div>
      <div className="form-grid">
        {target==="new"&&<><label className="form-field"><span>Username AutoSNAP *</span><input required minLength={3} maxLength={40} autoComplete="off" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label><label className="form-field"><span>Peran</span><select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="tester">Petugas</option><option value="admin">Admin</option></select></label></>}
        {target!=="new"&&target.id===state.user?.id&&<label className="form-field wide"><span>Password saat ini *</span><input type="password" required autoComplete="current-password" value={form.currentPassword} onChange={e=>setForm({...form,currentPassword:e.target.value})}/></label>}
        <label className="form-field wide"><span>{target==="new"?"Password":"Password baru"} *</span><input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><small className="helper">Minimal 12 karakter.</small></label>
      </div>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setTarget(null)}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
    </form></div>}
  </section>;
}
