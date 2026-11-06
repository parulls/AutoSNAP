import { Injectable } from "@nestjs/common";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RecordRow } from "./database.service";
import type { HitResult } from "./run-engine";
import { isoJakarta } from "./run-engine";
import { decrypt } from "./security";

type PortalInput={portalUrl:string;path:string;method:string;body:Record<string,unknown>;client:RecordRow;user:RecordRow;externalId:string;extraHeaders:Record<string,string>};
const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
const securityPortal="https://apidevportal.aspi-indonesia.or.id/api-services/keamanan";

function portalUrl(raw:string){
  let url:URL;
  try{url=new URL(raw);}catch{throw new Error("URL Aplikasi Pengujian ASPI tidak valid.");}
  if(url.protocol!=="https:"||url.hostname!=="apidevportal.aspi-indonesia.or.id"||!url.pathname.startsWith("/api-services/"))throw new Error("URL harus berasal dari halaman api-services ASPI Developer Portal.");
  return url.toString();
}

@Injectable()
export class PortalEngine{
  private running=false;

  async hit(input:PortalInput):Promise<HitResult>{
    if(this.running)throw new Error("Browser automation sedang digunakan oleh testing lain. Tunggu sampai selesai.");
    this.running=true;
    let context:BrowserContext|undefined;
    try{
      context=await this.openContext();
      const page=context.pages()[0]??await context.newPage();
      const timestamp=isoJakarta();
      const clientId=value(input.client,"clientId"),channelId=value(input.client,"channelId");
      const partnerId=value(input.client,"partnerIdSource")==="client_id"?clientId:input.client.partner_id??"";
      const signatureAuth=await this.execute(page,securityPortal,"/api/v1/utilities/signature-auth",{
        "X-TIMESTAMP":timestamp,
        "X-CLIENT-KEY":clientId,
        "Private_Key":decrypt(value(input.client,"privateKey")),
      },{},input.user);
      const signatureAuthBody=signatureAuth.body&&typeof signatureAuth.body==="object"?signatureAuth.body as Record<string,unknown>:{};
      if(signatureAuth.status<200||signatureAuth.status>=300||typeof signatureAuthBody.signature!=="string"||!signatureAuthBody.signature){
        return {status:signatureAuth.status,body:{error:"Form Signature Access Token ASPI tidak menghasilkan signature.",securityResponse:signatureAuth.body},request:{method:input.method,path:input.path,timestamp,body:input.body,steps:[signatureAuth.request]}};
      }
      const tokenHeaders={
        "Content-Type":"application/json",
        "X-TIMESTAMP":timestamp,
        "X-CLIENT-KEY":clientId,
        "X-SIGNATURE":String(signatureAuthBody.signature),
      };
      const tokenResult=await this.execute(page,securityPortal,"/api/v1.0/access-token/b2b",tokenHeaders,{grantType:"client_credentials",additionalInfo:{}},input.user);
      const tokenBody=tokenResult.body&&typeof tokenResult.body==="object"?tokenResult.body as Record<string,unknown>:{};
      if(tokenResult.status<200||tokenResult.status>=300||typeof tokenBody.accessToken!=="string"||!tokenBody.accessToken){
        return {status:tokenResult.status,body:{error:"Form Access Token B2B ASPI tidak menghasilkan accessToken. Form service belum dijalankan.",securityResponse:tokenResult.body},request:{method:input.method,path:input.path,timestamp,body:input.body,steps:[signatureAuth.request,tokenResult.request]}};
      }

      const token=String(tokenBody.accessToken);
      const signatureService=await this.execute(page,securityPortal,"/api/v1/utilities/signature-service",{
        "Content-Type":"application/json",
        "X-TIMESTAMP":timestamp,
        "X-CLIENT-SECRET":decrypt(value(input.client,"clientSecret")),
        "HttpMethod":input.method,
        "EndpoinUrl":input.path,
        "AccessToken":token,
      },input.body,input.user);
      const signatureServiceBody=signatureService.body&&typeof signatureService.body==="object"?signatureService.body as Record<string,unknown>:{};
      if(signatureService.status<200||signatureService.status>=300||typeof signatureServiceBody.signature!=="string"||!signatureServiceBody.signature){
        return {status:signatureService.status,body:{error:"Form Signature Service ASPI tidak menghasilkan signature. Form service belum dijalankan.",securityResponse:signatureService.body},request:{method:input.method,path:input.path,timestamp,body:input.body,steps:[signatureAuth.request,tokenResult.request,signatureService.request]}};
      }
      const headers:Record<string,string>={
        "Content-Type":"application/json",
        "Authorization":`Bearer ${token}`,
        "X-TIMESTAMP":timestamp,
        "X-SIGNATURE":String(signatureServiceBody.signature),
        "X-PARTNER-ID":partnerId,
        "X-EXTERNAL-ID":input.externalId,
        "CHANNEL-ID":channelId,
        ...input.extraHeaders,
      };
      if(value(input.client,"deviceId"))headers["X-DEVICE-ID"]=value(input.client,"deviceId");
      const serviceResult=await this.execute(page,portalUrl(input.portalUrl),input.path,headers,input.body,input.user);
      return {...serviceResult,request:{method:input.method,path:input.path,portalUrl:input.portalUrl,timestamp,externalId:input.externalId,body:input.body,headers:Object.fromEntries(Object.entries(headers).map(([key,val])=>[key,/authorization|signature/i.test(key)?"[REDACTED]":val])),steps:[signatureAuth.request,tokenResult.request,signatureService.request]}};
    }finally{
      if(context)await context.close().catch(()=>undefined);
      this.running=false;
    }
  }

