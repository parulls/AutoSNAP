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
import { BALANCE_PATH,balanceResponseChecks, mockBalance, object, validateBalanceRequest, validateHeaderProfile, type UseCase } from "./balance";
import { AspiFormResolver } from "./aspi-form-resolver";
import { AspiSessionManager } from "./aspi-session-manager";
import { clientAddress } from "./http-security";
import { requestPasswordReset, resetPasswordWithOtp } from "./password-reset";
import { hasPrivilege } from "./privileges";
import { createZip } from "./zip";
import { RunControl } from "./run-control";
import { readHistory } from "./history";
import {DocumentationReader} from "./documentation-reader";
import {validateConfig,configuredChecks,methods} from "./endpoint-config";
import {prepareBody,resolveRequestPath,managedHeaders} from "./request-builder";
import {assertOperationIdentity,resolveEndpoint,scenarioExpectation} from "./endpoint-resolver";
import {authenticationWorkflow} from "./auth-workflow";
import {evaluateTest,isHttpResponse,type ResultCheck} from "./test-evaluation";
import type {Page} from "playwright-core";
import {TestReportService,TEST_REPORT_ID,hasRecordedHttp,reportFingerprint} from "./test-report";
import type { AspiActivity } from "./aspi-evidence";

type Scenario={id:string;group:string;service:string;scenario:string;expected:string;expectedCode:string|null};
type Input=Record<string,unknown>;
const kinds=new Set(["client","project","environment","snap_user","service","endpoint","template"]);
const parentKinds:Record<string,string>={project:"client",environment:"project",service:"endpoint",template:"endpoint"};
const get=(rows:RecordRow[],id:unknown,kind:string)=>rows.find(row=>row.id===id&&row.kind===kind);
const value=(row:RecordRow|undefined,key:string)=>String(row?.data[key]??"");
const codeFor=(raw:string|null|undefined,code:string)=>raw?.replace("xx",/^\d{2}$/.test(code)?code:"00")??null;
function publicRecord(row:RecordRow){
  const data={...row.data};
  for(const field of secretFields)if(data[field])data[field]="••••••••";
  return {id:row.id,kind:row.kind,name:row.name,parentId:row.parent_id,partnerId:row.partner_id,data,createdAt:row.created_at,updatedAt:row.updated_at};
}
function clientError(message:string,status=400){return {error:message,status};}

