"use client";

import { FormEvent, useState } from "react";
import type { Api, Operator, State } from "./model";
import PasswordInput from "./password-input";
import { can, normalizePrivileges, privilegeOptions } from "./privileges";
import UiIcon from "./ui-icon";

export default function UserManagement({state,api,reload,setError,setNotice}:{state:State;api:Api;reload:()=>Promise<void>;setError:(s:string)=>void;setNotice:(s:string)=>void}){
  const [target,setTarget]=useState<Operator|"new"|null>(null),[busy,setBusy]=useState(false),[modalError,setModalError]=useState("");
  const [form,setForm]=useState({username:"",email:"",password:"",currentPassword:"",role:"petugas",privileges:["dashboard","dev_site","client_simulator"] as string[]});
  const canManageUsers=can(state.user,"user_management");
  const canCreate=canManageUsers,canUpdate=canManageUsers,canDelete=canManageUsers;
  const isAdmin=state.user?.role==="admin";
  const held=normalizePrivileges(state.user?.privileges,state.user?.role);
  const assignable=isAdmin?privilegeOptions:privilegeOptions.filter(item=>held.includes(item.key));
  function open(user:Operator|"new"){setTarget(user);setModalError("");setError("");const role=user==="new"||user.role!=="admin"?"petugas":"admin";setForm({username:user==="new"?"":user.username,email:user==="new"?"":user.email??"",password:"",currentPassword:"",role,privileges:user==="new"?["dashboard","dev_site","client_simulator"]:normalizePrivileges(user.privileges,role)});}
  function togglePrivilege(key:string){setForm(current=>({...current,privileges:current.privileges.includes(key)?current.privileges.filter(item=>item!==key):[...current.privileges,key]}));}
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setModalError("");setError("");
    try{
      await api(target==="new"?"userCreate":"userUpdate",{...form,id:target&&target!=="new"?target.id:undefined});
      setTarget(null);setNotice(target==="new"?(form.role==="admin"?"Akun admin dibuat.":"Akun petugas dibuat."):"Akun berhasil diperbarui.");await reload();
    }catch(e){setModalError((e as Error).message);}finally{setBusy(false);}
  }
  async function change(user:Operator,action:"active"|"delete"){
    if(action==="delete"&&!window.confirm(`Hapus akun ${user.username}?`))return;
    setBusy(true);setError("");
    try{await api(action==="delete"?"userDelete":"userUpdate",{id:user.id,...(action==="active"?{active:!user.active}:{})});await reload();setNotice("Akun diperbarui.");}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const showPrivilegeEditor=canUpdate&&form.role!=="admin"&&(target==="new"||(target&&target.id!==state.user?.id)||isAdmin);
  return <section className="card master-card">
    <div className="section-header"><div><h2>User AutoSNAP</h2><p>Kelola user sesuai privilege.</p></div>{canCreate&&<button className="primary-button" onClick={()=>open("new")}>Tambah Akun</button>}</div>
    <div className="table-wrap"><table><thead><tr><th>USER</th><th>ROLE</th><th>PRIVILEGE</th><th>STATUS</th><th>AKSI</th></tr></thead><tbody>{(state.operators??[]).map(user=><tr key={user.id}>
      <td><strong>{user.username}</strong>{user.id===state.user?.id&&<span className="cell-caption">Akun Anda</span>}</td>
      <td>{user.role==="admin"?"Admin":"Petugas"}</td><td><div className="privilege-list">{normalizePrivileges(user.privileges,user.role).map(key=><span key={key}>{privilegeOptions.find(item=>item.key===key)?.label??key}</span>)}</div></td><td><span className={`status-badge ${user.active?"passed":"skipped"}`}>{user.active?"Aktif":"Menunggu aktivasi / nonaktif"}</span></td>
      <td><div className="inline-actions">{(canUpdate||user.id===state.user?.id)&&<button disabled={busy} onClick={()=>open(user)}>Kelola</button>}{canUpdate&&isAdmin&&user.id!==state.user?.id&&<button disabled={busy} onClick={()=>change(user,"active")}>{user.active?"Nonaktifkan":"Aktifkan"}</button>}{canDelete&&user.id!==state.user?.id&&<button disabled={busy} className="danger-action" onClick={()=>change(user,"delete")}>Hapus</button>}</div></td>
    </tr>)}</tbody></table></div>
    {target&&<div className="modal-backdrop"><form className="card edit-modal" onSubmit={save} role="dialog" aria-modal="true">
      <div className="modal-header"><div><h2>{target==="new"?"Tambah Akun":`Kelola Akun — ${target.username}`}</h2></div><button type="button" className="close-button" aria-label="Tutup" title="Tutup" disabled={busy} onClick={()=>{setTarget(null);setModalError("");}}><UiIcon name="close"/></button></div>
      <div className="modal-body">
      {modalError&&<div className="form-error" role="alert">{modalError}</div>}
      <div className="form-grid">
        {target==="new"&&<><label className="form-field"><span>Username AutoSNAP *</span><input required minLength={3} maxLength={40} autoComplete="off" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></label>{isAdmin&&<label className="form-field"><span>Peran</span><select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="petugas">Petugas</option><option value="admin">Admin</option></select></label>}</>}
        <label className="form-field wide"><span>Email AutoSNAP *</span><input type="email" required maxLength={254} autoComplete="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></label>
        {showPrivilegeEditor&&<fieldset className="privilege-field wide"><legend>Privilege</legend><div className="privilege-options">{assignable.map(item=><label key={item.key}><input type="checkbox" checked={form.privileges.includes(item.key)} onChange={()=>togglePrivilege(item.key)}/><span>{item.label}</span></label>)}</div></fieldset>}
        {target!=="new"&&target.id===state.user?.id&&<label className="form-field wide"><span>Password saat ini *</span><PasswordInput required autoComplete="current-password" value={form.currentPassword} onChange={e=>setForm({...form,currentPassword:e.target.value})}/></label>}
        <label className="form-field wide"><span>{target==="new"?"Password *":"Password baru"}</span><PasswordInput required={target==="new"} {...(form.password||target==="new"?{minLength:12}:{})} maxLength={256} autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label>
      </div>
      <p className="helper form-footnote">* wajib diisi</p>
      </div>
      <div className="modal-footer"><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setTarget(null);setModalError("");}}>Batal</button><button className="primary-button" disabled={busy}>{busy?"Menyimpan...":"Simpan"}</button></div>
    </form></div>}
  </section>;
}
