import { Injectable, Optional } from "@nestjs/common";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseService, type RecordRow } from "./database.service";
import { randomUUID } from "node:crypto";
import { decrypt, sha256 } from "./security";
import { AspiAutomationError } from "./aspi-types";

const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
export function aspiAccountLease(user:{data?:Record<string,unknown>},environment:string){
  const data=user.data??{};
  const identity=String(data.email??data.username??"").toLowerCase();
  return sha256(`${identity}|${environment}`).slice(0,24);
}
export function pdfAccountLease(user:{data?:Record<string,unknown>},environment="apidevportal.aspi-indonesia.or.id"){
  return `pdf:${aspiAccountLease(user,environment)}`;
}
@Injectable()
export class AspiSessionManager{
  private leases=new Set<string>();
  constructor(@Optional() private readonly db?:DatabaseService){}
  async getAuthenticatedContext(user:RecordRow,environment:string,validate:(page:Page)=>Promise<boolean>,signal?:AbortSignal){
    signal?.throwIfAborted();
    const lease=aspiAccountLease(user,environment);
    if(this.leases.has(lease))throw new AspiAutomationError("ASPI_SESSION_BUSY","Sesi ASPI untuk akun dan environment ini sedang digunakan pengujian lain.");
    this.leases.add(lease);let context:BrowserContext|undefined;
    const owner=randomUUID();
    const abort=()=>{void context?.close().catch(()=>undefined);};
    signal?.addEventListener("abort",abort,{once:true});
    const release=async()=>{
      signal?.removeEventListener("abort",abort);
      try{await context?.close().catch(()=>undefined);}
      finally{
        this.leases.delete(lease);
        await this.db?.query("DELETE FROM autosnap_automation_leases WHERE key=$1 AND owner=$2",[lease,owner]);
      }
    };
    try{
      const now=new Date(),leaseDuration=process.env.VERCEL?330000:6*60_000;
      if(this.db){
        // A crashed process must not keep the account locked until expires_at.
        // Heartbeat older than three minutes can be taken over.
        const stale=new Date(now.getTime()-180000).toISOString();
        const acquired=await this.db.one("INSERT INTO autosnap_automation_leases (key,owner,expires_at,heartbeat_at) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at,heartbeat_at=EXCLUDED.heartbeat_at WHERE autosnap_automation_leases.expires_at<$5 OR COALESCE(autosnap_automation_leases.heartbeat_at,autosnap_automation_leases.expires_at)<$6 RETURNING owner",[lease,owner,new Date(now.getTime()+leaseDuration).toISOString(),now.toISOString(),now.toISOString(),stale]);
        if(!acquired)throw new AspiAutomationError("ASPI_SESSION_BUSY","Akun ASPI sedang digunakan pengujian lain. Tunggu hingga selesai.");
      }
      context=await this.openContext(lease);signal?.throwIfAborted();const page=context.pages()[0]??await context.newPage();

      const sessionValid = await validate(page);

      if (!sessionValid) {
        await this.loginIfRequired(page, user);

        const validAfterLogin = await validate(page);

        if (!validAfterLogin) {
          throw new AspiAutomationError(
            "AUTH_SESSION_EXPIRED",
            "Login ASPI selesai, tetapi halaman tujuan belum dapat diakses."
          );
        }
      }
      signal?.throwIfAborted();
      const beat=()=>this.db?.query("UPDATE autosnap_automation_leases SET heartbeat_at=$1,expires_at=$2 WHERE key=$3 AND owner=$4",[new Date().toISOString(),new Date(Date.now()+leaseDuration).toISOString(),lease,owner]);
      return {context,page,release,beat};
    }catch(error){await release().catch(()=>undefined);throw error;}
  }
  async validateSession(page:Page,validate:(page:Page)=>Promise<boolean>){return validate(page);}
  async invalidateSession(context:BrowserContext){await context.clearCookies();}
  private async openContext(lease:string){
    if(process.env.VERCEL){
      const {default:serverlessChromium}=await import("@sparticuz/chromium");
      const profile=join(tmpdir(),"autosnap-browser",lease);mkdirSync(profile,{recursive:true,mode:0o700});
      return chromium.launchPersistentContext(profile,{executablePath:await serverlessChromium.executablePath(),headless:true,viewport:{width:1440,height:900},args:serverlessChromium.args});
    }
    const configured=process.env.AUTOSNAP_CHROME_PATH?.trim(),candidates=[configured,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean) as string[],executablePath=candidates.find(existsSync);
    if(!executablePath)throw new AspiAutomationError("AUTOMATION_ERROR","Google Chrome tidak ditemukan. Isi AUTOSNAP_CHROME_PATH.");
    const root=process.env.AUTOSNAP_PORTAL_PROFILE_DIR?.trim()||join(process.cwd(),".autosnap-browser-profile"),profile=join(root,lease);mkdirSync(profile,{recursive:true,mode:0o700});
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
    await Promise.all([page.waitForNavigation({waitUntil:"domcontentloaded",timeout:60000}),submit.click()]).catch(()=>undefined);
    await page.waitForURL(url=>!String(url).includes("/sign-in"),{timeout:8000}).catch(()=>undefined);
    if(page.url().includes("/sign-in"))throw new AspiAutomationError("AUTH_SESSION_EXPIRED","Login ASPI ditolak. Periksa kredensial dan aktivasi akun.");
  }
}
