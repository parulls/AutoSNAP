"use client";

import {useEffect,useRef,useState} from "react";
import UiIcon from "./ui-icon";

export type ProgressStep={stage:string;status:string;detail?:string;at?:string};
export type TestProgress={status:string;stage:string;steps:ProgressStep[]};
const labels:Record<string,string>={preparing:"Persiapan",signature_auth:"Signature Authentication",access_token:"Access Token B2B",signature_service:"Signature Service",balance_inquiry:"Balance Inquiry",http_response:"HTTP Response",evaluation:"Validasi",pdf_download:"Download PDF ASPI",pdf_store:"Simpan PDF",evidence:"Bukti PDF",cancelling:"Pembatalan",finished:"Selesai"};

export default function TestingProgress({progress,running,onCancel,onClose}:{progress:TestProgress;running:boolean;onCancel:()=>Promise<void>;onClose:()=>void}){
  const end=useRef<HTMLDivElement>(null),[cancelling,setCancelling]=useState(false),[cancelError,setCancelError]=useState("");
  useEffect(()=>{end.current?.scrollIntoView({block:"nearest"});},[progress.steps.length,cancelError]);
  async function cancel(){setCancelling(true);setCancelError("");try{await onCancel();}catch(error){setCancelError((error as Error).message);setCancelling(false);}}
  return <div className="modal-backdrop"><section className="card testing-terminal-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-title">
    <div className="section-header"><div><h2 id="terminal-title">Log Testing</h2><p>{running?cancelling||progress.status==="cancel_requested"?"Menghentikan proses…":"Proses berjalan":"Proses selesai"}</p></div>{!running&&<button type="button" className="close-button" onClick={onClose} aria-label="Tutup" title="Tutup"><UiIcon name="close"/></button>}</div>
    <div className="testing-terminal" role="log" aria-live="polite" aria-relevant="additions" tabIndex={0}>
      <div className="terminal-heading">AutoSNAP — execution log</div>
      {!progress.steps.length&&<div className="terminal-pending">Menunggu log backend…</div>}
      {progress.steps.map((step,index)=><div key={`${index}-${step.at??""}`} className={`terminal-line ${step.status}`}><time>{step.at?new Date(step.at).toLocaleTimeString("id-ID",{timeZone:"Asia/Jakarta",hour12:false}):"--:--:--"}</time><span className="terminal-level">[{step.status.toUpperCase()}]</span><span>{labels[step.stage]??step.stage}{step.detail?` — ${step.detail}`:""}</span></div>)}
      {cancelError&&<div className="terminal-line failed">[CANCEL ERROR] {cancelError}</div>}<div ref={end}/>
    </div>
    <div className="terminal-actions">{running?<><span>Request yang sudah terkirim tetap tercatat.</span><button type="button" className="danger-button" disabled={cancelling||progress.status==="cancel_requested"} onClick={()=>void cancel()}>{cancelling||progress.status==="cancel_requested"?"Menghentikan…":"Cancel Testing"}</button></>:<span>Log tersimpan pada detail History Testing.</span>}</div>
  </section></div>;
}
