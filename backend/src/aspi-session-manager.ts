import { Injectable } from "@nestjs/common";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RecordRow } from "./database.service";
import { decrypt, sha256 } from "./security";
import { AspiAutomationError } from "./aspi-types";

const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
@Injectable()
export class AspiSessionManager{
  private leases=new Set<string>();
  async getAuthenticatedContext(user:RecordRow,environment:string,validate:(page:Page)=>Promise<boolean>){
    const identity=(value(user,"email")||value(user,"username")).toLowerCase(),lease=sha256(`${identity}|${environment}`).slice(0,24);
    if(this.leases.has(lease))throw new AspiAutomationError("AUTOMATION_ERROR","Sesi ASPI untuk akun dan environment ini sedang digunakan pengujian lain.");
    this.leases.add(lease);let context:BrowserContext|undefined;
    try{
      context=await this.openContext(lease);const page=context.pages()[0]??await context.newPage();
      if(!await validate(page))await this.loginIfRequired(page,user);
      return {context,page,release:async()=>{await context?.close().catch(()=>undefined);this.leases.delete(lease);}};
    }catch(error){await context?.close().catch(()=>undefined);this.leases.delete(lease);throw error;}
  }
  async validateSession(page:Page,validate:(page:Page)=>Promise<boolean>){return validate(page);}
  async invalidateSession(context:BrowserContext){await context.clearCookies();}
  private async openContext(lease:string){
    const configured=process.env.AUTOSNAP_CHROME_PATH?.trim(),candidates=[configured,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean) as string[],executablePath=candidates.find(existsSync);
    if(!executablePath)throw new AspiAutomationError("AUTOMATION_ERROR","Google Chrome tidak ditemukan. Isi AUTOSNAP_CHROME_PATH.");
    const root=process.env.AUTOSNAP_PORTAL_PROFILE_DIR?.trim()||join(process.cwd(),".autosnap-browser-profile"),profile=join(root,lease);mkdirSync(profile,{recursive:true});
    return chromium.launchPersistentContext(profile,{executablePath,headless:true,viewport:{width:1440,height:900},args:["--disable-blink-features=AutomationControlled"]});
  }
  async loginIfRequired(page:Page,user:RecordRow){
    const signIn=page.getByRole("link",{name:/sign in|login|masuk/i}).or(page.getByRole("button",{name:/sign in|login|masuk/i})).first();
    if(await signIn.count()&&await signIn.isVisible()){const href=await signIn.getAttribute("href");if(href)await page.goto(new URL(href,page.url()).toString(),{waitUntil:"domcontentloaded",timeout:60000});else await signIn.click();}
    const email=value(user,"email")||value(user,"username"),password=value(user,"password")?decrypt(value(user,"password")):"",emailInput=page.locator('input[type="email"],input[name*="email" i],input[name*="username" i]').first(),passwordInput=page.locator('input[type="password"]').first();
    const authTimeout=Math.max(100,Number(process.env.AUTOSNAP_PORTAL_AUTH_TIMEOUT_MS??30000));
    await emailInput.or(passwordInput).waitFor({state:"visible",timeout:authTimeout}).catch(()=>undefined);
    if(!await emailInput.count()||!await passwordInput.count())throw new AspiAutomationError("AUTH_SESSION_EXPIRED","Sesi ASPI tidak valid dan form login resmi tidak ditemukan.");
    await emailInput.fill(email);await passwordInput.fill(password);
    const interactive=page.locator('iframe[src*="recaptcha" i],.g-recaptcha,input[name*="captcha" i],input[name*="otp" i]').first();
    if(await interactive.count()&&await interactive.isVisible().catch(()=>false))throw new AspiAutomationError("AUTH_INTERACTION_REQUIRED","Login ASPI memerlukan CAPTCHA, OTP, MFA, atau verifikasi interaktif. Siapkan sesi secara sah sebelum menjalankan headless.");
    const submit=page.locator('form button[type="submit"],form input[type="submit"]').first();if(!await submit.count())throw new AspiAutomationError("AUTH_SESSION_EXPIRED","Tombol submit login ASPI tidak ditemukan.");
    await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded",timeout:60000}),submit.click()]).catch(()=>undefined);await page.waitForTimeout(750);
    if(page.url().includes("/sign-in")){const alert=page.locator(".validation-summary-errors,.field-validation-error,.alert-danger,.alert").first(),detail=(await alert.textContent().catch(()=>""))?.replace(/\s+/g," ").trim();throw new AspiAutomationError("AUTH_SESSION_EXPIRED",detail?`Login ASPI ditolak: ${detail}`:"Login ASPI ditolak. Periksa kredensial dan aktivasi akun.");}
  }
}
