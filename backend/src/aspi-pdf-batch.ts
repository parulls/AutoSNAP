import {pdfSettings} from "./pdf-settings";
import { correlateActivity, describeActivityMatch, type AspiActivity } from "./aspi-evidence";
import type {EvidenceOperation} from "./evidence-plan";

export type PdfEvidence={path:string;key?:string;activity?:AspiActivity;pdf?:Buffer;error?:string;attempts?:number};
type BatchInput={
  activityNames?:Record<string,string[]>;
  before:string[]|undefined;
  paths:string[];
  operations?:EvidenceOperation[];
  knownActivities?:Record<string,AspiActivity>;
  deadline:number;
  signal?:AbortSignal;
  read:()=>Promise<AspiActivity[]>;
  download:(activity:AspiActivity,itemDeadline:number)=>Promise<Buffer>;
  report:(status:"running"|"completed"|"failed",detail:string)=>Promise<void>;
  onResult?:(result:PdfEvidence)=>Promise<void>;
};

function downloadError(error:unknown){
  const message=error instanceof Error?error.message:"";
  if(/^ACTIVITY_NOT_FOUND\b/.test(message))return message.slice(0,220);
  if(/^DOWNLOAD_LINK_NOT_FOUND\b/.test(message))return message.slice(0,220);
  if(/^POPUP_NOT_DETECTED\b/.test(message))return message.slice(0,220);
  if(/^DOWNLOAD_EVENT_TIMEOUT\b/.test(message))return message.slice(0,220);
  if(/^ASPI_AUTH_EXPIRED\b/.test(message))return message.slice(0,220);
  if(/^INVALID_PDF_RESPONSE\b/.test(message))return message.slice(0,220);
  if(/^PDF_STORAGE_ERROR\b/.test(message))return message.slice(0,220);
  if(message.includes("ASPI_REPORT_TIMEOUT_headers"))return "DOWNLOAD_EVENT_TIMEOUT: Timeout menunggu HTTP headers laporan ASPI.";
  const bodyStatus=/ASPI_REPORT_TIMEOUT_body_http_(\d{3})/.exec(message)?.[1];
  if(bodyStatus)return `DOWNLOAD_EVENT_TIMEOUT: HTTP ${bodyStatus} diterima, tetapi isi laporan ASPI timeout.`;
  if(/HTTP (\d{3})/.test(message))return `INVALID_PDF_RESPONSE: ${/HTTP \d{3}/.exec(message)?.[0]}`;
  if(/timeout|batas waktu|AbortError/i.test(message))return "DOWNLOAD_EVENT_TIMEOUT: Batas waktu download PDF terlewati";
  if(/login|sesi/i.test(message))return "ASPI_AUTH_EXPIRED: Sesi ASPI tidak dapat membuka laporan";
  if(/tidak ditemukan|Tombol Download/i.test(message))return `DOWNLOAD_LINK_NOT_FOUND: ${message.slice(0,180)}`;
  if(/HTML|bukan binary|%%EOF|%PDF-/i.test(message))return `INVALID_PDF_RESPONSE: ${message.slice(0,180)}`;
  if(/PDF|laporan/i.test(message))return `INVALID_PDF_RESPONSE: ${message.slice(0,180)}`;
  return `DOWNLOAD_EVENT_TIMEOUT: ${message.slice(0,180)||"Koneksi download PDF ASPI gagal"}`;
}

function shouldRetryDownload(error:string){
  // Retry only when an alternate strategy or transient wait may help.
  // ASPI_AUTH_EXPIRED is renewed by the caller (portal evidence path) — not re-Executed here.
  return /DOWNLOAD_EVENT_TIMEOUT|DOWNLOAD_LINK_NOT_FOUND|POPUP_NOT_DETECTED|batas waktu|Timeout/i.test(error)
    && !/ASPI_AUTH_EXPIRED|INVALID_PDF_RESPONSE|ACTIVITY_NOT_FOUND|ACTIVITY_AMBIGUOUS|PDF_STORAGE_ERROR/i.test(error);
}

