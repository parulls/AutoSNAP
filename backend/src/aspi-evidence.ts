import {pdfSettings} from "./pdf-settings";
import type { Page } from "playwright-core";

export const ACTIVITY_PAGE="https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian";
export type AspiActivity={activityId:string;service:string;timestamp:string;downloadUrl:string};
const normalize=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,"");
const aliases:Record<string,string[]>={
  "/api/v1.0/utilities/signature-auth":["signatureauth","signatureauthentication","signatureaccesstoken"],
  "/api/v1.0/access-token/b2b":["accesstokenb2b","b2baccesstoken"],
  "/api/v1.0/utilities/signature-service":["signatureservice"],
  "/api/v1.0/balance-inquiry":["balanceinquiry","informasisaldo"]
};

/** A new row must uniquely match the executed service. Never choose the latest arbitrary ID. */
export function correlateActivity(before:Set<string>,after:AspiActivity[],path:string){
  const names=aliases[path]??[normalize(path.split("/").at(-1)??path)];
  const matches=after.filter(row=>!before.has(row.activityId)&&names.some(name=>normalize(row.service).replace(/^api/,"")===name||normalize(row.service)===normalize(path)));
  return matches.length===1?matches[0]:null;
}

function remaining(deadline:number|undefined,limit:number){
  if(deadline!==undefined&&Date.now()>=deadline)throw Error("Batas waktu pengambilan PDF tercapai.");
  return deadline===undefined?limit:Math.max(1,Math.min(limit,deadline-Date.now()));
}

export async function readActivities(page:Page,deadline?:number):Promise<AspiActivity[]>{
  const response=await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:remaining(deadline,20000)});
  const location=new URL(page.url());
  if(location.origin!=="https://apidevportal.aspi-indonesia.or.id"||location.pathname!=="/aktivitas-aplikasi-pengujian"){
    throw Error("Halaman aktivitas ASPI dialihkan; periksa autentikasi.");
  }
  if(!response?.ok())throw Error(`Halaman aktivitas ASPI mengembalikan HTTP ${response?.status()??"unknown"}.`);
  const table=page.locator("table").first();
  await table.waitFor({state:"attached",timeout:remaining(deadline,8000)});
  // AJAX may populate the table after DOMContentLoaded. Wait a short bounded
  // interval for report links, rather than treating initial empty HTML as final.
  const rows=page.locator("table tbody tr");
  // A freshly rendered DataTable can have zero rows until its AJAX response.
  await rows.first().waitFor({state:"attached",timeout:remaining(deadline,4000)}).catch(()=>undefined);
  if(await rows.count()>0){
    await page.locator('a[href*="downloadreportactivity"]').first()
      .waitFor({state:"attached",timeout:remaining(deadline,4000)})
      .catch(()=>undefined);
  }
  const activities=await rows.evaluateAll(rows=>rows.flatMap(row=>{
    const cells=row.querySelectorAll("td"),links=row.querySelectorAll<HTMLAnchorElement>('a[href*="downloadreportactivity"]');
    const clean=(text:string|null|undefined)=>(text??"").replace(/\s+/g," ").trim();
    for(const link of links){
      try{
        const url=new URL(link.getAttribute("href")??"",location.origin);
        const activityId=url.searchParams.get("activityId")??"";
        if(url.origin!==location.origin||url.pathname!=="/sandboxactivity/downloadreportactivity"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(activityId))continue;
        return [{activityId,service:clean(cells[2]?.textContent),timestamp:clean(cells[1]?.textContent),downloadUrl:url.toString()}];
      }catch{/* Ignore malformed third-party links, never guess Activity IDs. */}
    }
    return [];
  }));
  if(await rows.count()>0&&!activities.length){
    const isEmpty=await rows.first().evaluate(row=>
      row.classList.contains("dataTables_empty") ||
      /^(no data|no matching|belum ada|tidak ada|empty)/i.test((row.textContent??"").trim().slice(0,100))
    );
    if(!isEmpty)throw Error("Tabel aktivitas ASPI tidak memiliki tautan laporan yang dikenali.");
  }
  return activities;
}

export function validateOfficialPdf(pdf:Buffer){
  if(!pdf.length||pdf.length>15*1024*1024||pdf.subarray(0,5).toString()!=="%PDF-")throw Error("ASPI tidak memberikan PDF yang valid (maksimal 15 MB).");
  return pdf;
}

