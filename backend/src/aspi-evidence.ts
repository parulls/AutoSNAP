import { createHash } from "node:crypto";
import { pdfSettings } from "./pdf-settings";
import type { Page } from "playwright-core";
import { activityAliasesFor } from "./service-capabilities";

export const ACTIVITY_PAGE="https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian";
export type AspiActivity={activityId:string;service:string;timestamp:string;downloadUrl:string};
const normalize=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]/g,"");

function serviceLabelMatches(service:string,alias:string){
  const label=normalize(service).replace(/^api/,"");
  const name=normalize(alias).replace(/^api/,"");
  if(!label||!name)return false;
  return label===name||label.endsWith(name)||name.endsWith(label);
}

/** A new row must uniquely match the executed service. Never choose the latest arbitrary ID. */
export function correlateActivity(before:Set<string>,after:AspiActivity[],path:string,configuredNames:string[]=[],window?:{startedAt?:string;finishedAt?:string}){
  const pathAliases=activityAliasesFor(path);
  const pathTail=normalize(path.split("/").at(-1)??path);
  const names=[...new Set([
    ...pathAliases,
    ...(pathAliases.length?[]:[pathTail]),
    ...configuredNames.map(normalize).map(name=>name.replace(/^api/,"")),
  ].filter(Boolean))];
  const matches=after.filter(row=>{
    if(before.has(row.activityId))return false;
    if(window?.startedAt&&!activityWithinWindow(row.timestamp,window.startedAt,window.finishedAt))return false;
    return names.some(name=>serviceLabelMatches(row.service,name)||normalize(row.service)===normalize(path));
  });
  return matches.length===1?matches[0]:null;
}

/** Diagnostic summary for Activity ID matching (no secrets). */
export function describeActivityMatch(before:Set<string>,after:AspiActivity[],path:string,configuredNames:string[]=[]){
  const pathAliases=activityAliasesFor(path);
  const names=[...pathAliases,...configuredNames.map(normalize)];
  const fresh=after.filter(row=>!before.has(row.activityId));
  const matched=fresh.filter(row=>names.some(name=>serviceLabelMatches(row.service,name))||serviceLabelMatches(row.service,path.split("/").at(-1)??""));
  return {
    path,
    aliases:names,
    listed:after.length,
    fresh:fresh.length,
    candidates:matched.map(row=>({activityId:row.activityId,service:row.service,timestamp:row.timestamp})),
    result:matched.length===1?"matched":matched.length===0?"ACTIVITY_NOT_FOUND":"ACTIVITY_AMBIGUOUS",
  };
}
export function activityWithinWindow(raw:string,start:string,end?:string){
  const from=Date.parse(start)-60000,to=Date.parse(end??start)+60000;
  if(!Number.isFinite(from)||!Number.isFinite(to)||!/[T\s]\d{1,2}[:.]\d{2}/.test(raw))return false;
  const candidates:number[]=[];
  const local=(text:string)=>Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text)?text:text.replace(" ","T")+"+07:00");
  if(/^\d{4}-\d{2}-\d{2}/.test(raw))candidates.push(local(raw));
  const date=/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*(AM|PM)?$/i.exec(raw.trim());
  if(date){const [,a,b,year,h,m,s="00",ampm]=date;let hour=Number(h);if(ampm)hour=hour%12+(ampm.toUpperCase()==="PM"?12:0);for(const [day,month]of [[a,b],[b,a]])if(Number(day)<=31&&Number(month)<=12)candidates.push(local(`${year}-${month.padStart(2,"0")}-${day.padStart(2,"0")}T${String(hour).padStart(2,"0")}:${m}:${s}`));}
  return new Set(candidates.filter(time=>Number.isFinite(time)&&time>=from&&time<=to)).size===1;
}

function remaining(deadline:number|undefined,limit:number){
  if(deadline!==undefined&&Date.now()>=deadline)throw Error("Batas waktu pengambilan PDF tercapai.");
  return deadline===undefined?limit:Math.max(1,Math.min(limit,deadline-Date.now()));
}

