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
import {aspiAccountLease,pdfAccountLease} from "./aspi-session-manager";
import {AspiAutomationError} from "./aspi-types";
import {canRetryEvidence,markStage,type RunCheckpoint} from "./run-checkpoint";

type ProcessInput={runId:string;ownerId:string;user:RecordRow;initial?:boolean;session?:AspiEvidenceSession;signal?:AbortSignal;onProgress?:(stage:string,status:"running"|"completed"|"failed",detail?:string)=>Promise<void>};
type MissingPdf={path:string;key:string;activityId?:string;error:string};
type AuditEntry={at:string;attempt:number;stage:"pdf_reprocessing";priorStatus:string;priorOutcome:string|null;priorDetail:string;priorErrors:MissingPdf[];result:"COMPLETED"|"INCOMPLETE"|"PROCESSING"|"FAILED";statusBefore:string;statusAfter:string;stored:number;required:number;missing:MissingPdf[];note:string};
export type EvidenceProcessResult={status:string;notes:string;complete:boolean;stored:number;required:number;processing?:boolean;missing:MissingPdf[];evidence?:EvidencePlan;reprocessAudit?:AuditEntry[];pdfCounts?:{ready:number;required:number};reprocess?:{retryEvidence:boolean;resumeTesting:boolean;requireMutatingConfirm:boolean}};

function describePdfFailure(cause:unknown){
  if(cause instanceof AspiAutomationError)return cause.message;
  const message=cause instanceof Error?cause.message:"";
  if(/batas waktu|timeout/i.test(message))return "Timeout saat mengambil PDF ASPI.";
  if(/Activity ID tidak|aktivitas ASPI|halaman aktivitas/i.test(message))return message.slice(0,240);
  if(/database|23505|ECONNREFUSED|connection/i.test(message))return "Gagal menyimpan PDF resmi ke database.";
  return "Pengambilan PDF ASPI gagal. Retry tidak menjalankan API.";
}
const LEASE_TTL_MS=330_000;
const STALE_HEARTBEAT_MS=180_000;

