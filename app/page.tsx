"use client";

import { useEffect, useState } from "react";
import { api, fetchState } from "./api-client";
import AuthScreen from "./auth-screen";
import MasterData from "./master-data";
import Testing from "./testing-panel";
import ClientSimulatorPanel from "./client-simulator-panel";
import UserManagement from "./user-management";
import type { State } from "./model";
import UiIcon from "./ui-icon";
import Dashboard from "./dashboard";
import { can } from "./privileges";

type Page="Dashboard"|"Dev Site Client"|"Client Simulator"|"Master Data"|"User Management";
const empty:State={records:[],runs:[],scenarios:[],operators:[]};
const pages:{label:Page;icon:"dashboard"|"testing"|"simulator"|"data"|"users"}[]=[{label:"Dashboard",icon:"dashboard"},{label:"Dev Site Client",icon:"testing"},{label:"Client Simulator",icon:"simulator"},{label:"Master Data",icon:"data"},{label:"User Management",icon:"users"}];
const pagePrivilege:Record<Page,string>={Dashboard:"dashboard","Dev Site Client":"dev_site","Client Simulator":"client_simulator","Master Data":"master_data","User Management":"user_management"};
export default function Home(){
  const [state,setState]=useState<State>(empty),[loading,setLoading]=useState(true),[page,setPage]=useState<Page>("Dashboard");
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[sidebarOpen,setSidebarOpen]=useState(true),[profileOpen,setProfileOpen]=useState(false);
  async function reload(){setState(await fetchState());}
  useEffect(()=>{fetchState().then(setState).catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
  async function logout(){if(!window.confirm("Keluar dari AutoSNAP? Proses testing yang sedang berjalan tidak otomatis dibatalkan."))return;try{await api("logout");setState(empty);await reload();setNotice("");setError("");}catch(e){setError((e as Error).message);}}
  if(loading)return <div className="auth-screen"><span className="loading-spinner" role="status" aria-label="Memuat AutoSNAP"/></div>;
  if(!state.user)return <>{error&&<div className="form-error" role="alert">{error}</div>}<AuthScreen key={state.setupRequired?"setup":"login"} state={state} api={api} reload={reload}/></>;
  const moduleOf:Record<Page,"dashboard"|"dev_site"|"client_simulator"|"master_data"|"user_management">={Dashboard:"dashboard","Dev Site Client":"dev_site","Client Simulator":"client_simulator","Master Data":"master_data","User Management":"user_management"};
  const allowedPages=pages.filter(entry=>can(state.user,moduleOf[entry.label],"view")||(state.user?.privileges??[]).includes(pagePrivilege[entry.label]));
  const visiblePage=allowedPages.some(entry=>entry.label===page)?page:allowedPages[0]?.label;
  const common={state,api,reload,setError,setNotice};
  return <div className={`app-shell${sidebarOpen?"":" sidebar-collapsed"}`}>
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-header"><span className="workspace-label">WORKSPACE</span><button className="sidebar-toggle" aria-label={sidebarOpen?"Tutup sidebar":"Buka sidebar"} aria-expanded={sidebarOpen} title={sidebarOpen?"Tutup sidebar":"Buka sidebar"} onClick={()=>setSidebarOpen(value=>!value)}><UiIcon name="menu"/></button></div>
      <nav aria-label="Navigasi utama">{allowedPages.map(entry=><button key={entry.label} title={entry.label} aria-label={entry.label} aria-current={entry.label===visiblePage?"page":undefined} className={entry.label===visiblePage?"active":""} onClick={()=>{setPage(entry.label);setError("");setNotice("");}}><UiIcon name={entry.icon}/><span className="nav-label">{entry.label}</span></button>)}</nav>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="topbar-title"><div><div className="breadcrumb">Workspace <span>/</span> {visiblePage??"Tidak ada akses"}</div><h1>{visiblePage??"Tidak ada akses menu"}</h1></div></div><div className="profile-menu"><button className="profile-trigger" aria-expanded={profileOpen} onClick={()=>setProfileOpen(value=>!value)}><span className="avatar">{state.user.username.slice(0,2).toUpperCase()}</span><span><strong>{state.user.username}</strong><small>{state.user.role==="admin"?"Admin":"Petugas"}</small></span></button>{profileOpen&&<div className="profile-dropdown">{allowedPages.some(entry=>entry.label==="User Management")&&<button onClick={()=>{setPage("User Management");setProfileOpen(false);}}>Ubah password</button>}<button className="danger-action" onClick={logout}><UiIcon name="logout"/>Keluar</button></div>}</div></header>
      {error&&<div className="form-error" role="alert">{error}<button aria-label="Tutup pesan kesalahan" onClick={()=>setError("")}>×</button></div>}
      {notice&&<div className="form-notice" role="status">{notice}<button aria-label="Tutup pemberitahuan" onClick={()=>setNotice("")}>×</button></div>}
      {visiblePage==="Dashboard"&&<Dashboard state={state} api={api} navigate={setPage} reload={reload}/>}
      {visiblePage==="Master Data"&&<MasterData {...common}/>}
      {visiblePage==="Dev Site Client"&&<Testing {...common} variant="dev_site"/>}
      {visiblePage==="Client Simulator"&&<ClientSimulatorPanel {...common}/>}
      {visiblePage==="User Management"&&<UserManagement {...common}/>}
    </main>
  </div>;
}
