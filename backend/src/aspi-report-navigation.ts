import type {Download,Page} from "playwright-core";
import {ACTIVITY_PAGE,validateAspiDownloadPdf} from "./aspi-evidence";

export type PdfDownloadDiag={
  module:"dev_site"|"client_simulator";
  activityId:string;
  path:string;
  triggerPage:string;
  popupOpened:boolean;
  reportHttp?:number;
  contentType?:string;
  downloadCaptured:boolean;
  stageMs:Record<string,number>;
  bytes?:number;
  errorCode?:string;
};

function logDiag(diag:PdfDownloadDiag){
  const safe={
    module:diag.module,
    activityId:diag.activityId,
    path:diag.path,
    triggerPage:diag.triggerPage,
    popupOpened:diag.popupOpened,
    reportHttp:diag.reportHttp,
    contentType:diag.contentType,
    downloadCaptured:diag.downloadCaptured,
    stageMs:diag.stageMs,
    bytes:diag.bytes,
    errorCode:diag.errorCode,
  };
  console.info("[aspi-pdf]",JSON.stringify(safe));
}

function classifyNavError(message:string):string{
  if(/login|sesi|sign-in|ASPI_AUTH_EXPIRED/i.test(message))return "ASPI_AUTH_EXPIRED";
  if(/tidak ditemukan|DOWNLOAD_LINK_NOT_FOUND|Tombol Download/i.test(message))return "DOWNLOAD_LINK_NOT_FOUND";
  if(/POPUP_NOT_DETECTED/i.test(message))return "POPUP_NOT_DETECTED";
  if(/timeout|batas waktu|DOWNLOAD_EVENT_TIMEOUT/i.test(message))return "DOWNLOAD_EVENT_TIMEOUT";
  if(/HTML|html2pdf|%%EOF|%PDF-|INVALID_PDF|bukan PDF|blob PDF/i.test(message))return "INVALID_PDF_RESPONSE";
  if(/ACTIVITY_NOT_FOUND|daftar aktivitas/i.test(message))return "ACTIVITY_NOT_FOUND";
  if(/penyimpanan|STORAGE/i.test(message))return "PDF_STORAGE_ERROR";
  return "DOWNLOAD_EVENT_TIMEOUT";
}

async function readOfficialDownload(download:Download,expectedUrl:string){
  const actual=download.url();
  if(!actual.startsWith("blob:")){
    const parsed=new URL(actual),expected=new URL(expectedUrl);
    if(parsed.origin!==expected.origin||parsed.pathname!==expected.pathname||parsed.searchParams.get("activityId")!==expected.searchParams.get("activityId")){
      throw Error("URL laporan ASPI dialihkan.");
    }
  }
  const stream=await download.createReadStream();
  if(!stream)throw Error("Unduhan lampiran PDF ASPI tidak menyediakan stream binary.");
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of stream){
    const bytes=Buffer.from(chunk);size+=bytes.length;
    if(size>15*1024*1024){stream.destroy();await download.cancel();throw Error("Laporan ASPI melebihi 15 MB.");}
    chunks.push(bytes);
  }
  return validateAspiDownloadPdf(Buffer.concat(chunks));
}

async function waitDownloadOnPage(target:Page,timeout:number){
  return target.waitForEvent("download",{timeout});
}

