import {Injectable} from "@nestjs/common";
import {randomUUID} from "node:crypto";
import {DatabaseService,type RecordRow,type RunRow} from "./database.service";
import {PortalEngine,aspiActivityDownloadUrl} from "./portal-engine";
import {validateOfficialPdf,type AspiActivity} from "./aspi-evidence";
import type {PdfEvidence} from "./aspi-pdf-batch";
import {object} from "./endpoint-config";
import type {EvidencePlan} from "./evidence-plan";
import {finalOutcome,type Evaluation} from "./test-evaluation";
import type {AspiEvidenceSession} from "./run-engine";
import {pdfSettings} from "./pdf-settings";
import {sha256} from "./security";

type ProcessInput={runId:string;ownerId:string;user:RecordRow;initial?:boolean;session?:AspiEvidenceSession;signal?:AbortSignal;onProgress?:(stage:string,status:"running"|"completed"|"failed",detail?:string)=>Promise<void>};
/** Evidence-only reprocessing. This component deliberately has no API execution entry point. */
@Injectable()
export class RunEvidenceService{
  constructor(private readonly db:DatabaseService,private readonly portal:PortalEngine){}
  async process(input:ProcessInput){
    const run=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[input.runId,input.ownerId]);
    if(!run)throw {status:404,error:"History testing tidak ditemukan."};
    if(!input.initial&&!["PASSED","COMPLETED","FAILED","AUTOMATION_ERROR","VALIDATION_ERROR","CANCELLED"].includes(run.status))throw {status:409,error:"Pengujian masih berjalan. Tunggu proses selesai sebelum retry PDF."};
    const requestProbe=object(run.request_json)?run.request_json:{};
    const evaluationProbe=object(requestProbe.evaluation)?requestProbe.evaluation as Evaluation:null;
    if(evaluationProbe&&evaluationProbe.httpValidation&&!evaluationProbe.httpValidation.matches)throw {status:409,error:"HTTP tidak sesuai expected; retry PDF tidak mengubah status FAILED."};
    const request=object(run.request_json)?run.request_json:{};
    if(!object(request.evidence)||request.evidence.version!==1||!Array.isArray(request.evidence.operations))throw {status:409,error:"History ini belum menyimpan baseline dan rencana bukti yang aman. PDF yang sudah tersimpan tetap dapat diunduh; Activity ID tidak ditebak."};
    const plan=structuredClone(request.evidence) as EvidencePlan;
    if(plan.accountHash!==sha256(String(input.user.data.email??input.user.data.username??"").trim().toLowerCase()))throw {status:409,error:"Akun ASPI berbeda dari akun saat pengujian. Gunakan kembali User SNAP yang sama untuk retry PDF."};
    const owner=randomUUID(),lease=`evidence:${run.id}`,now=new Date().toISOString();
    const acquired=await this.db.one("INSERT INTO autosnap_automation_leases (key,owner,expires_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at WHERE autosnap_automation_leases.expires_at<$4 RETURNING owner",[lease,owner,new Date(Date.now()+330000).toISOString(),now]);
    if(!acquired)throw {status:409,error:"PDF untuk history ini sedang diproses. Tidak ada API yang dijalankan ulang."};
    const emit=async(stage:string,status:"running"|"completed"|"failed",detail="")=>{
      if(input.onProgress){await input.onProgress(stage,status,detail);return;}
      await this.db.transaction(async query=>{
        const row=(await query<{request_json:Record<string,unknown>}>("SELECT request_json FROM autosnap_runs WHERE id=$1 AND operator_id=$2 FOR UPDATE",[run.id,input.ownerId]))[0];
        const log=Array.isArray(row?.request_json.progressLog)?row.request_json.progressLog.slice(-499):[];
        log.push({stage,status,detail,at:new Date().toISOString()});
        await query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({progressLog:log}),run.id,input.ownerId]);
      });
    };
    const persist=async()=>{
      const activities=plan.operations.flatMap(op=>op.activity?[{...op.activity,pdfReady:op.pdfReady,path:op.path,key:op.key}]:[]);
      const errors=plan.operations.filter(op=>!op.pdfReady).map(op=>({path:op.path,key:op.key,activityId:op.activity?.activityId,error:op.error??"PDF belum tersedia."}));
      await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({evidence:plan,aspiActivities:activities,evidenceErrors:errors}),run.id,input.ownerId]);
    };
    try{
      const stored=await this.db.query<{activity_id:string;pdf_data:Buffer}>("SELECT activity_id,pdf_data FROM autosnap_evidence_pdfs WHERE run_id=$1",[run.id]);
      const validIds=new Set(stored.filter(row=>{try{validateOfficialPdf(Buffer.from(row.pdf_data));return true;}catch{return false;}}).map(row=>row.activity_id));
      for(const op of plan.operations)op.pdfReady=!!op.activity&&validIds.has(op.activity.activityId);
      plan.phase="COLLECTING";if(!input.initial)plan.retryCount++;
      await persist();
      const deadline=Date.now()+pdfSettings().budgetMs;
      for(let round=1;round<=2&&!input.signal?.aborted&&Date.now()<deadline;round++){
        const missing=plan.operations.filter(op=>!op.pdfReady);if(!missing.length)break;
        await emit("pdf_reprocessing","running",`${input.initial?"Pengumpulan":"Retry"} PDF ${round}/2; ${missing.length} bukti belum tersedia. Request API tidak diulang.`);
        const processed=new Set<string>();
        const accept=async(item:PdfEvidence)=>{
          const op=missing.find(candidate=>item.key?candidate.key===item.key:candidate.path===item.path);
          if(!op||processed.has(op.key))return;processed.add(op.key);op.attempts+=item.attempts??1;
          if(item.activity){
            try{op.activity={...item.activity,downloadUrl:aspiActivityDownloadUrl(item.activity.activityId)};}
            catch{op.error="Activity ID tidak valid; bukti tidak diganti dengan aktivitas lain.";await persist();return;}
          }
          op.error=item.error;
          if(item.pdf&&op.activity){
            try{
              const pdf=validateOfficialPdf(item.pdf);
              await this.db.query("INSERT INTO autosnap_evidence_pdfs(run_id,activity_id,service,pdf_data,byte_size,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,activity_id) DO UPDATE SET service=EXCLUDED.service,pdf_data=EXCLUDED.pdf_data,byte_size=EXCLUDED.byte_size,created_at=EXCLUDED.created_at",[run.id,op.activity.activityId,op.activity.service.slice(0,120),pdf,pdf.length,new Date().toISOString()]);
              op.pdfReady=true;delete op.error;await emit("pdf_store","completed",`${op.path}: PDF resmi tersimpan; Activity ID ${op.activity.activityId}.`);
            }catch{op.error="Gagal menyimpan PDF resmi ke database.";await emit("pdf_store","failed",`${op.path}: ${op.error}`);}
          }
          await persist();
        };
        const pinned:Record<string,AspiActivity>={};for(const op of missing)if(op.activity)pinned[op.key]={...op.activity,downloadUrl:aspiActivityDownloadUrl(op.activity.activityId)};
        let results:PdfEvidence[];
        try{results=await this.portal.collectEvidence({user:input.user,before:plan.beforeIds,paths:missing.map(op=>op.path),operations:missing,knownActivities:pinned,activityNames:Object.fromEntries(missing.map(op=>[op.path,[op.service]])),deadline:Date.now()+Math.max(1,Math.floor((deadline-Date.now())/(3-round))),session:input.session,signal:input.signal,onProgress:emit,onEvidence:accept});}
        catch{results=missing.map(op=>({key:op.key,path:op.path,error:"Pengambilan PDF ASPI gagal. Retry tidak menjalankan API."}));}
        for(const result of results)await accept(result);
      }
      for(const op of plan.operations)if(!op.pdfReady)op.error??=input.signal?.aborted?"Pengambilan bukti dibatalkan; bukti yang sudah tersimpan dipertahankan.":"PDF belum tersedia setelah reprocessing terbatas.";
      const complete=plan.operations.length>0&&plan.operations.every(op=>op.pdfReady);
      plan.phase=complete?"COMPLETE":"INCOMPLETE";await persist();
      const current=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[run.id,input.ownerId]);
      const evaluation=object(current?.request_json)&&object(current.request_json.evaluation)?current.request_json.evaluation as Evaluation:null;
      if(!evaluation?.outcome)throw {status:409,error:"Hasil evaluasi asli tidak tersedia; status tidak diubah hanya karena PDF tersedia."};
      const status=finalOutcome(evaluation,complete);
      const promoted={...evaluation,outcome:status,detail:complete?evaluation.detail.replace(/Pengumpulan bukti PDF belum selesai\.?/,"Bukti PDF lengkap."):evaluation.detail,suggestion:complete?"":evaluation.suggestion};
      const count=plan.operations.filter(op=>op.pdfReady).length;
      const notes=`${promoted.detail} Bukti PDF resmi ASPI ${count}/${plan.operations.length} tersimpan. Outcome: ${status}.`;
      await this.db.query("UPDATE autosnap_runs SET status=$1,notes=$2,request_json=request_json || $3::jsonb WHERE id=$4 AND operator_id=$5",[status,notes,JSON.stringify({outcome:status,evaluation:promoted,evidence:plan}),run.id,input.ownerId]);
      await emit("evidence",complete?"completed":"failed",`${count}/${plan.operations.length} PDF resmi ASPI tersimpan. Outcome akhir: ${status}.`);
      return {status,notes,complete,stored:count,required:plan.operations.length,evidence:plan};
    }finally{await this.db.query("DELETE FROM autosnap_automation_leases WHERE key=$1 AND owner=$2",[lease,owner]);}
  }
}
