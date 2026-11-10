import {chromium} from "playwright-core";
import {existsSync} from "node:fs";
import {join} from "node:path";

const executable=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);
const context=await chromium.launchPersistentContext(process.env.AUTOSNAP_PORTAL_PROFILE_DIR||join(process.cwd(),".autosnap-browser-profile"),{executablePath:executable,headless:true});
try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto("https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo",{waitUntil:"domcontentloaded",timeout:60000});
  await page.waitForTimeout(3000);
  const signIn=page.getByRole("link",{name:/sign in|login|masuk/i}).or(page.getByRole("button",{name:/sign in|login|masuk/i})).first();
  if(await signIn.count()){
    const href=await signIn.getAttribute("href");
    if(href)await page.goto(new URL(href,page.url()).toString(),{waitUntil:"domcontentloaded",timeout:60000});
    else await signIn.click();
  }
  await page.waitForTimeout(3000);
  const report=await page.evaluate(()=>({
    url:location.href,
    title:document.title,
    forms:[...document.forms].map(form=>({action:form.action,method:form.method,inputs:[...form.querySelectorAll("input")].map(input=>({type:input.type,name:input.name,id:input.id,placeholder:input.placeholder,required:input.required})),buttons:[...form.querySelectorAll("button,input[type=submit]")].map(button=>({tag:button.tagName,type:button.getAttribute("type"),text:(button.textContent||button.getAttribute("value")||"").trim()}))})),
    captcha:{recaptcha:!!document.querySelector('iframe[src*="recaptcha" i],.g-recaptcha'),captchaInput:!!document.querySelector('input[name*="captcha" i]')},
    visibleText:(document.body.innerText||"").replace(/\s+/g," ").trim().slice(0,700),
  }));
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
}finally{await context.close();}
