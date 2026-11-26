"use client";
import {useEffect,useRef,useState} from "react";
import UiIcon from "./ui-icon";

/** Preview only for official ASPI evidence PDFs (requires activityId). */
export default function PdfPreview({runId,activityId,fileName,onClose}:{runId:string;activityId:string;fileName:string;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),[url,setUrl]=useState(""),[error,setError]=useState("");
  useEffect(()=>{const node=dialog.current;node?.showModal();return()=>node?.close();},[]);
  useEffect(()=>{
    const controller=new AbortController();let objectUrl="",active=true;
    void (async()=>{try{
      const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"downloadAspiActivityPdf",id:runId,activityId}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
      if(!response.ok){const data=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw Error(String(data.error));}
      const blob=await response.blob();if(!active)return;
      objectUrl=URL.createObjectURL(new Blob([blob],{type:"application/pdf"}));setUrl(objectUrl);
    }catch(cause){if(active)setError(cause instanceof Error?cause.message:"PDF gagal dimuat.");}})();
    return()=>{active=false;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[runId,activityId]);
  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="pdf-preview-title" className="m-auto h-[85vh] w-[95vw] max-w-5xl overflow-hidden rounded-lg border border-slate-200 p-0 backdrop:bg-slate-900/50">
    <div className="modal-header"><div><h2 id="pdf-preview-title">Preview PDF</h2><p>{fileName}</p></div>
      <div className="inline-actions">{url&&<a className="text-button" href={url} download={fileName}>Download PDF</a>}
        <button type="button" className="close-button" aria-label="Tutup" title="Tutup" onClick={onClose}><UiIcon name="close"/></button>
      </div>
    </div>
    {error?<p role="alert" className="p-4 text-red-700">{error}</p>:url?<iframe title="PDF resmi ASPI" src={url} className="h-[calc(100%-60px)] w-full border-0"/>:<p role="status" className="p-4">Memuat PDF…</p>}
  </dialog>;
}
