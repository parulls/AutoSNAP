import {chromium} from "playwright-core";
import {existsSync} from "node:fs";
import {join} from "node:path";

const root=process.cwd();
const executable=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);
if(!executable)throw new Error("Chrome tidak ditemukan.");
const profile=process.env.AUTOSNAP_PORTAL_PROFILE_DIR||join(root,".autosnap-browser-profile");
const context=await chromium.launchPersistentContext(profile,{executablePath:executable,headless:true});
try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto("https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry",{waitUntil:"domcontentloaded",timeout:60000});
  await page.waitForTimeout(3000);
  const testingButton=page.locator('button[data-target="#sandBoxCollapse"]').first();
  if(await testingButton.count())await testingButton.click();
  await page.waitForTimeout(3000);
  const report=await page.evaluate(()=>{
    const clean=(value)=>String(value??"").replace(/\s+/g," ").trim().slice(0,300);
    const operations=[...document.querySelectorAll(".opblock")];
    const target=operations.find(item=>clean(item.querySelector(".opblock-summary-path")?.textContent).replaceAll("\u200B","").includes("balance-inquiry"));
    if(!target)return {url:location.href,operations:operations.length,pageText:clean(document.body.innerText),sandboxCollapse:(()=>{const item=document.querySelector("#sandBoxCollapse");return item?{classes:item.getAttribute("class"),style:item.getAttribute("style"),text:clean(item.textContent),html:item.innerHTML.slice(0,800)}:null})(),testingControls:[...document.querySelectorAll("a,button,[role=tab],li")].filter(item=>clean(item.textContent)==="Aplikasi Pengujian").map(item=>({tag:item.tagName,classes:item.getAttribute("class"),href:item.getAttribute("href"),role:item.getAttribute("role"),ariaControls:item.getAttribute("aria-controls"),dataToggle:item.getAttribute("data-toggle"),outer:item.outerHTML.slice(0,500)}))};
    const controls=[...target.querySelectorAll("input,textarea,select")].map(control=>({tag:control.tagName.toLowerCase(),name:control.getAttribute("name"),placeholder:control.getAttribute("placeholder"),ariaLabel:control.getAttribute("aria-label"),className:control.getAttribute("class"),parentClass:control.parentElement?.getAttribute("class"),ancestorText:clean(control.closest("tr,.parameter__item,.parameters-col_description,.opblock-body")?.textContent)}));
    const labels=[...target.querySelectorAll("label,.parameters-col_name,.parameter__name,dt,th")].map(label=>({tag:label.tagName.toLowerCase(),className:label.getAttribute("class"),text:clean(label.textContent)}));
    return {url:location.href,operations:operations.length,targetClass:target.getAttribute("class"),targetText:clean(target.textContent),controls,labels};
  });
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
}finally{await context.close();}