async function captureAspHtml2PdfBlob(page:Page,url:string,timeout:number){
  const activityId=new URL(url).searchParams.get("activityId")||"";
  const diag:PdfDownloadDiag={
    module:"dev_site",
    activityId,
    path:"/sandboxactivity/downloadreportactivity",
    triggerPage:"opened_report_tab",
    popupOpened:false,
    downloadCaptured:false,
    stageMs:{},
  };
  const started=Date.now();
  const mark=(stage:string)=>{diag.stageMs[stage]=Date.now()-started;};
  const report=await page.context().newPage();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired=false;
  // Attach download listener on the report Page before navigation (not BrowserContext).
  const downloadPromise=waitDownloadOnPage(report,timeout);
  try{
    const work=(async()=>{
      const navigated=report.goto(url,{waitUntil:"domcontentloaded",referer:ACTIVITY_PAGE,timeout}).then(
        response=>({kind:"response" as const,response}),
        error=>({kind:"naverror" as const,error}),
      );
      const early=await Promise.race([
        downloadPromise.then(download=>({kind:"download" as const,download})),
        navigated,
      ]);
      mark("navigate_or_download");
      if(early.kind==="download"){
        diag.downloadCaptured=true;
        await navigated.catch(()=>undefined);
        const pdf=await readOfficialDownload(early.download,url);
        diag.bytes=pdf.length;
        mark("stream_done");
        logDiag(diag);
        return pdf;
      }
      if(early.kind==="naverror"){
        const pdf=await readOfficialDownload(await downloadPromise,url);
        diag.downloadCaptured=true;
        diag.bytes=pdf.length;
        mark("stream_done");
        logDiag(diag);
        return pdf;
      }

      const response=early.response;
      diag.reportHttp=response?.status();
      diag.contentType=String(response?.headers()["content-type"]??"").toLowerCase();
      mark("domcontentloaded");
      const current=new URL(report.url()),expected=new URL(url);
      if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.searchParams.get("activityId")!==expected.searchParams.get("activityId")){
        diag.errorCode="ASPI_AUTH_EXPIRED";
        logDiag(diag);
        throw Error("ASPI_AUTH_EXPIRED: Sesi ASPI dialihkan dari halaman laporan Download.");
      }
      if(response&&!response.ok())throw Error(`Laporan ASPI mengembalikan HTTP ${response.status()}.`);
      if(diag.contentType.includes("application/pdf")){
        const pdf=await readOfficialDownload(await downloadPromise,url);
        diag.downloadCaptured=true;
        diag.bytes=pdf.length;
        mark("stream_done");
        logDiag(diag);
        return pdf;
      }
      if(await report.locator('input[type="password"],form[action*="login"],form[action*="sign-in"]').count()){
        diag.errorCode="ASPI_AUTH_EXPIRED";
        logDiag(diag);
        throw Error("ASPI_AUTH_EXPIRED: ASPI mengembalikan halaman login, bukan PDF resmi. Bukti belum berhasil diunduh.");
      }
      if(!(await report.locator("#printPdf").count())&&!/html2pdf|function\s+download\s*\(/.test(await report.content())){
        diag.errorCode="INVALID_PDF_RESPONSE";
        logDiag(diag);
        throw Error("INVALID_PDF_RESPONSE: Halaman Download ASPI tidak memuat skrip html2pdf resmi. AutoSNAP tidak membuat PDF pengganti.");
      }
      const pdf=await readOfficialDownload(await downloadPromise,url);
      diag.downloadCaptured=true;
      diag.bytes=pdf.length;
      mark("stream_done");
      logDiag(diag);
      return pdf;
    })();
    return await Promise.race([
      work,
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          expired=true;
          diag.errorCode="DOWNLOAD_EVENT_TIMEOUT";
          logDiag(diag);
          reject(Error("DOWNLOAD_EVENT_TIMEOUT: Timeout menunggu blob PDF dari download() resmi ASPI. AutoSNAP tidak membuat PDF pengganti."));
          void report.close().catch(()=>undefined);
        },timeout);
      }),
    ]);
  }catch(error){
    if(expired)throw Error("DOWNLOAD_EVENT_TIMEOUT: Timeout menunggu blob PDF dari download() resmi ASPI. AutoSNAP tidak membuat PDF pengganti.");
    if(!diag.errorCode){
      diag.errorCode=classifyNavError(error instanceof Error?error.message:String(error));
      logDiag(diag);
    }
    throw error;
  }finally{
    if(timer)clearTimeout(timer);
    await report.close().catch(()=>undefined);
  }
}

