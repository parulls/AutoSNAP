"use client";

import { useState } from "react";
import type { State } from "./model";
import UiIcon from "./ui-icon";

type Target="Dev Site Client"|"Client Simulator"|"Master Data"|"User Management";
export default function Dashboard({state,navigate}:{state:State;navigate:(target:Target)=>void}){
  const [cutoff]=useState(()=>Date.now()-7*24*60*60*1000),recent=state.runs.filter(run=>Date.parse(run.created_at)>=cutoff).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  const devRuns=recent.filter(run=>run.mode!=="mock"),simulatorRuns=recent.filter(run=>run.mode==="mock");
  const passed=recent.filter(run=>run.status.toLowerCase()==="passed").length,failed=recent.filter(run=>run.status.toLowerCase()==="failed").length,errors=recent.length-passed-failed;
  const can=(privilege:string)=>state.user?.role==="admin"||(state.user?.privileges??[]).includes(privilege);
  const contextOf=(run:(typeof recent)[number])=>run.request&&typeof run.request==="object"&&!Array.isArray(run.request)&&"context" in run.request&&run.request.context&&typeof run.request.context==="object"&&!Array.isArray(run.request.context)?run.request.context as Record<string,unknown>:{};
  const cards=[
    {label:"Dev Site diuji",value:devRuns.length,target:"Dev Site Client" as const},
    {label:"Simulator diuji",value:simulatorRuns.length,target:"Client Simulator" as const},
    {label:"Passed",value:passed,target:"Dev Site Client" as const,status:"passed"},
    {label:"Failed",value:failed,target:"Dev Site Client" as const,status:"failed"},
    {label:"Error",value:errors,target:"Dev Site Client" as const,status:"warning"},
  ];
  return <div className="dashboard-page">
    <section className="dashboard-grid">{cards.map(card=><button key={card.label} className="card metric-card" onClick={()=>navigate(card.target)}><span>{card.label}</span><strong>{card.value}</strong>{card.status&&<span className={`status-badge ${card.status}`}>{card.status}</span>}</button>)}</section>
    <section className="card dashboard-actions"><div className="section-header"><div><h2>Akses cepat</h2><p>Buka fungsi utama AutoSNAP.</p></div></div><div className="quick-actions">
      {can("dev_site")&&<button onClick={()=>navigate("Dev Site Client")}><UiIcon name="testing"/><span><strong>Dev Site Client</strong><small>Jalankan pengujian portal ASPI</small></span></button>}
      {can("master_data")&&<button onClick={()=>navigate("Master Data")}><UiIcon name="data"/><span><strong>Master Data</strong><small>Kelola konfigurasi pengujian</small></span></button>}
      {can("user_management")&&<button onClick={()=>navigate("User Management")}><UiIcon name="users"/><span><strong>User Management</strong><small>Kelola akun dan privilege</small></span></button>}
    </div></section>
    <section className="card dashboard-history"><div className="section-header"><div><h2>History 7 hari terakhir</h2><p>{recent.length} pengujian milik akun Anda.</p></div></div><div className="table-wrap"><table><thead><tr><th>WAKTU</th><th>SERVICE</th><th>DEV SITE CLIENT</th><th>SKENARIO</th><th>STATUS</th><th>DURASI</th></tr></thead><tbody>{recent.slice(0,15).map(run=>{const context=contextOf(run);return <tr key={run.id}><td>{new Date(run.created_at).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}</td><td>{String(context.service??"—")}</td><td>{String(context.environment??"—")}</td><td>{context.testType==="invalid_access_token"?"Negatif":"Positif"}</td><td><span className={`status-badge ${run.status.toLowerCase()}`}>{run.status}</span></td><td>{run.duration_ms??0} ms</td></tr>;})}</tbody></table>{!recent.length&&<p className="empty-note">Belum ada pengujian dalam tujuh hari terakhir.</p>}</div></section>
  </div>;
}
