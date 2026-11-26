import "reflect-metadata";
import { saveConnection } from "./connection";
import { createAccount, recaptchaPublicConfig, updateAccount, verifyPassword, verifyRecaptcha, type Operator } from "./accounts";
import { Controller, Get, Module, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseService, type RecordRow, type RunRow } from "./database.service";
import { RunEngine, isoJakarta, checkHeaders, type HitResult } from "./run-engine";
import { PortalEngine } from "./portal-engine";
import { decrypt, encrypt, redact, secretFields, sha256 } from "./security";
import { contentDispositionAttachment, evidencePdfFilenameForRun, resolveEvidencePdfBaseName, uniqueEvidenceZipEntryNames } from "./evidence-filename";
import { BALANCE_PATH,balanceResponseChecks, mockBalance, object, validateBalanceRequest, validateHeaderProfile, type UseCase } from "./balance";
import { AspiFormResolver } from "./aspi-form-resolver";
import { AspiSessionManager } from "./aspi-session-manager";
import { clientAddress } from "./http-security";
import { requestPasswordReset, resetPasswordWithOtp } from "./password-reset";
import { can, hasPrivilege, normalizeRole, normalizedPrivileges, assertAssignablePrivileges } from "./privileges";
import { createZip } from "./zip";
import { RunControl } from "./run-control";
import { canAccessRun, readHistory } from "./history";
import { writeAudit } from "./audit-log";
import { runClientSimulator } from "./simulator-run";
import { ASPI_SERVICE_NAME_MAX, ClientSimulatorPortalError, clientSimulatorEvidenceOutcome, clientSimulatorRetryTarget, clientSimulatorServiceLabel, officialActivityId } from "./aspi-client-simulator";
import { AspiAutomationError } from "./aspi-types";
import { normalizeEndpointPath, normalizeSignatureMode } from "./simulator-signing";
import {DocumentationReader} from "./documentation-reader";
import {validateConfig,configuredChecks,methods} from "./endpoint-config";
import {prepareBody,resolveRequestPath,managedHeaders} from "./request-builder";
import {assertOperationIdentity,resolveEndpoint,scenarioExpectation} from "./endpoint-resolver";
import {authenticationWorkflow} from "./auth-workflow";
import {evaluateTest,finalOutcome,hasRecordedHttp,type ResultCheck,type RunStatus} from "./test-evaluation";
import { inspectPdfProvenance, pdfContentSha256, pdfEvidenceFingerprint, validateAspiDownloadPdf, validateOfficialPdf, type AspiActivity } from "./aspi-evidence";
import {annotateServiceData,resolveCapabilities,savesPrerequisite} from "./service-capabilities";
import {buildEvidencePlan} from "./evidence-plan";
import {RunEvidenceService} from "./run-evidence";
import {buildCheckpoint,canResumeTesting,canRetryEvidence,failedStage,markStage,requiresMutatingConfirm,type RunCheckpoint} from "./run-checkpoint";
import {withSentProfile} from "./header-profile";
import {pdfCaptureProfile,type PdfCaptureProfile} from "./pdf-browser";
import {listMasterData} from "./master-data-list";

type Scenario={id:string;group:string;service:string;scenario:string;expected:string;expectedCode:string|null};
type Input=Record<string,unknown>;
const kinds=new Set(["client","project","environment","snap_user","service","endpoint","template","sim_provider","sim_service"]);
const parentKinds:Record<string,string>={project:"client",environment:"project",service:"endpoint",template:"endpoint",sim_service:"sim_provider"};
const get=(rows:RecordRow[],id:unknown,kind:string)=>rows.find(row=>row.id===id&&row.kind===kind);
const value=(row:RecordRow|undefined,key:string)=>String(row?.data[key]??"");
const codeFor=(raw:string|null|undefined,code:string)=>raw?.replace("xx",/^\d{2}$/.test(code)?code:"00")??null;
function publicRecord(row:RecordRow){
  const data={...row.data};
  if(row.kind==="sim_provider"){
    const clientId=String(data.clientId??"").trim();
    const legacyKey=String(data.clientKey??"").trim();
    if(!clientId&&legacyKey)data.clientId=legacyKey;
    else if(clientId&&legacyKey&&clientId!==legacyKey)data.clientIdConflict=true;
    else if(clientId&&legacyKey&&clientId===legacyKey)delete data.clientKey;
  }
  for(const field of secretFields)if(data[field])data[field]="••••••••";
  return {id:row.id,kind:row.kind,name:row.name,parentId:row.parent_id,partnerId:row.partner_id,data,createdAt:row.created_at,updatedAt:row.updated_at};
}
function clientError(message:string,status=400,code?:string){return {error:message,status,...(code?{code}:{})};}

