import { Injectable } from "@nestjs/common";
import type { Locator, Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from "playwright-core";
import type { RecordRow } from "./database.service";
import type { HitResult } from "./run-engine";
import { isoJakarta, checkHeaders } from "./run-engine";
import { decrypt, redact } from "./security";
import { AspiFormResolver, normalizedParameterName } from "./aspi-form-resolver";
import { AspiSessionManager } from "./aspi-session-manager";
import { AspiAutomationError, type HitOutcome } from "./aspi-types";

export {normalizedParameterName};
type RegistrationStep={portalUrl:string;path:string;body:Record<string,unknown>;externalId:string};
type PortalInput={portalUrl:string;path:string;method:string;body:Record<string,unknown>;client:RecordRow;user:RecordRow;externalId:string;extraHeaders:Record<string,string>;registration?:RegistrationStep|null;negativeAccessToken?:boolean};
type AspiActivity={activityId:string;service:string;timestamp:string;downloadUrl:string};
const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
const ACTIVITY_PAGE="https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian";
export function aspiActivityDownloadUrl(activityId:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activityId))throw new Error("Activity ID ASPI tidak valid.");
  return `https://apidevportal.aspi-indonesia.or.id/sandboxactivity/downloadreportactivity?activityId=${activityId}`;
}
export const PORTAL_URLS={registrationOtp:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_otp",registrationAccountBinding:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_account_binding",registrationAccountInquiry:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_account_inquiry",getAuthCode:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/get_api_v1_0_get_auth_code",registrationCardBindLimit:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_card_bind_limit",registrationCardInquiry:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/get_api_v1_0_registration_card_inquiry",otpVerification:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_otp_verification",registrationCardUnbind:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_card_unbind",registrationAccountCreation:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_account_creation",registrationAccountUnbinding:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_account_unbinding",registrationCardBind:"https://apidevportal.aspi-indonesia.or.id/api-services/registrasi#/Registrasi/post_api_v1_0_registration_card_bind",balanceInquiry:"https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry",signatureAuth:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_utilities_signature_auth",signatureService:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_utilities_signature_service",accessTokenB2B:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_access_token_b2b",accessTokenB2B2C:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_access_token_b2b2c"} as const;
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
  private readonly pdfCache=new Map<string,{pdf:Buffer;expiresAt:number}>();
  private readonly pendingPdfs=new Map<string,Promise<Buffer>>();
  constructor(private readonly sessions:AspiSessionManager,private readonly forms:AspiFormResolver){}
  async hit(input:PortalInput):Promise<HitResult>{
    const timestamp=isoJakarta();let release:(()=>Promise<void>)|undefined;
    try{
      // Validate before opening a browser or handling any credentials.
      checkHeaders(input.extraHeaders);
      const acquired=await this.sessions.getAuthenticatedContext(input.user,new URL(input.portalUrl).hostname,async page=>{await page.goto(PORTAL_URLS.signatureAuth,{waitUntil:"domcontentloaded",timeout:60000});await this.activateTestingPanel(page);return await this.hasSwagger(page);});
      release=acquired.release;const page=acquired.page,clientId=value(input.client,"clientId"),channelId=value(input.client,"channelId"),partnerId=value(input.client,"partnerIdSource")==="client_id"?clientId:input.client.partner_id??"";
      let activitySnapshot:Set<string>|null=null;
      try{activitySnapshot=new Set((await this.activityList(page)).map(item=>item.activityId));}catch{}
      const signatureAuth=await this.execute(page,PORTAL_URLS.signatureAuth,"/api/v1.0/utilities/signature-auth","POST",{"X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientId,"Private_Key":decrypt(value(input.client,"privateKey"))},{});
      const signatureAuthBody=this.object(signatureAuth.body);if(!this.ok(signatureAuth.status)||typeof signatureAuthBody.signature!=="string"||!signatureAuthBody.signature)return this.failedStep(input,timestamp,signatureAuth,"Form Signature Access Token ASPI tidak menghasilkan signature.");
      const tokenResult=await this.execute(page,PORTAL_URLS.accessTokenB2B,"/api/v1.0/access-token/b2b","POST",{"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-KEY":clientId,"X-SIGNATURE":String(signatureAuthBody.signature)},{grantType:"client_credentials",additionalInfo:{}});
      const tokenBody=this.object(tokenResult.body);if(!this.ok(tokenResult.status)||typeof tokenBody.accessToken!=="string"||!tokenBody.accessToken)return this.failedStep(input,timestamp,tokenResult,"Form Access Token B2B ASPI tidak menghasilkan accessToken.",[signatureAuth.request]);
      const validToken=String(tokenBody.accessToken),token=input.negativeAccessToken?`${validToken.slice(0,Math.max(1,validToken.length-4))}INVALID`:validToken,steps=[signatureAuth.request,tokenResult.request],serviceBody={...input.body};let registrationOutput:Record<string,unknown>|null=null;
      if(input.registration){
        const signature=await this.execute(page,PORTAL_URLS.signatureService,"/api/v1.0/utilities/signature-service","POST",{"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-SECRET":decrypt(value(input.client,"clientSecret")),"HttpMethod":"POST","EndpoinUrl":input.registration.path,"AccessToken":validToken},input.registration.body),signatureBody=this.object(signature.body);
        if(!this.ok(signature.status)||typeof signatureBody.signature!=="string")return this.failedStep(input,timestamp,signature,"Signature otomatis untuk Card Registration gagal.",steps);
        const registrationHeaders:Record<string,string>={"Content-Type":"application/json","Authorization":`Bearer ${validToken}`,"X-TIMESTAMP":timestamp,"X-SIGNATURE":String(signatureBody.signature),"X-PARTNER-ID":partnerId,"X-EXTERNAL-ID":input.registration.externalId,"CHANNEL-ID":channelId,...input.extraHeaders};if(value(input.client,"deviceId"))registrationHeaders["X-DEVICE-ID"]=value(input.client,"deviceId");
        const registration=await this.execute(page,portalUrl(input.registration.portalUrl),input.registration.path,"POST",registrationHeaders,input.registration.body);steps.push(signature.request,registration.request);registrationOutput=this.object(registration.body);
        if(!this.ok(registration.status)||!String(registrationOutput.responseCode??"").startsWith("2"))return {status:registration.status,outcome:registration.outcome,body:{error:"Card Registration otomatis gagal. Balance Inquiry belum dijalankan.",registrationResponse:registration.body},request:{method:input.method,path:input.path,timestamp,body:input.body,steps}};
        if(typeof registrationOutput.bankCardToken==="string"&&registrationOutput.bankCardToken)serviceBody.bankCardToken=registrationOutput.bankCardToken;else if(typeof registrationOutput.accountNo==="string"&&registrationOutput.accountNo)serviceBody.accountNo=registrationOutput.accountNo;else return {status:registration.status,outcome:"SNAP_BUSINESS_ERROR",body:{error:"Card Registration tidak menghasilkan bankCardToken atau accountNo."},request:{method:input.method,path:input.path,timestamp,body:input.body,steps}};
      }
      const signatureService=await this.execute(page,PORTAL_URLS.signatureService,"/api/v1.0/utilities/signature-service","POST",{"Content-Type":"application/json","X-TIMESTAMP":timestamp,"X-CLIENT-SECRET":decrypt(value(input.client,"clientSecret")),"HttpMethod":input.method,"EndpoinUrl":input.path,"AccessToken":token},serviceBody),serviceSignatureBody=this.object(signatureService.body);
      if(!this.ok(signatureService.status)||typeof serviceSignatureBody.signature!=="string")return this.failedStep(input,timestamp,signatureService,"Form Signature Service ASPI tidak menghasilkan signature.",steps);
      const headers:Record<string,string>={"Content-Type":"application/json","Authorization":`Bearer ${token}`,"X-TIMESTAMP":timestamp,"X-SIGNATURE":String(serviceSignatureBody.signature),"X-PARTNER-ID":partnerId,"X-EXTERNAL-ID":input.externalId,"CHANNEL-ID":channelId,...input.extraHeaders};if(value(input.client,"deviceId"))headers["X-DEVICE-ID"]=value(input.client,"deviceId");
      const result=await this.execute(page,portalUrl(input.portalUrl),input.path,input.method,headers,serviceBody);
      let aspiActivities:AspiActivity[]=[];
      if(activitySnapshot)try{aspiActivities=await this.newActivities(page,activitySnapshot,input.registration?6:4);}catch{}
      return {...result,request:{...result.request,method:input.method,path:input.path,portalUrl:input.portalUrl,timestamp,externalId:input.externalId,body:serviceBody,registrationOutput,steps:[...steps,signatureService.request],aspiActivities}};
    }catch(error){const typed=error instanceof AspiAutomationError?error:new AspiAutomationError("AUTOMATION_ERROR","Automasi Portal ASPI gagal. Periksa konfigurasi dan koneksi portal.");return {status:null,outcome:typed.outcome,body:{error:typed.message,diagnostic:redact(typed.diagnostic)},request:{method:input.method,path:input.path,portalUrl:input.portalUrl,timestamp,externalId:input.externalId,body:input.body}};
    }finally{await release?.();}
  }
  async downloadActivityPdf(user:RecordRow,activityId:string){
    aspiActivityDownloadUrl(activityId);
    const cacheKey=`${user.id}:${activityId}`;
    const cached=this.pdfCache.get(cacheKey);
    if(cached&&cached.expiresAt>Date.now())return cached.pdf;
    this.pdfCache.delete(cacheKey);
    const pending=this.pendingPdfs.get(cacheKey);
    if(pending)return pending;
    const job=this.renderActivityPdf(user,activityId).then(pdf=>{
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
  private async renderActivityPdf(user:RecordRow,activityId:string){
    const url=aspiActivityDownloadUrl(activityId);let release:(()=>Promise<void>)|undefined;
    try{
      const acquired=await this.sessions.getAuthenticatedContext(user,"apidevportal.aspi-indonesia.or.id",async page=>{
        await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
        return !page.url().includes("/sign-in");
      });
      release=acquired.release;
      const reportPage=acquired.page;
      try{
        if(reportPage.url()!==url){
          const response=await reportPage.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
          if(!response||response.status()!==200)throw new Error(`ASPI menolak laporan aktivitas dengan HTTP ${response?.status()??"unknown"}.`);
        }
        const current=new URL(reportPage.url());
        if(current.hostname!=="apidevportal.aspi-indonesia.or.id"||current.pathname!=="/sandboxactivity/downloadreportactivity"||current.searchParams.get("activityId")!==activityId||reportPage.url().includes("/sign-in"))throw new Error("Sesi ASPI tidak dapat membuka laporan aktivitas ini.");
        await reportPage.emulateMedia({media:"print"});
        await reportPage.evaluate(()=>Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1500))]));
        const pdf=await reportPage.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:"12mm",right:"12mm",bottom:"12mm",left:"12mm"}});
        if(!pdf.length||pdf.length>15*1024*1024||pdf.subarray(0,4).toString()!=="%PDF")throw new Error("Hasil render laporan ASPI bukan PDF yang valid.");
        return pdf;
      }finally{await reportPage.close();}
    }finally{await release?.();}
  }
  private async activityList(page:Page):Promise<AspiActivity[]>{
    await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:60000});
    if(page.url().includes("/sign-in"))throw new AspiAutomationError("AUTH_SESSION_EXPIRED","Sesi ASPI berakhir saat membaca aktivitas.");
    await page.locator("table tbody tr").first().waitFor({state:"visible",timeout:10000}).catch(()=>undefined);
    return page.locator("table tbody tr").evaluateAll(rows=>rows.flatMap(row=>{
      const cells=row.querySelectorAll("td"),link=row.querySelector<HTMLAnchorElement>('a[href*="downloadreportactivity?activityId="]');
      const match=link?.getAttribute("href")?.match(/[?&]activityId=([0-9a-f-]{36})/i);
      if(!match)return [];
      const clean=(value:string|null|undefined)=>(value??"").replace(/\s+/g," ").trim();
      return [{activityId:match[1],timestamp:clean(cells[1]?.textContent),service:clean(cells[2]?.textContent),downloadUrl:new URL(link!.getAttribute("href")!,location.origin).toString()}];
    }));
  }
  private async newActivities(page:Page,before:Set<string>,expectedCount:number){
    let found:AspiActivity[]=[];
    for(let attempt=0;attempt<4;attempt++){
      found=(await this.activityList(page)).filter(item=>!before.has(item.activityId));
      if(found.length>=expectedCount)break;
      await page.waitForTimeout(750);
    }
    // Daftar ASPI diurutkan terbaru lebih dahulu. Batasi ke jumlah service
    // yang benar-benar dijalankan oleh satu history agar aktivitas lain tidak ikut.
    return found.slice(0,expectedCount);
  }
  private async execute(page:Page,url:string,path:string,method:string,headers:Record<string,string>,body:Record<string,unknown>):Promise<HitResult>{
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
    for(const [name,entry] of Object.entries(headers))await this.forms.fillParameter(operation,name,entry);
    // Beberapa utility ASPI (contohnya Signature Auth) hanya menerima header
    // dan memang tidak mempunyai editor request body. Jangan mencari textarea
    // untuk payload kosong; endpoint dengan payload tetap wajib mengisi body.
    if(Object.keys(body).length>0)await this.forms.fillBody(operation,body);
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
      captured = await captureTargetResponse(page, method, path, () => executeButton.click());
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
    const status=captured.status(),outcome=classifyHttpOutcome(status,parsed);
    return {status,outcome,body:parsed,request:{name:path,portalUrl:url,httpStatus:status,actualUrl:captured.url(),automationChecks:verification,headers:redact(requestHeaders)}};
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
  private failedStep(input: PortalInput, timestamp: string, result: HitResult, message: string, previous: Record<string, unknown>[] = []): HitResult {
    // A prerequisite's HTTP response must never masquerade as Balance Inquiry's response.
    return {
      status: null,
      outcome: "PRECONDITION_FAILED",
      body: { error: message, prerequisiteHttpStatus: result.status, securityResponse: result.body },
      request: { method: input.method, path: input.path, timestamp, body: input.body, steps: [...previous, result.request] }
    };
  }
}
