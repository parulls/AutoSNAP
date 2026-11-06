import "reflect-metadata";
import { saveConnection } from "./connection";
import { createAccount, recaptchaPublicConfig, updateAccount, verifyPassword, verifyRecaptcha, type Operator } from "./accounts";
import { Controller, Get, Module, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseService, type RecordRow, type RunRow } from "./database.service";
import { RunEngine, isoJakarta, type HitResult } from "./run-engine";
import { PortalEngine } from "./portal-engine";
import { decrypt, encrypt, redact, secretFields, sha256 } from "./security";
import { balanceResponseChecks, mockBalance, object, validateBalanceRequest, validateHeaderProfile, type UseCase } from "./balance";

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
  constructor(private readonly db:DatabaseService,private readonly engine:RunEngine,private readonly portal:PortalEngine){}
  private async catalog(){return this.scenarios??=JSON.parse(await readFile(join(process.cwd(),"app","scenario-catalog.json"),"utf8")) as Scenario[];}
  private async allRecords(){return this.db.query<RecordRow>("SELECT * FROM autosnap_records ORDER BY created_at DESC");}
  private async user(req:Request){
    const token=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("autosnap_session="))?.slice("autosnap_session=".length);
    if(!token)return null;
    return this.db.one<Operator>("SELECT u.id,u.email,u.username,u.name,u.role,u.active,u.created_at FROM autosnap_users u JOIN autosnap_sessions s ON s.user_id=u.id WHERE s.hash=$1 AND s.expires_at>$2 AND u.active=TRUE",[sha256(token),new Date().toISOString()]);
  }
  private async newSession(req:Request,res:Response,userId:string){
    const token=randomBytes(32).toString("hex"),expiry=new Date(Date.now()+8*3600000);
    await this.db.query("INSERT INTO autosnap_sessions (hash,user_id,expires_at) VALUES ($1,$2,$3)",[sha256(token),userId,expiry.toISOString()]);
    res.cookie("autosnap_session",token,{httpOnly:true,sameSite:"strict",secure:req.headers["x-autosnap-proto"]==="https",path:"/",expires:expiry});
  }
  private fail(res:Response,error:unknown){
    const e=error as {error?:string;status?:number;message?:string};
    return res.status(e.status??500).json({error:e.error??e.message??"Terjadi kesalahan server."});
  }
  @Get()
  async state(@Req() req:Request,@Res() res:Response){
    try{
      const count=await this.db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_users");
      if(!Number(count?.n)){
        const host=String(req.headers["x-autosnap-host"]??req.hostname).split(":")[0];
        return res.json({setupRequired:true,setupTokenRequired:!["localhost","127.0.0.1"].includes(host),...recaptchaPublicConfig()});
      }
      const user=await this.user(req);if(!user)return res.json({loginRequired:true,...recaptchaPublicConfig()});
      const [records,runs,scenarios,operators]=await Promise.all([this.allRecords(),this.db.query<RunRow>("SELECT * FROM autosnap_runs ORDER BY created_at DESC"),this.catalog(),this.db.query<Operator>("SELECT id,name,email,username,role,active,created_at FROM autosnap_users WHERE ($1=TRUE OR id=$2) ORDER BY created_at",[user.role==="admin",user.id])]);
      return res.json({user,operators:operators.map(item=>({...item,createdAt:item.created_at})),records:records.map(publicRecord),runs:runs.map(run=>({...run,request:run.request_json,response:run.response_json})),scenarios});
    }catch(error){return this.fail(res,error);}
  }
  @Post()
  async action(@Req() req:Request,@Res() res:Response){
    try{
      const input=(req.body??{}) as Input,action=String(input.action??"");
      if(action==="setup")return await this.setup(req,res,input);
      if(action==="register"){
        await verifyRecaptcha(input,req.ip);
        const count=await this.db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_users");
        if(!Number(count?.n))return this.fail(res,clientError("Buat administrator pertama terlebih dahulu."));
        await createAccount(this.db,input,"tester",false);
        return res.json({ok:true,message:"Pendaftaran berhasil. Tunggu admin mengaktifkan akun."});
      }
      if(action==="login")return await this.login(req,res,input);
      const user=await this.user(req);if(!user)return this.fail(res,clientError("Sesi login diperlukan.",401));
      if(action==="logout"){
        const token=req.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith("autosnap_session="))?.slice("autosnap_session=".length);
        if(token)await this.db.query("DELETE FROM autosnap_sessions WHERE hash=$1",[sha256(token)]);
        res.clearCookie("autosnap_session",{path:"/"});return res.json({ok:true});
      }
      if(["save","saveConnection","delete","userCreate","userDelete"].includes(action)&&user.role!=="admin")return this.fail(res,clientError("Hanya admin yang boleh mengubah master data atau mengelola akun.",403));
      if(action==="save")return await this.save(res,input);
      if(action==="saveConnection")return res.json(await saveConnection(this.db,input));
      if(action==="delete")return await this.remove(res,input);
      if(action==="userCreate"){await createAccount(this.db,input,input.role==="admin"?"admin":"tester",true);return res.json({ok:true});}
      if(action==="userDelete"||action==="userUpdate"){await updateAccount(this.db,input,user);return res.json({ok:true});}
      if(action==="run")return await this.run(res,input);
      return this.fail(res,clientError("Action tidak dikenal.",404));
    }catch(error){return this.fail(res,error);}
  }
  private async setup(req:Request,res:Response,input:Input){
    const count=await this.db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_users");
    if(Number(count?.n))return this.fail(res,clientError("Admin sudah dibuat.",409));
    const host=String(req.headers["x-autosnap-host"]??req.hostname).split(":")[0],local=["localhost","127.0.0.1"].includes(host);
    if(!local&&(!process.env.AUTOSNAP_SETUP_TOKEN||input.setupToken!==process.env.AUTOSNAP_SETUP_TOKEN))return this.fail(res,clientError("Setup publik memerlukan AUTOSNAP_SETUP_TOKEN.",403));
    await verifyRecaptcha(input,req.ip);
    const id=await createAccount(this.db,input,"admin",true,true);
    await this.newSession(req,res,id);return res.json({ok:true});
  }
  private async login(req:Request,res:Response,input:Input){
    const username=String(input.username??input.email??"").trim().toLowerCase(),password=String(input.password??"");
    const row=await this.db.one<Operator&{salt:string;password_hash:string}>("SELECT * FROM autosnap_users WHERE LOWER(username)=$1 OR LOWER(email)=$1",[username]);
    if(!row||!(await verifyPassword(password,row)))return this.fail(res,clientError("Username atau password salah.",401));
    if(!row.active)return this.fail(res,clientError("Akun belum aktif. Hubungi admin AutoSNAP.",403));
    await this.newSession(req,res,row.id);return res.json({ok:true});
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
    if(kind==="endpoint"&&(!["GET","POST","PUT","PATCH","DELETE"].includes(String(data.method))||(data.path&&!/^\/(?!\/)[^\s]*$/.test(String(data.path)))))return this.fail(res,clientError("Method atau path endpoint tidak valid."));
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
  private async run(res:Response,input:Input){
    const rows=await this.allRecords(),client=get(rows,input.clientId,"client"),project=get(rows,input.projectId,"project"),environment=get(rows,input.environmentId,"environment"),snapUser=input.userId?get(rows,input.userId,"snap_user"):null,service=get(rows,input.serviceId,"service"),endpoint=get(rows,input.endpointId,"endpoint"),template=input.templateId?get(rows,input.templateId,"template"):rows.find(row=>row.kind==="template"&&row.parent_id===input.endpointId);
    if(!client||!project||!environment||!service||!endpoint)return this.fail(res,clientError("Konfigurasi test belum lengkap."));
    if(input.userId&&!snapUser)return this.fail(res,clientError("User SNAP tidak ditemukan."));
    const serviceEndpointValid=service.parent_id===endpoint.id||endpoint.parent_id===service.id;
    const userValid=!!snapUser&&(value(environment,"defaultUserId")?value(environment,"defaultUserId")===snapUser.id:snapUser.parent_id===project.id);
    if(project.parent_id!==client.id||environment.parent_id!==project.id||!serviceEndpointValid||!userValid)return this.fail(res,clientError("Relasi data pengujian tidak sesuai."));
    if(input.templateId&&(!template||template.parent_id!==endpoint.id))return this.fail(res,clientError("Template tidak melekat pada endpoint terpilih."));
    const mode=value(environment,"mode"),method=value(endpoint,"method"),path=value(endpoint,"path"),serviceCode=value(service,"code");
    if(!["Informasi Saldo","Registrasi","Keamanan"].includes(value(service,"module")))return this.fail(res,clientError("Tahap ini hanya mengaktifkan Balance Inquiry beserta prasyarat Registrasi dan Keamanan."));
    if(value(environment,"category")!=="Dev Site")return this.fail(res,clientError("Pengujian saat ini hanya untuk Dev Site."));
    if(!["mock","live","portal"].includes(mode))return this.fail(res,clientError("Mode environment tidak valid."));
    if(serviceCode==="11"&&method!=="POST")return this.fail(res,clientError("Balance Inquiry harus menggunakan POST."));
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
      for(const [key,label] of [["clientId","Client ID"],["clientSecret","Client Secret"],["privateKey","Private Key"],["channelId","CHANNEL-ID"]])if(!value(client,key))missing.push(label);
      if(!client.partner_id)missing.push("X-PARTNER-ID");
      if(!snapUser||!value(snapUser,"email")||!value(snapUser,"password"))missing.push("Email dan Password User SNAP");
      if(missing.length)return this.fail(res,clientError("Lengkapi Master Data untuk browser ASPI: "+missing.join(", ")+"."));
    }
    if(!path||!path.startsWith("/"))return this.fail(res,clientError("Endpoint harus dikonfigurasi sebelum dijalankan."));
    if(/production|prod\b/i.test(environment.name))return this.fail(res,clientError("Target production tidak diizinkan untuk automation ini."));
    const useCase=String(input.useCase??environment.data.useCase??"B2B") as UseCase;
    if(!["B2B","B2B2C"].includes(useCase))return this.fail(res,clientError("Pilih use case B2B atau B2B2C."));
    if(useCase==="B2B2C"&&serviceCode==="11"&&(!snapUser||!value(snapUser,"customerToken")||!value(client,"deviceId")))return this.fail(res,clientError("Balance Inquiry B2B2C memerlukan User SNAP, customer access token, dan X-DEVICE-ID."));
    if(serviceCode==="11"&&useCase==="B2B2C"&&value(snapUser??undefined,"customerTokenExpiresAt")&&Date.parse(value(snapUser??undefined,"customerTokenExpiresAt"))<=Date.now())return this.fail(res,clientError("Customer token kedaluwarsa. Perbarui melalui Keamanan sebelum testing."));
    const scenarios=await this.catalog(),scenarioId=input.scenarioId?String(input.scenarioId):null,scenario=scenarioId?scenarios.find(item=>item.id===scenarioId):null;
    if(scenarioId&&!scenario)return this.fail(res,clientError("Skenario tidak ditemukan."));
    if(scenario){
      const groups=new Set(scenarios.filter(item=>!item.expectedCode?.includes("xx")&&item.expectedCode?.slice(3,5)===serviceCode).map(item=>item.group));
      if(!groups.has(scenario.group)||(!scenario.expectedCode?.includes("xx")&&scenario.expectedCode?.slice(3,5)!==serviceCode))return this.fail(res,clientError("Skenario tidak sesuai dengan API service yang dipilih."));
    }
    let body:Record<string,unknown>;
    try{body=JSON.parse(String(input.body??"{}"));}catch{return this.fail(res,clientError("Request body harus JSON valid."));}
    if(!object(body))return this.fail(res,clientError("Request body harus objek JSON."));
    const readSecret=(field:string)=>{const stored=value(snapUser??undefined,field);if(!stored)throw clientError("Isi "+field+" pada Master Data > User SNAP terlebih dahulu.");return decrypt(stored);};
    const resolve=(entry:unknown):unknown=>{
      if(Array.isArray(entry))return entry.map(resolve);
      if(object(entry))return Object.fromEntries(Object.entries(entry).map(([key,item])=>[key,resolve(item)]));
      if(entry==="{{partner_reference_no}}")return Date.now().toString()+randomBytes(6).toString("hex");
      if(entry==="{{client.deviceId}}")return value(client,"deviceId");
      const variables:Record<string,string>={"{{registration.accountNo}}":"accountNo","{{registration.bankCardToken}}":"bankCardToken","{{authorization_code}}":"authCode","{{refresh_token}}":"refreshToken"};
      if(typeof entry==="string"&&variables[entry])return readSecret(variables[entry]);
      return entry;
    };
    body=resolve(body) as Record<string,unknown>;
    // Registration data belongs to User SNAP. Reuse it when Balance Inquiry
    // does not provide an explicit account, so operators never retype secrets.
    if(serviceCode==="11"&&snapUser&&!body.accountNo&&!body.bankCardToken&&!scenarioId?.endsWith(".3")&&!scenarioId?.endsWith(".4")){
      if(value(snapUser,"accountNo"))body.accountNo=decrypt(value(snapUser,"accountNo"));
      else if(value(snapUser,"bankCardToken"))body.bankCardToken=decrypt(value(snapUser,"bankCardToken"));
    }
    if(/\{\{[^}]+\}\}/.test(JSON.stringify(body)))return this.fail(res,clientError("Masih ada placeholder yang belum diisi pada request."));
    const negativeFieldCase=scenarioId?.endsWith(".3")||scenarioId?.endsWith(".4");
    if(serviceCode==="11"&&!negativeFieldCase){
      const errors=validateBalanceRequest(body,useCase==="B2B2C"&&!!value(snapUser??undefined,"customerToken"));
      if(errors.length)return this.fail(res,clientError(errors.join(" ")));
    }
    const savesPrerequisite=["01","03","04","07","08","74"].includes(serviceCode);
    if(savesPrerequisite&&!snapUser)return this.fail(res,clientError("Pilih User SNAP agar hasil Registrasi atau Keamanan dapat disimpan otomatis."));
    const expected=codeFor(scenario?.expectedCode,serviceCode)??(serviceCode==="11"?"2001100":null),externalId=String(input.externalId??"").trim()||Date.now().toString()+String(Math.floor(Math.random()*1000000)).padStart(6,"0");
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
    const started=Date.now();let result:HitResult;
    if(mode==="mock"){
      const code=expected??"200"+serviceCode+"00",timestamp=isoJakarta();
      const response=serviceCode==="11"?mockBalance(body,code):{responseCode:code,responseMessage:scenario?.expected.match(/(?:Response|Error) Message:\s*"([^"]+)/i)?.[1]??(code.startsWith("2")?"Successful":"Simulated error"),additionalInfo:{mock:true}};
      result={status:Number(code.slice(0,3)),body:response,request:{method,path,timestamp,externalId,body:method==="GET"?null:body,headers:{"Content-Type":"application/json","Authorization":"[MOCK TOKEN]","X-TIMESTAMP":timestamp,"X-SIGNATURE":"[MOCK SIGNATURE]","X-PARTNER-ID":client.data.partnerIdSource==="client_id"?value(client,"clientId"):client.partner_id,"X-EXTERNAL-ID":externalId,"CHANNEL-ID":value(client,"channelId"),...(useCase==="B2B2C"?{"Authorization-Customer":"[MOCK CUSTOMER TOKEN]"}:{}),...(value(client,"deviceId")?{"X-DEVICE-ID":value(client,"deviceId")}:{}),...requestHeaders}}};
    }else if(mode==="portal"){
      try{result=await this.portal.hit({portalUrl:value(endpoint,"portalUrl"),path,method,body,client,user:snapUser!,externalId,extraHeaders:requestHeaders});}
      catch(error){result={status:0,body:{error:error instanceof Error?error.message:"Automasi Portal ASPI gagal"},request:{method,path,portalUrl:value(endpoint,"portalUrl"),externalId,body}};}
    }else{
      try{result=await this.engine.hit({baseUrl:value(environment,"baseUrl"),path,method,body,client,user:snapUser??null,scenarioId,externalId,extraHeaders:requestHeaders,authFlow:serviceCode==="11"?"token_b2b":value(environment,"authFlow")||"token_b2b",useCase,tokenPath:value(environment,"tokenPath")||"/api/v1.0/access-token/b2b",rsaEncoding:value(environment,"rsaEncoding")||"base64",hmacEncoding:value(environment,"hmacEncoding")||"hex"});}
      catch(error){result={status:0,body:{error:error instanceof Error?error.message:"Live request failed"},request:{method,path,externalId,body}};}
    }
    const duration=Date.now()-started,responseBody=object(result.body)?result.body:{},responseCode=String(responseBody.responseCode??"")||null;
    const checks=serviceCode==="11"?balanceResponseChecks(result.status,result.body,expected??"2001100",body):[];
    const status=checks.length?(checks.every(check=>check.passed)?"Passed":"Failed"):expected?(responseCode===expected&&result.status===Number(expected.slice(0,3))?"Passed":"Failed"):(result.status>=200&&result.status<300?"Passed":"Failed");
    let notes=mode==="mock"?"Simulasi lokal; bukan bukti kesesuaian terhadap penyedia SNAP.":mode==="portal"?(status==="Failed"?"Form ASPI telah dijalankan, tetapi respons tidak sesuai ekspektasi.":"Form Aplikasi Pengujian ASPI berhasil dijalankan."):status==="Failed"?"Respons tidak sesuai ekspektasi. Periksa hasil validasi dan respons tersanitasi.":"Respons sesuai skenario.";
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
    const requestSnapshot={...result.request,validation:checks,context:{client:client.name,project:project.name,environment:environment.name,user:snapUser?.name??null,service:service.name,endpoint:endpoint.name,template:template?.name??null,useCase}};
    await this.db.query("INSERT INTO autosnap_runs (id,client_id,project_id,environment_id,user_id,service_id,endpoint_id,scenario_id,mode,status,http_status,response_code,expected_code,duration_ms,request_json,response_json,notes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18)",[id,client.id,project.id,environment.id,snapUser?.id??null,service.id,endpoint.id,scenarioId,mode,status,result.status,responseCode,expected,duration,JSON.stringify(redact(requestSnapshot)),JSON.stringify(redact(result.body)),notes,now]);
    return res.json({ok:true,id,status,httpStatus:result.status,responseCode,expectedCode:expected,durationMs:duration,response:redact(result.body),checks,notes});
  }
}

@Module({controllers:[AutoSnapController],providers:[DatabaseService,RunEngine,PortalEngine]})
export class AppModule {}