@Controller("autosnap")
export class AutoSnapController {
  private scenarios:Scenario[]|null=null;
  constructor(private readonly db:DatabaseService,private readonly engine:RunEngine,private readonly portal:PortalEngine,private readonly docs:DocumentationReader,private readonly reports:TestReportService=new TestReportService()){}
  private async catalog(){return this.scenarios??=JSON.parse(await readFile(join(process.cwd(),"app","scenario-catalog.json"),"utf8")) as Scenario[];}
  private async allRecords(){return this.db.query<RecordRow>("SELECT * FROM autosnap_records ORDER BY created_at DESC");}
  private async user(req:Request){
    const token=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("autosnap_session="))?.slice("autosnap_session=".length);
    if(!token)return null;
    return this.db.one<Operator>("SELECT u.id,u.email,u.username,u.name,u.role,u.active,u.privileges,u.created_at FROM autosnap_users u JOIN autosnap_sessions s ON s.user_id=u.id WHERE s.hash=$1 AND s.expires_at>$2 AND u.active=TRUE",[sha256(token),new Date().toISOString()]);
  }
  private async newSession(req:Request,res:Response,userId:string){
    const token=randomBytes(32).toString("hex"),expiry=new Date(Date.now()+8*3600000);
    await this.db.query("DELETE FROM autosnap_sessions WHERE expires_at<=$1",[new Date().toISOString()]);
    await this.db.query("INSERT INTO autosnap_sessions (hash,user_id,expires_at) VALUES ($1,$2,$3)",[sha256(token),userId,expiry.toISOString()]);
    res.cookie("autosnap_session",token,{httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV==="production"||req.headers["x-autosnap-proto"]==="https",path:"/",expires:expiry});
  }
  private fail(res:Response,error:unknown){
    const e=error as {error?:string;status?:number;message?:string};
    return res.status(e.status??500).json({error:e.error??"Terjadi kesalahan server. Hubungi administrator."});
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
      const [records,runs,scenarios,operators]=await Promise.all([this.allRecords(),this.db.query<RunRow>("SELECT * FROM autosnap_runs WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 500",[user.id]),this.catalog(),this.db.query<Operator>("SELECT id,name,email,username,role,active,privileges,created_at FROM autosnap_users WHERE ($1=TRUE OR id=$2) ORDER BY created_at",[user.role==="admin",user.id])]);
      return res.json({user,operators:operators.map(item=>({...item,createdAt:item.created_at})),records:records.map(publicRecord),runs:runs.map(run=>({...run,request:run.request_json,response:run.response_json})),scenarios});
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
        await createAccount(this.db,input,"tester",false);
        return res.json({ok:true,message:"Pendaftaran berhasil. Tunggu admin mengaktifkan akun."});
      }
      if(action==="login")return await this.login(req,res,input);
      if(action==="forgotPassword"){
        await this.enforceRateLimit(`forgot:${clientAddress(req)}`,5,15*60_000);
        await verifyRecaptcha(input,req.ip);
        await this.enforceRateLimit(`forgot-email:${String(input.email??"").trim().toLowerCase()}`,3,15*60_000);
        return res.json(await requestPasswordReset(this.db,input.email));
      }
      if(action==="resetPassword"){
        await this.enforceRateLimit(`reset:${clientAddress(req)}`,10,15*60_000);
        await resetPasswordWithOtp(this.db,input);
        return res.json({ok:true,message:"Password berhasil diperbarui. Silakan masuk."});
      }
      const user=await this.user(req);if(!user)return this.fail(res,clientError("Sesi login diperlukan.",401));
      if(action==="logout"){
        const token=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("autosnap_session="))?.slice("autosnap_session=".length);
        if(token)await this.db.query("DELETE FROM autosnap_sessions WHERE hash=$1",[sha256(token)]);
        res.clearCookie("autosnap_session",{path:"/"});return res.json({ok:true});
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
      if(action==="getHistory")return res.json(await readHistory(this.db,user.id,input));
      if(action==="deleteEndpointConfiguration"){
        if(user.role!=="admin")return this.fail(res,clientError("Hanya admin dapat menghapus konfigurasi endpoint.",403));
        const records=await this.allRecords(),endpoint=get(records,input.id,"endpoint");
        if(!endpoint)return this.fail(res,clientError("Endpoint tidak ditemukan.",404));
        const ids=[endpoint.id,...records.filter(row=>row.kind==="service"&&(row.parent_id===endpoint.id||endpoint.parent_id===row.id)).map(row=>row.id)];
        if(records.some(row=>row.parent_id&&ids.includes(row.parent_id)&&!ids.includes(row.id)&&row.kind!=="template"))return this.fail(res,clientError("Konfigurasi masih dipakai data lain.",409));
        const slots=ids.map((_,index)=>`$${index+1}`).join(",");
        await this.db.transaction(async query=>{
          await query(`DELETE FROM autosnap_records WHERE kind='template' AND parent_id IN (${slots})`,ids);
          await query(`DELETE FROM autosnap_records WHERE id IN (${slots})`,ids);
        });
        return res.json({ok:true});
      }
      if(action==="inspectDocumentation"||action==="saveImportedService"){
        if(user.role!=="admin")return this.fail(res,clientError("Hanya admin dapat mengimpor dokumentasi.",403));
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
        const linkedServices=existingEndpoint?records.filter(row=>row.kind==="service"&&(row.parent_id===existingEndpoint.id||existingEndpoint.parent_id===row.id)):[];
        const existingService=draft.serviceId?get(records,draft.serviceId,"service"):linkedServices.length===1?linkedServices[0]:undefined;
        if(draft.serviceId&&(!existingService||!linkedServices.some(row=>row.id===existingService.id)))return this.fail(res,clientError("Service tidak melekat pada endpoint yang diedit."));
        if(!draft.serviceId&&linkedServices.length>1)return this.fail(res,clientError("Pilih konfigurasi service yang ingin diedit."));
        const endpointId=existingEndpoint?.id??"doc-endpoint-"+sha256(url.toString()).slice(0,24),serviceId=existingService?.id??"doc-service-"+sha256(url.toString()).slice(0,24),now=new Date().toISOString();
        await this.db.transaction(async query=>{
          for(const [id,kind,parentId,data]of [[endpointId,"endpoint",null,{...existingEndpoint?.data,method:draft.method,path:draft.path,portalUrl:url.toString()}],[serviceId,"service",endpointId,{...existingService?.data,module:String(draft.module??"Layanan SNAP"),code:String(draft.code??""),requestBody,config}]]){
            await query("INSERT INTO autosnap_records(id,kind,name,parent_id,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,parent_id=EXCLUDED.parent_id,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at",[id,kind,String(draft.name??config.operationId).slice(0,120),parentId,JSON.stringify(data),now]);
          }
        });
        return res.json({ok:true,endpointId,serviceId});
      }
      if(["save","saveConnection","delete","userCreate","userDelete"].includes(action)&&user.role!=="admin")return this.fail(res,clientError("Hanya admin yang boleh mengubah master data atau mengelola akun.",403));
      if(action==="save")return await this.save(res,input);
      if(action==="saveConnection")return res.json(await saveConnection(this.db,input));
      if(action==="delete")return await this.remove(res,input);
      if(action==="userCreate"){await createAccount(this.db,input,input.role==="admin"?"admin":"tester",true);return res.json({ok:true});}
      if(action==="userDelete"||action==="userUpdate"){await updateAccount(this.db,input,user);return res.json({ok:true});}
      if(action==="downloadAspiActivityPdf"){
        await this.enforceRateLimit(`pdf:${user.id}`,20,10*60_000);
        if(!hasPrivilege(user,"dev_site"))return this.fail(res,clientError("Anda tidak memiliki privilege download bukti Dev Site.",403));
        return await this.downloadAspiActivityPdf(res,input,user);
      }
      if(action==="downloadTestReportPdf"){
        await this.enforceRateLimit(`report:${user.id}`,20,10*60_000);
        const run=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[String(input.id??""),user.id]);
        if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
        if(!hasPrivilege(user,run.mode==="mock"?"client_simulator":"dev_site"))return this.fail(res,clientError("Anda tidak memiliki privilege untuk laporan pengujian ini.",403));
        if(!hasRecordedHttp(run))return this.fail(res,clientError("Belum ada HTTP response untuk laporan PDF pengujian ini.",409));
        try{
          const pdf=await this.ensureTestReport(run);
          res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename="AutoSNAP-${run.id.replace(/[^A-Za-z0-9_-]/g,"-")}.pdf"`);res.setHeader("Content-Length",String(pdf.length));return res.send(pdf);
        }catch{return this.fail(res,clientError("Laporan PDF belum dapat dibuat. Coba kembali dari History; request API tidak akan diulang.",503));}
      }
      if(action==="downloadAspiActivitiesZip"){
        await this.enforceRateLimit(`zip:${user.id}`,10,10*60_000);
        if(!hasPrivilege(user,"dev_site"))return this.fail(res,clientError("Anda tidak memiliki privilege download bukti Dev Site.",403));
        return await this.downloadAspiActivitiesZip(res,input,user);
      }
      if(action==="run")await this.enforceRateLimit(`run:${user.id}`,20,10*60_000);
      if(action==="run"){
        const environment=await this.db.one<RecordRow>("SELECT * FROM autosnap_records WHERE id=$1 AND kind='environment'",[String(input.environmentId??"")]);
        const required=value(environment??undefined,"mode")==="mock"?"client_simulator":"dev_site";
        if(!hasPrivilege(user,required))return this.fail(res,clientError("Anda tidak memiliki privilege untuk menjalankan pengujian ini.",403));
        return await this.run(res,input,user);
      }
      return this.fail(res,clientError("Action tidak dikenal.",404));
    }catch(error){return this.fail(res,error);}
  }
  private async downloadAspiActivityPdf(res:Response,input:Input,operator:Operator){
    const runId=String(input.id??""),activityId=String(input.activityId??"");
    const run=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[runId,operator.id]);
    if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
    const request=object(run.request_json)?run.request_json:{},activities=Array.isArray(request.aspiActivities)?request.aspiActivities.filter(object):[];
    const activity=activities.find(item=>String(item.activityId??"")===activityId);
    if(!activity)return this.fail(res,clientError("Aktivitas ASPI tidak terdaftar pada history ini.",404));
    const cached=await this.db.one<{pdf_data:Buffer}>("SELECT pdf_data FROM autosnap_evidence_pdfs WHERE run_id=$1 AND activity_id=$2",[runId,activityId]);
    if(!cached)return this.fail(res,clientError("PDF resmi ASPI belum tersimpan untuk aktivitas ini. Lihat detail bukti pada History.",409));
    const pdf=cached.pdf_data,service=String(activity.service??"ASPI").replace(/[^A-Za-z0-9_-]+/g,"-").slice(0,60);
    const filename=`ASPI-${service||"Activity"}-${activityId}.pdf`;
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
    res.setHeader("Content-Length",String(pdf.length));
    return res.send(pdf);
  }
  private async downloadAspiActivitiesZip(res:Response,input:Input,operator:Operator){
    const runId=String(input.id??""),run=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[runId,operator.id]);
    if(!run)return this.fail(res,clientError("History testing tidak ditemukan.",404));
    const request=object(run.request_json)?run.request_json:{},activities=Array.isArray(request.aspiActivities)?request.aspiActivities.filter(object):[];
    if(!activities.length)return this.fail(res,clientError("History ini belum memiliki bukti aktivitas ASPI.",409));
    const entries:{name:string;data:Buffer}[]=[];
    for(const [index,activity] of activities.entries()){
      const activityId=String(activity.activityId??"");
      if(!activityId)continue;
      const service=String(activity.service??`Service-${index+1}`),cached=await this.db.one<{pdf_data:Buffer}>("SELECT pdf_data FROM autosnap_evidence_pdfs WHERE run_id=$1 AND activity_id=$2",[runId,activityId]);
      if(!cached)return this.fail(res,clientError("Sebagian PDF belum tersimpan; ZIP tidak dibuat agar bukti tidak terlewat.",409));
      const pdf=cached.pdf_data;
      entries.push({name:`${String(index+1).padStart(2,"0")}-${service}.pdf`,data:pdf});
    }
    const zip=createZip(entries),filename=`ASPI-Evidence-${runId.replace(/[^A-Za-z0-9_-]/g,"-")}.zip`;
    if(zip.length>50*1024*1024)return this.fail(res,clientError("Ukuran gabungan bukti melebihi 50 MB.",413));
    res.setHeader("Content-Type","application/zip");res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);res.setHeader("Content-Length",String(zip.length));
    return res.send(zip);
  }
  private async storeEvidencePdf(runId:string,activityId:string,service:string,pdf:Buffer){
    if(!pdf.length||pdf.length>15*1024*1024||pdf.subarray(0,5).toString()!=="%PDF-")throw clientError("PDF bukti pengujian tidak valid.",413);
    await this.db.query("INSERT INTO autosnap_evidence_pdfs (run_id,activity_id,service,pdf_data,byte_size,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,activity_id) DO UPDATE SET service=EXCLUDED.service,pdf_data=EXCLUDED.pdf_data,byte_size=EXCLUDED.byte_size,created_at=EXCLUDED.created_at",[runId,activityId,service.slice(0,120),pdf,pdf.length,new Date().toISOString()]);
  }
  private async ensureTestReport(run:RunRow,page?:Page):Promise<Buffer>{
    const snapshot=object(run.request_json)?run.request_json:{},metadata=object(snapshot.report)?snapshot.report:{},fingerprint=reportFingerprint(run);
    const cached=await this.db.one<{pdf_data:Buffer}>("SELECT pdf_data FROM autosnap_evidence_pdfs WHERE run_id=$1 AND activity_id=$2",[run.id,TEST_REPORT_ID]);
    if(cached&&metadata.fingerprint===fingerprint)return cached.pdf_data;
    const pdf=await this.reports.render(run,page);
    await this.storeEvidencePdf(run.id,TEST_REPORT_ID,"AutoSNAP Testing Report",pdf);
    await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({report:{ready:true,fingerprint,generatedAt:new Date().toISOString(),kind:"autosnap"}}),run.id,run.operator_id]);
    return pdf;
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
  private async save(res:Response,input:Input){
    const kind=String(input.kind??""),id=input.id?String(input.id):randomUUID(),name=String(input.name??"").trim(),parentId=input.parentId?String(input.parentId):null;
    let partnerId=input.partnerId?String(input.partnerId).trim():null;
    if(!kinds.has(kind)||!name||name.length>120)return this.fail(res,clientError("Jenis dan nama data tidak valid."));
    const rows=await this.allRecords(),old=rows.find(row=>row.id===id);
    if(old&&old.kind!==kind)return this.fail(res,clientError("Jenis data tidak dapat diubah."));
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
      data.email=email;data.username=email;
    }
    if(kind==="service"&&data.config)validateConfig(data.config);
    if(kind==="service"&&data.code&&!/^\d{2}$/.test(String(data.code)))return this.fail(res,clientError("Service code harus dua digit."));
    if(kind==="service"&&data.requestBody)try{if(!object(JSON.parse(String(data.requestBody))))throw Error();}catch{return this.fail(res,clientError("Default Request Body harus object JSON valid."));}
    if(kind==="environment"){
      if(!["Dev Site","Client Simulator"].includes(String(data.category)))return this.fail(res,clientError("Kategori environment tidak valid."));
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
    const now=new Date().toISOString();
    if(old)await this.db.query("UPDATE autosnap_records SET name=$1,parent_id=$2,partner_id=$3,data=$4::jsonb,updated_at=$5 WHERE id=$6",[name,parentId,partnerId,JSON.stringify(data),now,id]);
    else await this.db.query("INSERT INTO autosnap_records (id,kind,name,parent_id,partner_id,data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)",[id,kind,name,parentId,partnerId,JSON.stringify(data),now]);
    return res.json({ok:true,id});
  }
  private async remove(res:Response,input:Input){
    const id=String(input.id??""),rows=await this.allRecords(),row=rows.find(item=>item.id===id);
    if(!row)return this.fail(res,clientError("Data tidak ditemukan.",404));
    if(rows.some(item=>item.parent_id===id&&item.kind!=="template"))return this.fail(res,clientError("Data masih dipakai. Hapus atau pindahkan data turunannya dahulu.",409));
    if(row.kind==="snap_user"&&rows.some(item=>item.kind==="environment"&&value(item,"defaultUserId")===id))return this.fail(res,clientError("User SNAP masih dipakai oleh Dev Site Client.",409));
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
    return res.json({ok:true});
  }
  private async updateProgress(id:string,userId:string,stage:string,status:"queued"|"running"|"completed"|"failed"|"cancelled"|"not_evaluated"|"passed_http",detail=""){
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
  private async run(res:Response,input:Input,operator:Operator){
    const rows=await this.allRecords(),client=get(rows,input.clientId,"client"),project=get(rows,input.projectId,"project"),environment=get(rows,input.environmentId,"environment"),snapUser=input.userId?get(rows,input.userId,"snap_user"):null,service=get(rows,input.serviceId,"service"),endpoint=get(rows,input.endpointId,"endpoint"),template=input.templateId?get(rows,input.templateId,"template"):rows.find(row=>row.kind==="template"&&row.parent_id===input.endpointId);
    if(!client||!project||!environment||!service||!endpoint)return this.fail(res,clientError("Konfigurasi test belum lengkap."));
    if(input.userId&&!snapUser)return this.fail(res,clientError("User SNAP tidak ditemukan."));
    const serviceEndpointValid=service.parent_id===endpoint.id||endpoint.parent_id===service.id;
    const userValid=!!snapUser&&(value(environment,"defaultUserId")?value(environment,"defaultUserId")===snapUser.id:snapUser.parent_id===project.id);
    if(project.parent_id!==client.id||environment.parent_id!==project.id||!serviceEndpointValid||!userValid)return this.fail(res,clientError("Relasi data pengujian tidak sesuai."));
    if(input.templateId&&(!template||template.parent_id!==endpoint.id))return this.fail(res,clientError("Template tidak melekat pada endpoint terpilih."));
    const mode=value(environment,"mode");
    const {method,path,serviceCode,config,legacyBalance}=resolveEndpoint(endpoint,service);
    const isBalance=method==="POST"&&path===BALANCE_PATH;
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
    if(!["positive","invalid_access_token"].includes(testType))return this.fail(res,clientError("Jenis testing tidak valid."));
    const negativeAccessToken=testType==="invalid_access_token";
    const expectation=scenarioExpectation(config,legacyBalance,negativeAccessToken,service.data);
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
    let automaticRegistration:{portalUrl:string;path:string;body:Record<string,unknown>}|null=null;
    if(mode==="portal"&&legacyBalance&&!negativeAccessToken&&!body.accountNo&&!body.bankCardToken&&!scenarioId?.endsWith(".3")&&!scenarioId?.endsWith(".4")){
      const registrationService=rows.find(row=>row.kind==="service"&&value(row,"code")==="01");
      const registrationEndpoint=registrationService?rows.find(row=>row.kind==="endpoint"&&(row.id===registrationService.parent_id||row.parent_id===registrationService.id)):undefined;
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
    const savesPrerequisite=["01","03","04","07","08","74"].includes(serviceCode);
    if(savesPrerequisite&&!snapUser)return this.fail(res,clientError("Pilih User SNAP agar hasil Registrasi atau Keamanan dapat disimpan otomatis."));
    const expected=negativeAccessToken?expectation.expectedCode:codeFor(scenario?.expectedCode,serviceCode)??expectation.expectedCode,externalId=String(input.externalId??"").trim()||Date.now().toString()+String(Math.floor(Math.random()*1000000)).padStart(6,"0");
    if(!/^[0-9]{1,36}$/.test(externalId))return this.fail(res,clientError("X-EXTERNAL-ID harus angka, maksimal 36 digit."));
    const extra=template?.data.headers;
    if(extra!==undefined&&(!object(extra)||Object.values(extra).some(x=>typeof x!=="string")))return this.fail(res,clientError("Header tambahan harus object berisi string."));
    const extraHeaders=(extra??{}) as Record<string,string>;
    const profileHeaders:Record<string,string>={};
    for(const [header,field] of [["ORIGIN","origin"],["X-IP-ADDRESS","ipAddress"],["X-LATITUDE","latitude"],["X-LONGITUDE","longitude"]])if(value(client,field))profileHeaders[header]=value(client,field);
    const requestHeaders={...profileHeaders,...extraHeaders};
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
      const response=object(sample)?structuredClone(sample):negativeAccessToken?{...(expected?{responseCode:expected}:{}),responseMessage:"Access Token Invalid",additionalInfo:{mock:true}}:isBalance?mockBalance(body,expected):{...(expected?{responseCode:expected}:{}),responseMessage:"Mock response",additionalInfo:{mock:true}};
      result={status:scenario?.expectedCode&&expected?Number(expected.slice(0,3)):httpStatus,body:response,request:{method,path,timestamp,externalId,body:method==="GET"?null:body,headers:{"Content-Type":"application/json","Authorization":"[MOCK TOKEN]","X-TIMESTAMP":timestamp,"X-SIGNATURE":"[MOCK SIGNATURE]","X-PARTNER-ID":client.data.partnerIdSource==="client_id"?value(client,"clientId"):client.partner_id,"X-EXTERNAL-ID":externalId,"CHANNEL-ID":value(client,"channelId"),...(useCase==="B2B2C"?{"Authorization-Customer":"[MOCK CUSTOMER TOKEN]"}:{}),...(value(client,"deviceId")?{"X-DEVICE-ID":value(client,"deviceId")}:{}),...requestHeaders}}};
      await progress("api_request","completed",`${service.name} — simulasi selesai`);
    }else if(mode==="portal"){
      try{
        result=await this.portal.hit({portalUrl:value(endpoint,"portalUrl"),path,method,body,client,user:snapUser!,externalId,extraHeaders:requestHeaders,authFlow:config?.authFlow,workflow:workflow.profile,omitBody:["GET","HEAD"].includes(method)||config?.requestBodyMode==="none"||config?.requestBodyMode==="optional"&&!String(input.body??"").trim(),serviceName:service.name,parameters:dynamicParameters,parameterDefinitions:config?.parameters,negativeAccessToken,signal:control.signal,onProgress:progress,registration:automaticRegistration?{...automaticRegistration,externalId:Date.now().toString()+String(Math.floor(Math.random()*1000000)).padStart(6,"0")}:null});
        activePortalSession=result.evidenceSession;
      }
      catch{result={status:null,outcome:"AUTOMATION_ERROR",body:{error:"Automasi Portal ASPI gagal. Periksa konfigurasi dan koneksi portal."},request:{method,path,portalUrl:value(endpoint,"portalUrl"),externalId,body}};}
    }else{
      await progress("api_request","running",`${service.name} — ${method} ${path}`);
      try{result=await this.engine.hit({baseUrl:value(environment,"baseUrl"),path,method,body,client,user:snapUser??null,scenarioId,externalId,extraHeaders:requestHeaders,negativeAccessToken,signal:control.signal,authFlow:serviceCode==="11"?"token_b2b":value(environment,"authFlow")||"token_b2b",useCase,tokenPath:value(environment,"tokenPath")||"/api/v1.0/access-token/b2b",rsaEncoding:value(environment,"rsaEncoding")||"base64",hmacEncoding:value(environment,"hmacEncoding")||"hex"});}
      catch{result={status:null,outcome:"TRANSPORT_ERROR",body:{error:"Request API gagal. Periksa konfigurasi dan koneksi target."},request:{method,path,externalId,body}};}
      await progress("api_request",result.status===null?"failed":"completed",result.status===null?"Target tidak memberikan response":`${service.name} — response diterima`);
    }
    await control.check();
    if(control.signal.aborted){result={...result,outcome:"CANCELLED",body:{...(object(result.body)?result.body:{}),error:"Pengujian dibatalkan pengguna. Request yang sudah terkirim tidak dapat ditarik kembali."}};}
    await progress("http_response",result.status===null?"failed":"completed",result.status===null?"HTTP response belum diterima":`HTTP ${result.status} diterima`);
    await progress("evaluation","running","Mengevaluasi actual dan expected result");
    const duration=Date.now()-started,responseBody=object(result.body)?result.body:{},responseCode=String(responseBody.responseCode??"")||null;
    const executedBody=object(result.request.body)?result.request.body:body;
    const registrationOutput=object(result.request.registrationOutput)?result.request.registrationOutput:null;
    if(mode==="portal"&&snapUser&&registrationOutput){
      const outputs:Record<string,unknown>={};
      for(const field of ["bankCardToken","accountNo"])if(typeof registrationOutput[field]==="string"&&registrationOutput[field])outputs[field]=encrypt(String(registrationOutput[field]));
      if(Object.keys(outputs).length)await this.db.query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE id=$3",[JSON.stringify(outputs),new Date().toISOString(),snapUser.id]);
    }
    // An internal automation/precondition error isn't an HTTP response from the target API.
    const checks:ResultCheck[] = result.status === null
      ? [{ label: "HTTP Request", passed: false, detail: `API target belum memberikan HTTP response. Outcome: ${result.outcome??"UNKNOWN"}.` }]
      : config ? configuredChecks(result.status,result.body,config,{expectedCode:expected,expectedHttpStatus:negativeAccessToken?expectation.expectedHttpStatus:scenario?.expectedCode?Number(expected?.slice(0,3)):expectation.expectedHttpStatus}) : isBalance&&expected ? balanceResponseChecks(result.status, result.body, expected, executedBody) : [{label:"HTTP status",passed:result.status===expectation.expectedHttpStatus,detail:`Expected HTTP ${expectation.expectedHttpStatus}; actual ${result.status}.`}];
    if(config&&isBalance&&result.status!==null&&expected)checks.push(...balanceResponseChecks(result.status,result.body,expected,executedBody).filter(check=>!checks.some(existing=>existing.label===check.label)));
    const automationChecks=object(result.request)&&Array.isArray(result.request.automationChecks)?result.request.automationChecks.filter(object).map(item=>({label:String(item.label??"Automation"),passed:item.passed===true,detail:String(item.detail??"")})):[];
    checks.push(...automationChecks);
    const evaluated=evaluateTest({httpStatus:result.status,actualCode:responseCode,expectedCode:expected,checks,cancelled:result.outcome==="CANCELLED"});
    let status=evaluated.status;
    const evaluation=evaluated.evaluation,executionOutcome=result.outcome??null;
    if(!evaluation.snapValidationPerformed&&isHttpResponse(result.status)&&result.outcome!=="CANCELLED"){
      result.outcome=evaluation.outcome as HitResult["outcome"];
      checks.push({label:"SNAP responseCode",passed:null,detail:evaluation.detail});
    }else if(evaluation.outcome==="PASSED"||evaluation.outcome==="FAILED")result.outcome=evaluation.outcome;
    await this.updateProgress(progressId,operator.id,"evaluation",status==="PASSED_HTTP"?"passed_http":status==="NOT_EVALUATED"?"not_evaluated":status==="Failed"?"failed":"completed",`${evaluation.outcome} — ${evaluation.detail}${evaluation.suggestion?` Saran: ${evaluation.suggestion}`:""}`);
    const expectedNegativeRejection=negativeAccessToken&&status==="Passed";
    let notes = result.outcome==="CANCELLED" ? "Pengujian dibatalkan pengguna; tahap berikutnya dihentikan. Request yang sudah terkirim tidak dapat ditarik kembali." : expectedNegativeRejection ? "API menolak access token tidak valid sesuai ekspektasi skenario."
      : status==="NOT_EVALUATED"||status==="PASSED_HTTP" ? `${evaluation.detail} Saran: ${evaluation.suggestion}`
      : mode === "mock" ? "Pengujian menggunakan mock lokal; tidak ada request eksternal."
      : result.status === null ? "Pengujian belum mendapatkan HTTP response dari API target; periksa prasyarat autentikasi dan log automasi."
      : status === "Failed" ? "HTTP response diterima, tetapi validasi terhadap ekspektasi gagal."
      : "HTTP response diterima dan validasi sesuai skenario.";
    // HTTP_ERROR hanya klasifikasi teknis status 4xx. Jika 401 memang expected
    // oleh negative test, hasil skenario tetap Passed dan tidak disebut error.
    if(result.outcome&&!expectedNegativeRejection) notes += ` Outcome: ${result.outcome}.`;
    notes += negativeAccessToken
      ? expectedNegativeRejection?` HTTP ${result.status} dan responseCode ${responseCode} sesuai expected ${expected}.`:" Skenario tes negatif meminta token tidak valid."
      : ` Skenario positif ${service.name}; autentikasi ${config?.authFlow??useCase}, tanpa modifikasi token.`;
    const now=new Date().toISOString(),id="RUN-"+now.slice(0,10).replaceAll("-","")+"-"+randomUUID().slice(0,8).toUpperCase();
    if(savesPrerequisite&&(mode==="live"||mode==="portal")&&snapUser&&result.status===200&&((serviceCode==="74"&&!responseCode)||responseCode==="200"+serviceCode+"00")){
      const outputs:Record<string,unknown>={};
      if(["01","03","04","07","08"].includes(serviceCode)){
        for(const field of ["bankCardToken","accountNo","authCode","refreshToken"])if(typeof responseBody[field]==="string"&&responseBody[field])outputs[field]=encrypt(String(responseBody[field]));
      }
      if(serviceCode==="74"&&typeof responseBody.accessToken==="string"&&responseBody.accessToken){
        outputs.customerToken=encrypt(responseBody.accessToken);
        if(typeof responseBody.refreshToken==="string")outputs.refreshToken=encrypt(responseBody.refreshToken);
        outputs.customerTokenExpiresAt=typeof responseBody.accessTokenExpiryTime==="string"&&Number.isFinite(Date.parse(responseBody.accessTokenExpiryTime))?responseBody.accessTokenExpiryTime:null;
      }
      if(Object.keys(outputs).length){
        outputs.registrationSourceRun=id;
        await this.db.query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE id=$3",[JSON.stringify(outputs),now,snapUser.id]);
        notes+=" Data hasil disimpan terenkripsi ke User SNAP terpilih.";
      }else notes+=" Tidak ada field hasil yang dikenali; isi User SNAP dari respons provider yang sudah dikonfirmasi.";
    }else if(savesPrerequisite&&mode==="mock")notes+=" Hasil mock tidak disimpan sebagai kredensial.";
    const cleanRequest=result.request;
    const evidenceMetadata:Array<AspiActivity&{pdfReady:boolean}>=[];
    const requestSnapshot:Record<string,unknown>={...cleanRequest,outcome:result.outcome??null,executionOutcome,evaluation,validation:checks,endpointConfiguration:config,workflow:workflow.profile,configurationIds:{endpointId:endpoint.id,serviceId:service.id,endpointRevision:endpoint.updated_at,serviceRevision:service.updated_at},expectation:{...expectation,expectedCode:expected},aspiActivities:evidenceMetadata,context:{client:client.name,project:project.name,environment:environment.name,user:snapUser?.name??null,service:service.name,endpoint:endpoint.name,template:template?.name??null,useCase,testType}};
    await this.db.query("INSERT INTO autosnap_runs (id,operator_id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,scenario_id,mode,status,http_status,response_code,expected_code,duration_ms,request_json,response_json,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19)",[id,operator.id,client.id,project.id,environment.id,snapUser?.id??null,service.id,endpoint.id,scenarioId,mode,status,result.status,responseCode,expected,duration,JSON.stringify(redact(requestSnapshot)),JSON.stringify(redact(result.body)),notes,now]);
    // Persist the actual test result before any potentially slow ASPI report download.
    // Evidence failures never turn a valid test result into a transport/validation error.
    if(mode==="portal"&&hasRecordedHttp({http_status:result.status,request_json:cleanRequest})&&!control.signal.aborted){
      await progress("evidence","running","Respons HTTP tersimpan. Mengambil PDF resmi ASPI untuk operasi yang sudah dijalankan.");
      const executedSteps=[...(Array.isArray(cleanRequest.steps)?cleanRequest.steps.filter(object).filter(step=>isHttpResponse(step.httpStatus)):[]),...(isHttpResponse(result.status)?[{...cleanRequest,name:cleanRequest.name??path}]:[])].filter(item=>typeof item.name==="string");
      const paths=executedSteps.map(item=>String(item.name));
      let evidence:Awaited<ReturnType<PortalEngine["collectEvidence"]>>=[];
      try{evidence=await this.portal.collectEvidence({user:snapUser!,before:result.activityBaseline,paths,activityNames:{[path]:[service.name]},deadline:started+240000,session:activePortalSession,signal:control.signal,onProgress:progress});}
      catch{evidence=paths.map(path=>({path,error:"Download PDF ASPI gagal; hasil pengujian tetap tersimpan."}));}
      const errors:Array<{path:string;activityId?:string;error:string}>=[];
      for(const item of evidence){
        if(item.error){errors.push({path:item.path,activityId:item.activity?.activityId,error:item.error});await progress("pdf_download","failed",`${item.path}: ${item.error}`);}
        if(!item.activity)continue;
        const metadata={...item.activity,pdfReady:false};evidenceMetadata.push(metadata);
        if(!item.pdf||control.signal.aborted)continue;
        try{await this.storeEvidencePdf(id,metadata.activityId,metadata.service,item.pdf);metadata.pdfReady=true;await progress("pdf_store","completed",`${item.path}: PDF tersimpan; Activity ID ${metadata.activityId}.`);}
        catch{const error="Gagal menyimpan PDF ke database.";errors.push({path:item.path,activityId:metadata.activityId,error});await progress("pdf_store","failed",`${item.path}: ${error}`);}
      }
      requestSnapshot.evidenceErrors=errors;
      const stored=evidenceMetadata.filter(item=>item.pdfReady).length;
      await progress("evidence",stored===paths.length&&stored>0?"completed":"failed",`${stored} dari ${paths.length} PDF resmi ASPI tersimpan.`);
      notes+=` PDF resmi ASPI tersimpan ${stored} dari ${paths.length} operasi.`;
      if(stored<paths.length)notes+=" Periksa log download PDF pada detail History.";
      await this.db.query("UPDATE autosnap_runs SET request_json=$1::jsonb,notes=$2 WHERE id=$3",[JSON.stringify(redact(requestSnapshot)),notes,id]);
    }else if(mode==="portal"){
      await progress("evidence","completed",control.signal.aborted?"Pengambilan PDF ASPI dibatalkan; bukti respons tersimpan tetap dibuat pada laporan AutoSNAP.":"Belum ada HTTP response dari operasi ASPI; tidak menebak Activity ID.");
    }
    let reportReady=false;
    const createReport=async()=>{
      const saved=await this.db.one<RunRow>("SELECT * FROM autosnap_runs WHERE id=$1 AND operator_id=$2",[id,operator.id]);
      if(!saved||!hasRecordedHttp(saved))return;
      await progress("test_report","running","Membuat laporan PDF AutoSNAP dari request, response dan hasil evaluasi tersimpan.");
      try{await this.ensureTestReport(saved,activePortalSession?.page);reportReady=true;await progress("test_report","completed","Laporan PDF AutoSNAP tersimpan dan siap diunduh.");}
      catch{
        reportReady=false;const error="PDF AutoSNAP belum berhasil dibuat. Unduh kembali dari History untuk mencoba pembuatan PDF tanpa mengulang API.";
        await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({report:{ready:false,error}}),id,operator.id]);
        await progress("test_report","failed",error);
      }
    };
    await createReport();
    const finalStatus=await this.updateProgress(progressId,operator.id,"finished",status==="Cancelled"?"cancelled":status==="PASSED_HTTP"?"passed_http":status==="NOT_EVALUATED"?"not_evaluated":status==="Passed"?"completed":"failed",notes);
    if(finalStatus==="cancelled"&&status!=="Cancelled"){
      status="Cancelled";result.outcome="CANCELLED";notes="Pengujian dibatalkan pengguna. Request yang sudah terkirim tetap tercatat.";
      Object.assign(evaluation,{outcome:"CANCELLED",detail:notes,suggestion:"Periksa request yang sudah terkirim pada History Testing sebelum mencoba ulang."});
      await this.db.query("UPDATE autosnap_runs SET status=$1,notes=$2,request_json=request_json || $3::jsonb WHERE id=$4 AND operator_id=$5",[status,notes,JSON.stringify({outcome:"CANCELLED",evaluation}),id,operator.id]);
      await createReport();
    }
    const finalProgress=await this.db.one<{steps:unknown}>("SELECT steps FROM autosnap_test_progress WHERE id=$1 AND user_id=$2",[progressId,operator.id]);
    await this.db.query("UPDATE autosnap_runs SET request_json=request_json || $1::jsonb WHERE id=$2 AND operator_id=$3",[JSON.stringify({progressLog:finalProgress?.steps??[]}),id,operator.id]);
    return res.json({ok:true,id,progressId,status,outcome:result.outcome??null,executionOutcome,evaluation,reportReady,failedStage:responseBody.failedStage??null,httpStatus:result.status,responseCode,expectedCode:expected,durationMs:duration,response:redact(result.body),checks,notes});
    }finally{
      // Important: release the borrowed ASPI browser even if DB writes,
      // cancellation, or evidence collection fails before normal completion.
      try{await activePortalSession?.release();}catch{/* preserve original result/error */}
      control.stop();
    }
  }
}

@Module({controllers:[AutoSnapController],providers:[DatabaseService,RunEngine,AspiSessionManager,AspiFormResolver,PortalEngine,DocumentationReader,TestReportService]})
export class AppModule {}