/** Evidence-only reprocessing. This component deliberately has no API execution entry point. */
@Injectable()
export class RunEvidenceService{
  constructor(private readonly db:DatabaseService,private readonly portal:PortalEngine){}
  async process(input:ProcessInput):Promise<EvidenceProcessResult>{
    const run=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[input.runId,input.ownerId]);
    if(!run)throw {status:404,error:"History testing tidak ditemukan."};
    if(!input.initial&&!["PASSED","COMPLETED","FAILED","AUTOMATION_ERROR","VALIDATION_ERROR","CANCELLED"].includes(run.status))throw {status:409,error:"Pengujian masih berjalan. Tunggu proses selesai sebelum retry PDF."};
    const request=object(run.request_json)?run.request_json:{};
    if(!object(request.evidence)||request.evidence.version!==1||!Array.isArray(request.evidence.operations))throw {status:409,error:"History ini belum menyimpan baseline dan rencana bukti yang aman. PDF yang sudah tersimpan tetap dapat diunduh; Activity ID tidak ditebak."};
    const plan=structuredClone(request.evidence) as EvidencePlan;
    if(plan.accountHash!==sha256(String(input.user.data.email??input.user.data.username??"").trim().toLowerCase()))throw {status:409,error:"Akun ASPI berbeda dari akun saat pengujian. Gunakan kembali User SNAP yang sama untuk retry PDF."};
    const evaluation=object(request.evaluation)?request.evaluation as Evaluation:null;
    const owner=randomUUID(),lease=`evidence:${run.id}`,started=new Date();
    const acquired=await this.acquire(lease,owner,started);
    if(!acquired){
      const ready=await this.readyIds(run.id);
      this.applyStored(plan,ready);
      const stored=plan.operations.filter(op=>op.pdfReady).length;
      const complete=plan.operations.length>0&&plan.operations.every(op=>op.pdfReady);
      if(complete){
        if(!evaluation)throw {status:409,error:"Hasil evaluasi asli tidak tersedia; status tidak diubah hanya karena PDF tersedia."};
        return this.commitOutcome({run,request,plan,evaluation,input,complete:true,processing:false,priorErrors:[]});
      }
      const note="PDF untuk history ini sedang diproses. Tidak ada API yang dijalankan ulang.";
      const entry=this.auditEntry({run,plan,evaluation,attempt:plan.retryCount,result:"PROCESSING",statusAfter:run.status,stored,missing:[],note,priorErrors:this.missingOf(plan)});
      await this.appendAudit(run.id,input.ownerId,entry,{stage:"pdf_reprocessing",status:"running",detail:note,at:entry.at});
      return {status:"PROCESSING",processing:true,notes:note,complete:false,stored,required:plan.operations.length,missing:this.missingOf(plan),reprocessAudit:[entry]};
    }
    let pdfKey="",pdfOwner="";
    const beat=async()=>{
      const now=new Date().toISOString(),expires=new Date(Date.now()+LEASE_TTL_MS).toISOString();
      await this.db.query("UPDATE autosnap_automation_leases SET heartbeat_at=$1,expires_at=$2 WHERE key=$3 AND owner=$4",[now,expires,lease,owner]);
      if(pdfKey&&pdfOwner)await this.db.query("UPDATE autosnap_automation_leases SET heartbeat_at=$1,expires_at=$2 WHERE key=$3 AND owner=$4",[now,expires,pdfKey,pdfOwner]);
    };
    const emit=async(stage:string,status:"running"|"completed"|"failed",detail="")=>{
      await beat().catch(()=>undefined);
      if(input.onProgress){await input.onProgress(stage,status,detail);return;}
      await this.db.transaction(async query=>{
        const row=(await query<{request_json:Record<string,unknown>}>("SELECT request_json FROM autosnap_runs WHERE id=$1 AND operator_id=$2 FOR UPDATE",[run.id,input.ownerId]))[0];
        const log=Array.isArray(row?.request_json.progressLog)?row.request_json.progressLog.slice(-499):[];
        log.push({stage,status,detail,at:new Date().toISOString()});
        await query("UPDATE autosnap_runs SET request_json=jsonb_set(request_json,'{progressLog}',$1::jsonb,true) WHERE id=$2 AND operator_id=$3",[JSON.stringify(log),run.id,input.ownerId]);
      });
    };
    const persist=async()=>{
      const activities=plan.operations.flatMap(op=>op.activity?[{...op.activity,pdfReady:op.pdfReady,path:op.path,key:op.key}]:[]);
      const errors=this.missingOf(plan);
      await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({evidence:plan,aspiActivities:activities,evidenceErrors:errors}),run.id,input.ownerId]);
    };
    try{
      await beat();
      const ready=await this.readyIds(run.id);
      this.applyStored(plan,ready);
      const priorErrors=this.missingOf(plan);
      const completeAlready=plan.operations.length>0&&plan.operations.every(op=>op.pdfReady);
      if(completeAlready){plan.phase="COMPLETE";await persist();if(!evaluation)throw {status:409,error:"Hasil evaluasi asli tidak tersedia; status tidak diubah hanya karena PDF tersedia."};return await this.commitOutcome({run,request,plan,evaluation,input,complete:true,processing:false,priorErrors});}
      pdfKey=pdfAccountLease(input.user);pdfOwner=randomUUID();
      const pdfHeld=await this.acquire(pdfKey,pdfOwner,new Date());
      if(!pdfHeld){
        const stored=plan.operations.filter(op=>op.pdfReady).length;
        const note="Sesi ASPI ini sedang dipakai untuk pengujian atau pengambilan bukti. Tidak ada API yang dijalankan ulang.";
        const entry=this.auditEntry({run,plan,evaluation,attempt:plan.retryCount,result:"PROCESSING",statusAfter:run.status,stored,missing:this.missingOf(plan),note,priorErrors});
        await this.appendAudit(run.id,input.ownerId,entry,{stage:"pdf_reprocessing",status:"running",detail:note,at:entry.at});
        return {status:"PROCESSING",processing:true,notes:note,complete:false,stored,required:plan.operations.length,missing:this.missingOf(plan),reprocessAudit:[entry]};
      }
      plan.phase="COLLECTING";if(!input.initial)plan.retryCount++;
      await persist();
      const deadline=Date.now()+pdfSettings().budgetMs;
      {
        const missing=plan.operations.filter(op=>!op.pdfReady);
        await emit("pdf_reprocessing","running",`${input.initial?"Pengumpulan":"Retry"} PDF; ${missing.length} bukti belum tersedia. Request API tidak diulang.`);
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
            const previousReady=op.pdfReady;
            try{
              const pdf=validateOfficialPdf(item.pdf);
              op.pdfReady=true;delete op.error;
              const activities=plan.operations.flatMap(entry=>entry.activity?[{...entry.activity,pdfReady:entry.pdfReady,path:entry.path,key:entry.key}]:[]);
              await this.db.transaction(async query=>{
                await query("INSERT INTO autosnap_evidence_pdfs(run_id,activity_id,service,pdf_data,byte_size,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id,activity_id) DO UPDATE SET service=EXCLUDED.service,pdf_data=EXCLUDED.pdf_data,byte_size=EXCLUDED.byte_size,created_at=EXCLUDED.created_at",[run.id,op.activity!.activityId,op.activity!.service.slice(0,120),pdf,pdf.length,new Date().toISOString()]);
                await query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({evidence:plan,aspiActivities:activities,evidenceErrors:this.missingOf(plan)}),run.id,input.ownerId]);
              });
              await emit("pdf_store","completed",`${op.path}: PDF resmi tersimpan; Activity ID ${op.activity.activityId}.`);
            }catch{op.pdfReady=previousReady;op.error="Gagal menyimpan PDF resmi ke database.";await persist();await emit("pdf_store","failed",`${op.path}: ${op.error}`);}
          }
          await persist();
        };
        const pinned:Record<string,AspiActivity>={};for(const op of missing)if(op.activity)pinned[op.key]={...op.activity,downloadUrl:aspiActivityDownloadUrl(op.activity.activityId)};
        let results:PdfEvidence[];
        try{results=await this.portal.collectEvidence({user:input.user,before:plan.beforeIds,paths:missing.map(op=>op.path),operations:missing,knownActivities:pinned,activityNames:Object.fromEntries(missing.map(op=>[op.path,[op.service]])),deadline:Date.now()+Math.max(1,deadline-Date.now()),session:input.session,signal:input.signal,onProgress:emit,onEvidence:accept});}
        catch(cause){results=missing.map(op=>({key:op.key,path:op.path,error:describePdfFailure(cause)}));}
        for(const result of results)await accept(result);
      }
      for(const op of plan.operations)if(!op.pdfReady)op.error??=input.signal?.aborted?"Pengambilan bukti dibatalkan; bukti yang sudah tersimpan dipertahankan.":"PDF belum tersedia setelah reprocessing terbatas.";
      const complete=plan.operations.length>0&&plan.operations.every(op=>op.pdfReady);
      plan.phase=complete?"COMPLETE":"INCOMPLETE";await persist();
      if(!evaluation)throw {status:409,error:"Hasil evaluasi asli tidak tersedia; status tidak diubah hanya karena PDF tersedia."};
      return await this.commitOutcome({run,request,plan,evaluation,input,complete,processing:false,priorErrors});
    }finally{
      await this.db.query("DELETE FROM autosnap_automation_leases WHERE key=$1 AND owner=$2",[lease,owner]);
      if(pdfKey&&pdfOwner)await this.db.query("DELETE FROM autosnap_automation_leases WHERE key=$1 AND owner=$2",[pdfKey,pdfOwner]);
    }
  }
  async accountBusy(user:Pick<RecordRow,"data">){
    const key=aspiAccountLease(user,"apidevportal.aspi-indonesia.or.id");
    const now=new Date().toISOString(),stale=new Date(Date.now()-STALE_HEARTBEAT_MS).toISOString();
    const row=await this.db.one("SELECT key FROM autosnap_automation_leases WHERE key=ANY($1::text[]) AND expires_at>$2 AND COALESCE(heartbeat_at,expires_at)>$3",[[key,pdfAccountLease(user)],now,stale]);
    return !!row;
  }
  async busyUserIds(records:RecordRow[]){
    const now=new Date().toISOString(),stale=new Date(Date.now()-STALE_HEARTBEAT_MS).toISOString();
    const active=new Set((await this.db.query<{key:string}>("SELECT key FROM autosnap_automation_leases WHERE expires_at>$1 AND COALESCE(heartbeat_at,expires_at)>$2",[now,stale])).map(row=>row.key));
    return records.filter(row=>row.kind==="snap_user").filter(row=>{const key=aspiAccountLease(row,"apidevportal.aspi-indonesia.or.id");return active.has(key)||active.has(pdfAccountLease(row));}).map(row=>row.id);
  }
  private async acquire(lease:string,owner:string,started:Date){
    const now=started.toISOString(),expires=new Date(started.getTime()+LEASE_TTL_MS).toISOString(),stale=new Date(started.getTime()-STALE_HEARTBEAT_MS).toISOString();
    return this.db.one("INSERT INTO autosnap_automation_leases (key,owner,expires_at,heartbeat_at) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at,heartbeat_at=EXCLUDED.heartbeat_at WHERE autosnap_automation_leases.expires_at<$5 OR COALESCE(autosnap_automation_leases.heartbeat_at,autosnap_automation_leases.expires_at)<$6 RETURNING owner",[lease,owner,expires,now,now,stale]);
  }
  private async readyIds(runId:string){
    const stored=await this.db.query<{activity_id:string;pdf_data:Buffer}>("SELECT activity_id,pdf_data FROM autosnap_evidence_pdfs WHERE run_id=$1",[runId]);
    return new Set(stored.filter(row=>{try{validateOfficialPdf(Buffer.from(row.pdf_data));return true;}catch{return false;}}).map(row=>row.activity_id));
  }
  private applyStored(plan:EvidencePlan,validIds:Set<string>){
    for(const op of plan.operations)op.pdfReady=!!op.activity&&validIds.has(op.activity.activityId);
  }
  private missingOf(plan:EvidencePlan):MissingPdf[]{
    return plan.operations.filter(op=>!op.pdfReady).map(op=>({path:op.path,key:op.key,activityId:op.activity?.activityId,error:op.error??"PDF belum tersedia."}));
  }
  private auditEntry(input:{run:RunRow;plan:EvidencePlan;evaluation:Evaluation|null;attempt:number;result:AuditEntry["result"];statusAfter:string;stored:number;missing:MissingPdf[];note:string;priorErrors:MissingPdf[]}):AuditEntry{
    return {at:new Date().toISOString(),attempt:input.attempt,stage:"pdf_reprocessing",priorStatus:input.run.status,priorOutcome:input.evaluation?.outcome??null,priorDetail:input.evaluation?.detail??"",priorErrors:input.priorErrors,result:input.result,statusBefore:input.run.status,statusAfter:input.statusAfter,stored:input.stored,required:input.plan.operations.length,missing:input.missing,note:input.note};
  }
  private async appendAudit(runId:string,ownerId:string,entry:AuditEntry,log?:{stage:string;status:string;detail:string;at:string}){
    const patch=log
      ? "jsonb_set(jsonb_set(request_json,'{reprocessAudit}',COALESCE(request_json->'reprocessAudit','[]'::jsonb)||$1::jsonb,true),'{progressLog}',COALESCE(request_json->'progressLog','[]'::jsonb)||$2::jsonb,true)"
      : "jsonb_set(request_json,'{reprocessAudit}',COALESCE(request_json->'reprocessAudit','[]'::jsonb)||$1::jsonb,true)";
    const params=log?[JSON.stringify([entry]),JSON.stringify([log]),runId,ownerId]:[JSON.stringify([entry]),runId,ownerId];
    await this.db.query(`UPDATE autosnap_runs SET request_json=${patch} WHERE id=$${log?3:2} AND operator_id=$${log?4:3}`,params);
  }
  private async commitOutcome(input:{run:RunRow;request:Record<string,unknown>;plan:EvidencePlan;evaluation:Evaluation;complete:boolean;processing:boolean;priorErrors:MissingPdf[];input:ProcessInput}){
    const {run,request,plan,evaluation,complete,priorErrors}=input;
    const status=finalOutcome(evaluation,complete);
    const count=plan.operations.filter(op=>op.pdfReady).length;
    const missing=this.missingOf(plan);
    const httpFailed=!evaluation.httpValidation?.matches;
    const promoted={...evaluation,outcome:status,detail:httpFailed?evaluation.detail:complete?evaluation.detail.replace(/Pengumpulan bukti PDF belum selesai\.?/,"Bukti PDF lengkap."):evaluation.detail,suggestion:complete||httpFailed?"":"Sebagian bukti PDF belum tersedia. Proses ulang hanya mengunduh PDF yang belum tersimpan."};
    const notes=httpFailed
      ? `${evaluation.detail} Bukti PDF resmi ASPI ${count}/${plan.operations.length} tersimpan. Outcome tetap FAILED karena validasi HTTP sebelumnya tidak sesuai.`
      : complete
        ? `HTTP sesuai expected. Bukti PDF resmi ASPI ${count}/${plan.operations.length} tersimpan. Outcome: PASSED.`
        : `HTTP sesuai expected. Bukti PDF resmi ASPI ${count}/${plan.operations.length} tersimpan. Outcome: COMPLETED. Belum tersedia: ${missing.map(item=>item.path).join(", ")||"—"}.`;
    let checkpoint=object(request.checkpoint)&&Array.isArray(request.checkpoint.stages)?structuredClone(request.checkpoint) as RunCheckpoint:{version:1 as const,stages:[]};
    if(complete){
      checkpoint=markStage(checkpoint,"evidence","COMPLETED",`${count}/${plan.operations.length} PDF resmi tersimpan`);
      checkpoint=markStage(checkpoint,"pdf_reprocessing","COMPLETED","Proses ulang bukti selesai tanpa menjalankan API");
      for(const id of ["pdf_download","pdf_store"])if(checkpoint.stages.some(stage=>stage.id===id&&stage.status==="FAILED"))checkpoint=markStage(checkpoint,id,"COMPLETED","PDF tersimpan pada proses ulang");
      if(evaluation.httpValidation?.matches)checkpoint=markStage(checkpoint,"evaluation","COMPLETED",evaluation.detail);
      checkpoint=markStage(checkpoint,"finished","COMPLETED",notes);
    }else{
      checkpoint=markStage(checkpoint,"evidence","FAILED",`${count}/${plan.operations.length} PDF; sebagian belum tersedia`);
      checkpoint=markStage(checkpoint,"pdf_reprocessing","FAILED","Sebagian bukti belum tersedia");
      checkpoint=markStage(checkpoint,"finished","COMPLETED",notes);
    }
    const previous=object(request.reprocess)?request.reprocess:{};
    const flags={
      retryEvidence:canRetryEvidence({status,httpMatched:evaluation.httpValidation?.matches===true,evidenceIncomplete:!complete&&plan.operations.length>0}),
      resumeTesting:previous.resumeTesting===true,
      requireMutatingConfirm:previous.requireMutatingConfirm===true,
    };
    const activities=plan.operations.flatMap(op=>op.activity?[{...op.activity,pdfReady:op.pdfReady,path:op.path,key:op.key}]:[]);
    const entry=this.auditEntry({run,plan,evaluation,attempt:plan.retryCount,result:httpFailed?"FAILED":complete?"COMPLETED":"INCOMPLETE",statusAfter:status,stored:count,missing,note:notes,priorErrors});
    const summary={stage:"evidence",status:complete?"completed":"failed",detail:notes,at:entry.at};
    await this.db.query("UPDATE autosnap_runs SET status=$1,notes=$2,request_json=jsonb_set(jsonb_set(request_json || $3::jsonb,'{reprocessAudit}',COALESCE(request_json->'reprocessAudit','[]'::jsonb)||$4::jsonb,true),'{progressLog}',COALESCE(request_json->'progressLog','[]'::jsonb)||$5::jsonb,true) WHERE id=$6 AND operator_id=$7",[status,notes,JSON.stringify({outcome:status,evaluation:promoted,evidence:plan,checkpoint,pdfCounts:{ready:count,required:plan.operations.length},reprocess:flags,evidenceErrors:missing,aspiActivities:activities}),JSON.stringify([entry]),JSON.stringify([summary]),run.id,input.input.ownerId]);
    await this.touchProgress(request,input.input.ownerId,status==="FAILED"?"failed":"completed",notes);
    return {status,notes,complete,stored:count,required:plan.operations.length,missing,evidence:plan,pdfCounts:{ready:count,required:plan.operations.length},reprocess:flags,reprocessAudit:[entry]};
  }
  private async touchProgress(request:Record<string,unknown>,ownerId:string,status:"completed"|"failed"|"running",detail:string){
    const progressId=typeof request.progressId==="string"?request.progressId:"";
    if(!/^[0-9a-f-]{36}$/i.test(progressId))return;
    const at=new Date().toISOString();
    await this.db.query("UPDATE autosnap_test_progress SET status=$1,stage='pdf_reprocessing',steps=COALESCE(steps,'[]'::jsonb)||$2::jsonb,updated_at=$3 WHERE id=$4 AND user_id=$5",[status==="running"?"running":status==="failed"?"failed":"completed",JSON.stringify([{stage:"pdf_reprocessing",status,detail,at}]),at,progressId,ownerId]).catch(()=>undefined);
  }
}
