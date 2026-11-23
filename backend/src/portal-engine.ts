import type {Parameter,AuthWorkflow} from "./endpoint-config";
import {resolveRequestPath} from "./request-builder";
import {authenticationWorkflow,executeWorkflow,type AuthStage} from "./auth-workflow";
import {pdfSettings} from "./pdf-settings";
import { Injectable, Logger } from "@nestjs/common";
import type { Locator, Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from "playwright-core";
import type { RecordRow } from "./database.service";
import type { HitResult, AspiEvidenceSession } from "./run-engine";
import { isoJakarta, checkHeaders } from "./run-engine";
import { decrypt, redact } from "./security";
import { AspiFormResolver, normalizedParameterName } from "./aspi-form-resolver";
import { AspiSessionManager } from "./aspi-session-manager";
import { AspiAutomationError, type HitOutcome } from "./aspi-types";
import { ACTIVITY_PAGE, fetchOfficialPdf, readActivities } from "./aspi-evidence";
import { openPdfCaptureBrowser, type PdfCaptureProfile } from "./pdf-browser";
import { collectActivityPdfs, type PdfEvidence } from "./aspi-pdf-batch";

export {normalizedParameterName};
export {resolveRequestPath};
type RegistrationStep={portalUrl:string;path:string;body:Record<string,unknown>;externalId:string};
type ProgressReporter=(stage:string,status:"running"|"completed"|"failed",detail?:string)=>Promise<void>;
type PortalInput={authFlow?:"unknown"|"b2b"|"b2b2c"|"none";workflow?:AuthWorkflow;omitBody?:boolean;serviceName?:string;parameters?:Record<string,unknown>;parameterDefinitions?:Parameter[];portalUrl:string;path:string;method:string;body:Record<string,unknown>;client:RecordRow;user:RecordRow;externalId:string;extraHeaders:Record<string,string>;registration?:RegistrationStep|null;negativeAccessToken?:boolean;signal?:AbortSignal;onProgress?:ProgressReporter};
type ExecutePolicy={bodyText?:string;omitBody?:boolean;expectedRelative?:string};
const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
export function aspiActivityDownloadUrl(activityId:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activityId))throw new Error("Activity ID ASPI tidak valid.");
  return `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;
}
/** ASPI platform auth pages only. Service-under-test URLs come from endpoint.portalUrl / registration.portalUrl in Master Data. */
export const PORTAL_URLS={signatureAuth:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_utilities_signature_auth",signatureService:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_utilities_signature_service",accessTokenB2B:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_access_token_b2b"} as const;
function portalUrl(raw:string){let url:URL;try{url=new URL(raw);}catch{throw new AspiAutomationError("FORM_NOT_READY","URL Aplikasi Pengujian ASPI tidak valid.");}if(url.protocol!=="https:"||url.hostname!=="apidevportal.aspi-indonesia.or.id"||!url.pathname.startsWith("/api-services/"))throw new AspiAutomationError("FORM_NOT_READY","URL harus berasal dari halaman api-services ASPI Developer Portal.");return url.toString();}
export function classifyHttpOutcome(status:number,body:unknown):HitOutcome{const parsed=body&&typeof body==="object"&&!Array.isArray(body)?body as Record<string,unknown>:{};return status<200||status>=300?"HTTP_ERROR":typeof parsed.responseCode==="string"&&!String(parsed.responseCode).startsWith("2")?"SNAP_BUSINESS_ERROR":"SUCCESS";}
export function correlatesTarget(method:string,path:string,requestMethod:string,url:string){try{return requestMethod.toUpperCase()===method.toUpperCase()&&new URL(url).pathname.replace(/\/$/,"").endsWith(path.replace(/\/$/,""));}catch{return false;}}
/** Capture network traffic at BrowserContext level, including requests from iframes/popups.
 *  Set listeners BEFORE clicking Execute. Never retry a financial API request. */
export async function captureTargetResponse(
  page: Page,
  method: string,
  path: string,
  execute: () => Promise<void>,
  timeout = 30000
): Promise<PlaywrightResponse> {
  const context = page.context();
  const observedRequests: string[] = [];
  let dispatched = false;
  let failedReason: string | null = null;
  let settle!: (response: PlaywrightResponse | null) => void;
  const pending = new Promise<PlaywrightResponse | null>(resolve => { settle = resolve; });
  const matches = (request: PlaywrightRequest) =>
    correlatesTarget(method, path, request.method(), request.url());

  const onRequest = (request: PlaywrightRequest) => {
    if (observedRequests.length < 30) {
      // No query strings, header values or request body in History.
      observedRequests.push(`${request.method()} ${thisUrl(request.url())}`);
    }
    if (matches(request)) dispatched = true;
  };
  const onResponse = (response: PlaywrightResponse) => {
    if (matches(response.request())) { dispatched = true; settle(response); }
  };
  const onFailed = (request: PlaywrightRequest) => {
    if (!matches(request)) return;
    dispatched = true;
    failedReason = request.failure()?.errorText ?? "Network request failed";
    settle(null);
  };

  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onFailed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await execute();
    const response = await Promise.race([
      pending,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeout); })
    ]);
    if (response) return response;
    if (failedReason) {
      throw new AspiAutomationError("TRANSPORT_ERROR", `${method} ${path} gagal di jaringan.`, {
        requestDispatched: true, networkError: failedReason, observedRequests
      });
    }
    if (dispatched) {
      throw new AspiAutomationError("TRANSPORT_ERROR", `Tidak ada HTTP response untuk ${method} ${path}.`, {
        requestDispatched: true, observedRequests
      });
    }
    throw new AspiAutomationError("FORM_NOT_READY", `Execute tidak menghasilkan request ${method} ${path}.`, {
      requestDispatched: false, observedRequests
    });
  } finally {
    if (timer) clearTimeout(timer);
    context.off("request", onRequest);
    context.off("response", onResponse);
    context.off("requestfailed", onFailed);
  }
}

function thisUrl(raw:string){try{const url=new URL(raw);return `${url.origin}${url.pathname}`;}catch{return "invalid-url";}}

@Injectable()
export class PortalEngine{
  private readonly logger=new Logger(PortalEngine.name);
  private readonly pdfCache=new Map<string,{pdf:Buffer;expiresAt:number}>();
  private readonly pendingPdfs=new Map<string,Promise<Buffer>>();
  constructor(private readonly sessions:AspiSessionManager,private readonly forms:AspiFormResolver){}
  async hit(input:PortalInput):Promise<HitResult>{
    const timestamp=isoJakarta();
    let release:(()=>Promise<void>)|undefined,page:Page|undefined,currentStage="preparing",sessionHandedOff=false;
    let sessionBeat:(()=>Promise<unknown>|undefined|void)|undefined;
    const completedRequests:Record<string,unknown>[]=[];
    let activityBaseline:string[]|undefined;
    const report:ProgressReporter=async(stage,status,detail)=>{currentStage=stage;await Promise.resolve(sessionBeat?.()).catch(()=>undefined);await input.onProgress?.(stage,status,detail).catch(()=>undefined);};
    const execute:typeof this.execute=async(...args)=>{
      input.signal?.throwIfAborted();
      const startedAt=new Date().toISOString();
      const result=await this.execute(...args);
      Object.assign(result.request,{method:args[3],httpStatus:result.status,startedAt,finishedAt:new Date().toISOString()});
      completedRequests.push(result.request);
      input.signal?.throwIfAborted();
      if(args[2]!==input.path&&Array.isArray(result.request.automationChecks)&&result.request.automationChecks.some(check=>check&&typeof check==="object"&&(check as {passed?:boolean}).passed!==true))throw new AspiAutomationError("AUTOMATION_ERROR","Request aktual berbeda dari konfigurasi; tahap berikutnya dihentikan.");
      return result;
    };
    try{
      input.signal?.throwIfAborted();
      checkHeaders(input.extraHeaders);
      const targetUrl=portalUrl(input.portalUrl);
      const {profile,nodes}=authenticationWorkflow({authFlow:input.authFlow??"b2b",workflow:input.workflow,parameters:input.parameterDefinitions??[]});
      if(input.negativeAccessToken&&profile.token==="none")throw new AspiAutomationError("PRECONDITION_FAILED","Tes token tidak berlaku tanpa autentikasi.");
      if(input.negativeAccessToken&&input.registration)throw new AspiAutomationError("PRECONDITION_FAILED","Tes negatif tidak menjalankan registrasi atau memperbaiki payload otomatis.");
      const signingPath=resolveRequestPath(input.path,input.parameterDefinitions??[],input.parameters??{});
      const omitBody=input.omitBody||["GET","HEAD"].includes(input.method);
      const acquired=await this.sessions.getAuthenticatedContext(input.user,new URL(targetUrl).hostname,async page=>{
        await page.goto(targetUrl,{waitUntil:"domcontentloaded",timeout:60000});
        await this.activateTestingPanel(page);return this.hasSwagger(page);
      },input.signal);
      release=acquired.release;page=acquired.page;sessionBeat=acquired.beat;
      const clientId=value(input.client,"clientId"),channelId=value(input.client,"channelId");
      const partnerId=value(input.client,"partnerIdSource")==="client_id"?clientId:input.client.partner_id??"";
      try{activityBaseline=(await this.activitiesInContext(page,Date.now()+15000)).map(item=>item.activityId);}
      catch{await report("evidence","failed","Daftar aktivitas awal ASPI tidak tersedia; Activity ID tidak ditebak.");}
      let signatureAuth="",token="",customerToken="",serviceSignature="";
      const serviceBody={...input.body};
      let registrationOutput:Record<string,unknown>|null=null,target:HitResult|undefined;
      const successful=(result:HitResult,field:string,message:string)=>{
        const body=this.object(result.body);
        if(!this.ok(result.status)||typeof body[field]!=="string"||!body[field]||body.responseCode&&!String(body.responseCode).startsWith("2"))throw new AspiAutomationError("PRECONDITION_FAILED",message,{prerequisiteHttpStatus:result.status});
        return String(body[field]);
      };
      const headersFor=(signature:string,externalId:string):Record<string,string>=>{
        const headers:Record<string,string>={"Content-Type":"application/json",...input.extraHeaders};
        if(profile.token!=="none")Object.assign(headers,{"Authorization":`Bearer ${token}`,"X-TIMESTAMP":timestamp,"X-PARTNER-ID":partnerId,"X-EXTERNAL-ID":externalId,"CHANNEL-ID":channelId});
        if(profile.signature==="hmac")headers["X-SIGNATURE"]=signature;
        if(customerToken)headers["Authorization-Customer"]=`Bearer ${customerToken}`;
        if(value(input.client,"deviceId"))headers["X-DEVICE-ID"]=value(input.client,"deviceId");
        return headers;
      };
      const handlers:Record<AuthStage,()=>Promise<void>>={
        signature_auth:async()=>{
          const result=await execute(page!,PORTAL_URLS.signatureAuth,"/api/v1.0/utilities/signature-auth","POST",{"X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientId,"Private_Key":decrypt(value(input.client,"privateKey"))},{});
          signatureAuth=successful(result,"signature","Signature Authentication tidak menghasilkan signature.");
        },
        access_token:async()=>{
          if(profile.token==="provided"){
            const expires=Date.parse(value(input.client,"accessTokenExpiresAt"));
            if(!Number.isFinite(expires)||expires<=Date.now())throw new AspiAutomationError("PRECONDITION_FAILED","Masa berlaku access token tersimpan harus diketahui dan belum kedaluwarsa.");
            token=decrypt(value(input.client,"accessToken"));
          }else{
            const result=await execute(page!,PORTAL_URLS.accessTokenB2B,"/api/v1.0/access-token/b2b","POST",{"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientId,"X-SIGNATURE":signatureAuth},{grantType:"client_credentials",additionalInfo:{}});
            token=successful(result,"accessToken","Access Token B2B tidak menghasilkan accessToken.");
          }
          // Deliberately corrupt only the selected client's token. Never refresh/repair it afterwards.
          if(input.negativeAccessToken)token=`${token.slice(0,Math.max(1,token.length-4))}INVALID`;
        },
        customer_token:async()=>{
          const expires=value(input.user,"customerTokenExpiresAt");
          if(!value(input.user,"customerToken")||expires&&(!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.now()))throw new AspiAutomationError("PRECONDITION_FAILED","Customer token B2B2C belum tersedia atau kedaluwarsa; diperlukan consent pelanggan.");
          customerToken=decrypt(value(input.user,"customerToken"));
        },
        signature_service:async()=>{
          // Legacy registration is explicit, scoped to the selected SNAP user, and positive-only.
          if(input.registration){
            await report("registration","running",input.registration.path);
            const signature=await execute(page!,PORTAL_URLS.signatureService,"/api/v1.0/utilities/signature-service","POST",{"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-SECRET":decrypt(value(input.client,"clientSecret")),"HttpMethod":"POST","EndpoinUrl":input.registration.path,"AccessToken":token},input.registration.body);
            const registration=await execute(page!,portalUrl(input.registration.portalUrl),input.registration.path,"POST",headersFor(successful(signature,"signature","Signature registrasi gagal."),input.registration.externalId),input.registration.body);
            registrationOutput=this.object(registration.body);
            if(!this.ok(registration.status)||!String(registrationOutput.responseCode??"").startsWith("2"))throw new AspiAutomationError("PRECONDITION_FAILED","Registrasi otomatis gagal; API target belum dijalankan.");
            if(typeof registrationOutput.bankCardToken==="string"&&registrationOutput.bankCardToken)serviceBody.bankCardToken=registrationOutput.bankCardToken;
            else if(typeof registrationOutput.accountNo==="string"&&registrationOutput.accountNo)serviceBody.accountNo=registrationOutput.accountNo;
            else throw new AspiAutomationError("PRECONDITION_FAILED","Registrasi tidak menghasilkan bankCardToken atau accountNo.");
            await report("registration","completed",input.registration.path);
          }
          const result=await execute(page!,PORTAL_URLS.signatureService,"/api/v1.0/utilities/signature-service","POST",{"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-SECRET":decrypt(value(input.client,"clientSecret")),"HttpMethod":input.method,"EndpoinUrl":signingPath,"AccessToken":token},serviceBody,undefined,{bodyText:omitBody?"":undefined});
          serviceSignature=successful(result,"signature","Signature Service tidak menghasilkan signature.");
        },
        api_request:async()=>{
          target=await execute(page!,targetUrl,input.path,input.method,headersFor(serviceSignature,input.externalId),serviceBody,input.parameters,{expectedRelative:signingPath,omitBody});
        }
      };
      await executeWorkflow(nodes,Object.fromEntries(nodes.map(node=>[node.stage,async()=>{
        const detail=node.stage==="api_request"?`${input.serviceName??input.path} — ${input.method} ${input.path}`:node.stage==="access_token"?(profile.token==="provided"?"Token tersimpan milik client terpilih":"Access Token B2B"):node.stage==="customer_token"?"Customer token dari consent User SNAP terpilih":undefined;
        await report(node.stage,"running",detail);await handlers[node.stage]();await report(node.stage,"completed",detail);
      }])) as Record<AuthStage,()=>Promise<void>>);
      if(!target)throw new AspiAutomationError("AUTOMATION_ERROR","Workflow belum mengeksekusi API target.");
      const evidenceSession:AspiEvidenceSession={page,release,beat:sessionBeat};sessionHandedOff=true;
      return {...target,activityBaseline,evidenceSession,request:{...target.request,method:input.method,path:input.path,portalUrl:input.portalUrl,timestamp,externalId:input.externalId,body:omitBody?null:serviceBody,registrationOutput,steps:completedRequests.slice(0,-1)}};
    }catch(error){
      const timeout=error instanceof Error&&/timeout/i.test(`${error.name} ${error.message}`);
      const typed=input.signal?.aborted?new AspiAutomationError("CANCELLED","Pengujian dibatalkan pengguna. Request yang sudah terkirim tidak dapat ditarik kembali."):error instanceof AspiAutomationError?error:new AspiAutomationError(timeout?"TIMEOUT":"AUTOMATION_ERROR",timeout?"Automasi Portal ASPI melewati batas waktu.":"Automasi Portal ASPI gagal sebelum respons API target diterima.");
      await report(currentStage,"failed",typed.message);
      this.logger.error(`[${input.externalId}] ${typed.outcome} pada ${currentStage}: ${typed.message}`);
      return {status:null,outcome:typed.outcome,body:{error:typed.message,failedStage:currentStage,diagnostic:redact(typed.diagnostic)},request:{method:input.method,path:input.path,portalUrl:input.portalUrl,timestamp,externalId:input.externalId,body:input.body,steps:completedRequests}};
    }finally{if(!sessionHandedOff)await release?.();}
  }
  async downloadActivityPdf(user:RecordRow,activityId:string){
    aspiActivityDownloadUrl(activityId);
    const cacheKey=`${user.id}:${activityId}`;
    const cached=this.pdfCache.get(cacheKey);
    if(cached&&cached.expiresAt>Date.now())return cached.pdf;
    this.pdfCache.delete(cacheKey);
    const pending=this.pendingPdfs.get(cacheKey);
    if(pending)return pending;
    const job=this.fetchOfficialActivityPdf(user,activityId).then(pdf=>{
      for(const [key,item] of this.pdfCache)if(item.expiresAt<=Date.now())this.pdfCache.delete(key);
      let bytes=[...this.pdfCache.values()].reduce((total,item)=>total+item.pdf.length,0);
      for(const [key,item] of this.pdfCache){
        if(bytes+pdf.length<=32*1024*1024)break;
        bytes-=item.pdf.length;this.pdfCache.delete(key);
      }
      this.pdfCache.set(cacheKey,{pdf,expiresAt:Date.now()+10*60_000});
      return pdf;
    }).finally(()=>{this.pendingPdfs.delete(cacheKey);});
    this.pendingPdfs.set(cacheKey,job);
    return job;
  }
  /** Download official ASPI Download-button bytes only. Never generates or prints a PDF. */
  private async fetchOfficialActivityPdf(user:RecordRow,activityId:string){
    const url=aspiActivityDownloadUrl(activityId);let release:(()=>Promise<void>)|undefined;
    try{
      const acquired=await this.sessions.getAuthenticatedContext(user,"apidevportal.aspi-indonesia.or.id",async page=>{
        await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:30000});
        return !page.url().includes("/sign-in");
      });
      release=acquired.release;
      return await fetchOfficialPdf(acquired.page,url,undefined,"navigation");
    }finally{await release?.();}
  }
  private async execute(page:Page,url:string,path:string,method:string,headers:Record<string,string>,body:Record<string,unknown>,parameters?:Record<string,unknown>,policy:ExecutePolicy={}):Promise<HitResult>{
    let operation!:Locator;
    // Swagger ASPI kadang selesai memuat body editor lebih dahulu, tetapi event
    // Try it out belum terpasang. Muat ulang satu kali sebelum ada Execute/API
    // request sehingga pemulihan ini aman dan tidak membuat request ganda.
    for(let activationAttempt=0;activationAttempt<2;activationAttempt++){
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
      await this.activateTestingPanel(page);
      if(!await this.hasSwagger(page))throw new AspiAutomationError("AUTH_SESSION_EXPIRED","Sesi ASPI tidak lagi memberikan akses ke Aplikasi Pengujian.",await this.panelDiagnostic(page));
      ({operation}=await this.forms.operation(page,path,method));
      if(!(await operation.getAttribute("class"))?.includes("is-open")){
        await operation.locator(".opblock-summary").click();
        await operation.locator(".opblock-body").waitFor({state:"visible",timeout:15000});
      }
      try{
        await this.forms.activateTryOut(operation,path);
        break;
      }catch(error){
        if(!(error instanceof AspiAutomationError)||error.outcome!=="FORM_NOT_READY"||activationAttempt===1)throw error;
      }
    }
    for(const [name,entry] of Object.entries(parameters??{}))await this.forms.fillParameter(operation,name,typeof entry==="object"?JSON.stringify(entry):String(entry));
    for(const [name,entry] of Object.entries(headers))await this.forms.fillParameter(operation,name,entry);
    // Beberapa utility ASPI (contohnya Signature Auth) hanya menerima header
    // dan memang tidak mempunyai editor request body. Jangan mencari textarea
    // untuk payload kosong; endpoint dengan payload tetap wajib mengisi body.
    if(policy.bodyText!==undefined)await this.forms.fillBody(operation,policy.bodyText);
    else if(policy.omitBody){if(await operation.locator('textarea.body-param__text:visible, .body-param textarea:visible').count())await this.forms.fillBody(operation,"");}
    else if(Object.keys(body).length>0||!['GET','HEAD'].includes(method)&&await operation.locator('textarea.body-param__text:visible, .body-param textarea:visible').count())await this.forms.fillBody(operation,body);
    // Pada beberapa form ASPI, perubahan body memicu render ulang Swagger dan
    // mengosongkan input Content-Type walaupun header lain tetap tersimpan.
    // Isi ulang paling akhir agar validasi internal Execute menerima form.
    const contentType=Object.entries(headers).find(([name])=>name.toLowerCase()==="content-type");
    if(contentType)await this.forms.fillParameter(operation,contentType[0],contentType[1]);
    const executeButton = operation.getByRole("button", { name: /^execute$/i }).first();
    if (!await executeButton.count()) {
      throw new AspiAutomationError("FORM_NOT_READY", `Tombol Execute tidak ditemukan untuk ${path}.`, await this.forms.diagnostic(operation));
    }
    await executeButton.waitFor({ state: "visible", timeout: 15000 });
    if (!await executeButton.isEnabled()) {
      throw new AspiAutomationError("FORM_NOT_READY", `Tombol Execute tidak aktif untuk ${path}.`, await this.forms.diagnostic(operation));
    }

    // Basic browser validity differs from Swagger's own JS validation.
    const formState = await this.forms.diagnostic(operation);
    const invalidFields = (formState.fields as Record<string, unknown>[]).filter(item => item.valid === false);
    if (invalidFields.length) {
      throw new AspiAutomationError("FORM_NOT_READY", `Ada field HTML yang tidak valid pada ${path}.`, {
        invalidFields
      });
    }

    const browserIssues: string[] = [];
    const onPageError = () => { if (browserIssues.length < 10) browserIssues.push("Unhandled JavaScript error"); };
    const onConsole = (message: {type():string}) => {
      if (message.type() === "error" && browserIssues.length < 10) browserIssues.push("Console error");
    };
    page.on("pageerror", onPageError);
    page.on("console", onConsole);
    let captured: PlaywrightResponse;
    try {
      captured = await captureTargetResponse(page, method, path.replace(/\{[^}]+\}/g,match=>encodeURIComponent(String(parameters?.[match.slice(1,-1)]??match))), () => executeButton.click());
    } catch (error) {
      if (error instanceof AspiAutomationError && error.outcome === "FORM_NOT_READY") {
        const diagnostic = await this.forms.diagnostic(operation);
        const messages = await operation.locator(
          '.errors-wrapper, .validation-error, [role="alert"], .error, .invalid-feedback'
        ).allTextContents().catch(() => []);
        throw new AspiAutomationError("FORM_NOT_READY", `Form ASPI belum berhasil mengirim ${method} ${path}.`, {
          ...error.diagnostic,
          ...diagnostic,
          javascriptIssues: browserIssues,
          validationMessageCount: messages.filter(text => text.trim()).length,
          // No raw validation message: it could contain credentials.
          executeEnabled: await executeButton.isEnabled().catch(() => false)
        });
      }
      throw error;
    } finally {
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
    }
    const requestHeaders=await captured.request().allHeaders(),verification=this.verifyHeaders(headers,requestHeaders),raw=await captured.text().catch(()=>"");let parsed:unknown=raw;try{parsed=JSON.parse(raw);}catch{}
    const actualUrl=new URL(captured.url());
    if(policy.expectedRelative)verification.push({label:"Canonical request path",passed:actualUrl.pathname+actualUrl.search===policy.expectedRelative,detail:"Method/path/query aktual harus sama dengan input Signature Service.",sensitive:false});
    for(const [name,expected]of Object.entries(parameters??{})){
      const actual=requestHeaders[name.toLowerCase()]??actualUrl.searchParams.get(name);
      const isPath=path.includes(`{${name}}`);
      const passed=isPath?actualUrl.pathname.includes(encodeURIComponent(String(expected))):actual===String(expected);
      verification.push({label:`Parameter ${name}`,passed,detail:passed?"Parameter terkirim sesuai konfigurasi.":"Parameter aktual tidak sesuai konfigurasi.",sensitive:/token|secret|password|key|account|card/i.test(name)});
    }
    const sent=captured.request().postData()??"";
    let bodyMatches=false;
    try{bodyMatches=policy.bodyText!==undefined?sent===policy.bodyText:policy.omitBody||['GET','HEAD'].includes(method)?sent==="":sent?JSON.stringify(JSON.parse(sent))===JSON.stringify(body):Object.keys(body).length===0;}catch{}
    verification.push({label:"Request body",passed:bodyMatches,detail:bodyMatches?"Body aktual sesuai payload yang disiapkan untuk signature.":"Body aktual berbeda dari payload yang disiapkan; jangan menganggap signature valid.",sensitive:true});
    const status=captured.status(),outcome=classifyHttpOutcome(status,parsed);
    const storedUrl=new URL(captured.url());
    for(const name of storedUrl.searchParams.keys())storedUrl.searchParams.set(name,"[REDACTED]");
    for(const [name,entry]of Object.entries(parameters??{}))if(path.includes(`{${name}}`))storedUrl.pathname=storedUrl.pathname.replace(encodeURIComponent(String(entry)),"[REDACTED]");
    const safeHeaders={...requestHeaders};for(const name of Object.keys(safeHeaders))if(name.startsWith(":"))delete safeHeaders[name];
    return {status,outcome,body:parsed,request:{name:path,method,path,portalUrl:url,httpStatus:status,actualUrl:storedUrl.toString(),automationChecks:verification,headers:redact(safeHeaders)}};
  }
  private async activitiesInContext(page:Page,deadline?:number){
    let location:URL|undefined;
    try{location=new URL(page.url());}catch{location=undefined;}
    if(location?.origin==="https://apidevportal.aspi-indonesia.or.id"&&location.pathname==="/aktivitas-aplikasi-pengujian")return readActivities(page,deadline);
    const activityPage=await page.context().newPage();
    try{return await readActivities(activityPage,deadline);}finally{await activityPage.close();}
  }
  /** Called by the controller only after all API calls are validated and History is saved. */
  async collectEvidence(input:{activityNames?:Record<string,string[]>;operations?:import("./evidence-plan").EvidenceOperation[];knownActivities?:Record<string,import("./aspi-evidence").AspiActivity>;onEvidence?:(result:PdfEvidence)=>Promise<void>;user:RecordRow;before:string[]|undefined;paths:string[];deadline:number;session?:AspiEvidenceSession;signal?:AbortSignal;onProgress?:ProgressReporter;pdfCapture?:PdfCaptureProfile}):Promise<PdfEvidence[]>{
    const deadline=Math.min(input.deadline,Date.now()+pdfSettings().budgetMs);
    const report=async(status:"running"|"completed"|"failed",detail:string)=>{
      await input.onProgress?.("pdf_download",status,detail).catch(()=>undefined);
    };
    if(!input.before&&!input.knownActivities||input.signal?.aborted||Date.now()>=deadline){
      return input.paths.map(path=>({path,error:input.signal?.aborted?"Download PDF dibatalkan.":!input.before?"Daftar aktivitas awal tidak tersedia; Activity ID tidak ditebak.":"Batas waktu pengambilan PDF tercapai."}));
    }
    let release:(()=>Promise<void>)|undefined;
    let closePdfBrowser:(()=>Promise<void>)|undefined;
    // Borrow the still-authenticated testing browser when available. The
    // controller always releases it in finally, including cancelled/failed runs.
    // Only the fallback (old data path) owns its browser here.
    // Close an evidence-only context when its budget expires.
    const controller=new AbortController(),abort=()=>controller.abort();
    input.signal?.addEventListener("abort",abort,{once:true});
    const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
    try{
      const session = input.session ?? await this.sessions.getAuthenticatedContext(
        input.user,
        "apidevportal.aspi-indonesia.or.id",
        async (page) => {
          const timeout = Math.max(
            1,
            Math.min(20000, deadline - Date.now())
          );

          try {
            const response = await page.goto(ACTIVITY_PAGE, {
              waitUntil: "domcontentloaded",
              timeout,
            });

            const pathname = new URL(page.url()).pathname;
            const status = response?.status() ?? null;

            this.logger.log(
              `[ASPI PDF] Activity page: HTTP ${status ?? "none"}, path=${pathname}`
            );

            return (
              response?.ok() === true &&
              pathname === "/aktivitas-aplikasi-pengujian"
            );
          } catch (error) {
            const timeoutError =
              error instanceof Error &&
              /timeout/i.test(`${error.name} ${error.message}`);

            this.logger.error(
              `[ASPI PDF] Activity navigation failed: ${
                timeoutError ? "NAVIGATION_TIMEOUT" :
                error instanceof Error ? error.name : "UNKNOWN"
              }`
            );

            throw error;
          }
        },
        controller.signal
      );
      if(!input.session)release=session.release;
      await Promise.resolve(session.beat?.()).catch(()=>undefined);
      const pdfCapture=input.pdfCapture??{kind:"chrome" as const};
      const opened=await openPdfCaptureBrowser(pdfCapture,session.page);
      closePdfBrowser=opened.close;
      const downloadPage=opened.page;
      await downloadPage.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:Math.max(1000,Math.min(30000,deadline-Date.now()))});
      if(downloadPage.url().includes("/sign-in")||await downloadPage.locator('input[type="password"]').count()){
        await this.sessions.loginIfRequired(downloadPage,input.user);
        await downloadPage.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:Math.max(1000,Math.min(30000,deadline-Date.now()))});
      }
      this.logger.log(`[ASPI PDF] PDF digambar ${pdfCapture.kind} ${pdfCapture.width??1280}x${pdfCapture.height??800} @${pdfCapture.deviceScaleFactor??1}x. Skrip download ASPI tidak ditahan.`);
      return await collectActivityPdfs({
        before:input.before,paths:input.paths,operations:input.operations,knownActivities:input.knownActivities,activityNames:input.activityNames,deadline,signal:controller.signal,
        read:()=>this.activitiesInContext(session.page,deadline),
        download:activity=>fetchOfficialPdf(downloadPage,activity.downloadUrl,deadline,"navigation"),
        report,onResult:input.onEvidence
      });
    }catch(cause){
      const isTimeout=cause instanceof Error&&/timeout|batas waktu/i.test(`${cause.name} ${cause.message}`);
      const reason=cause instanceof AspiAutomationError?cause.outcome:isTimeout?"TIMEOUT":cause instanceof Error?cause.name:"UNKNOWN";
      // Never record raw browser errors: they may contain URLs or credentials.
      this.logger.error(`[ASPI PDF] Gagal membuka aktivitas/laporan: ${reason}`);
      const error=input.signal?.aborted?"Download PDF dibatalkan.":controller.signal.aborted?"Batas waktu pengambilan PDF tercapai.":cause instanceof AspiAutomationError?cause.message:isTimeout?"Timeout mengakses halaman aktivitas ASPI.":`Halaman aktivitas ASPI gagal diakses (${reason}).`;
      await report("failed",error);
      return input.paths.map(path=>({path,error}));
    }finally{
      clearTimeout(timer);input.signal?.removeEventListener("abort",abort);
      await closePdfBrowser?.().catch(()=>undefined);
      await release?.();
    }
  }
  private verifyHeaders(expected:Record<string,string>,actual:Record<string,string>){const lower=Object.fromEntries(Object.entries(actual).map(([key,value])=>[key.toLowerCase(),value]));return Object.entries(expected).map(([name,value])=>{const received=lower[name.toLowerCase()],managed=name.toLowerCase()==="content-type",passed=managed?received?.toLowerCase().includes("application/json")===true:received===value;return {label:`Header ${name}`,passed,detail:passed?`${name} terkirim pada request aktual.`:`${name} tidak sesuai pada request aktual.`,sensitive:/authorization|signature|secret|private/i.test(name)};});}
  private async activateTestingPanel(page:Page){
    // Jangan menghabiskan 15+15 detik pada setiap tahap bila Swagger sudah siap.
    if(await this.hasSwagger(page))return;
    const button=page.locator('button[data-target="#sandBoxCollapse"]').first();
    for(let attempt=0;attempt<20;attempt++){
      if(await this.hasSwagger(page))return;
      if(await button.count()&&await button.isVisible().catch(()=>false))break;
      await page.waitForTimeout(250);
    }
    if(!await button.count()||!await button.isVisible().catch(()=>false))return;
    if(await button.getAttribute("aria-expanded")!=="true")await button.click();
    await page.locator("#sandBoxCollapse.show, .opblock:visible").first().waitFor({state:"visible",timeout:10000}).catch(()=>undefined);
  }
  private async hasSwagger(page:Page){if(await page.locator(".opblock:visible").count())return true;for(const frame of page.frames())if(frame!==page.mainFrame()&&await frame.locator(".opblock:visible").count())return true;return false;}
  private async panelDiagnostic(page:Page){const alert=page.locator("#sandBoxCollapse .alert,#sandBoxCollapse [role='alert']").first(),detail=(await alert.textContent().catch(()=>""))?.replace(/\s+/g," ").replace(/^×\s*/,"").trim();return {authenticated:!page.url().includes("/sign-in"),panelAlert:detail||null,iframeCount:page.frames().length-1};}
  private object(entry:unknown){return entry&&typeof entry==="object"&&!Array.isArray(entry)?entry as Record<string,unknown>:{};}
  private ok(status:number|null){return status!==null&&status>=200&&status<300;}
}