@Controller("autosnap")
export class AutoSnapController {
  private scenarios:Scenario[]|null=null;
  constructor(private readonly db:DatabaseService,private readonly engine:RunEngine,private readonly portal:PortalEngine,private readonly docs:DocumentationReader,private readonly evidenceService:RunEvidenceService){}
  private async catalog(){return this.scenarios??=JSON.parse(await readFile(join(process.cwd(),"app","scenario-catalog.json"),"utf8")) as Scenario[];}
  private async allRecords(){return this.db.query<RecordRow>("SELECT * FROM autosnap_records ORDER BY created_at DESC");}
  private async user(req:Request){
    const token=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("autosnap_session="))?.slice("autosnap_session=".length);
    if(!token)return null;
    const row=await this.db.one<Operator>("SELECT u.id,u.email,u.username,u.name,u.role,u.active,u.privileges,u.created_at FROM autosnap_users u JOIN autosnap_sessions s ON s.user_id=u.id WHERE s.hash=$1 AND s.expires_at>$2 AND u.active=TRUE",[sha256(token),new Date().toISOString()]);
    const role=row?normalizeRole(row.role):null;
    return row&&role?{...row,role}:null;
  }
  private async newSession(req:Request,res:Response,userId:string){
    const token=randomBytes(32).toString("hex"),expiry=new Date(Date.now()+8*3600000);
    await this.db.query("DELETE FROM autosnap_sessions WHERE expires_at<=$1",[new Date().toISOString()]);
    await this.db.query("INSERT INTO autosnap_sessions (hash,user_id,expires_at) VALUES ($1,$2,$3)",[sha256(token),userId,expiry.toISOString()]);
    res.cookie("autosnap_session",token,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production"||req.headers["x-autosnap-proto"]==="https",path:"/",expires:expiry});
  }
  private fail(res:Response,error:unknown){
    const e=error as {error?:string;status?:number;message?:string;code?:string;detail?:string};
    // PostgreSQL SQLSTATE is five chars (e.g. 42703). App codes use SCREAMING_SNAKE.
    const pgCode=typeof e.code==="string"&&/^[0-9A-Z]{5}$/.test(e.code)?e.code:undefined;
    if(pgCode==="42703"){
      console.error("[DATABASE_SCHEMA_ERROR]",e.message??e.detail??e.error);
      return res.status(503).json({error:"Skema database belum lengkap (kolom hilang). Terapkan migrasi evidence PDF / leases, lalu coba Proses Ulang Bukti lagi.",code:"DATABASE_SCHEMA_ERROR"});
    }
    if(pgCode){
      console.error(`[DATABASE_ERROR_${pgCode}]`,e.message??e.detail??e.error);
      return res.status(500).json({error:e.error??"Kesalahan database saat memproses bukti. Hubungi administrator.",code:"DATABASE_ERROR"});
    }
    return res.status(e.status??500).json({error:e.error??"Terjadi kesalahan server. Hubungi administrator.",...(e.code?{code:e.code}:{})});
  }
  @Get()
  async state(@Req() req:Request,@Res() res:Response){
    try{
      const count=await this.db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_users");
      if(!Number(count?.n)){
        const host=String(req.headers["x-autosnap-host"]??req.hostname).split(":")[0];
        return res.json({setupRequired:true,setupTokenRequired:process.env.NODE_ENV==="production"||!["localhost","127.0.0.1"].includes(host),...recaptchaPublicConfig()});
      }
      const user=await this.user(req);if(!user)return res.json({loginRequired:true,...recaptchaPublicConfig()});
      const canListUsers=can(user,"user_management")||can(user,"history","view_all");
      const [records,runs,scenarios,operators]=await Promise.all([this.allRecords(),this.db.query<RunRow>("SELECT * FROM autosnap_runs WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 500",[user.id]),this.catalog(),this.db.query<Operator>("SELECT id,name,email,username,role,active,privileges,created_at FROM autosnap_users WHERE ($1=TRUE OR id=$2) ORDER BY created_at",[canListUsers,user.id])]);
      const account=(item:Operator)=>{const role=normalizeRole(item.role)??"petugas";return {...item,role,privileges:normalizedPrivileges(item.privileges,role),createdAt:item.created_at};};
      return res.json({user:account(user),operators:operators.map(account),records:records.map(publicRecord),runs:runs.map(run=>({...run,request:run.request_json,response:run.response_json})),scenarios});
    }catch(error){return this.fail(res,error);}
  }
  @Post()
  async action(@Req() req:Request,@Res() res:Response){
    try{
      const input=(req.body??{}) as Input,action=String(input.action??"");
      if(action==="setup")return await this.setup(req,res,input);
      if(action==="register"){
        await this.enforceRateLimit(`register:${clientAddress(req)}`,5,15*60_000);
        await verifyRecaptcha(input,req.ip);
        const count=await this.db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_users");
        if(!Number(count?.n))return this.fail(res,clientError("Buat administrator pertama terlebih dahulu."));
        await createAccount(this.db,input,"petugas",false);
        return res.json({ok:true,message:"Pendaftaran berhasil. Tunggu admin mengaktifkan akun."});
      }
      if(action==="login")return await this.login(req,res,input);
      if(action==="forgotPassword"){
        const forgotEmail=String(input.email??"").trim().toLowerCase();
        await this.enforceRateLimit(`forgot:${clientAddress(req)}`,5,15*60_000);
        await verifyRecaptcha(input,req.ip);
        await this.enforceRateLimit(`forgot-email:${forgotEmail}`,3,15*60_000);
        await this.enforceRateLimit(`forgot-cooldown:${forgotEmail}`,1,60_000);
        return res.json(await requestPasswordReset(this.db,input.email));
      }
      if(action==="resetPassword"){
        await this.enforceRateLimit(`reset:${clientAddress(req)}`,10,15*60_000);
        await this.enforceRateLimit(`reset-id:${String(input.resetId??"").slice(0,80)}`,8,15*60_000);
        await resetPasswordWithOtp(this.db,input);
        return res.json({ok:true,message:"Password berhasil diperbarui. Silakan masuk."});
      }
      const user=await this.user(req);if(!user)return this.fail(res,clientError("Sesi login diperlukan.",401));
      if(action==="logout"){
        const token=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("autosnap_session="))?.slice("autosnap_session=".length);
        if(token)await this.db.query("DELETE FROM autosnap_sessions WHERE hash=$1",[sha256(token)]);
        res.clearCookie("autosnap_session",{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production"||req.headers["x-autosnap-proto"]==="https",path:"/"});return res.json({ok:true});
      }
      if(action==="cancelRun"){
        await this.enforceRateLimit(`cancel:${user.id}`,30,60_000);
        const id=String(input.id??"");if(!/^[0-9a-f-]{36}$/i.test(id))return this.fail(res,clientError("ID testing tidak valid."));
        const row=await this.db.one("INSERT INTO autosnap_test_progress (id,user_id,status,stage,steps,updated_at) VALUES ($1,$2,'cancel_requested','cancelling','[]'::jsonb,$3) ON CONFLICT (id) DO UPDATE SET status='cancel_requested',updated_at=EXCLUDED.updated_at WHERE autosnap_test_progress.user_id=$2 AND autosnap_test_progress.stage<>'finished' RETURNING id",[id,user.id,new Date().toISOString()]);
        if(!row)return this.fail(res,clientError("Testing sudah selesai atau tidak ditemukan.",409));
        await this.updateProgress(id,user.id,"cancelling","running","Cancel diterima. Menghentikan browser dan tahap berikutnya.");
        return res.json({ok:true,status:"cancel_requested"});
      }
      if(action==="getProgress"){
        const progress=await this.db.one("SELECT id,status,stage,steps,updated_at FROM autosnap_test_progress WHERE id=$1 AND user_id=$2",[String(input.id??""),user.id]);
        return progress?res.json(progress):this.fail(res,clientError("Progress testing tidak ditemukan.",404));
      }
      if(action==="getHistory"){
        await this.enforceRateLimit(`history:${user.id}`,120,60_000);
        return res.json(await readHistory(this.db,user,input));
      }
      if(action==="listMasterData"){
        await this.enforceRateLimit(`master-list:${user.id}`,120,60_000);
        return res.json(await listMasterData(this.db,user,input));
      }
      if(action==="linkClientServices"){
        if(!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Master Data.",403));
        const environmentId=String(input.environmentId??"");
        const appendIds=Array.isArray(input.appendServiceIds)?input.appendServiceIds.map(id=>String(id)).filter(id=>/^[0-9a-f-]{8,}$/i.test(id)).slice(0,200):[];
        const replaceIds=Array.isArray(input.serviceIds)?input.serviceIds.map(id=>String(id)).filter(id=>/^[0-9a-f-]{8,}$/i.test(id)).slice(0,200):null;
        const rows=await this.allRecords();
        const environment=get(rows,environmentId,"environment");
        if(!environment)return this.fail(res,clientError("Dev Site Client tidak ditemukan.",404));
        const valid=new Set(rows.filter(row=>row.kind==="service").map(row=>row.id));
        const prior=Array.isArray(environment.data.linkedServiceIds)?environment.data.linkedServiceIds.map(String):[];
        const serviceIds=replaceIds??Array.from(new Set([...prior,...appendIds]));
        if(serviceIds.some(id=>!valid.has(id)))return this.fail(res,clientError("Satu atau lebih API Service tidak valid."));
        const data={...environment.data,linkedServiceIds:serviceIds};
        await this.db.query("UPDATE autosnap_records SET data=$1::jsonb,updated_at=$2 WHERE id=$3",[JSON.stringify(data),new Date().toISOString(),environment.id]);
        await writeAudit(this.db,user.id,"link_client_services","environment",environment.id,{count:serviceIds.length});
        return res.json({ok:true,linkedServiceIds:serviceIds});
      }
      if(action==="deleteEndpointConfiguration"){
        if(!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Master Data.",403));
        const records=await this.allRecords(),endpoint=get(records,input.id,"endpoint");
        if(!endpoint)return this.fail(res,clientError("Dev Site Endpoint tidak ditemukan.",404));
        const ids=[endpoint.id,...records.filter(row=>row.kind==="service"&&row.parent_id===endpoint.id).map(row=>row.id)];
        if(records.some(row=>row.parent_id&&ids.includes(row.parent_id)&&!ids.includes(row.id)&&row.kind!=="template"))return this.fail(res,clientError("Konfigurasi masih dipakai data lain.",409));
        const slots=ids.map((_,index)=>`$${index+1}`).join(",");
        await this.db.transaction(async query=>{
          await query(`DELETE FROM autosnap_records WHERE kind='template' AND parent_id IN (${slots})`,ids);
          await query(`DELETE FROM autosnap_records WHERE id IN (${slots})`,ids);
        });
        await writeAudit(this.db,user.id,"delete_endpoint","endpoint",endpoint.id,{name:endpoint.name,serviceCount:ids.length-1});
        return res.json({ok:true});
      }
      if(action==="inspectDocumentation"||action==="saveImportedService"){
        if(!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Master Data.",403));
        await this.enforceRateLimit(`import:${user.id}`,10,60_000);
        if(action==="inspectDocumentation"){
          const snapUser=get(await this.allRecords(),input.userId,"snap_user");
          if(!snapUser)return this.fail(res,clientError("Pilih User SNAP untuk sesi dokumentasi ASPI."));
          try{return res.json(await this.docs.inspect(snapUser,String(input.url??"")));}catch(error){return this.fail(res,clientError(error instanceof Error&&error.message.startsWith("Schema Swagger")?error.message:"Dokumentasi belum dapat dibaca. Periksa URL operasi dan sesi User SNAP. Tidak ada API transaksi dijalankan."));}
        }
        const draft=object(input.draft)?input.draft:{};
        const config=validateConfig(draft.config);
        if(!config.reviewed)return this.fail(res,clientError("Tinjau konfigurasi sebelum menyimpan."));
        const url=new URL(String(draft.portalUrl));
        if(url.origin!=="https://apidevportal.aspi-indonesia.or.id"||!url.pathname.startsWith("/api-services/")||!methods.includes(String(draft.method))||!/^\/(?!\/)[^\s?#]+$/.test(String(draft.path)))return this.fail(res,clientError("URL, path atau method tidak valid."));
        if(draft.code&&!/^\d{2}$/.test(String(draft.code)))return this.fail(res,clientError("Service code harus dua digit jika diketahui."));
        assertOperationIdentity(String(draft.method),String(draft.path),url.toString(),config);
        // Store capabilities once; execution never branches on a service's display name.
        if(config.authFlow!=="unknown")config.workflow=authenticationWorkflow(config).profile;
        const requestBody=String(draft.requestBody??"");
        if(requestBody.trim()&&!object(JSON.parse(requestBody)))return this.fail(res,clientError("Template harus object JSON atau kosong jika sample tidak tersedia."));
        const records=await this.allRecords();
        const existingEndpoint=draft.endpointId?get(records,draft.endpointId,"endpoint"):records.find(row=>row.kind==="endpoint"&&value(row,"portalUrl")===url.toString());
        if(records.some(row=>row.kind==="endpoint"&&row.id!==existingEndpoint?.id&&value(row,"portalUrl")===url.toString()))return this.fail(res,clientError("URL sudah digunakan endpoint lain. Edit endpoint yang sudah ada.",409));
        if(draft.endpointId&&!existingEndpoint)return this.fail(res,clientError("Endpoint yang diedit tidak ditemukan.",404));
        const linkedServices=existingEndpoint?records.filter(row=>row.kind==="service"&&row.parent_id===existingEndpoint.id):[];
        const existingService=draft.serviceId?get(records,draft.serviceId,"service"):linkedServices.length===1?linkedServices[0]:undefined;
        if(draft.serviceId&&(!existingService||!linkedServices.some(row=>row.id===existingService.id)))return this.fail(res,clientError("Service tidak melekat pada endpoint yang diedit."));
        if(!draft.serviceId&&linkedServices.length>1)return this.fail(res,clientError("Pilih konfigurasi service yang ingin diedit."));
        const endpointId=existingEndpoint?.id??"doc-endpoint-"+sha256(url.toString()).slice(0,24),serviceId=existingService?.id??"doc-service-"+sha256(url.toString()).slice(0,24),now=new Date().toISOString();
        await this.db.transaction(async query=>{
          for(const [id,kind,parentId,data]of [[endpointId,"endpoint",null,{...existingEndpoint?.data,method:draft.method,path:draft.path,portalUrl:url.toString()}],[serviceId,"service",endpointId,annotateServiceData({...existingService?.data,module:String(draft.module??"Layanan SNAP"),code:String(draft.code??""),requestBody,config})]]){
            await query("INSERT INTO autosnap_records(id,kind,name,parent_id,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,parent_id=EXCLUDED.parent_id,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at",[id,kind,String(draft.name??config.operationId).slice(0,120),parentId,JSON.stringify(data),now]);
          }
        });
        return res.json({ok:true,endpointId,serviceId});
      }
      if(action==="save"||action==="saveConnection"){
        const kind=String(input.kind??(action==="saveConnection"?"environment":""));
        const isSim=kind==="sim_provider"||kind==="sim_service";
        if(isSim){
          if(!can(user,"client_simulator")&&!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Client Simulator atau Master Data.",403));
        }else if(!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Master Data.",403));
      }
      if(action==="delete"){
        const existing=await this.db.one<RecordRow>("SELECT * FROM autosnap_records WHERE id=$1",[String(input.id??"")]);
        const isSim=existing?.kind==="sim_provider"||existing?.kind==="sim_service";
        if(isSim){
          if(!can(user,"client_simulator")&&!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Client Simulator atau Master Data.",403));
        }else if(!can(user,"master_data"))return this.fail(res,clientError("Anda tidak memiliki privilege Master Data.",403));
      }
      if(action==="userCreate"){
        if(!can(user,"user_management"))return this.fail(res,clientError("Anda tidak memiliki privilege User Management.",403));
        if(input.role==="admin"&&user.role!=="admin")return this.fail(res,clientError("Hanya admin yang boleh membuat akun admin.",403));
        const privileges=assertAssignablePrivileges(user,input.privileges);
        await createAccount(this.db,{...input,privileges},input.role==="admin"?"admin":"petugas",true);
        await writeAudit(this.db,user.id,"user_create","user",null,{username:input.username,role:input.role==="admin"?"admin":"petugas"});
        return res.json({ok:true});
      }
      if(action==="userDelete"){
        if(!can(user,"user_management"))return this.fail(res,clientError("Anda tidak memiliki privilege User Management.",403));
        await updateAccount(this.db,input,user);
        await writeAudit(this.db,user.id,"user_delete","user",String(input.id??""),{});
        return res.json({ok:true});
      }
      if(action==="save")return await this.save(res,input,user);
      if(action==="saveConnection"){const result=await saveConnection(this.db,input);await writeAudit(this.db,user.id,"save_connection","environment",String(result.id??""),{});return res.json(result);}
      if(action==="delete")return await this.remove(res,input,user);
      if(action==="userUpdate"){await updateAccount(this.db,input,user);await writeAudit(this.db,user.id,"user_update","user",String(input.id??user.id),{fields:Object.keys(input).filter(k=>k!=="password"&&k!=="currentPassword")});return res.json({ok:true});}
      if(action==="downloadAspiActivityPdf"){
        await this.enforceRateLimit(`pdf:${user.id}`,20,10*60_000);
        if(!can(user,"dev_site")&&!can(user,"client_simulator"))return this.fail(res,clientError("Anda tidak memiliki privilege untuk mengunduh bukti ini.",403));
        return await this.downloadAspiActivityPdf(res,input,user);
      }
      if(action==="retryAspiEvidence"){
        await this.enforceRateLimit(`retry-evidence:${user.id}`,10,10*60_000);
        if(!can(user,"dev_site")&&!can(user,"client_simulator"))return this.fail(res,clientError("Anda tidak memiliki privilege untuk proses ulang bukti.",403));
        return await this.retryAspiEvidence(res,input,user,pdfCaptureProfile(req.headers["user-agent"],input.pdfScreen));
      }
      if(action==="resumeTesting"){
        await this.enforceRateLimit(`resume:${user.id}`,10,10*60_000);
        return await this.resumeTesting(res,input,user);
      }
      if(action==="downloadAspiActivitiesZip"){
        await this.enforceRateLimit(`zip:${user.id}`,10,10*60_000);
        if(!can(user,"dev_site")&&!can(user,"client_simulator"))return this.fail(res,clientError("Anda tidak memiliki privilege untuk mengunduh bukti ini.",403));
        return await this.downloadAspiActivitiesZip(res,input,user);
      }
      if(action==="aspiBusy")return res.json({busyUserIds:await this.evidenceService.busyUserIds(await this.allRecords())});
      if(action==="runClientSimulator"){
        await this.enforceRateLimit(`run-sim:${user.id}`,20,10*60_000);
        if(!can(user,"client_simulator"))return this.fail(res,clientError("Anda tidak memiliki privilege Client Simulator.",403));
        const progressId=/^[0-9a-f-]{36}$/i.test(String(input.progressId??""))?String(input.progressId):randomUUID();
        await this.db.query("DELETE FROM autosnap_test_progress WHERE updated_at<$1",[new Date(Date.now()-24*3600000).toISOString()]);
        const registered=await this.db.query("INSERT INTO autosnap_test_progress (id,user_id,status,stage,steps,updated_at) VALUES ($1,$2,'queued','preparing','[]'::jsonb,$3) ON CONFLICT (id) DO NOTHING RETURNING id",[progressId,user.id,new Date().toISOString()]);
        if(!registered.length)return this.fail(res,clientError("Pengujian dengan ID ini sudah diterima. Periksa Log Testing, jangan kirim ulang.",409));
        const progress=async(stage:string,status:"running"|"completed"|"failed",detail="")=>{await this.updateProgress(progressId,user.id,stage,status,detail);};
        const control=new RunControl(this.db,progressId,user.id);
        await control.start();
        try{
          await progress("preparing","completed","Konfigurasi Client Simulator tervalidasi. Form ASPI akan diisi, lalu PDF ditunggu dari Client Simulator Activity.");
          const result=await runClientSimulator(this.db,await this.allRecords(),user,input,{submit:(snapUser,form)=>this.portal.submitClientSimulator(snapUser,form,{onProgress:progress,signal:control.signal}),hitAspiSignature:(snapUser,request)=>this.portal.hitAspiSignatureUtility(snapUser,request,control.signal)},progress,control.signal);
          const pipeline=result.status==="CANCELLED"?"cancelled":"completed";
          const finished=await this.updateProgress(progressId,user.id,"finished",pipeline,`Finished — Outcome: ${result.status}. ${String(result.notes??"")}`);
          const stored=await this.db.one<{steps:unknown}>("SELECT steps FROM autosnap_test_progress WHERE id=$1 AND user_id=$2",[progressId,user.id]);
          await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2",[JSON.stringify({progressId,progressLog:Array.isArray(stored?.steps)?stored.steps:[]}),result.id]);
          return res.json({...result,progressId,formReady:true,aspiReady:finished!=="cancelled"});
        }catch(error){
          const cancelled=control.signal.aborted;
          const message=error instanceof Error?error.message:error&&typeof error==="object"&&"error" in error?String((error as {error:unknown}).error):"Client Simulator gagal.";
          await this.updateProgress(progressId,user.id,"finished",cancelled?"cancelled":"failed",message).catch(()=>undefined);
          if(cancelled)return res.json({ok:false,status:"CANCELLED",progressId,formReady:true,notes:message});
          throw error;
        }finally{control.stop();}
      }
      if(action==="run")await this.enforceRateLimit(`run:${user.id}`,20,10*60_000);
      if(action==="run"){
        const environment=await this.db.one<RecordRow>("SELECT * FROM autosnap_records WHERE id=$1 AND kind='environment'",[String(input.environmentId??"")]);
        const required=value(environment??undefined,"mode")==="mock"?"client_simulator":"dev_site";
        if(!hasPrivilege(user,required))return this.fail(res,clientError("Anda tidak memiliki privilege untuk menjalankan pengujian ini.",403));
        return await this.run(res,input,user,pdfCaptureProfile(req.headers["user-agent"],input.pdfScreen));
      }
      return this.fail(res,clientError("Action tidak dikenal.",404));
    }catch(error){return this.fail(res,error);}
  }
  /** Load a run for view/download/retry. Admin may access any run; petugas only own. Ownership is never rewritten. */
  private async loadAccessibleRun(runId:string,operator:Operator){
    const run=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1",[runId]);
    if(!run||!canAccessRun(operator,run))return null;
    return run;
  }
  private canDownloadEvidence(operator:Operator,run:RunRow){
    return run.mode==="client_sim"?can(operator,"client_simulator"):can(operator,"dev_site");
  }
  private requireCrossUserConfirm(run:RunRow,operator:Operator,input:Input,actionLabel:string){
    if(run.operator_id&&run.operator_id!==operator.id){
      if(!can(operator,"history","view_all")&&operator.role!=="admin")throw clientError("Anda tidak berwenang mengakses History pengguna lain.",403);
      if(input.confirmCrossUser!==true)throw clientError(`${actionLabel} milik pengguna lain memerlukan konfirmasi (confirmCrossUser=true).`,409,"CROSS_USER_CONFIRM");
    }
  }
  private loadStoredOfficialPdf(row:{pdf_data:Buffer;content_sha256?:string|null;byte_size?:number;verification_status?:string|null}){
    const pdf=validateOfficialPdf(Buffer.from(row.pdf_data));
    const hash=pdfContentSha256(pdf);
    if(row.content_sha256&&row.content_sha256!==hash)throw clientError("Integritas PDF tersimpan rusak (SHA-256 tidak cocok). Proses ulang bukti tanpa menjalankan API.",409);
    if(row.byte_size!=null&&row.byte_size!==pdf.length)throw clientError("Ukuran PDF tersimpan tidak konsisten.",409);
    const provenance=inspectPdfProvenance(pdf);
    // Downloadable when origin is ASPI html2pdf (CAPTURED/VERIFIED). UNVERIFIED = Chromium/legacy.
    if(provenance.fromChromiumPrint||row.verification_status==="UNVERIFIED"||!provenance.fromAspHtml2Pdf){
      throw clientError("PDF tersimpan belum terbukti Download resmi ASPI (UNVERIFIED). Proses ulang bukti tanpa menjalankan API.",409);
    }
    return {pdf,hash,fingerprint:pdfEvidenceFingerprint(pdf),provenance};
  }
  private async downloadAspiActivityPdf(res:Response,input:Input,operator:Operator){
    const runId=String(input.id??""),activityId=String(input.activityId??"");
    const run=await this.loadAccessibleRun(runId,operator);
    if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
    if(!this.canDownloadEvidence(operator,run))return this.fail(res,clientError("Anda tidak memiliki privilege untuk mengunduh bukti ini.",403));
    try{this.requireCrossUserConfirm(run,operator,input,"Unduh PDF");}catch(error){return this.fail(res,error);}
    const request=object(run.request_json)?run.request_json:{},activities=Array.isArray(request.aspiActivities)?request.aspiActivities.filter(object):[];
    const activity=activities.find(item=>String(item.activityId??"")===activityId);
    if(!activity)return this.fail(res,clientError("Aktivitas ASPI tidak terdaftar pada history ini.",404));
    const cached=await this.db.one<{pdf_data:Buffer;content_sha256:string|null;byte_size:number;verification_status:string|null}>("SELECT pdf_data,content_sha256,byte_size,verification_status FROM autosnap_evidence_pdfs WHERE run_id=$1 AND activity_id=$2",[runId,activityId]);
    if(!cached)return this.fail(res,clientError("PDF resmi ASPI belum tersimpan untuk aktivitas ini. Lihat detail bukti pada History.",409));
    let pdf:Buffer,hash:string,fingerprint:string;
    try{({pdf,hash,fingerprint}=this.loadStoredOfficialPdf(cached));}catch(error){return this.fail(res,error);}
    if(!cached.content_sha256)await this.db.query("UPDATE autosnap_evidence_pdfs SET content_sha256=$1 WHERE run_id=$2 AND activity_id=$3",[hash,runId,activityId]).catch(()=>undefined);
    const filename=evidencePdfFilenameForRun(request,activity);
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",contentDispositionAttachment(filename));
    res.setHeader("Content-Length",String(pdf.length));
    res.setHeader("X-Content-SHA256",hash);
    res.setHeader("X-Content-Fingerprint",fingerprint);
    res.setHeader("X-ASPI-Activity-Id",activityId);
    return res.send(pdf);
  }
  private async downloadAspiActivitiesZip(res:Response,input:Input,operator:Operator){
    const runId=String(input.id??""),run=await this.loadAccessibleRun(runId,operator);
    if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
    if(!this.canDownloadEvidence(operator,run))return this.fail(res,clientError("Anda tidak memiliki privilege untuk mengunduh bukti ini.",403));
    try{this.requireCrossUserConfirm(run,operator,input,"Unduh ZIP bukti");}catch(error){return this.fail(res,error);}
    const request=object(run.request_json)?run.request_json:{},activities=Array.isArray(request.aspiActivities)?request.aspiActivities.filter(object):[];
    if(!activities.length)return this.fail(res,clientError("History ini belum memiliki bukti aktivitas ASPI.",409));
    const prepared:{activityId:string;serviceName:string;pdf:Buffer}[]=[];
    for(const [index,activity] of activities.entries()){
      const activityId=String(activity.activityId??"");
      if(!activityId)continue;
      const cached=await this.db.one<{pdf_data:Buffer;content_sha256:string|null;byte_size:number;verification_status:string|null}>("SELECT pdf_data,content_sha256,byte_size,verification_status FROM autosnap_evidence_pdfs WHERE run_id=$1 AND activity_id=$2",[runId,activityId]);
      if(!cached)return this.fail(res,clientError("Sebagian PDF belum tersimpan; ZIP tidak dibuat agar bukti tidak terlewat.",409));
      let pdf:Buffer;
      try{({pdf}=this.loadStoredOfficialPdf(cached));}catch(error){return this.fail(res,error);}
      prepared.push({activityId,serviceName:resolveEvidencePdfBaseName(request,activity)||`Service-${index+1}`,pdf});
    }
    const names=uniqueEvidenceZipEntryNames(prepared.map(item=>item.serviceName));
    const entries=prepared.map((item,index)=>({name:names[index],data:item.pdf}));
    const zip=createZip(entries),filename=`evidence-${runId.replace(/[^A-Za-z0-9_-]+/g,"-").slice(0,40)}.zip`;
    if(zip.length>50*1024*1024)return this.fail(res,clientError("Ukuran gabungan bukti melebihi 50 MB.",413));
    res.setHeader("Content-Type","application/zip");res.setHeader("Content-Disposition",contentDispositionAttachment(filename));res.setHeader("Content-Length",String(zip.length));
    return res.send(zip);
  }
  private async retryAspiEvidence(res:Response,input:Input,operator:Operator,pdfCapture:PdfCaptureProfile={kind:"chrome"}){
    const runId=String(input.id??"");
    const run=await this.loadAccessibleRun(runId,operator);
    if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
    try{this.requireCrossUserConfirm(run,operator,input,"Proses ulang bukti");}catch(error){return this.fail(res,error);}
    const ownerId=run.operator_id;
    if(!ownerId)return this.fail(res,clientError("History ini tidak memiliki operator_id; proses ulang ditolak agar kepemilikan tidak berubah.",409));
    const request=object(run.request_json)?run.request_json:{};
    if(run.mode==="client_sim")return await this.retryClientSimulatorEvidence(res,run,operator,input);
    if(!can(operator,"dev_site"))return this.fail(res,clientError("Anda tidak memiliki privilege Dev Site Client.",403));
    const evaluation=object(request.evaluation)?request.evaluation:{};
    const httpMatched=object(evaluation.httpValidation)?evaluation.httpValidation.matches===true:false;
    const plan=object(request.evidence)?request.evidence:{};
    const ops=Array.isArray(plan.operations)?plan.operations:[];
    const incomplete=ops.length>0&&ops.some(op=>object(op)&&op.pdfReady!==true);
    if(!canRetryEvidence({status:run.status,httpMatched,evidenceIncomplete:incomplete||run.status==="COMPLETED"}))return this.fail(res,clientError("Proses ulang bukti tidak tersedia untuk history ini.",409));
    const userId=run.user_id,snapUser=userId?await this.db.one<RecordRow>("SELECT * FROM autosnap_records WHERE id=$1 AND kind='snap_user'",[userId]):null;
    if(!snapUser)return this.fail(res,clientError("User SNAP pada history tidak ditemukan.",404));
    const actor={id:operator.id,username:operator.username,name:operator.name,role:normalizeRole(operator.role)??"petugas"};
    const result=await this.evidenceService.process({runId,ownerId,user:snapUser,initial:false,actor,pdfCapture});
    const aspiReady=!(await this.evidenceService.accountBusy(snapUser));
    const busyUserIds=await this.evidenceService.busyUserIds(await this.allRecords());
    return res.json({ok:true,...result,aspiReady,busyUserIds,formReady:aspiReady});
  }
  private async retryClientSimulatorEvidence(res:Response,run:RunRow,operator:Operator,input:Input){
    if(!can(operator,"client_simulator"))return this.fail(res,clientError("Anda tidak memiliki privilege Client Simulator.",403));
    if(run.status==="RUNNING")return this.fail(res,clientError("Pengujian masih berjalan.",409));
    const request=object(run.request_json)?run.request_json:{};
    const counts=object(request.pdfCounts)?request.pdfCounts:{};
    const ready=Number(counts.ready??0),required=Math.max(1,Number(counts.required??1));
    const activities=Array.isArray(request.aspiActivities)?request.aspiActivities.filter(object):[];
    const target=clientSimulatorRetryTarget(activities.map(item=>({activityId:String(item.activityId??"")})),String(input.activityId??""));
    if(!target.ok)return this.fail(res,clientError(target.message,409,target.code));
    const activity=activities.find(item=>officialActivityId(String(item.activityId??""))===target.activityId);
    if(activity?.pdfReady===true){
      return res.json({ok:true,status:run.status,notes:run.notes,complete:true,stored:ready,required,missing:[],pdfCounts:{ready,required},reprocess:{retryEvidence:false,resumeTesting:false,requireMutatingConfirm:false},processing:false});
    }
    const snapUser=run.user_id?await this.db.one<RecordRow>("SELECT * FROM autosnap_records WHERE id=$1 AND kind='snap_user'",[run.user_id]):null;
    if(!snapUser)return this.fail(res,clientError("User SNAP pada history tidak ditemukan.",404));
    if(await this.evidenceService.accountBusy(snapUser))return this.fail(res,clientError("Akun ASPI ini sedang dipakai. PDF yang sudah tersimpan tetap aman. Transaksi tidak dijalankan ulang.",409,"ASPI_SESSION_BUSY"));
    const activityId=target.activityId;
    try{
      const captured=await this.portal.redownloadClientSimulatorActivity(snapUser,activityId);
      if(officialActivityId(captured.activity.activityId)!==activityId)return this.fail(res,clientError("Activity ID yang diunduh tidak sama dengan Activity ID pada history.",409,"ASPI_ACTIVITY_AMBIGUOUS"));
      const pdf=validateAspiDownloadPdf(captured.pdf);
      const now=new Date().toISOString();
      const hash=pdfContentSha256(pdf),fingerprint=pdfEvidenceFingerprint(pdf),provenance=inspectPdfProvenance(pdf);
      const parsed=clientSimulatorServiceLabel([],[captured.activity.service]);
      const previous=String(activity?.serviceName??activity?.service??"");
      const serviceLabel=parsed.serviceSource==="portal"?parsed.service:(/^\d{1,3}$/.test(previous)?"":previous);
      const storedService=(serviceLabel||previous||"Client Simulator").slice(0,ASPI_SERVICE_NAME_MAX);
      const serviceSource=parsed.serviceSource==="portal"?"portal":"autosnap_snapshot";
      await this.db.query(
        `INSERT INTO autosnap_evidence_pdfs(
           run_id,activity_id,service,pdf_data,byte_size,content_sha256,content_fingerprint,
           verification_status,pdf_producer,source_url,downloaded_at,created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'CAPTURED',$8,$9,$10,$10)
         ON CONFLICT (run_id, activity_id) DO UPDATE SET
           service=EXCLUDED.service, pdf_data=EXCLUDED.pdf_data, byte_size=EXCLUDED.byte_size,
           content_sha256=EXCLUDED.content_sha256, content_fingerprint=EXCLUDED.content_fingerprint,
           verification_status='CAPTURED', pdf_producer=EXCLUDED.pdf_producer, source_url=EXCLUDED.source_url, downloaded_at=EXCLUDED.downloaded_at`,
        [run.id,captured.activity.activityId,storedService,pdf,pdf.length,hash,fingerprint,provenance.producer||null,captured.activity.downloadUrl,now]
      );
      const storedActivity={...(activity??{}),activityId,service:storedService,serviceName:storedService,serviceSource,timestamp:captured.activity.timestamp,downloadUrl:captured.activity.downloadUrl,pdfReady:true,evidenceStatus:"CAPTURED",authenticity:"aspi-html2pdf-download"};
      const aspiActivities=activities.map(item=>officialActivityId(String(item.activityId??""))===activityId?storedActivity:item);
      const pdfCounts={ready:1,required};
      const evaluation=object(request.evaluation)?request.evaluation:null;
      const status=clientSimulatorEvidenceOutcome(evaluation,true,run.status);
      const promoted=evaluation?{...evaluation,outcome:status}:null;
      const reprocess={retryEvidence:false,resumeTesting:false,requireMutatingConfirm:false};
      const notes=`${run.notes??""} Outcome: ${status}.`.trim();
      const audit={at:now,stage:"pdf_reprocessing",result:"COMPLETED",priorStatus:run.status,statusAfter:status,note:"PDF Client Simulator diambil ulang dari Client Simulator Activity. Send tidak dijalankan. HTTP dan SNAP yang tersimpan tidak diubah.",actorId:operator.id,actorUsername:operator.username,actorName:operator.name};
      await this.db.query("UPDATE autosnap_runs SET status=$1, notes=$2, request_json=jsonb_set(request_json || $3::jsonb,'{reprocessAudit}',COALESCE(request_json->'reprocessAudit','[]'::jsonb)||$4::jsonb,true) WHERE id=$5",[status,notes,JSON.stringify({outcome:status,evaluation:promoted,aspiActivities,pdfCounts,reprocess,evidenceErrors:[]}),JSON.stringify([audit]),run.id]);
      return res.json({ok:true,status,notes,complete:true,stored:1,required,missing:[],pdfCounts,reprocess,reprocessAudit:[audit],processing:false});
    }catch(error){
      if(error instanceof AspiAutomationError&&error.outcome==="ASPI_SESSION_BUSY")return this.fail(res,clientError("Akun ASPI ini sedang dipakai. PDF yang sudah tersimpan tetap aman. Transaksi tidak dijalankan ulang.",409,"ASPI_SESSION_BUSY"));
      if(error instanceof AspiAutomationError)return this.fail(res,clientError("Sesi ASPI telah berakhir. Login ulang diperlukan sebelum mengambil bukti.",502,"ASPI_SESSION_EXPIRED"));
      if(error instanceof ClientSimulatorPortalError){
        const status=error.code==="ASPI_ACTIVITY_NOT_FOUND"||error.code==="ASPI_ACTIVITY_AMBIGUOUS"?409:502;
        return this.fail(res,clientError(error.userMessage,status,error.code));
      }
      const message=error instanceof Error?error.message:"PDF Client Simulator gagal diambil.";
      const storage=/disimpan|database|constraint/i.test(message);
      return this.fail(res,clientError(storage?"PDF berhasil diterima tetapi gagal disimpan. Status evidence belum lengkap.":message,502,storage?"ASPI_PDF_STORAGE_FAILED":"ASPI_DOWNLOAD_TRIGGER_FAILED"));
    }
  }
  private async resumeTesting(res:Response,input:Input,operator:Operator){
    const runId=String(input.id??"");
    const run=await this.loadAccessibleRun(runId,operator);
    if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
    try{this.requireCrossUserConfirm(run,operator,input,"Lanjutkan Testing");}catch(error){return this.fail(res,error);}
    const request=object(run.request_json)?run.request_json:{};
    const checkpoint=(object(request.checkpoint)?request.checkpoint:null) as RunCheckpoint|null;
    const fail=failedStage(checkpoint);
    const hasTargetHttp=hasRecordedHttp(run);
    if(!canResumeTesting({status:run.status,hasTargetHttp,failedStageId:fail?.id??null})&&!(requiresMutatingConfirm(String(request.method??"POST"),hasTargetHttp,fail?.id==="api_request")||(!hasTargetHttp&&fail?.id==="api_request"))){
      return this.fail(res,clientError("Lanjutkan Testing tidak tersedia. Gunakan Proses Ulang Bukti atau jalankan pengujian baru.",409));
    }
    if(hasTargetHttp)return this.fail(res,clientError("HTTP target sudah tercatat. Ulangi hanya bukti PDF atau mulai pengujian baru.",409));
    const method=String(request.method??"POST");
    if(requiresMutatingConfirm(method,false,fail?.id==="api_request")&&input.confirmMutatingRetry!==true){
      return this.fail(res,clientError("Eksekusi ulang API berpotensi menduplikasi transaksi. Kirim confirmMutatingRetry=true untuk melanjutkan pada history yang sama.",409));
    }
    const rows=await this.allRecords();
    const resumeInput={
      clientId:run.client_id,projectId:run.project_id,environmentId:run.environment_id,userId:run.user_id,
      serviceId:run.service_id,endpointId:run.endpoint_id,body:typeof request.body==="string"?request.body:JSON.stringify(request.body??{}),
      testType:object(request.context)?String(request.context.testType??"positive"):"positive",
      useCase:object(request.context)?String(request.context.useCase??"B2B"):"B2B",
      progressId:randomUUID(),resumeRunId:runId,confirmMutatingRetry:input.confirmMutatingRetry===true,
      // Keep original ownership when Admin resumes another user's run.
      ownerOperatorId:run.operator_id??operator.id,
      resumeActorId:operator.id,
    };
    if(!get(rows,resumeInput.clientId,"client")||!get(rows,resumeInput.serviceId,"service"))return this.fail(res,clientError("Konfigurasi master data untuk resume tidak lengkap.",409));
    return await this.run(res,resumeInput,operator);
  }
  private async setup(req:Request,res:Response,input:Input){
    await this.enforceRateLimit(`setup:${clientAddress(req)}`,5,15*60_000);
    const count=await this.db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_users");
    if(Number(count?.n))return this.fail(res,clientError("Admin sudah dibuat.",409));
    const host=String(req.headers["x-autosnap-host"]??req.hostname).split(":")[0],local=["localhost","127.0.0.1"].includes(host);
    if((process.env.NODE_ENV==="production"||!local)&&(!process.env.AUTOSNAP_SETUP_TOKEN||input.setupToken!==process.env.AUTOSNAP_SETUP_TOKEN))return this.fail(res,clientError("Setup publik memerlukan AUTOSNAP_SETUP_TOKEN.",403));
    await verifyRecaptcha(input,req.ip);
    const id=await createAccount(this.db,input,"admin",true,true);
    await this.newSession(req,res,id);return res.json({ok:true});
  }
  private async login(req:Request,res:Response,input:Input){
    await this.enforceRateLimit(`login:${clientAddress(req)}`,20,15*60_000);
    const username=String(input.username??input.email??"").trim().toLowerCase(),password=String(input.password??"");
    if(!username||username.length>120||!password||password.length>256)return this.fail(res,clientError("Username atau password salah.",401));
    await this.enforceRateLimit(`login-account:${username}`,10,15*60_000);
    const row=await this.db.one<Operator&{salt:string;password_hash:string}>("SELECT * FROM autosnap_users WHERE LOWER(username)=$1 OR LOWER(email)=$1",[username]);
    const valid=await verifyPassword(password,row??{salt:"00".repeat(16),password_hash:"00".repeat(32)});
    if(!row||!valid)return this.fail(res,clientError("Username atau password salah.",401));
    if(!row.active)return this.fail(res,clientError("Akun belum aktif. Hubungi admin AutoSNAP.",403));
    await this.newSession(req,res,row.id);return res.json({ok:true});
  }
  private async enforceRateLimit(key:string,max:number,windowMs:number){
    const bucket=Math.floor(Date.now()/windowMs),now=new Date().toISOString();
    await this.db.query("DELETE FROM autosnap_rate_limits WHERE expires_at<$1",[now]);
    const result=await this.db.one<{attempts:number}>("INSERT INTO autosnap_rate_limits (key,attempts,expires_at) VALUES ($1,1,$2) ON CONFLICT (key) DO UPDATE SET attempts=autosnap_rate_limits.attempts+1 RETURNING attempts",[sha256(`${key}:${bucket}`),new Date((bucket+1)*windowMs).toISOString()]);
    if(!result||result.attempts>max)throw clientError("Terlalu banyak permintaan. Tunggu beberapa menit lalu coba lagi.",429);
  }
  private async save(res:Response,input:Input,actor?:Operator){
    const kind=String(input.kind??""),id=input.id?String(input.id):randomUUID(),name=String(input.name??"").trim(),parentId=input.parentId?String(input.parentId):null;
    let partnerId=input.partnerId?String(input.partnerId).trim():null;
    if(!kinds.has(kind)||!name||name.length>120)return this.fail(res,clientError("Jenis dan nama data tidak valid."));
    const rows=await this.allRecords(),old=rows.find(row=>row.id===id);
    if(old&&old.kind!==kind)return this.fail(res,clientError("Jenis data tidak dapat diubah."));
    if(kind==="endpoint"&&parentId)return this.fail(res,clientError("Dev Site Endpoint adalah akar konfigurasi; parent harus kosong."));
    if(kind==="sim_provider"&&parentId)return this.fail(res,clientError("Penyedia Client Simulator adalah akar; parent harus kosong."));
    // Keep Dev Site and Client Simulator master-data trees isolated.
    if(kind==="service"&&parentId&&get(rows,parentId,"sim_provider"))return this.fail(res,clientError("API Service Dev Site tidak dapat digantungkan pada Penyedia Client Simulator."));
    if(kind==="sim_service"&&parentId&&get(rows,parentId,"endpoint"))return this.fail(res,clientError("API Service Client Simulator tidak dapat digantungkan pada Dev Site Endpoint."));
    if(kind==="template"&&parentId&&!get(rows,parentId,"endpoint"))return this.fail(res,clientError("Template hanya untuk Dev Site Endpoint."));
    if(parentKinds[kind]&&!get(rows,parentId,parentKinds[kind]))return this.fail(res,clientError(`Pilih ${parentKinds[kind]} induk yang valid.`));
    const incoming=input.data&&typeof input.data==="object"&&!Array.isArray(input.data)?input.data as Record<string,unknown>:{};
    const data:Record<string,unknown>={...(old?.data??{}),...incoming};
    if(kind==="client"){
      if(!data.partnerIdSource)data.partnerIdSource=old?"custom":"client_id";
      if(!["client_id","custom"].includes(String(data.partnerIdSource)))return this.fail(res,clientError("Sumber Partner ID tidak valid."));
      if(data.partnerIdSource==="client_id")partnerId=String(data.clientId??"").trim();
      if(!partnerId||!/^[A-Za-z0-9._-]{1,36}$/.test(partnerId))return this.fail(res,clientError("Client ID / Partner ID maksimal 36 karakter dan harus unik."));
      if(rows.some(row=>row.partner_id===partnerId&&row.id!==id))return this.fail(res,clientError("Partner ID sudah dipakai.",409));
      const headerErrors=validateHeaderProfile(data);if(headerErrors.length)return this.fail(res,clientError(headerErrors.join(" ")));
    }else if(partnerId)return this.fail(res,clientError("Partner ID hanya digunakan pada Client."));
    for(const field of secretFields){
      if(!(field in incoming))continue;
      const secret=incoming[field];
      if(secret==="••••••••"){if(old)data[field]=old.data[field];else delete data[field];}
      else if(typeof secret==="string"&&secret)data[field]=encrypt(secret);
      else if(old?.data[field])data[field]=old.data[field];
      else delete data[field];
    }
    if(kind==="client"&&!data.clientId)return this.fail(res,clientError("Client ID wajib diisi."));
    if(kind==="snap_user"){
      const email=String(data.email??data.username??"").trim().toLowerCase();
      if(email&&!/^\S+@\S+\.\S+$/.test(email))return this.fail(res,clientError("Email User SNAP harus valid jika diisi."));
      if(email&&rows.some(row=>row.kind==="snap_user"&&row.id!==id&&String(row.data.email??row.data.username??"").toLowerCase()===email))return this.fail(res,clientError("Email User SNAP sudah digunakan.",409));
      const displayUsername=String(data.displayUsername??"").trim().replace(/[ \t\f\v]+/g," ");
      if(displayUsername.includes("@"))return this.fail(res,clientError("Username User SNAP tidak boleh berisi email."));
      if(displayUsername.length>80)return this.fail(res,clientError("Username User SNAP maksimal 80 karakter."));
      data.displayUsername=displayUsername;
      data.email=email;
      data.username=email;
    }
    if(kind==="service"&&data.config)validateConfig(data.config);
    if(kind==="service"&&data.code&&!/^\d{2}$/.test(String(data.code)))return this.fail(res,clientError("Service code harus dua digit."));
    if(kind==="service"&&data.requestBody)try{if(!object(JSON.parse(String(data.requestBody))))throw Error();}catch{return this.fail(res,clientError("Default Request Body harus object JSON valid."));}
    if(kind==="service")Object.assign(data,annotateServiceData(data));
    if(kind==="environment"){
      // New environments are Dev Site only. Legacy "Client Simulator" category rows remain readable.
      if(!["Dev Site","Client Simulator"].includes(String(data.category)))return this.fail(res,clientError("Kategori environment tidak valid."));
      if(String(data.category)==="Client Simulator"&&!old)return this.fail(res,clientError("Environment Client Simulator legacy tidak dapat dibuat lagi. Gunakan Penyedia Client Simulator."));
      // Dev Site Client is always portal/ASPI Sandbox.
      if(String(data.category)==="Dev Site"){
        data.mode="portal";
        data.executionMode="portal";
      }
      if(!["mock","live","portal"].includes(String(data.mode)))return this.fail(res,clientError("Mode environment tidak valid."));
      if(data.authFlow&&!["token_b2b","direct_rsa","provided_token"].includes(String(data.authFlow)))return this.fail(res,clientError("Alur authorization tidak valid."));
      if(data.useCase&&!["B2B","B2B2C"].includes(String(data.useCase)))return this.fail(res,clientError("Use case harus B2B atau B2B2C."));
      for(const field of ["rsaEncoding","hmacEncoding"])if(data[field]&&!["hex","base64"].includes(String(data[field])))return this.fail(res,clientError("Encoding signature harus hex atau base64."));
      if(data.tokenPath&&!/^\/(?!\/)[^\s?#]*$/.test(String(data.tokenPath)))return this.fail(res,clientError("Path token harus relative path tanpa query."));
      if(data.mode==="live")try{if(new URL(String(data.baseUrl??"")).protocol!=="https:")return this.fail(res,clientError("Base URL live wajib HTTPS."));}catch{return this.fail(res,clientError("Base URL live wajib HTTPS."));}
    }
    if(kind==="endpoint"&&(!methods.includes(String(data.method))||(data.path&&!/^\/(?!\/)[^\s]*$/.test(String(data.path)))))return this.fail(res,clientError("Method atau path endpoint tidak valid."));
    if(kind==="endpoint"&&data.portalUrl)try{const url=new URL(String(data.portalUrl));if(url.protocol!=="https:"||url.hostname!=="apidevportal.aspi-indonesia.or.id"||!url.pathname.startsWith("/api-services/"))throw Error();}catch{return this.fail(res,clientError("URL Aplikasi Pengujian harus berasal dari halaman api-services ASPI Developer Portal."));}
    if(kind==="template"){
      try{JSON.parse(String(data.body??"{}"));}catch{return this.fail(res,clientError("Template body harus JSON valid."));}
      if(data.headers&&typeof data.headers!=="object")return this.fail(res,clientError("Header tambahan harus objek JSON."));
    }
    if(kind==="sim_provider"){
      try{if(new URL(String(data.baseUrl??"")).protocol!=="https:")return this.fail(res,clientError("Base URL penyedia wajib HTTPS."));}catch{return this.fail(res,clientError("Base URL penyedia wajib HTTPS."));}
      {
        const clientId=String(data.clientId??"").trim();
        const legacyKey=String(data.clientKey??"").trim();
        if(clientId&&legacyKey&&clientId!==legacyKey)return this.fail(res,clientError("Client ID dan Client Key lama berbeda. Simpan ulang dengan satu nilai Client ID yang benar."));
        const resolved=clientId||legacyKey;
        if(!resolved)return this.fail(res,clientError("Client ID penyedia wajib diisi."));
        data.clientId=resolved;
        delete data.clientKey;
      }
      const partner=String(data.partnerId??"").trim();
      if(!partner)return this.fail(res,clientError("X-PARTNER-ID penyedia wajib diisi."));
      if(!/^[A-Za-z0-9._-]{1,36}$/.test(partner))return this.fail(res,clientError("X-PARTNER-ID maksimal 36 karakter tanpa spasi."));
      if(rows.some(row=>row.kind==="sim_provider"&&row.id!==id&&String(row.data.partnerId??"").trim()===partner))return this.fail(res,clientError("X-PARTNER-ID sudah dipakai penyedia lain.",409));
      data.partnerId=partner;
      const channelId=String(data.channelId??"").trim();
      const deviceId=String(data.deviceId??"").trim();
      if(!channelId)return this.fail(res,clientError("CHANNEL-ID penyedia wajib diisi."));
      if(channelId.length>5)return this.fail(res,clientError("CHANNEL-ID maksimal 5 karakter."));
      if(!deviceId)return this.fail(res,clientError("X-DEVICE-ID penyedia wajib diisi."));
      data.channelId=channelId;
      data.deviceId=deviceId;
      for(const field of ["origin","ipAddress","latitude","longitude"] as const)if(field in data)data[field]=String(data[field]??"").trim();
      const headerErrors=validateHeaderProfile(data);if(headerErrors.length)return this.fail(res,clientError(headerErrors.join(" ")));
      try{data.signatureAccessTokenMode=normalizeSignatureMode(data.signatureAccessTokenMode??"FUNCTION");data.signatureServiceMode=normalizeSignatureMode(data.signatureServiceMode??"FUNCTION");}catch(error){return this.fail(res,error);}
      if(data.signatureAccessTokenMode==="HIT_API"&&!String(data.signatureAccessTokenUrl??"").trim())return this.fail(res,clientError("Endpoint Signature Authentication wajib untuk mode HIT_API."));
      if(data.signatureServiceMode==="HIT_API"&&!String(data.signatureServiceUrl??"").trim())return this.fail(res,clientError("Endpoint Signature Service wajib untuk mode HIT_API."));
      if((data.signatureAccessTokenMode==="HIT_API"||data.signatureAccessTokenMode==="FUNCTION")&&!data.privateKey&&!data.signatureAuthPrivateKey)return this.fail(res,clientError("Private Key PEM wajib. Mode HIT_API mengubah PEM itu menjadi base64 sebelum signature-auth."));
      if(data.signatureServiceMode==="HIT_API"&&!data.clientSecret)return this.fail(res,clientError("Client Secret wajib untuk HIT_API Signature Service."));
      if(data.rsaEncoding&&!["hex","base64"].includes(String(data.rsaEncoding)))return this.fail(res,clientError("Encoding RSA harus hex atau base64."));
      if(data.hmacEncoding&&!["hex","base64"].includes(String(data.hmacEncoding)))return this.fail(res,clientError("Encoding HMAC harus hex atau base64."));
      const baseUrl=String(data.baseUrl??"").trim();
      try{
        data.accessTokenUrl=normalizeEndpointPath(String(data.accessTokenUrl??"").trim()||"/api/v1.0/access-token/b2b",baseUrl);
        data.signatureAccessTokenUrl=normalizeEndpointPath(String(data.signatureAccessTokenUrl??""),baseUrl);
        data.signatureServiceUrl=normalizeEndpointPath(String(data.signatureServiceUrl??""),baseUrl);
      }catch(error){return this.fail(res,error);}
      const ts=data.timestampConfig&&typeof data.timestampConfig==="object"&&!Array.isArray(data.timestampConfig)?data.timestampConfig as Record<string,unknown>:{offsetMinutes:420,includeMillis:false};
      const offset=Number(ts.offsetMinutes??420);
      if(!Number.isFinite(offset)||Math.abs(offset)>14*60)return this.fail(res,clientError("Offset timezone timestamp tidak valid."));
      data.timestampConfig={offsetMinutes:Math.trunc(offset),includeMillis:ts.includeMillis===true};
      // Never mix Client Simulator provider config with Dev Site Endpoint ASPI fields.
      delete data.portalUrl;delete data.config;delete data.allowPrivateKeyToSigner;
    }
    if(kind==="sim_service"){
      if(/[\u0000-\u001F\u007F]/.test(name))return this.fail(res,clientError("Nama API Service tidak boleh berisi baris baru atau karakter kontrol."));
      if(!methods.includes(String(data.method??"")))return this.fail(res,clientError("Method HTTP service tidak valid."));
      const path=String(data.path??data.serviceUrl??"").trim();
      if(!path.startsWith("/")||path.startsWith("//"))return this.fail(res,clientError("Service URL / Relative Path harus diawali / tanpa protokol."));
      data.path=path;
      for(const field of ["channelId","deviceId","partnerId","externalId"] as const){
        if(!(field in data))continue;
        const text=String(data[field]??"").trim();
        if(!text){delete data[field];continue;}
        data[field]=text;
      }
      if(data.channelId&&String(data.channelId).length>5)return this.fail(res,clientError("CHANNEL-ID maksimal 5 karakter."));
      if(data.partnerId&&!/^[A-Za-z0-9._-]{1,36}$/.test(String(data.partnerId)))return this.fail(res,clientError("X-PARTNER-ID maksimal 36 karakter tanpa spasi."));
      if(data.externalId&&/[\r\n]/.test(String(data.externalId)))return this.fail(res,clientError("X-EXTERNAL-ID harus teks tanpa baris baru."));
      const overrideHeaders:Record<string,unknown>={};
      for(const field of ["channelId","deviceId","origin","ipAddress","latitude","longitude"] as const)if(data[field])overrideHeaders[field]=data[field];
      const headerErrors=validateHeaderProfile(overrideHeaders);if(headerErrors.length)return this.fail(res,clientError(headerErrors.join(" ")));
      if(data.defaultBody||data.requestBody){
        try{const body=String(data.defaultBody??data.requestBody);if(body.trim()&&!object(JSON.parse(body)))throw Error();data.defaultBody=body;}catch{return this.fail(res,clientError("Default request body harus object JSON valid."));}
      }
      if(data.expectedHttpStatus!=null&&data.expectedHttpStatus!==""&&!(Number(data.expectedHttpStatus)>=100&&Number(data.expectedHttpStatus)<=599))return this.fail(res,clientError("Expected HTTP Status tidak valid."));
      if(typeof data.expectedCode==="string"&&/[\u0000-\u001F\u007F]/.test(data.expectedCode))return this.fail(res,clientError("Expected SNAP Response Code tidak valid."));
      const serviceCode=String(data.serviceCode??"").trim();
      if(serviceCode&&!/^\d{2}$/.test(serviceCode))return this.fail(res,clientError("Kode service SNAP harus dua digit."));
      data.serviceCode=serviceCode;
      for(const field of [...secretFields,"baseUrl","clientKey","clientId","signatureAccessTokenUrl","signatureServiceUrl","signatureAccessTokenMode","signatureServiceMode"])delete data[field];
    }
    const now=new Date().toISOString();
    if(old)await this.db.query("UPDATE autosnap_records SET name=$1,parent_id=$2,partner_id=$3,data=$4::jsonb,updated_at=$5 WHERE id=$6",[name,parentId,partnerId,JSON.stringify(data),now,id]);
    else await this.db.query("INSERT INTO autosnap_records (id,kind,name,parent_id,partner_id,data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)",[id,kind,name,parentId,partnerId,JSON.stringify(data),now]);
    if(actor)await writeAudit(this.db,actor.id,old?"update_record":"create_record",kind,id,{name});
    return res.json({ok:true,id});
  }
  private async remove(res:Response,input:Input,actor?:Operator){
    const id=String(input.id??""),rows=await this.allRecords(),row=rows.find(item=>item.id===id);
    if(!row)return this.fail(res,clientError("Data tidak ditemukan.",404));
    if(rows.some(item=>item.parent_id===id&&item.kind!=="template"))return this.fail(res,clientError("Data masih dipakai. Hapus atau pindahkan data turunannya dahulu.",409));
    if(row.kind==="snap_user"&&rows.some(item=>item.kind==="environment"&&value(item,"defaultUserId")===id))return this.fail(res,clientError("User SNAP masih dipakai oleh Dev Site Client.",409));
    if(row.kind==="sim_provider"&&rows.some(item=>item.parent_id===id))return this.fail(res,clientError("Hapus seluruh API Service penyedia terlebih dahulu.",409));
    await this.db.transaction(async query=>{
      await query("DELETE FROM autosnap_records WHERE kind='template' AND parent_id=$1",[id]);
      await query("DELETE FROM autosnap_records WHERE id=$1",[id]);
      if(row.kind==="environment"){
        const project=rows.find(item=>item.id===row.parent_id&&item.kind==="project");
        if(project&&!rows.some(item=>item.kind==="environment"&&item.id!==id&&item.parent_id===project.id)){
          await query("UPDATE autosnap_records SET parent_id=NULL WHERE kind='snap_user' AND parent_id=$1",[project.id]);
          await query("DELETE FROM autosnap_records WHERE id=$1",[project.id]);
          if(!rows.some(item=>item.kind==="project"&&item.id!==project.id&&item.parent_id===project.parent_id))await query("DELETE FROM autosnap_records WHERE id=$1 AND kind='client'",[project.parent_id]);
        }
      }
    });
    if(actor)await writeAudit(this.db,actor.id,"delete_record",row.kind,id,{name:row.name});
    return res.json({ok:true});
  }
  private async updateProgress(id:string,userId:string,stage:string,status:"queued"|"running"|"completed"|"failed"|"cancelled",detail=""){
    return this.db.transaction(async query=>{
      const current=(await query<{steps:unknown;status:string}>("SELECT steps,status FROM autosnap_test_progress WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,userId]))[0];
      if(current?.status==="cancel_requested"&&stage==="finished"){status="cancelled";detail="Pengujian dibatalkan pengguna. Request yang sudah terkirim tetap tercatat.";}
      const steps=Array.isArray(current?.steps)?current.steps.filter(object):[];
      const next=steps.slice(-499);
      next.push({stage,status,detail,at:new Date().toISOString()});
      await query("UPDATE autosnap_test_progress SET status=$1,stage=$2,steps=$3::jsonb,updated_at=$4 WHERE id=$5 AND user_id=$6",[current?.status==="cancel_requested"&&stage!=="finished"?"cancel_requested":status,stage,JSON.stringify(next),new Date().toISOString(),id,userId]);
      return status;
    });
  }
  private async run(res:Response,input:Input,operator:Operator,pdfCapture:PdfCaptureProfile={kind:"chrome"}){
    const rows=await this.allRecords(),sourceClient=get(rows,input.clientId,"client"),project=get(rows,input.projectId,"project"),environment=get(rows,input.environmentId,"environment"),snapUser=input.userId?get(rows,input.userId,"snap_user"):null,service=get(rows,input.serviceId,"service"),endpoint=get(rows,input.endpointId,"endpoint"),template=input.templateId?get(rows,input.templateId,"template"):rows.find(row=>row.kind==="template"&&row.parent_id===input.endpointId);
    if(!sourceClient||!project||!environment||!service||!endpoint)return this.fail(res,clientError("Konfigurasi test belum lengkap."));
    if(input.userId&&!snapUser)return this.fail(res,clientError("User SNAP tidak ditemukan."));
    const serviceEndpointValid=service.parent_id===endpoint.id&&!endpoint.parent_id;
    const userValid=!!snapUser&&value(environment,"defaultUserId")===snapUser.id;
    if(project.parent_id!==sourceClient.id||environment.parent_id!==project.id||!serviceEndpointValid||!userValid)return this.fail(res,clientError("Relasi data pengujian tidak sesuai."));
    const client=withSentProfile(sourceClient,environment);
    if(input.templateId&&(!template||template.parent_id!==endpoint.id))return this.fail(res,clientError("Template tidak melekat pada endpoint terpilih."));
    const mode=value(environment,"mode");
    if(!hasPrivilege(operator,mode==="mock"?"client_simulator":"dev_site"))return this.fail(res,clientError("Anda tidak memiliki privilege untuk menjalankan pengujian ini.",403));
    if(mode==="portal"&&snapUser&&await this.evidenceService.accountBusy(snapUser))return this.fail(res,clientError("Akun ASPI ini sedang dipakai untuk pengujian atau pengambilan bukti. Tunggu hingga selesai.",409,"ASPI_SESSION_BUSY"));
    const resolved=resolveEndpoint(endpoint,service);
    let method=resolved.method,path=resolved.path;
    const {serviceCode,config,legacyBalance}=resolved;
    const isBalance=method==="POST"&&path===BALANCE_PATH&&String(input.testType??"positive")!=="custom";
    const workflow=authenticationWorkflow(config??{authFlow:"b2b",parameters:[]});
    if(value(environment,"category")!=="Dev Site")return this.fail(res,clientError("Pengujian saat ini hanya untuk Dev Site."));
    if(!["mock","live","portal"].includes(mode))return this.fail(res,clientError("Mode environment tidak valid."));
    if(path===BALANCE_PATH&&method!=="POST")return this.fail(res,clientError("Balance Inquiry harus menggunakan POST."));
    if(mode==="live"){
      const missing:string[]=[];
      for(const [key,label] of [["baseUrl","Base URL Bank Sumut"],["tokenPath","Path API Keamanan / access token"],["rsaEncoding","Encoding RSA"],["hmacEncoding","Encoding HMAC"]])if(!value(environment,key))missing.push(label);
      for(const [key,label] of [["clientId","Client ID"],["clientSecret","Client Secret"],["privateKey","Private Key"],["channelId","CHANNEL-ID"]])if(!value(client,key))missing.push(label);
      if(!client.partner_id)missing.push("X-PARTNER-ID");
      if(missing.length)return this.fail(res,clientError("Lengkapi Master Data Dev Site Client sebelum hit API: "+missing.join(", ")+"."));
    }
    if(mode==="portal"){
      const missing:string[]=[];
      if(!value(endpoint,"portalUrl"))missing.push("URL Aplikasi Pengujian endpoint");
      if(workflow.profile.token!=="none")for(const [key,label] of [["clientId","Client ID"],["channelId","CHANNEL-ID"],...(workflow.profile.token==="b2b"?[["privateKey","Private Key"]]:[["accessToken","Access token tersimpan"]]),...(workflow.profile.signature==="hmac"?[["clientSecret","Client Secret"]]:[])])if(!value(client,key))missing.push(label);
      if(config?.authFlow!=="none"&&!client.partner_id)missing.push("X-PARTNER-ID");
      if(!snapUser||!value(snapUser,"email")||!value(snapUser,"password"))missing.push("Email dan Password User SNAP");
      if(missing.length)return this.fail(res,clientError("Lengkapi Master Data untuk browser ASPI: "+missing.join(", ")+"."));
    }
    if(!path||!path.startsWith("/"))return this.fail(res,clientError("Endpoint harus dikonfigurasi sebelum dijalankan."));
    if(/production|prod\b/i.test(environment.name))return this.fail(res,clientError("Target production tidak diizinkan untuk automation ini."));
    const useCase=String(config?(config.authFlow==="b2b2c"?"B2B2C":"B2B"):input.useCase??environment.data.useCase??"B2B") as UseCase;
    if(!["B2B","B2B2C"].includes(useCase))return this.fail(res,clientError("Pilih use case B2B atau B2B2C."));
    const testType=String(input.testType??"positive");
    // "custom" (Lainnya) replaces the old positive label; keep "positive" for history resume compatibility.
    if(!["positive","custom","invalid_access_token"].includes(testType))return this.fail(res,clientError("Jenis testing tidak valid."));
    const negativeAccessToken=testType==="invalid_access_token";
    const custom=testType==="custom"&&object(input.customOverride)?input.customOverride:{};
    const customMethod=String(custom.method??"").trim().toUpperCase();
    const customPath=String(custom.path??"").trim();
    const customExpectedHttp=custom.expectedHttpStatus===undefined||custom.expectedHttpStatus===null||custom.expectedHttpStatus===""?null:Number(custom.expectedHttpStatus);
    const customExpectedCode=String(custom.expectedCode??"").trim();
    const customHeaders=object(custom.headers)?Object.fromEntries(Object.entries(custom.headers).filter(([,v])=>typeof v==="string").map(([k,v])=>[String(k),String(v).trim()])):{};
    if(testType==="custom"){
      if(customMethod&&!["GET","POST","PUT","PATCH","DELETE","HEAD"].includes(customMethod))return this.fail(res,clientError("Method Lainnya tidak valid."));
      if(customPath&&(!customPath.startsWith("/")||customPath.startsWith("//")))return this.fail(res,clientError("Path Lainnya harus diawali /."));
      if(customExpectedHttp!==null&&!(Number.isInteger(customExpectedHttp)&&customExpectedHttp>=100&&customExpectedHttp<=599))return this.fail(res,clientError("Expected HTTP Lainnya harus 100–599."));
      if(customExpectedCode&&!/^\d{7}$/.test(customExpectedCode))return this.fail(res,clientError("Expected SNAP Code Lainnya harus 7 digit."));
      for(const required of ["CHANNEL-ID"])if(required in customHeaders&&!String(customHeaders[required]??"").trim())return this.fail(res,clientError(`${required} wajib diisi pada override header.`));
    }
    const expectation=scenarioExpectation(config,legacyBalance,negativeAccessToken,service.data);
    if(testType==="custom"){
      if(customExpectedHttp!==null)expectation.expectedHttpStatus=customExpectedHttp;
      if(customExpectedCode)expectation.expectedCode=customExpectedCode;
      if(customMethod)method=customMethod;
      if(customPath)path=customPath;
    }
    const dynamicParameters=object(input.parameters)?input.parameters:{};
    if(config){
      if(mode!=="portal"&&mode!=="mock")return this.fail(res,clientError("Service dinamis menggunakan portal ASPI atau simulator."));
      if(config.authFlow==="b2b2c"&&(!value(snapUser??undefined,"customerToken")||!value(client,"deviceId")))return this.fail(res,clientError("B2B2C memerlukan customer token dan X-DEVICE-ID yang valid."));
      const managed=managedHeaders;
      for(const name of Object.keys(dynamicParameters))if(!config.parameters.some(p=>p.name===name)||managed.has(name.toLowerCase()))return this.fail(res,clientError("Parameter tidak dikenal atau mengganti header yang dikelola sistem."));
      for(const p of config.parameters.filter(p=>p.in==="header"))if(dynamicParameters[p.name]!==undefined)checkHeaders({[p.name]:String(dynamicParameters[p.name])});
      for(const parameter of config.parameters)if(parameter.required&&!managed.has(parameter.name.toLowerCase())&&(dynamicParameters[parameter.name]===undefined||dynamicParameters[parameter.name]===""))return this.fail(res,clientError(`Parameter ${parameter.name} wajib.`));
    }
    if(useCase==="B2B2C"&&isBalance&&(!snapUser||!value(snapUser,"customerToken")||!value(client,"deviceId")))return this.fail(res,clientError("Balance Inquiry B2B2C memerlukan User SNAP, customer access token, dan X-DEVICE-ID."));
    if(useCase==="B2B2C"&&value(snapUser??undefined,"customerTokenExpiresAt")&&Date.parse(value(snapUser??undefined,"customerTokenExpiresAt"))<=Date.now())return this.fail(res,clientError("Customer token kedaluwarsa. Perbarui melalui Keamanan sebelum testing."));
    const scenarios=await this.catalog(),scenarioId=input.scenarioId?String(input.scenarioId):null,scenario=scenarioId?scenarios.find(item=>item.id===scenarioId):null;
    if(scenarioId&&!scenario)return this.fail(res,clientError("Skenario tidak ditemukan."));
    if(scenario){
      const groups=new Set(scenarios.filter(item=>!item.expectedCode?.includes("xx")&&item.expectedCode?.slice(3,5)===serviceCode).map(item=>item.group));
      if(!groups.has(scenario.group)||(!scenario.expectedCode?.includes("xx")&&scenario.expectedCode?.slice(3,5)!==serviceCode))return this.fail(res,clientError("Skenario tidak sesuai dengan API service yang dipilih."));
    }
    const readSecret=(field:string)=>{const stored=value(snapUser??undefined,field);if(!stored)throw clientError("Isi "+field+" pada Master Data > User SNAP terlebih dahulu.");return decrypt(stored);};
    const body=prepareBody(input.body,method,config,value(client,"deviceId"),readSecret);
    resolveRequestPath(path,config?.parameters??[],dynamicParameters);
    // Registration data belongs to User SNAP. Reuse it when Balance Inquiry
    // does not provide an explicit account, so operators never retype secrets.
    if(legacyBalance&&!negativeAccessToken&&snapUser&&!body.accountNo&&!body.bankCardToken&&!scenarioId?.endsWith(".3")&&!scenarioId?.endsWith(".4")){
      if(value(snapUser,"accountNo"))body.accountNo=decrypt(value(snapUser,"accountNo"));
      else if(value(snapUser,"bankCardToken"))body.bankCardToken=decrypt(value(snapUser,"bankCardToken"));
    }
    const capabilities=resolveCapabilities(service);
    let automaticRegistration:{portalUrl:string;path:string;body:Record<string,unknown>}|null=null;
    const autoRegisterCode=capabilities.autoRegisterFromCode;
    if(mode==="portal"&&autoRegisterCode&&isBalance&&!negativeAccessToken&&!body.accountNo&&!body.bankCardToken&&!scenarioId?.endsWith(".3")&&!scenarioId?.endsWith(".4")){
      const registrationService=rows.find(row=>row.kind==="service"&&value(row,"code")===autoRegisterCode);
      const registrationEndpoint=registrationService?rows.find(row=>row.kind==="endpoint"&&row.id===registrationService.parent_id&&!row.parent_id):undefined;
      const registrationTemplate=registrationEndpoint?rows.find(row=>row.kind==="template"&&row.parent_id===registrationEndpoint.id):undefined;
      const registrationRaw=registrationService?.data.requestBody??registrationTemplate?.data.body;
      if(!registrationEndpoint||!value(registrationEndpoint,"portalUrl")||typeof registrationRaw!=="string")return this.fail(res,clientError("Konfigurasi Card Registration otomatis belum lengkap di Master Data."));
      try{
        const parsed=prepareBody(registrationRaw,"POST",null,value(client,"deviceId"),readSecret);
        if(!object(parsed))throw Error();
        automaticRegistration={portalUrl:value(registrationEndpoint,"portalUrl"),path:value(registrationEndpoint,"path"),body:parsed};
      }catch{return this.fail(res,clientError("Default Request Body Card Registration harus berupa object JSON valid dan lengkap."));}
      if(/\{\{[^}]+\}\}/.test(JSON.stringify(automaticRegistration.body)))return this.fail(res,clientError("Request Card Registration otomatis masih memiliki placeholder yang belum diisi."));
    }
    if(/\{\{[^}]+\}\}/.test(JSON.stringify(body)))return this.fail(res,clientError("Masih ada placeholder yang belum diisi pada request."));
    const negativeFieldCase=scenarioId?.endsWith(".3")||scenarioId?.endsWith(".4");
    if(isBalance&&!negativeFieldCase){
      const validationBody=automaticRegistration?{...body,bankCardToken:"AUTO_FROM_CARD_REGISTRATION"}:body;
      const errors=validateBalanceRequest(validationBody,useCase==="B2B2C"&&!!value(snapUser??undefined,"customerToken"));
      if(errors.length)return this.fail(res,clientError(errors.join(" ")));
    }
    const persistOutputs=savesPrerequisite(capabilities);
    if(persistOutputs&&!snapUser)return this.fail(res,clientError("Pilih User SNAP agar hasil Registrasi atau Keamanan dapat disimpan otomatis."));
    const expected=negativeAccessToken?expectation.expectedCode:codeFor(scenario?.expectedCode,serviceCode)??expectation.expectedCode,externalId=String(input.externalId??"").trim()||Date.now().toString()+String(Math.floor(Math.random()*1000000)).padStart(6,"0");
    if(!/^[0-9]{1,36}$/.test(externalId))return this.fail(res,clientError("X-EXTERNAL-ID harus angka, maksimal 36 digit."));
    const extra=template?.data.headers;
    if(extra!==undefined&&(!object(extra)||Object.values(extra).some(x=>typeof x!=="string")))return this.fail(res,clientError("Header tambahan harus object berisi string."));
    const extraHeaders=(extra??{}) as Record<string,string>;
    const profileHeaders:Record<string,string>={};
    for(const [header,field] of [["ORIGIN","origin"],["X-IP-ADDRESS","ipAddress"],["X-LATITUDE","latitude"],["X-LONGITUDE","longitude"]])if(value(client,field))profileHeaders[header]=value(client,field);
    const requestHeaders={...profileHeaders,...extraHeaders,...(testType==="custom"?customHeaders:{})};
    const day=isoJakarta().slice(0,10),existing=await this.db.one("SELECT 1 AS n FROM autosnap_external_ids WHERE environment_id=$1 AND external_id=$2 AND day=$3",[environment.id,externalId,day]),duplicateCase=scenarioId?.endsWith(".5");
    if(duplicateCase&&!existing)return this.fail(res,clientError("Untuk skenario duplikat, isi X-EXTERNAL-ID yang sudah dijalankan hari ini."));
    if(existing&&!duplicateCase)return this.fail(res,clientError("X-EXTERNAL-ID sudah dipakai hari ini.",409));
    if(!duplicateCase){const claimed=await this.db.query("INSERT INTO autosnap_external_ids (environment_id,external_id,day) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING external_id",[environment.id,externalId,day]);if(!claimed.length)return this.fail(res,clientError("X-EXTERNAL-ID sudah dipakai hari ini.",409));}
    const progressId=/^[0-9a-f-]{36}$/i.test(String(input.progressId??""))?String(input.progressId):randomUUID();
    await this.db.query("DELETE FROM autosnap_test_progress WHERE updated_at<$1",[new Date(Date.now()-24*3600000).toISOString()]);
    const registered=await this.db.query("INSERT INTO autosnap_test_progress (id,user_id,status,stage,steps,updated_at) VALUES ($1,$2,'queued','preparing','[]'::jsonb,$3) ON CONFLICT (id) DO NOTHING RETURNING id",[progressId,operator.id,new Date().toISOString()]);
    if(!registered.length){
      const pendingCancel=await this.db.one<{status:string;stage:string;steps:unknown[]}>("SELECT status,stage,steps FROM autosnap_test_progress WHERE id=$1 AND user_id=$2",[progressId,operator.id]);
      if(pendingCancel?.status!=="cancel_requested"||pendingCancel.stage!=="cancelling"||pendingCancel.steps.some(step=>object(step)&&step.stage==="preparing"))return this.fail(res,clientError("Pengujian dengan ID ini sudah diterima. Periksa Progress atau History, jangan kirim ulang.",409));
    }
    const progressOwner=await this.db.one<{user_id:string}>("SELECT user_id FROM autosnap_test_progress WHERE id=$1",[progressId]);
    if(progressOwner?.user_id!==operator.id)return this.fail(res,clientError("ID testing sudah digunakan.",409));
    await this.updateProgress(progressId,operator.id,"preparing","completed",`${service.name} — ${method} ${path}; konfigurasi tervalidasi`);
    const progress=async(stage:string,status:"running"|"completed"|"failed",detail="")=>{await this.updateProgress(progressId,operator.id,stage,status,detail);};
    const control=new RunControl(this.db,progressId,operator.id);await control.start();
    let activePortalSession:HitResult["evidenceSession"];
    try{
    const started=Date.now();let result:HitResult;
    if(control.signal.aborted){result={status:null,outcome:"CANCELLED",body:{error:"Pengujian dibatalkan sebelum request dikirim."},request:{method,path,body}};}
    else
    if(mode==="mock"){
      await progress("api_request","running",`${service.name} — simulasi lokal ${method} ${path}`);
      const timestamp=isoJakarta(),httpStatus=expectation.expectedHttpStatus??200;
      const documented=config?.responses[String(httpStatus)],sample=object(documented)?documented.example:undefined;
      // Mock-only examples are actual simulated responses, NEVER fallback expected values.
      // Mock bodies may include a realistic SNAP code for display; negative validation still uses HTTP only.
      const mockSnap=expected??(negativeAccessToken?`${String(expectation.expectedHttpStatus??401)}${serviceCode||"00"}01`.slice(0,7):null);
      const response=object(sample)?structuredClone(sample):negativeAccessToken?{...(mockSnap?{responseCode:mockSnap}:{}),responseMessage:"Access Token Invalid",additionalInfo:{mock:true}}:isBalance?mockBalance(body,expected??mockSnap??"2001100"):{...(expected?{responseCode:expected}:{}),responseMessage:"Mock response",additionalInfo:{mock:true}};
      result={status:httpStatus,body:response,request:{method,path,timestamp,externalId,body:method==="GET"?null:body,headers:{"Content-Type":"application/json","Authorization":"[MOCK TOKEN]","X-TIMESTAMP":timestamp,"X-SIGNATURE":"[MOCK SIGNATURE]","X-PARTNER-ID":(client.data.partnerIdSource||"client_id")==="client_id"?value(client,"clientId"):client.partner_id,"X-EXTERNAL-ID":externalId,"CHANNEL-ID":value(client,"channelId"),...(useCase==="B2B2C"?{"Authorization-Customer":"[MOCK CUSTOMER TOKEN]"}:{}),...(value(client,"deviceId")?{"X-DEVICE-ID":value(client,"deviceId")}:{}),...requestHeaders}}};
      await progress("api_request","completed",`${service.name} — simulasi selesai`);
    }else if(mode==="portal"){
      try{
        result=await this.portal.hit({portalUrl:value(endpoint,"portalUrl"),path,method,body,client,user:snapUser!,externalId,extraHeaders:requestHeaders,authFlow:config?.authFlow,workflow:workflow.profile,omitBody:["GET","HEAD"].includes(method)||config?.requestBodyMode==="none"||config?.requestBodyMode==="optional"&&!String(input.body??"").trim(),serviceName:service.name,parameters:dynamicParameters,parameterDefinitions:config?.parameters,negativeAccessToken,signal:control.signal,onProgress:progress,registration:automaticRegistration?{...automaticRegistration,externalId:Date.now().toString()+String(Math.floor(Math.random()*1000000)).padStart(6,"0")}:null});
        activePortalSession=result.evidenceSession;
      }
      catch{result={status:null,outcome:"AUTOMATION_ERROR",body:{error:"Automasi Portal ASPI gagal. Periksa konfigurasi dan koneksi portal."},request:{method,path,portalUrl:value(endpoint,"portalUrl"),externalId,body}};}
    }else{
      await progress("api_request","running",`${service.name} — ${method} ${path}`);
      // Live Balance Inquiry always goes through Security token_b2b; provided_token must not bypass it.
      try{result=await this.engine.hit({baseUrl:value(environment,"baseUrl"),path,method,body,client,user:snapUser??null,scenarioId,externalId,extraHeaders:requestHeaders,negativeAccessToken,signal:control.signal,authFlow:isBalance?"token_b2b":value(environment,"authFlow")||"token_b2b",useCase,tokenPath:value(environment,"tokenPath")||"/api/v1.0/access-token/b2b",rsaEncoding:value(environment,"rsaEncoding")||"base64",hmacEncoding:value(environment,"hmacEncoding")||"hex"});}
      catch{result={status:null,outcome:"TRANSPORT_ERROR",body:{error:"Request API gagal. Periksa konfigurasi dan koneksi target."},request:{method,path,externalId,body}};}
      await progress("api_request",result.status===null?"failed":"completed",result.status===null?"Target tidak memberikan response":`${service.name} — response diterima`);
    }
    await control.check();
    if(control.signal.aborted){result={...result,outcome:"CANCELLED",body:{...(object(result.body)?result.body:{}),error:"Pengujian dibatalkan pengguna. Request yang sudah terkirim tidak dapat ditarik kembali."}};}
    if(mode==="portal")await progress("api_request",result.status===null?"failed":"completed",result.status===null?"HTTP response belum diterima":`HTTP ${result.status} diterima`);
    await progress("evaluation","running","Validasi HTTP terhadap expected status");
    const duration=Date.now()-started,responseBody=object(result.body)?result.body:{},responseCode=String(responseBody.responseCode??"")||null;
    const executedBody=object(result.request.body)?result.request.body:body;
    const registrationOutput=object(result.request.registrationOutput)?result.request.registrationOutput:null;
    if(mode==="portal"&&snapUser&&registrationOutput){
      const outputs:Record<string,unknown>={};
      for(const field of ["bankCardToken","accountNo"])if(typeof registrationOutput[field]==="string"&&registrationOutput[field])outputs[field]=encrypt(String(registrationOutput[field]));
      if(Object.keys(outputs).length)await this.db.query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE id=$3",[JSON.stringify(outputs),new Date().toISOString(),snapUser.id]);
    }
    const expectedHttp=expectation.expectedHttpStatus??(negativeAccessToken?401:200);
    const checks:ResultCheck[] = result.status === null
      ? [{ label: "HTTP Request", passed: false, detail: `API target belum memberikan HTTP response. Outcome: ${result.outcome??"UNKNOWN"}.` }]
      : config ? configuredChecks(result.status,result.body,config,{expectedCode:expected,expectedHttpStatus:expectedHttp},{negative:negativeAccessToken}) : [{label:"HTTP status",passed:result.status===expectedHttp,detail:`Expected HTTP ${expectedHttp}; actual ${result.status}.`}];
    if(config&&isBalance&&result.status!==null&&expected)checks.push(...balanceResponseChecks(result.status,result.body,expected,executedBody).filter(check=>!checks.some(existing=>existing.label===check.label)&&check.label==="HTTP status"));
    const automationChecks=object(result.request)&&Array.isArray(result.request.automationChecks)?result.request.automationChecks.filter(object).map(item=>({label:String(item.label??"Automation"),passed:item.passed===true,detail:String(item.detail??"")})):[];
    checks.push(...automationChecks);
    const evaluated=evaluateTest({httpStatus:result.status,expectedHttpStatus:expectedHttp,actualCode:responseCode,expectedCode:expected,negative:negativeAccessToken,checks,cancelled:result.outcome==="CANCELLED"});
    let status:RunStatus=evaluated.status;
    const evaluation=evaluated.evaluation,executionOutcome=result.outcome??null;
    result.outcome=evaluation.outcome as HitResult["outcome"];
    await this.updateProgress(progressId,operator.id,"evaluation",status==="FAILED"||status==="AUTOMATION_ERROR"?"failed":"completed",`${evaluation.outcome} — ${evaluation.detail}${evaluation.suggestion?` Saran: ${evaluation.suggestion}`:""}`);
    const expectedNegativeRejection=negativeAccessToken&&evaluation.httpValidation.matches&&status!=="FAILED";
    let notes = status==="CANCELLED" ? "Pengujian dibatalkan pengguna; tahap berikutnya dihentikan. Request yang sudah terkirim tidak dapat ditarik kembali."
      : expectedNegativeRejection ? "API menolak access token tidak valid sesuai ekspektasi skenario HTTP."
      : mode === "mock" ? "Pengujian menggunakan mock lokal; tidak ada request eksternal."
      : status === "AUTOMATION_ERROR" ? "Pengujian belum mendapatkan HTTP response dari API target; periksa prasyarat autentikasi dan log automasi."
      : status === "FAILED" ? (evaluation.mode==="SNAP_AND_HTTP"?"Validasi SNAP/HTTP gagal sesuai konfigurasi expected.":"HTTP response diterima, tetapi tidak sesuai expected HTTP status.")
      : evaluation.mode==="SNAP_AND_HTTP"?"SNAP dan HTTP sesuai expected; bukti PDF ASPI sedang/akan diproses.":"HTTP response sesuai expected; bukti PDF ASPI sedang/akan diproses.";
    if(result.outcome&&!expectedNegativeRejection) notes += ` Outcome: ${result.outcome}.`;
    notes += negativeAccessToken
      ? expectedNegativeRejection?` HTTP ${result.status} sesuai expected ${expectedHttp}.`:" Skenario tes negatif meminta token tidak valid."
      : ` Skenario positif ${service.name}; autentikasi ${config?.authFlow??useCase}, tanpa modifikasi token.`;
    const now=new Date().toISOString();
    const resumeRunId=typeof input.resumeRunId==="string"?input.resumeRunId:"";
    const id=resumeRunId||("RUN-"+now.slice(0,10).replaceAll("-","")+"-"+randomUUID().slice(0,8).toUpperCase());
    // Keep original ownership when Admin resumes another user's history.
    const ownerOperatorId=typeof input.ownerOperatorId==="string"&&input.ownerOperatorId?String(input.ownerOperatorId):operator.id;
    let checkpoint=buildCheckpoint(workflow.nodes,{registration:!!automaticRegistration});
    checkpoint=markStage(checkpoint,"preparing","COMPLETED","Konfigurasi tervalidasi");
    if(automaticRegistration)checkpoint=markStage(checkpoint,"registration","COMPLETED");
    for(const node of workflow.nodes)checkpoint=markStage(checkpoint,node.stage,node.stage==="api_request"?(result.status===null?"FAILED":"COMPLETED"):"COMPLETED");
    checkpoint=markStage(checkpoint,"evaluation",status==="FAILED"||status==="AUTOMATION_ERROR"?"FAILED":"COMPLETED",evaluation.detail);
    if(persistOutputs&&(mode==="live"||mode==="portal")&&snapUser&&result.status===200&&((capabilities.persistCustomerToken&&!responseCode)||responseCode==="200"+serviceCode+"00")){
      const outputs:Record<string,unknown>={};
      for(const field of capabilities.persistFields??[])if(typeof responseBody[field]==="string"&&responseBody[field])outputs[field]=encrypt(String(responseBody[field]));
      if(capabilities.persistCustomerToken&&typeof responseBody.accessToken==="string"&&responseBody.accessToken){
        outputs.customerToken=encrypt(responseBody.accessToken);
        if(typeof responseBody.refreshToken==="string")outputs.refreshToken=encrypt(responseBody.refreshToken);
        outputs.customerTokenExpiresAt=typeof responseBody.accessTokenExpiryTime==="string"&&Number.isFinite(Date.parse(responseBody.accessTokenExpiryTime))?responseBody.accessTokenExpiryTime:null;
      }
      if(Object.keys(outputs).length){
        outputs.registrationSourceRun=id;
        await this.db.query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE id=$3",[JSON.stringify(outputs),now,snapUser.id]);
        notes+=" Data hasil disimpan terenkripsi ke User SNAP terpilih.";
      }else notes+=" Tidak ada field hasil yang dikenali; isi User SNAP dari respons provider yang sudah dikonfirmasi.";
    }else if(persistOutputs&&mode==="mock")notes+=" Hasil mock tidak disimpan sebagai kredensial.";
    const cleanRequest=result.request;
    const evidenceMetadata:Array<AspiActivity&{pdfReady:boolean}>=[];
    const email=String(snapUser?.data.email??snapUser?.data.username??"");
    const evidencePlan=mode==="portal"&&snapUser&&evaluation.httpValidation.matches?buildEvidencePlan(result,path,method,service.name,email):null;
    const priorOperator=object(cleanRequest)&&object(cleanRequest.operator)?cleanRequest.operator:null;
    const operatorSnapshot=priorOperator??(ownerOperatorId===operator.id
      ?{id:operator.id,name:operator.name,username:operator.username,role:normalizeRole(operator.role)??"petugas"}
      :{id:ownerOperatorId,name:"Tidak diketahui",username:"-",role:"unknown"});
    if(resumeRunId&&ownerOperatorId!==operator.id)notes+=` (Resume oleh Admin ${operator.username}).`;
    else if(resumeRunId)notes+=" (Resume Testing).";
    const requestSnapshot:Record<string,unknown>={...cleanRequest,outcome:status,executionOutcome,evaluation,validation:checks,endpointConfiguration:config,workflow:workflow.profile,checkpoint,evidence:evidencePlan,progressId,pdfCapture,configurationIds:{endpointId:endpoint.id,serviceId:service.id,endpointRevision:endpoint.updated_at,serviceRevision:service.updated_at},expectation:{...expectation,expectedCode:expected,expectedHttpStatus:expectedHttp},aspiActivities:evidenceMetadata,reprocess:{retryEvidence:false,resumeTesting:false},operator:operatorSnapshot,context:{client:client.name,project:project.name,environment:environment.name,user:snapUser?.name??null,service:service.name,endpoint:endpoint.name,template:template?.name??null,useCase,testType}};
    if(resumeRunId){
      await this.db.query("UPDATE autosnap_runs SET status=$1,http_status=$2,response_code=$3,expected_code=$4,duration_ms=$5,request_json=$6::jsonb,response_json=$7::jsonb,notes=$8 WHERE id=$9 AND operator_id=$10",[status,result.status,responseCode,expected,duration,JSON.stringify(redact(requestSnapshot)),JSON.stringify(redact(result.body)),notes,id,ownerOperatorId]);
    }else{
      await this.db.query("INSERT INTO autosnap_runs (id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,scenario_id,mode,status,http_status,response_code,expected_code,duration_ms,request_json,response_json,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)",[id,ownerOperatorId,client.id,project.id,environment.id,snapUser?.id??null,service.id,endpoint.id,scenarioId,mode,status,result.status,responseCode,expected,duration,JSON.stringify(redact(requestSnapshot)),JSON.stringify(redact(result.body)),notes,now]);
    }
    // Official ASPI PDFs only when HTTP matched (COMPLETED path). FAILED HTTP never becomes PASSED via PDFs.
    if(mode==="portal"&&evaluation.httpValidation.matches&&evidencePlan&&snapUser&&!control.signal.aborted){
      checkpoint=markStage(checkpoint,"evidence","RUNNING","Mengambil PDF resmi ASPI");
      await progress("evidence","running","Respons HTTP tersimpan. Mengambil PDF resmi ASPI untuk operasi yang sudah dijalankan.");
      await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({evidence:evidencePlan,checkpoint}),id,ownerOperatorId]);
      try{
        const evidenceResult=await this.evidenceService.process({runId:id,ownerId:ownerOperatorId,user:snapUser,initial:true,session:activePortalSession,signal:control.signal,onProgress:progress,actor:{id:operator.id,username:operator.username,name:operator.name,role:normalizeRole(operator.role)??"petugas"},pdfCapture});
        // Evidence finishes locks before returning; clear the handoff so finally does not double-hold.
        activePortalSession=undefined;
        status=evidenceResult.status as RunStatus;
        notes=evidenceResult.notes;
        checkpoint=markStage(checkpoint,"evidence",evidenceResult.complete?"COMPLETED":"FAILED",`${evidenceResult.stored}/${evidenceResult.required} PDF`);
      }catch{
        status="COMPLETED";
        notes+=` Pengambilan PDF ASPI gagal; HTTP tetap valid. Gunakan Proses Ulang Bukti.`;
        checkpoint=markStage(checkpoint,"evidence","FAILED","Download PDF ASPI gagal");
        await progress("evidence","failed","Download PDF ASPI gagal; hasil HTTP tetap tersimpan.");
      }
      await this.db.query("UPDATE autosnap_runs SET status=$1,notes=$2,request_json=request_json || $3::jsonb WHERE id=$4 AND operator_id=$5",[status,notes,JSON.stringify({checkpoint,outcome:status}),id,ownerOperatorId]);
    }else if(mode==="portal"){
      checkpoint=markStage(checkpoint,"evidence","SKIPPED",status==="FAILED"?"HTTP gagal; bukti ASPI tidak diunduh.":"Belum ada HTTP target.");
      await progress("evidence","completed",status==="FAILED"?"HTTP tidak sesuai; bukti ASPI tidak diunduh.":control.signal.aborted?"Pengambilan PDF ASPI dibatalkan.":"Belum ada HTTP response dari operasi ASPI.");
    }else if(evaluation.httpValidation.matches){
      // Mock/live have no ASPI PDF gate — HTTP match is the final outcome.
      status=finalOutcome(evaluation,true);
      Object.assign(evaluation,{outcome:status,detail:`HTTP ${result.status} sesuai expected ${expectedHttp}.`,suggestion:""});
      await this.db.query("UPDATE autosnap_runs SET status=$1,notes=$2,request_json=request_json || $3::jsonb WHERE id=$4 AND operator_id=$5",[status,`${evaluation.detail} Outcome: ${status}.`,JSON.stringify({outcome:status,evaluation}),id,ownerOperatorId]);
    }
    await progress("finalizing","running","Melepaskan sesi ASPI dan menyelesaikan status…");
    if(activePortalSession){
      try{await activePortalSession.release();}catch{/* already released */}
      activePortalSession=undefined;
    }
    const aspiReady=!(snapUser&&await this.evidenceService.accountBusy(snapUser));
    const busyUserIds=snapUser?await this.evidenceService.busyUserIds(await this.allRecords()):[];
    checkpoint=markStage(checkpoint,"finished",status==="CANCELLED"?"FAILED":"COMPLETED",notes);
    const finalStatus=await this.updateProgress(progressId,operator.id,"finished",status==="CANCELLED"?"cancelled":status==="FAILED"||status==="AUTOMATION_ERROR"||status==="VALIDATION_ERROR"?"failed":"completed",aspiReady?notes:`${notes} Form masih terkunci: akun ASPI dipakai proses lain.`);
    if(finalStatus==="cancelled"&&status!=="CANCELLED"){
      status="CANCELLED";result.outcome="CANCELLED";notes="Pengujian dibatalkan pengguna. Request yang sudah terkirim tetap tercatat.";
      Object.assign(evaluation,{outcome:"CANCELLED",detail:notes,suggestion:"Periksa request yang sudah terkirim pada History Testing sebelum mencoba ulang."});
      checkpoint=markStage(checkpoint,"finished","FAILED",notes);
      await this.db.query("UPDATE autosnap_runs SET status=$1,notes=$2,request_json=request_json || $3::jsonb WHERE id=$4 AND operator_id=$5",[status,notes,JSON.stringify({outcome:"CANCELLED",evaluation,checkpoint}),id,ownerOperatorId]);
    }
    const finalProgress=await this.db.one<{steps:unknown}>("SELECT steps FROM autosnap_test_progress WHERE id=$1 AND user_id=$2",[progressId,operator.id]);
    const savedRow=await this.db.one<RunRow>("SELECT request_json FROM autosnap_runs WHERE id=$1",[id]);
    const savedRequest=object(savedRow?.request_json)?savedRow.request_json:{};
    const evidenceOps=object(savedRequest.evidence)?savedRequest.evidence:null;
    const ops=evidenceOps&&Array.isArray(evidenceOps.operations)?evidenceOps.operations:[];
    const pdfReady=ops.filter(op=>object(op)&&op.pdfReady===true).length,pdfRequired=ops.length;
    const reprocess={
      retryEvidence:canRetryEvidence({status,httpMatched:evaluation.httpValidation.matches,evidenceIncomplete:pdfRequired>0&&pdfReady<pdfRequired||status==="COMPLETED"}),
      resumeTesting:canResumeTesting({status,hasTargetHttp:hasRecordedHttp({http_status:result.status,request_json:cleanRequest}),failedStageId:failedStage(checkpoint)?.id??null})||(!hasRecordedHttp({http_status:result.status,request_json:cleanRequest})&&failedStage(checkpoint)?.id==="api_request"),
      requireMutatingConfirm:requiresMutatingConfirm(method,hasRecordedHttp({http_status:result.status,request_json:cleanRequest}),failedStage(checkpoint)?.id==="api_request"),
    };
    await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({progressLog:finalProgress?.steps??[],checkpoint,reprocess,pdfCounts:{ready:pdfReady,required:pdfRequired},operator:operatorSnapshot}),id,ownerOperatorId]);
    return res.json({ok:true,id,progressId,status,outcome:status,executionOutcome,evaluation,checkpoint,reprocess,pdfCounts:{ready:pdfReady,required:pdfRequired},failedStage:responseBody.failedStage??failedStage(checkpoint)?.id??null,httpStatus:result.status,responseCode,expectedCode:expected,expectedHttpStatus:expectedHttp,durationMs:duration,response:redact(result.body),checks,notes,aspiReady,busyUserIds,formReady:aspiReady});
    }finally{
      // Important: release the borrowed ASPI browser even if DB writes,
      // cancellation, or evidence collection fails before normal completion.
      try{await activePortalSession?.release();}catch{/* preserve original result/error */}
      control.stop();
    }
  }
}

@Module({controllers:[AutoSnapController],providers:[DatabaseService,RunEngine,AspiSessionManager,AspiFormResolver,PortalEngine,DocumentationReader,RunEvidenceService]})
export class AppModule {}