/** Use the authenticated Chromium transport for the headless evidence phase.
 * Uses browser networking and existing portal cookies; redirects are rejected.
 * Only read this fixed-origin report URL; no API Execute is repeated. */
async function browserReport(page:Page,url:string,timeout:number){
  if(new URL(page.url()).origin!=="https://apidevportal.aspi-indonesia.or.id")throw Error("Sesi ASPI tidak dapat membuka laporan.");
  const result=await page.evaluate(async({url,timeout})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);let phase="headers";
    try{
      const response=await fetch(url,{credentials:"same-origin",redirect:"error",cache:"no-store",signal:controller.signal});
      phase=`body_http_${response.status}`;
      const reader=response.body?.getReader(),parts:string[]=[];let size=0;
      if(Number(response.headers.get("content-length"))>15*1024*1024)throw Error("Laporan ASPI melebihi 15 MB.");
      try{
        if(reader)while(true){
          const item=await reader.read();if(item.done)break;size+=item.value.byteLength;
          if(size>15*1024*1024){await reader.cancel();throw Error("Laporan ASPI melebihi 15 MB.");}
          for(let offset=0;offset<item.value.length;offset+=32768)parts.push(String.fromCharCode(...item.value.subarray(offset,offset+32768)));
        }
      }finally{reader?.releaseLock();}
      return {status:response.status,contentType:response.headers.get("content-type")??"",data:btoa(parts.join(""))};
    }catch(error){if(controller.signal.aborted)throw Error(`ASPI_REPORT_TIMEOUT_${phase}`);throw error;}finally{clearTimeout(timer);}
  },{url,timeout});
  return {ok:()=>result.status>=200&&result.status<300,status:()=>result.status,headers:()=>({"content-type":result.contentType}),body:async()=>Buffer.from(result.data,"base64"),dispose:async()=>{}};
}

/** Use ASPI's report only: original PDF bytes, or its official printable HTML. */
export async function fetchOfficialPdf(page:Page,downloadUrl:string,deadline?:number,transport:"browser"|"request"|"navigation"="request"){
  const url=new URL(downloadUrl);
  if(url.origin!=="https://apidevportal.aspi-indonesia.or.id"||url.pathname!=="/sandboxactivity/downloadreportactivity"||!url.searchParams.get("activityId")||url.username||url.password)throw Error("URL PDF ASPI tidak valid.");
  const timeout=remaining(deadline,pdfSettings().requestTimeoutMs);
  if(transport==="navigation"){
    const {downloadReportByNavigation}=await import("./aspi-report-navigation.js");
    return downloadReportByNavigation(page,url.toString(),timeout);
  }
  const response=transport==="browser"?await browserReport(page,url.toString(),timeout):await page.context().request.get(url.toString(),{timeout,maxRedirects:0});
  try{
    if(!response.ok())throw Error(`Download PDF ASPI ditolak: HTTP ${response.status()}.`);
    const data=await response.body();
    if(data.subarray(0,5).toString()==="%PDF-")return validateOfficialPdf(data);
    // ASPI may serve its official printable report as HTML from downloadreportactivity.
    // Print that exact page; do not substitute a custom AutoSNAP document or screenshot.
    if(!response.headers?.()["content-type"]?.includes("text/html"))throw Error("ASPI belum memberikan file PDF atau halaman laporan resmi.");
    const report=await page.context().newPage();
    try{
      const loaded=await report.goto(url.toString(),{waitUntil:"domcontentloaded",timeout:remaining(deadline,deadline===undefined?20000:10000)});
      const current=new URL(report.url());
      if(!loaded?.ok()||current.origin!==url.origin||current.pathname!==url.pathname||current.searchParams.get("activityId")!==url.searchParams.get("activityId"))throw Error("Sesi ASPI tidak dapat mengakses laporan resmi.");
      if(await report.locator('input[type="password"],form[action*="sign-in"],form[action*="login"]').count())throw Error("ASPI mengembalikan halaman login, bukan laporan.");
      const text=await report.locator("body").innerText({timeout:remaining(deadline,5000)});
      if(!/request/i.test(text)||!/response/i.test(text))throw Error("Isi halaman bukan laporan hasil pengujian ASPI.");
      await report.emulateMedia({media:"print"});
      await report.evaluate(()=>Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1000))]));
      remaining(deadline,10000);
      return validateOfficialPdf(await report.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:"12mm",right:"12mm",bottom:"12mm",left:"12mm"}}));
    }finally{await report.close();}
  }finally{await response.dispose();}
}
