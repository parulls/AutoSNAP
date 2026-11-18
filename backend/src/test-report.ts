import {Injectable} from "@nestjs/common";
import {chromium,type Page,type Browser} from "playwright-core";
import {existsSync} from "node:fs";
import type {RunRow} from "./database.service";
import {object} from "./endpoint-config";
import {isHttpResponse} from "./test-evaluation";
import {redact,sha256} from "./security";

/** Separate namespace: this is an AutoSNAP report, NEVER an ASPI Activity ID. */
export const TEST_REPORT_ID="autosnap-report-v1";
const escape=(text:unknown)=>String(text??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
const json=(value:unknown)=>escape(JSON.stringify(redact(value??null),null,2));
export function reportSource(run:RunRow){
  const snapshot=object(run.request_json)?run.request_json:{};
  const request=Object.fromEntries(Object.entries(snapshot).filter(([key])=>!["endpointConfiguration","aspiActivities","evidenceErrors","report","progressLog"].includes(key)));
  return redact({id:run.id,createdAt:run.created_at,mode:run.mode,status:run.status,httpStatus:run.http_status,actualCode:run.response_code,expectedCode:run.expected_code,durationMs:run.duration_ms,request,response:run.response_json});
}
export const reportFingerprint=(run:RunRow)=>sha256(JSON.stringify(reportSource(run)));
export function hasRecordedHttp(run:Pick<RunRow,"http_status"|"request_json">){
  const snapshot=object(run.request_json)?run.request_json:{};
  return isHttpResponse(run.http_status)||Array.isArray(snapshot.steps)&&snapshot.steps.some(step=>object(step)&&isHttpResponse(step.httpStatus));
}
export function reportHtml(run:RunRow){
  const snapshot=object(run.request_json)?run.request_json:{},context=object(snapshot.context)?snapshot.context:{},evaluation=object(snapshot.evaluation)?snapshot.evaluation:{};
  const outcome=String(snapshot.outcome??run.status),snapValidated=evaluation.snapValidationPerformed===true;
  const checks=Array.isArray(snapshot.validation)?snapshot.validation.filter(object):[];
  const request=object(reportSource(run))?(reportSource(run) as Record<string,unknown>).request:null;
  const tone=outcome==="PASSED"?"success":outcome==="FAILED"?"danger":outcome==="PASSED_HTTP"?"http":"warning";
  const pairs=(entries:Array<[string,unknown]>)=>entries.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value??"Tidak tersedia")}</dd></div>`).join("");
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; script-src 'none';"><title>AutoSNAP - ${escape(run.id)}</title><style>
    @page{size:A4}*{box-sizing:border-box}body{margin:0;color:#0f172a;font:12pt/1.45 Arial,sans-serif}h1{font-size:21pt;margin:0 0 5mm}h2{font-size:15pt;margin:6mm 0 3mm;break-after:avoid}p{margin:2mm 0}small,.muted{font-size:10pt;color:#475569}.badge{display:inline-block;border:1px solid;padding:2mm 4mm;border-radius:2mm;font-size:11pt;font-weight:600}.success{color:#166534;background:#f0fdf4;border-color:#86efac}.danger{color:#991b1b;background:#fef2f2;border-color:#fca5a5}.http{color:#1d4ed8;background:#eff6ff;border-color:#93c5fd}.warning{color:#92400e;background:#fffbeb;border-color:#fcd34d}.columns{display:grid;grid-template-columns:1fr 1fr;gap:6mm}dl{margin:0}dl>div{display:grid;grid-template-columns:36mm minmax(0,1fr);gap:2mm;padding:1.5mm 0}dt{color:#475569}dd{margin:0;overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3mm;margin:5mm 0}.metric{border:1px solid #e2e8f0;background:#f8fafc;padding:3mm;border-radius:2mm;break-inside:avoid}.metric span{display:block;font-size:9pt;color:#475569}.metric strong{font-size:12pt;overflow-wrap:anywhere}.validation{border:1px solid #cbd5e1;border-left:3px solid #2563eb;padding:3mm;margin:4mm 0;break-inside:avoid}table{width:100%;border-collapse:collapse;font-size:10pt;table-layout:fixed}th,td{text-align:left;vertical-align:top;border:1px solid #e2e8f0;padding:2mm;overflow-wrap:anywhere}th{background:#f1f5f9}thead{display:table-header-group}tr{break-inside:avoid}.detail{break-before:page}.detail h2{margin-top:0}pre{font:9pt/1.5 Consolas,'Courier New',monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:#f1f5f9;border:1px solid #e2e8f0;padding:4mm;margin:0;-webkit-box-decoration-break:clone;box-decoration-break:clone}h1,h2,.badge,.columns{break-inside:avoid}
    </style></head><body><h1>Laporan Pengujian AutoSNAP</h1><p class="muted">Laporan dari hasil aktual tersimpan. Bukan dokumen resmi ASPI.</p><p><span class="badge ${tone}">${escape(outcome)}</span></p><h2>Identitas Pengujian</h2><div class="columns"><dl>${pairs([["ID Testing",run.id],["Waktu",run.created_at],["API Service",context.service],["Endpoint",snapshot.path]])}</dl><dl>${pairs([["Client",context.client],["Environment",context.environment],["User SNAP",context.user],["Method",snapshot.method]])}</dl></div><div class="metrics">${[["HTTP Status",run.http_status??"Tidak ada"],["Actual SNAP Code",run.response_code??"Tidak tersedia"],["Expected SNAP Code",run.expected_code??"Belum ditentukan"],["Durasi",`${run.duration_ms??0} ms`]].map(([label,value])=>`<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("")}</div><div class="validation"><strong>Validasi SNAP: ${snapValidated?"Dilakukan":"Belum dilakukan"}</strong><p>${escape(evaluation.detail??"Lihat hasil aktual dan validasi yang tersimpan pada history.")}</p>${!snapValidated?"<p>HTTP 200 hanya membuktikan keberhasilan pada level HTTP, bukan keberhasilan validasi SNAP.</p>":""}${evaluation.suggestion?`<p class="muted">${escape(evaluation.suggestion)}</p>`:""}</div><h2>Hasil Validasi</h2>${checks.length?`<table><thead><tr><th style="width:28%">Pemeriksaan</th><th style="width:20%">Hasil</th><th>Detail</th></tr></thead><tbody>${checks.map(check=>`<tr><td>${escape(check.label)}</td><td>${check.passed===true?"Lulus":check.passed===false?"Gagal":"Tidak dijalankan"}</td><td>${escape(check.detail)}</td></tr>`).join("")}</tbody></table>`:"<p>Detail validasi tidak tersedia pada history ini.</p>"}<section class="detail"><h2>Request Detail</h2><p class="muted">Nilai sensitif disanitasi. Data tidak diubah menjadi payload layanan lain.</p><pre>${json(request)}</pre></section><section class="detail"><h2>Response Detail</h2><pre>${json(run.response_json)}</pre></section></body></html>`;
}

@Injectable()
export class TestReportService{
  async render(run:RunRow,borrowedPage?:Page):Promise<Buffer>{
    if(!hasRecordedHttp(run))throw Error("Belum ada HTTP response yang dapat dijadikan bukti pengujian.");
    let browser:Browser|undefined,page:Page|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    try{
      if(borrowedPage&&!borrowedPage.isClosed())page=await borrowedPage.context().newPage().catch(()=>undefined);
      if(!page){
        if(process.env.VERCEL){const {default:runtime}=await import("@sparticuz/chromium");browser=await chromium.launch({executablePath:await runtime.executablePath(),headless:true,args:runtime.args});}
        else{const executablePath=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(path=>path&&existsSync(path));if(!executablePath)throw Error("Chrome tidak tersedia untuk membuat PDF AutoSNAP.");browser=await chromium.launch({executablePath,headless:true});}
        page=await browser.newPage({javaScriptEnabled:false});
      }
      const reportPage=page;
      await reportPage.route("**/*",route=>route.abort("blockedbyclient"));
      const work=(async()=>{
        await reportPage.setContent(reportHtml(run),{waitUntil:"load",timeout:15000});
        const header=`<div style="font:8px Arial;width:100%;margin:0 15mm;display:flex;justify-content:space-between;color:#475569"><span>AutoSNAP - Testing Report</span><span>${escape(run.id)}</span></div>`;
        return await reportPage.pdf({format:"A4",printBackground:true,displayHeaderFooter:true,headerTemplate:header,footerTemplate:'<div style="font:8px Arial;width:100%;margin:0 15mm;display:flex;justify-content:space-between;color:#475569"><span>AutoSNAP - data tersanitasi</span><span>Halaman <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',margin:{top:"15mm",bottom:"15mm",left:"15mm",right:"15mm"}});
      })();
      return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void reportPage.close().catch(()=>undefined);reject(Error("Batas waktu pembuatan laporan PDF AutoSNAP tercapai."));},20000);})]);
    }finally{if(timer)clearTimeout(timer);await page?.close().catch(()=>undefined);await browser?.close().catch(()=>undefined);}
  }
}
