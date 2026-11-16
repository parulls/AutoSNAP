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

export async function readActivities(page:Page):Promise<AspiActivity[]>{
  const response=await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:15000});
  if(!response?.ok()||new URL(page.url()).pathname!=="/aktivitas-aplikasi-pengujian")throw Error("Daftar aktivitas ASPI tidak dapat diakses.");
  await page.locator("table").first().waitFor({state:"attached",timeout:5000});
  return page.locator("table tbody tr").evaluateAll(rows=>rows.flatMap(row=>{
    const cells=row.querySelectorAll("td"),link=row.querySelector<HTMLAnchorElement>('a[href*="downloadreportactivity?activityId="]');
    if(!link)return [];
    const url=new URL(link.getAttribute("href")!,location.origin),activityId=url.searchParams.get("activityId")??"";
    if(url.origin!==location.origin||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(activityId))return [];
    const clean=(text:string|null|undefined)=>(text??"").replace(/\s+/g," ").trim();
    return [{activityId,service:clean(cells[2]?.textContent),timestamp:clean(cells[1]?.textContent),downloadUrl:url.toString()}];
  }));
}

export function validateOfficialPdf(pdf:Buffer){
  if(!pdf.length||pdf.length>15*1024*1024||pdf.subarray(0,5).toString()!=="%PDF-")throw Error("ASPI tidak memberikan PDF yang valid (maksimal 15 MB).");
  return pdf;
}

/** Use ASPI's report only: original PDF bytes, or its official printable HTML. */
export async function fetchOfficialPdf(page:Page,downloadUrl:string){
  const url=new URL(downloadUrl);
  if(url.origin!=="https://apidevportal.aspi-indonesia.or.id"||url.pathname!=="/sandboxactivity/downloadreportactivity"||!url.searchParams.get("activityId")||url.username||url.password)throw Error("URL PDF ASPI tidak valid.");
  const response=await page.context().request.get(url.toString(),{timeout:20000,maxRedirects:0});
  try{
    if(!response.ok())throw Error(`Download PDF ASPI ditolak: HTTP ${response.status()}.`);
    const data=await response.body();
    if(data.subarray(0,5).toString()==="%PDF-")return validateOfficialPdf(data);
    // ASPI may serve its official printable report as HTML from downloadreportactivity.
    // Print that exact page; do not substitute a custom AutoSNAP document or screenshot.
    if(!response.headers?.()["content-type"]?.includes("text/html"))throw Error("ASPI belum memberikan file PDF atau halaman laporan resmi.");
    const report=await page.context().newPage();
    try{
      const loaded=await report.goto(url.toString(),{waitUntil:"domcontentloaded",timeout:20000});
      const current=new URL(report.url());
      if(!loaded?.ok()||current.origin!==url.origin||current.pathname!==url.pathname||current.searchParams.get("activityId")!==url.searchParams.get("activityId"))throw Error("Sesi ASPI tidak dapat mengakses laporan resmi.");
      if(await report.locator('input[type="password"],form[action*="sign-in"],form[action*="login"]').count())throw Error("ASPI mengembalikan halaman login, bukan laporan.");
      const text=await report.locator("body").innerText();
      if(!/request/i.test(text)||!/response/i.test(text))throw Error("Isi halaman bukan laporan hasil pengujian ASPI.");
      await report.emulateMedia({media:"print"});
      await report.evaluate(()=>Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1000))]));
      return validateOfficialPdf(await report.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:"12mm",right:"12mm",bottom:"12mm",left:"12mm"}}));
    }finally{await report.close();}
  }finally{await response.dispose();}
}