/** Read-only evidence phase. Never Execute an API again to obtain a missing PDF. */
export async function collectActivityPdfs(input:BatchInput):Promise<PdfEvidence[]>{
  const {paths,signal,deadline}=input;
  const active=()=>!signal?.aborted&&Date.now()<deadline;
  const stopped=()=>Date.now()>=deadline?"Batas waktu pengambilan PDF tercapai.":"Download PDF dibatalkan.";
  const failure=(path:string,error:string):PdfEvidence=>({path,error});
  const pinned=(index:number)=>input.knownActivities?.[input.operations?.[index]?.key??paths[index]];
  if(!input.before&&!paths.every((_,index)=>!!pinned(index)))return paths.map(path=>failure(path,"Daftar aktivitas awal tidak tersedia; Activity ID tidak ditebak."));
  const before=new Set(input.before??[]),rows=new Map<string,AspiActivity>();
  const candidate=(index:number)=>pinned(index)??correlateActivity(before,[...rows.values()],paths[index],input.activityNames?.[paths[index]],input.operations?.[index]);
  // One shared activity listing for the entire run, rather than a new page per API.
  // Retry the listing only while an unambiguous activity is still missing.
  let listingError="";
  // ASPI may persist activity rows a few seconds after Execute; poll before giving up.
  for(let attempt=0;attempt<5&&active()&&!paths.every((_,index)=>!!pinned(index));attempt++){
    try{
      for(const row of await input.read())rows.set(row.activityId,row);
      listingError="";
      for(const path of paths){
        const match=describeActivityMatch(before,[...rows.values()],path,input.activityNames?.[path]);
        const label=input.activityNames?.[path]?.[0]||path;
        if(match.result==="matched")await input.report("running",`${label}: Activity ID ditemukan`);
        else if(match.result==="ACTIVITY_AMBIGUOUS")await input.report("running",`${label}: beberapa kandidat Activity ID`);
        else await input.report("running",`${label}: mencari Activity ID…`);
      }
    }catch(cause){
      const message=cause instanceof Error?cause.message:"";
      listingError=/timeout|batas waktu/i.test(message)?"DOWNLOAD_TIMEOUT: Timeout membaca aktivitas ASPI."
        :/autentikasi|dialihkan|login|sesi/i.test(message)?"ASPI_AUTH_EXPIRED: Akses daftar aktivitas ASPI memerlukan login ulang."
        :/tabel|tautan/i.test(message)?"ACTIVITY_NOT_FOUND: Struktur tabel/tautan aktivitas ASPI tidak sesuai."
        :/HTTP \d{3}/i.test(message)?"DOWNLOAD_HTTP_ERROR: Halaman aktivitas ASPI menolak request HTTP."
        :"ACTIVITY_NOT_FOUND: Daftar aktivitas ASPI belum dapat dibaca.";
    }
    if(paths.every((_,index)=>candidate(index)))break;
    // Keep budget for actual downloads; stop polling when little time remains.
    const remainingMs=deadline-Date.now();
    if(attempt<4&&active()&&remainingMs>2500){
      const pause=Math.min(1200*(attempt+1),remainingMs-2000);
      if(pause>0)await new Promise<void>(resolve=>setTimeout(resolve,pause));
    }else break;
  }
  const results=new Array<PdfEvidence>(paths.length);
  let cursor=0;
  const worker=async()=>{
    while(cursor<paths.length){
      const index=cursor++,path=paths[index];
      // Two identical service calls cannot be distinguished safely using just a service name.
      const selected=candidate(index),sameId=selected?paths.filter((_,i)=>candidate(i)?.activityId===selected.activityId).length:0;
      const match=describeActivityMatch(before,[...rows.values()],path,input.activityNames?.[path]);
      const activity=sameId===1?selected:null;
      if(!active())results[index]=failure(path,stopped());
      else if(!activity){
        const code=match.result==="ACTIVITY_AMBIGUOUS"?"ACTIVITY_AMBIGUOUS":"ACTIVITY_NOT_FOUND";
        const detail=match.candidates.length
          ?`${code}: ${match.candidates.length} kandidat untuk ${path} (${match.candidates.map(item=>`${item.service}/${item.activityId}`).join("; ")}). PDF tidak dikaitkan secara sembarang.`
          :listingError||`${code}: Activity ID unik untuk ${path} belum ditemukan (aliases: ${match.aliases.join(", ")||"—"}; fresh rows: ${match.fresh}).`;
        results[index]=failure(path,detail);
      }
      else{
        const label=String(activity.service||input.activityNames?.[path]?.[0]||path).trim()||path;
        await input.report("running",`${label}: mengunduh PDF · Activity ID ${activity.activityId}`);
        let error="";
        let attempts=0;
        // Fair share of remaining budget so one slow PDF cannot starve the rest.
        const pending=paths.length-index;
        const fairShare=Math.max(8000,Math.floor((deadline-Date.now())/Math.max(1,pending)));
        const perAttempt=Math.min(pdfSettings().requestTimeoutMs,fairShare);
        for(let attempt=1;attempt<=2&&active();attempt++){
          const slice=Math.min(perAttempt,Math.max(5000,deadline-Date.now()-1000));
          if(slice<5000){error=stopped();break;}
          attempts=attempt;
          const itemDeadline=Date.now()+slice;
          try{
            results[index]={path,activity,pdf:await input.download(activity,itemDeadline),attempts};
            break;
          }catch(cause){
            error=downloadError(cause);
            await input.report("failed",`${label}: ${error} (percobaan ${attempt}/2)`);
            if(attempt===1&&!shouldRetryDownload(error))break;
            if(attempt===1&&active())await new Promise<void>(resolve=>setTimeout(resolve,400));
          }
        }
        results[index]??={path,activity,error:!active()?stopped():error,attempts};
      }
      const result=results[index];
      result.key=input.operations?.[index]?.key;
      await input.onResult?.(result);
      const doneLabel=String(result.activity?.service||input.activityNames?.[path]?.[0]||path).trim()||path;
      await input.report(result.pdf?"completed":"failed",result.pdf?`${doneLabel}: PDF diterima · Activity ID ${result.activity!.activityId}`:`${doneLabel}: ${result.error}`);
    }
  };
  // Bounded parallelism avoids four serial report downloads without opening excessive tabs.
  await Promise.all(Array.from({length:Math.min(pdfSettings().concurrency,paths.length)},worker));
  return results;
}