export async function readActivities(page:Page,deadline?:number):Promise<AspiActivity[]>{
  let location:URL;
  try{location=new URL(page.url());}catch{location=new URL("https://invalid.local/");}
  const already=location.origin==="https://apidevportal.aspi-indonesia.or.id"&&location.pathname==="/aktivitas-aplikasi-pengujian";
  if(!already){
    const response=await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:remaining(deadline,20000)});
    location=new URL(page.url());
    if(location.origin!=="https://apidevportal.aspi-indonesia.or.id"||location.pathname!=="/aktivitas-aplikasi-pengujian"){
      throw Error("Halaman aktivitas ASPI dialihkan; periksa autentikasi.");
    }
    if(!response?.ok())throw Error(`Halaman aktivitas ASPI mengembalikan HTTP ${response?.status()??"unknown"}.`);
  }
  const table=page.locator("table").first();
  await table.waitFor({state:"attached",timeout:remaining(deadline,8000)});
  // DataTables often defaults to 10 rows; expand when possible so concurrent ops are visible.
  const lengthSelect=page.locator('select[name$="_length"], .dataTables_length select').first();
  if(await lengthSelect.count()){
    const options=await lengthSelect.locator("option").evaluateAll(nodes=>nodes.map(node=>({value:(node as HTMLOptionElement).value,label:(node.textContent??"").trim()})));
    const preferred=options.find(item=>/all|semua|-1/i.test(item.label)||item.value==="-1")??options.find(item=>Number(item.value)>=50)??options.at(-1);
    if(preferred)await lengthSelect.selectOption(preferred.value).catch(()=>undefined);
  }
  const rows=page.locator("table tbody tr");
  await rows.first().waitFor({state:"attached",timeout:remaining(deadline,4000)}).catch(()=>undefined);
  if(await rows.count()>0){
    await page.locator('a[href*="downloadreportactivity"]').first()
      .waitFor({state:"attached",timeout:remaining(deadline,8000)})
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

/** Official ASPI PDF only: binary signature, size, and trailer. Never accept HTML or generated substitutes. */
export function validateOfficialPdf(pdf:Buffer){
  if(!pdf.length)throw Error("ASPI tidak memberikan PDF yang valid (file kosong).");
  if(pdf.length>15*1024*1024)throw Error("ASPI tidak memberikan PDF yang valid (maksimal 15 MB).");
  if(pdf.subarray(0,5).toString("latin1")!=="%PDF-")throw Error("ASPI tidak memberikan PDF yang valid (signature %PDF- tidak ada).");
  const head=pdf.subarray(0,Math.min(512,pdf.length)).toString("latin1");
  if(/<\s*html|<\s*!doctype\s+html/i.test(head))throw Error("Respons ASPI berisi HTML, bukan binary PDF resmi.");
  const tail=pdf.subarray(Math.max(0,pdf.length-2048)).toString("latin1");
  if(!/%%EOF/.test(tail))throw Error("PDF ASPI tidak lengkap (marker %%EOF tidak ditemukan); unduhan dianggap gagal.");
  return pdf;
}

/** Raw SHA-256 of stored bytes (round-trip integrity). */
export function pdfContentSha256(pdf:Buffer){
  return createHash("sha256").update(pdf).digest("hex");
}

/**
 * ASPI Download regenerates PDF via html2pdf/jsPDF on every click, so raw SHA-256
 * differs across downloads (CreationDate / ID). Fingerprint strips those volatile
 * fields for cross-download equivalence of the same Activity ID.
 */
export function pdfEvidenceFingerprint(pdf:Buffer){
  let latin=pdf.toString("latin1");
  latin=latin.replace(/\/CreationDate\s*\([^)]*\)/g,"/CreationDate()");
  latin=latin.replace(/\/ModDate\s*\([^)]*\)/g,"/ModDate()");
  latin=latin.replace(/\/ID\s*\[\s*<[^>]+>\s*<[^>]+>\s*\]/g,"/ID[<><>]");
  return createHash("sha256").update(Buffer.from(latin,"latin1")).digest("hex");
}

export function inspectPdfProvenance(pdf:Buffer){
  const latin=pdf.toString("latin1");
  const producer=(latin.match(/\/Producer\s*\(([^)]*)\)/)||[])[1]??"";
  const creator=(latin.match(/\/Creator\s*\(([^)]*)\)/)||[])[1]??"";
  const creationDate=(latin.match(/\/CreationDate\s*\(([^)]*)\)/)||[])[1]??"";
  const fromAspHtml2Pdf=/jspdf/i.test(producer)||/jspdf/i.test(creator);
  const fromChromiumPrint=/skia|chrome|chromium|headless|playwright/i.test(`${producer} ${creator}`);
  return {producer,creator,creationDate,fromAspHtml2Pdf,fromChromiumPrint};
}

/**
 * Origin gate only: accept the blob from ASPI Download (html2pdf → jsPDF).
 * Reject browser printToPDF / page.pdf() substitutes.
 *
 * Layers (do not conflate):
 * - Integrity: validateOfficialPdf + content SHA-256 of stored bytes
 * - Origin: jsPDF/html2pdf Producer (this function) + capture from downloadreportactivity
 * - Visual: layout vs user Firefox PDF → verification_status VERIFIED (never auto here)
 */
export function validateAspiDownloadPdf(pdf:Buffer){
  validateOfficialPdf(pdf);
  const provenance=inspectPdfProvenance(pdf);
  if(provenance.fromChromiumPrint){
    throw Error("PDF berasal dari print/render browser (bukan tombol Download ASPI). Bukti ditolak. AutoSNAP tidak membuat PDF pengganti.");
  }
  if(!provenance.fromAspHtml2Pdf){
    throw Error(`PDF bukan keluaran Download resmi ASPI (Producer: ${provenance.producer||provenance.creator||"tidak ada"}). ASPI memakai html2pdf/jsPDF pada tombol Download. AutoSNAP tidak membuat PDF pengganti.`);
  }
  return pdf;
}

/**
 * Download the official ASPI activity report binary only via the Download button path.
 * Only "navigation" (click Download / open downloadreportactivity + capture blob) is allowed.
 * HTTP GET of the HTML shell is rejected — it is not the official PDF. Never page.pdf().
 */
export async function fetchOfficialPdf(page:Page,downloadUrl:string,deadline?:number,transport:"browser"|"request"|"navigation"="navigation"){
  const url=new URL(downloadUrl);
  if(url.origin!=="https://apidevportal.aspi-indonesia.or.id"||url.pathname!=="/sandboxactivity/downloadreportactivity"||!url.searchParams.get("activityId")||url.username||url.password)throw Error("URL PDF ASPI tidak valid.");
  const timeout=remaining(deadline,pdfSettings().requestTimeoutMs);
  if(transport!=="navigation"){
    throw Error(`Transport '${transport}' dilarang untuk bukti audit. Gunakan mekanisme Download resmi ASPI (navigation/blob). AutoSNAP tidak membuat PDF pengganti.`);
  }
  const {downloadReportByNavigation}=await import("./aspi-report-navigation.js");
  return downloadReportByNavigation(page,url.toString(),timeout);
}