async function captureViaDownloadLinkClick(page:Page,url:string,timeout:number){
  const activityId=new URL(url).searchParams.get("activityId");
  if(!activityId)throw Error("URL Download ASPI tidak valid.");
  const diag:PdfDownloadDiag={
    module:"dev_site",
    activityId,
    path:"/sandboxactivity/downloadreportactivity",
    triggerPage:"/aktivitas-aplikasi-pengujian",
    popupOpened:false,
    downloadCaptured:false,
    stageMs:{},
  };
  const started=Date.now();
  const mark=(stage:string)=>{diag.stageMs[stage]=Date.now()-started;};
  const clickTimeout=Math.min(10000,timeout);
  const location=(()=>{try{return new URL(page.url());}catch{return null;}})();
  if(!location||location.origin!=="https://apidevportal.aspi-indonesia.or.id"||location.pathname!=="/aktivitas-aplikasi-pengujian"){
    const response=await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:Math.min(20000,timeout)});
    mark("open_activity_page");
    const here=new URL(page.url());
    if(here.pathname!=="/aktivitas-aplikasi-pengujian"){
      diag.errorCode="ACTIVITY_NOT_FOUND";
      logDiag(diag);
      throw Error("ACTIVITY_NOT_FOUND: Tidak dapat membuka daftar aktivitas ASPI untuk klik Download.");
    }
    if(response&&!response.ok())throw Error(`Halaman aktivitas ASPI mengembalikan HTTP ${response.status()}.`);
  }
  const link=page.locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`).first();
  if(!(await link.count())){
    diag.errorCode="DOWNLOAD_LINK_NOT_FOUND";
    logDiag(diag);
    throw Error(`DOWNLOAD_LINK_NOT_FOUND: Tombol Download untuk Activity ID ${activityId} tidak ditemukan di tabel aktivitas ASPI.`);
  }

  // Listen on the activity Page and for a popup before the click — avoid races.
  const pageDownload=waitDownloadOnPage(page,timeout).then(d=>({kind:"page" as const,download:d})).catch(()=>null);
  const popupPromise=page.waitForEvent("popup",{timeout}).then(p=>({kind:"popup" as const,popup:p})).catch(()=>null);

  await link.click({timeout:clickTimeout});
  mark("click_download");

  const first=await Promise.race([
    pageDownload.then(v=>v),
    popupPromise.then(v=>v),
    new Promise<null>(resolve=>setTimeout(()=>resolve(null),timeout)),
  ]);

  if(first?.kind==="page"){
    diag.downloadCaptured=true;
    const pdf=await readOfficialDownload(first.download,url);
    diag.bytes=pdf.length;
    mark("stream_done");
    logDiag(diag);
    return pdf;
  }

  if(first?.kind==="popup"){
    diag.popupOpened=true;
    mark("popup_opened");
    const popup=first.popup;
    try{
      if(/sign-in|login/i.test(new URL(popup.url()||"about:blank").pathname)){
        diag.errorCode="ASPI_AUTH_EXPIRED";
        logDiag(diag);
        throw Error("ASPI_AUTH_EXPIRED: Popup laporan ASPI dialihkan ke halaman login.");
      }
      // Popup may still be navigating; attach download on that Page immediately.
      const popupDownload=waitDownloadOnPage(popup,Math.max(1000,timeout-(Date.now()-started)));
      try{
        const response=await popup.waitForLoadState("domcontentloaded",{timeout:Math.min(20000,timeout)}).then(()=>null).catch(()=>null);
        void response;
        diag.contentType=await popup.evaluate(()=>document.contentType||"").catch(()=>"");
      }catch{/* load may complete via download first */}
      const download=await popupDownload;
      diag.downloadCaptured=true;
      const pdf=await readOfficialDownload(download,url);
      diag.bytes=pdf.length;
      mark("stream_done");
      logDiag(diag);
      return pdf;
    }finally{
      await popup.close().catch(()=>undefined);
    }
  }

  // Late page download (popup listener lost the race timing).
  const late=await pageDownload;
  if(late?.kind==="page"){
    diag.downloadCaptured=true;
    const pdf=await readOfficialDownload(late.download,url);
    diag.bytes=pdf.length;
    mark("stream_done");
    logDiag(diag);
    return pdf;
  }

  diag.errorCode="DOWNLOAD_EVENT_TIMEOUT";
  logDiag(diag);
  throw Error(`DOWNLOAD_EVENT_TIMEOUT: Event download tidak tertangkap setelah klik Download Activity ID ${activityId}.`);
}

export async function downloadReportByNavigation(page:Page,url:string,timeout:number){
  const parsed=new URL(url);
  if(parsed.pathname!=="/sandboxactivity/downloadreportactivity"||!parsed.searchParams.get("activityId")){
    throw Error("URL Download ASPI tidak valid.");
  }
  const clickBudget=Math.max(8000,Math.floor(timeout*0.5));
  const openBudget=Math.max(8000,timeout-clickBudget);
  try{
    return await captureViaDownloadLinkClick(page,url,clickBudget);
  }catch(clickError){
    const reason=clickError instanceof Error?clickError.message:String(clickError);
    if(/ASPI_AUTH_EXPIRED/i.test(reason)){
      throw Error(`${reason} AutoSNAP tidak membuat PDF pengganti.`);
    }
    try{
      return await captureAspHtml2PdfBlob(page,url,openBudget);
    }catch(navError){
      const navReason=navError instanceof Error?navError.message:String(navError);
      const code=classifyNavError(navReason)||classifyNavError(reason);
      throw Error(`${code}: Unduhan Download ASPI gagal. Klik tombol: ${reason.slice(0,160)}. Buka href Download: ${navReason.slice(0,160)}. AutoSNAP tidak membuat PDF pengganti.`);
    }
  }
}
