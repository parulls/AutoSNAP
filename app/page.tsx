"use client";

import { useEffect, useState } from "react";
import { api, fetchState } from "./api-client";
import AuthScreen from "./auth-screen";
import MasterData from "./master-data";
import Testing from "./testing";
import UserManagement from "./user-management";
import type { State } from "./model";

type Page="Master Data"|"API Testing"|"User Management";
const empty:State={records:[],runs:[],scenarios:[],operators:[]};
const pages:Page[]=["Master Data","API Testing","User Management"];
export default function Home(){
  const [state,setState]=useState<State>(empty),[loading,setLoading]=useState(true),[page,setPage]=useState<Page>("Master Data");
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  async function reload(){setState(await fetchState());}
  useEffect(()=>{fetchState().then(setState).catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
  async function logout(){try{await api("logout");setState(empty);await reload();setNotice("");setError("");}catch(e){setError((e as Error).message);}}
  if(loading)return <div className="auth-screen"><div className="card auth-card">Memuat AutoSNAP...</div></div>;
  if(!state.user)return <>{error&&<div className="form-error" role="alert">{error}</div>}<AuthScreen key={state.setupRequired?"setup":"login"} state={state} api={api} reload={reload}/></>;
  const common={state,api,reload,setError,setNotice};
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">AS</div><div><strong>AutoSNAP</strong><span>Dev Site Testing</span></div></div>
      <div className="workspace-label">MENU UTAMA</div>
      <nav aria-label="Navigasi utama">{pages.map((entry,index)=><button key={entry} title={entry} aria-label={entry} className={entry===page?"active":""} onClick={()=>{setPage(entry);setError("");setNotice("");}}><span className="nav-icon" aria-hidden="true">{["MD","AT","UM"][index]}</span><span className="nav-label">{entry}</span></button>)}</nav>
      <div className="profile"><span className="avatar">{state.user.username.slice(0,2).toUpperCase()}</span><div><strong>{state.user.username}</strong><span>{state.user.role==="admin"?"Admin":"Petugas"}</span></div><button onClick={logout}>Keluar</button></div>
      <button className="mobile-logout" onClick={logout} aria-label="Keluar dari AutoSNAP">Keluar</button>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><div className="breadcrumb">AutoSNAP / {page}</div><h1>{page==="API Testing"?"API Testing":page}</h1></div></header>
      {error&&<div className="form-error" role="alert">{error}<button aria-label="Tutup pesan kesalahan" onClick={()=>setError("")}>×</button></div>}
      {notice&&<div className="form-notice" role="status">{notice}<button aria-label="Tutup pemberitahuan" onClick={()=>setNotice("")}>×</button></div>}
      {page==="Master Data"&&<MasterData {...common}/>}
      {page==="API Testing"&&<Testing {...common}/>}
      {page==="User Management"&&<UserManagement {...common}/>}
    </main>
  </div>;
}
