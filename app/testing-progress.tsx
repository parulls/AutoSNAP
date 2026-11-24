"use client";

import {useEffect,useRef,useState} from "react";
import UiIcon from "./ui-icon";

export type ProgressStep={stage:string;status:string;detail?:string;at?:string};
export type TestProgress={status:string;stage:string;steps:ProgressStep[]};
const labels:Record<string,string>={preparing:"Persiapan",signature_auth:"Signature Authentication",access_token:"Access Token",customer_token:"Customer Token B2B2C",signature_service:"Signature Service",api_request:"Request API",registration:"Registrasi",evaluation:"Validasi",finalizing:"Finalisasi",pdf_download:"Download PDF ASPI",pdf_store:"Simpan PDF",pdf_reprocessing:"Proses Ulang Bukti",evidence:"Bukti PDF ASPI",cancelling:"Pembatalan",finished:"Selesai"};

type Props={
  progress:TestProgress;
  running:boolean;
  formReady:boolean;
  accountBusy?:boolean;
  onCancel:()=>Promise<void>;
  onClose:()=>void;
  onRetryEvidence?:()=>Promise<void>|void;
  product?:string;
};

export default function TestingProgress({progress,running,formReady,accountBusy=false,onCancel,onClose,onRetryEvidence,product="Dev Site"}:Props){
  const end=useRef<HTMLDivElement>(null),[cancelling,setCancelling]=useState(false),[cancelError,setCancelError]=useState("");
  const ownActive=running||progress.status==="cancel_requested"||cancelling;
  // Tutup hanya setelah proses milik kita selesai. Jika form masih terkunci oleh proses ASPI lain, izinkan Tutup
  // tetapi jangan klaim "form siap" — tampilkan penyebab sebenarnya.
  const canClose=!ownActive;
  const statusText=ownActive
    ?(cancelling||progress.status==="cancel_requested"?"Menghentikan proses…":progress.stage==="finalizing"?"Menyelesaikan dan melepaskan sesi ASPI…":"Proses berjalan")
    :progress.status==="unknown"
      ?"Status belum dapat dipastikan"
      :formReady
        ?"Proses selesai — form siap digunakan."
        :accountBusy
          ?"Pengujian selesai, tetapi form masih terkunci karena akun ASPI dipakai proses lain."
          :`Menunggu form ${product} siap digunakan kembali…`;
  useEffect(()=>{end.current?.scrollIntoView({block:"nearest"});},[progress.steps.length,cancelError,statusText]);
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if(event.key!=="Escape")return;
      if(!canClose){event.preventDefault();event.stopPropagation();return;}
      onClose();
    };
    window.addEventListener("keydown",onKey,true);
    return ()=>window.removeEventListener("keydown",onKey,true);
  },[canClose,onClose]);
  async function cancel(){setCancelling(true);setCancelError("");try{await onCancel();}catch(error){setCancelError((error as Error).message);setCancelling(false);}}
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!canClose){event.preventDefault();event.stopPropagation();}}} onClick={event=>{if(event.target===event.currentTarget){if(!canClose){event.preventDefault();return;}onClose();}}}>
    <section className="card testing-terminal-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-title" onClick={event=>event.stopPropagation()}>
      <div className="section-header">
        <div><h2 id="terminal-title">Log Testing</h2><p>{statusText}</p></div>
        {canClose&&<button type="button" className="close-button" onClick={onClose} aria-label="Tutup jendela log" title={formReady?"Tutup":"Tutup log (form masih terkunci)"}><UiIcon name="close"/></button>}
      </div>
      <div className="testing-terminal" role="log" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        <div className="terminal-heading">AutoSNAP — execution log</div>
        {!progress.steps.length&&<div className="terminal-pending">Menunggu log backend…</div>}
        {progress.steps.map((step,index)=><div key={`${index}-${step.at??""}`} className={`terminal-line ${step.status}`}><time>{step.at?new Date(step.at).toLocaleTimeString("id-ID",{timeZone:"Asia/Jakarta",hour12:false}):"--:--:--"}</time><span className="terminal-level">[{step.status.toUpperCase()}]</span><span>{labels[step.stage]??step.stage}{step.detail?` — ${step.detail}`:""}</span></div>)}
        {cancelError&&<div className="terminal-line failed">[CANCEL ERROR] {cancelError}</div>}
        {!ownActive&&accountBusy&&<div className="terminal-line failed">[LOCKED] Form {product} masih terkunci: akun ASPI yang sama sedang dipakai proses lain.</div>}
        <div ref={end}/>
      </div>
      <div className="terminal-actions">
        {ownActive
          ?<><span>Request yang sudah terkirim tetap tercatat.</span><button type="button" className="danger-button" disabled={cancelling||progress.status==="cancel_requested"} onClick={()=>void cancel()}>{cancelling||progress.status==="cancel_requested"?"Menghentikan…":"Cancel Testing"}</button></>
          :<>{onRetryEvidence&&formReady&&<button type="button" className="secondary-button" onClick={()=>void onRetryEvidence()}>Proses Ulang Bukti</button>}{canClose?<button type="button" className="secondary-button" onClick={onClose}>{formReady?"Tutup":"Tutup Log"}</button>:<span>{`Menunggu form ${product} siap digunakan kembali…`}</span>}<span>{formReady?"Log tersimpan pada detail History Testing.":accountBusy?"Form belum siap: akun ASPI dipakai proses lain.":"Menunggu pelepasan sesi ASPI…"}</span></>}
      </div>
    </section>
  </div>;
}
