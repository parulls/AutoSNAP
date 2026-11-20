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
  download:(activity:AspiActivity)=>Promise<Buffer>;
  report:(status:"running"|"completed"|"failed",detail:string)=>Promise<void>;
  onResult?:(result:PdfEvidence)=>Promise<void>;
};

function downloadError(error:unknown){
  const message=error instanceof Error?error.message:"";
  if(message.includes("ASPI_REPORT_TIMEOUT_headers"))return "DOWNLOAD_TIMEOUT: Timeout menunggu HTTP headers laporan ASPI.";
  const bodyStatus=/ASPI_REPORT_TIMEOUT_body_http_(\d{3})/.exec(message)?.[1];
  if(bodyStatus)return `DOWNLOAD_TIMEOUT: HTTP ${bodyStatus} diterima, tetapi isi laporan ASPI timeout.`;
  if(/HTTP (\d{3})/.test(message))return `DOWNLOAD_HTTP_ERROR: ${/HTTP \d{3}/.exec(message)?.[0]}`;
  if(/timeout|batas waktu|AbortError/i.test(message))return "DOWNLOAD_TIMEOUT: Batas waktu download PDF terlewati";
  if(/login|sesi/i.test(message))return "ASPI_AUTH_EXPIRED: Sesi ASPI tidak dapat membuka laporan";
  if(/HTML|bukan binary|%%EOF|%PDF-/i.test(message))return `INVALID_PDF_RESPONSE: ${message.slice(0,180)}`;
  if(/PDF|laporan/i.test(message))return `INVALID_PDF_RESPONSE: ${message.slice(0,180)}`;
  return `DOWNLOAD_HTTP_ERROR: ${message.slice(0,180)||"Koneksi download PDF ASPI gagal"}`;
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
        await input.report("running",`Activity search ${path}: listed=${match.listed} fresh=${match.fresh} candidates=${match.candidates.length} → ${match.result}`);
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
        await input.report("running",`${path}: mengunduh PDF; Activity ID ${activity.activityId}.`);
        let error="";
        for(let attempt=1;attempt<=2&&active();attempt++){
          try{results[index]={path,activity,pdf:await input.download(activity),attempts:attempt};break;}
          catch(cause){error=downloadError(cause);await input.report("failed",`${path}: ${error} (percobaan ${attempt}/2).`);}
        }
        results[index]??={path,activity,error:!active()?stopped():error,attempts:2};
      }
      const result=results[index];
      result.key=input.operations?.[index]?.key;
      await input.onResult?.(result);
      await input.report(result.pdf?"completed":"failed",result.pdf?`${path}: PDF diterima; Activity ID ${activity!.activityId}.`:`${path}: ${result.error}`);
    }
  };
  // Bounded parallelism avoids four serial report downloads without opening excessive tabs.
  await Promise.all(Array.from({length:Math.min(pdfSettings().concurrency,paths.length)},worker));
  return results;
}