  private async openContext(){
    const configured=process.env.AUTOSNAP_CHROME_PATH?.trim();
    const candidates=[configured,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean) as string[];
    const executablePath=candidates.find(existsSync);
    if(!executablePath)throw new Error("Google Chrome tidak ditemukan. Isi AUTOSNAP_CHROME_PATH pada file .env.");
    const userDataDir=process.env.AUTOSNAP_PORTAL_PROFILE_DIR?.trim()||join(process.cwd(),".autosnap-browser-profile");
    const headless=process.env.AUTOSNAP_PORTAL_HEADLESS==="true";
    return chromium.launchPersistentContext(userDataDir,{executablePath,headless,viewport:{width:1440,height:900},args:["--disable-blink-features=AutomationControlled"]});
  }

  private async execute(page:Page,url:string,path:string,headers:Record<string,string>,body:Record<string,unknown>,user:RecordRow){
    await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
    await this.ensureSignedIn(page,url,user);
    const operation=await this.operation(page,path);
    if(!(await operation.getAttribute("class"))?.includes("is-open")){
      await operation.locator(".opblock-summary").click();
      await operation.locator(".opblock-body").waitFor({state:"visible",timeout:15000});
    }
    const tryButton=operation.getByRole("button",{name:/try it out/i});
    if(await tryButton.count()&&await tryButton.first().isVisible())await tryButton.first().click();
    for(const [name,entry] of Object.entries(headers))await this.fillParameter(operation,name,entry);
    const bodyText=JSON.stringify(body,null,2);
    const bodyInput=operation.locator("textarea.body-param__text, .body-param textarea, textarea").last();
    if(await bodyInput.count())await bodyInput.fill(bodyText);
    const executeButton=operation.getByRole("button",{name:/^execute$/i});
    if(!await executeButton.count())throw new Error(`Tombol Execute tidak ditemukan untuk ${path}. Pastikan URL mengarah tepat ke operasi API.`);
    await executeButton.click();
    const response=operation.locator(".live-responses-table tbody tr.response").first();
    await response.waitFor({state:"visible",timeout:60000});
    const codeText=(await response.locator(".response-col_status").textContent().catch(()=>""))?.trim()??"";
    const raw=(await response.locator(".response-col_description pre, .response-col_description .microlight, pre").first().textContent().catch(()=>""))?.trim()??"";
    let parsed:unknown=raw;
    try{parsed=JSON.parse(raw);}catch{}
    return {status:Number.parseInt(codeText,10)||0,body:parsed,request:{name:path,portalUrl:url,httpStatus:Number.parseInt(codeText,10)||0}};
  }

  private async ensureSignedIn(page:Page,url:string,user:RecordRow){
    const operation=page.locator(".opblock");
    if(await operation.count())return;
    const signIn=page.getByRole("link",{name:/sign in|login|masuk/i}).or(page.getByRole("button",{name:/sign in|login|masuk/i})).first();
    if(await signIn.count()&&await signIn.isVisible())await signIn.click();
    const email=value(user,"email")||value(user,"username"),password=value(user,"password")?decrypt(value(user,"password")):"";
    const emailInput=page.locator('input[type="email"], input[name*="email" i], input[name*="username" i]').first();
    const passwordInput=page.locator('input[type="password"]').first();
    if(await emailInput.count()&&email)await emailInput.fill(email);
    if(await passwordInput.count()&&password)await passwordInput.fill(password);
    if(await emailInput.count()||await passwordInput.count()){
      await page.bringToFront();
      await page.waitForFunction(()=>document.querySelectorAll(".opblock").length>0,{timeout:120000}).catch(()=>undefined);
      if(!await page.locator(".opblock").count()){
        await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
        if(!await page.locator(".opblock").count())throw new Error("Login ASPI belum selesai. Selesaikan CAPTCHA/OTP pada jendela Chrome, lalu jalankan testing lagi.");
      }
    }else throw new Error("Halaman Aplikasi Pengujian ASPI belum dapat diakses. Login ke ASPI pada jendela Chrome automation terlebih dahulu.");
  }

  private async operation(page:Page,path:string):Promise<Locator>{
    const operations=page.locator(".opblock");
    await operations.first().waitFor({state:"visible",timeout:60000});
    const count=await operations.count();
    for(let i=0;i<count;i++){
      const item=operations.nth(i),shown=(await item.locator(".opblock-summary-path").textContent().catch(()=>""))??"";
      const normalized=(entry:string)=>entry.replaceAll("\u200B","").trim().replace("/v1.0/","/v1/");
      if(normalized(shown)===normalized(path))return item;
    }
    throw new Error(`Operasi ${path} tidak ditemukan pada halaman Aplikasi Pengujian ASPI.`);
  }

  private async fillParameter(operation:Locator,name:string,entry:string){
    const rows=operation.locator("tr");
    const count=await rows.count();
    for(let i=0;i<count;i++){
      const row=rows.nth(i),label=((await row.locator(".parameters-col_name").textContent().catch(()=>""))??"").replace(/\s+/g," ").trim();
      if(label.toLowerCase().startsWith(name.toLowerCase())){
        const input=row.locator("input, textarea, select").first();
        if(await input.count()){await input.fill(entry);return;}
      }
    }
    if(["Authorization-Customer","X-DEVICE-ID","ORIGIN","X-IP-ADDRESS","X-LATITUDE","X-LONGITUDE"].includes(name))return;
    throw new Error(`Field ${name} tidak ditemukan pada form Aplikasi Pengujian ASPI.`);
  }
}
