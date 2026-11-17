import {pdfSettings} from "./pdf-settings";
import { correlateActivity, type AspiActivity } from "./aspi-evidence";

export type PdfEvidence={path:string;activity?:AspiActivity;pdf?:Buffer;error?:string};
type BatchInput={
  before:string[]|undefined;
  paths:string[];
  deadline:number;
  signal?:AbortSignal;
  read:()=>Promise<AspiActivity[]>;
  download:(activity:AspiActivity)=>Promise<Buffer>;
  report:(status:"running"|"completed"|"failed",detail:string)=>Promise<void>;
};

function downloadError(error:unknown){
  const message=error instanceof Error?error.message:"";
  if(message.includes("ASPI_REPORT_TIMEOUT_headers"))return "Timeout menunggu HTTP headers laporan ASPI; belum ada response laporan.";
  const bodyStatus=/ASPI_REPORT_TIMEOUT_body_http_(\\d{3})/.exec(message)?.[1];
  if(bodyStatus)return `HTTP ${bodyStatus} diterima, tetapi pembacaan isi laporan ASPI timeout.`;
  return /HTTP \d{3}/.exec(message)?.[0]
    ??(/timeout|batas waktu|AbortError/i.test(message)?"Batas waktu download PDF terlewati"
    :/login|sesi/i.test(message)?"Sesi ASPI tidak dapat membuka laporan"
    :/PDF|laporan/i.test(message)?"ASPI belum memberikan PDF atau laporan pengujian yang valid"
    :"Koneksi download PDF ASPI gagal");
}

/** Read-only evidence phase. Never Execute an API again to obtain a missing PDF. */
export async function collectActivityPdfs(input:BatchInput):Promise<PdfEvidence[]>{
  const {paths,signal,deadline}=input;
  const active=()=>!signal?.aborted&&Date.now()<deadline;
  const stopped=()=>Date.now()>=deadline?"Batas waktu pengambilan PDF tercapai.":"Download PDF dibatalkan.";
  const failure=(path:string,error:string):PdfEvidence=>({path,error});
  if(!input.before)return paths.map(path=>failure(path,"Daftar aktivitas awal tidak tersedia; Activity ID tidak ditebak."));
  const before=new Set(input.before),rows=new Map<string,AspiActivity>();
  // One shared activity listing for the entire run, rather than a new page per API.
  // Retry the listing only while an unambiguous activity is still missing.
  let listingError="";
  for(let attempt=0;attempt<3&&active();attempt++){
    try{
      for(const row of await input.read())rows.set(row.activityId,row);
      listingError="";
    }catch(cause){
      const message=cause instanceof Error?cause.message:"";
      listingError=/timeout|batas waktu/i.test(message)?"Timeout membaca aktivitas ASPI."
        :/autentikasi|dialihkan|login|sesi/i.test(message)?"Akses daftar aktivitas ASPI memerlukan login ulang."
        :/tabel|tautan/i.test(message)?"Struktur tabel/tautan aktivitas ASPI tidak sesuai."
        :/HTTP \d{3}/i.test(message)?"Halaman aktivitas ASPI menolak request HTTP."
        :"Daftar aktivitas ASPI belum dapat dibaca.";
    }
    if(paths.every(path=>correlateActivity(before,[...rows.values()],path)))break;
    if(attempt<2&&active()){
      const pause=Math.min(1000*(attempt+1),Math.max(0,deadline-Date.now()));
      if(pause>0)await new Promise<void>(resolve=>setTimeout(resolve,pause));
    }
  }
  const results=new Array<PdfEvidence>(paths.length);
  let cursor=0;
  const worker=async()=>{
    while(cursor<paths.length){
      const index=cursor++,path=paths[index];
      // Two identical service calls cannot be distinguished safely using just a service name.
      const activity=paths.filter(item=>item===path).length===1?correlateActivity(before,[...rows.values()],path):null;
      if(!active())results[index]=failure(path,stopped());
      else if(!activity)results[index]=failure(path,listingError||`Activity ID unik untuk ${path} belum ditemukan; PDF tidak dikaitkan dengan aktivitas lain.`);
      else{
        await input.report("running",`${path}: mengunduh PDF; Activity ID ${activity.activityId}.`);
        let error="";
        for(let attempt=1;attempt<=2&&active();attempt++){
          try{results[index]={path,activity,pdf:await input.download(activity)};break;}
          catch(cause){error=downloadError(cause);await input.report("failed",`${path}: ${error} (percobaan ${attempt}/2).`);}
        }
        results[index]??={path,activity,error:!active()?stopped():error};
      }
      const result=results[index];
      await input.report(result.pdf?"completed":"failed",result.pdf?`${path}: PDF diterima; Activity ID ${activity!.activityId}.`:`${path}: ${result.error}`);
    }
  };
  // Bounded parallelism avoids four serial report downloads without opening excessive tabs.
  await Promise.all(Array.from({length:Math.min(pdfSettings().concurrency,paths.length)},worker));
  return results;
}
