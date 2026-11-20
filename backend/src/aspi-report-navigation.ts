import type {Download,Page} from "playwright-core";
import {ACTIVITY_PAGE,validateAspiDownloadPdf} from "./aspi-evidence";

async function readOfficialDownload(download:Download,expectedUrl:string){
  const actual=download.url();
  // Official ASPI Download: page script fires blob: via html2pdf — AutoSNAP only captures bytes.
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

/**
 * Prefer the exact UI path: Aktivitas Pengujian → link Download (target=_blank).
 * Captures the browser download event only — never generates PDF.
 */
async function downloadViaActivityLinkClick(page:Page,url:string,timeout:number){
  const activityId=new URL(url).searchParams.get("activityId")??"";
  if(!activityId)throw Error("Activity ID PDF ASPI tidak valid.");
  const onList=(()=>{try{return new URL(page.url()).pathname==="/aktivitas-aplikasi-pengujian";}catch{return false;}})();
  if(!onList)await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout});

  const link=page.locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`).first();
  if(!await link.count())throw Error("Tautan Download resmi ASPI untuk Activity ID ini tidak ditemukan di daftar aktivitas.");

  const context=page.context();
  let popup:Page|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired=false;
  try{
    const downloadPromise=Promise.race([
      page.waitForEvent("download",{timeout}),
      context.waitForEvent("page",{timeout}).then(async opened=>{
        popup=opened;
        await opened.waitForLoadState("domcontentloaded").catch(()=>undefined);
        return opened.waitForEvent("download",{timeout});
      }),
    ]);
    await link.click({force:true});
    const download=await Promise.race([
      downloadPromise,
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error("Timeout menunggu blob PDF dari tombol Download ASPI."));},timeout);}),
    ]);
    return await readOfficialDownload(download,url);
  }catch(error){
    if(expired)throw Error("Timeout menunggu blob PDF dari tombol Download ASPI.");
    throw error;
  }finally{
    if(timer)clearTimeout(timer);
    if(popup&&!popup.isClosed())await popup.close().catch(()=>undefined);
  }
}

/**
 * Open the same href the Download button uses and capture ASPI's own html2pdf blob.
 * Never calls page.pdf() or AutoSNAP generators.
 */
async function downloadViaOfficialUrl(page:Page,url:string,timeout:number){
  const report=await page.context().newPage();
  let settled=false;
  let settle!:(download:Download)=>void;
  let fail!:(error:Error)=>void;
  const pending=new Promise<Download>((resolve,reject)=>{settle=resolve;fail=reject;});
  const onDownload=(download:Download)=>{if(settled)return;settled=true;report.off("download",onDownload);settle(download);};
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired=false;
  try{
    report.on("download",onDownload);
    const work=(async()=>{
      let response;
      try{response=await report.goto(url,{waitUntil:"domcontentloaded",referer:ACTIVITY_PAGE,timeout});}
      catch(error){
        if(!(error instanceof Error)||!/ERR_ABORTED|Download is starting|ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_/i.test(error.message))throw error;
      }
      if(!response)return readOfficialDownload(await pending,url);

      const early=await Promise.race([
        pending.then(download=>({kind:"download" as const,download})),
        new Promise<{kind:"none"}>(resolve=>setTimeout(()=>resolve({kind:"none"}),750)),
      ]);
      if(early.kind==="download")return readOfficialDownload(early.download,url);

      const current=new URL(report.url()),expected=new URL(url);
      if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.searchParams.get("activityId")!==expected.searchParams.get("activityId")){
        throw Error("Sesi ASPI dialihkan dari halaman laporan.");
      }
      if(!response.ok())throw Error(`Laporan ASPI mengembalikan HTTP ${response.status()}.`);
      const contentType=String(response.headers()["content-type"]??"").toLowerCase();
      const disposition=String(response.headers()["content-disposition"]??"").toLowerCase();
      const body=await response.body();

      if(disposition.includes("attachment")&&body.subarray(0,5).toString("latin1")==="%PDF-"){
        return validateAspiDownloadPdf(body);
      }
      if(await report.locator('input[type="password"],form[action*="login"],form[action*="sign-in"]').count()){
        throw Error("ASPI mengembalikan halaman login, bukan PDF resmi. Bukti belum berhasil diunduh.");
      }
      const looksHtml=contentType.includes("text/html")||/<\s*html|<\s*!doctype/i.test(body.subarray(0,200).toString("utf8"));
      if(!looksHtml){
        throw Error(`ASPI belum memberikan unduhan PDF resmi (Content-Type: ${contentType||"tidak ada"}). AutoSNAP tidak membuat PDF pengganti.`);
      }

      await report.locator("#printPdf").first().waitFor({state:"attached",timeout:Math.min(15000,Math.max(1000,timeout))}).catch(()=>undefined);
      await report.waitForFunction("typeof window.html2pdf === 'function'",null,{timeout:Math.min(20000,Math.max(1000,timeout))}).catch(()=>undefined);

      try{return await readOfficialDownload(await pending,url);}
      catch(error){
        if(expired)throw Error("Timeout navigasi/download laporan ASPI.");
        const message=error instanceof Error?error.message:String(error);
        if(/Timeout/i.test(message))throw Error("Timeout menunggu blob PDF dari tombol Download ASPI. AutoSNAP tidak membuat PDF pengganti.");
        if(/print\/render browser|bukan keluaran Download|html2pdf\/jsPDF/i.test(message))throw error;
        throw Error(`Endpoint Download ASPI mengembalikan HTML tanpa blob PDF resmi. AutoSNAP tidak membuat PDF pengganti. (Content-Type: ${contentType||"tidak ada"})`);
      }
    })();
    return await Promise.race([
      work,
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          expired=true;
          if(!settled){settled=true;fail(Error("Timeout navigasi/download laporan ASPI."));}
          reject(Error("Timeout navigasi/download laporan ASPI."));
          void report.close().catch(()=>undefined);
        },timeout);
      }),
    ]);
  }catch(error){if(expired)throw Error("Timeout navigasi/download laporan ASPI.");throw error;}
  finally{
    if(timer)clearTimeout(timer);
    report.off("download",onDownload);
    settled=true;
    await report.close().catch(()=>undefined);
  }
}

/**
 * Official ASPI Download only. Never page.pdf(), printToPDF, or AutoSNAP-generated PDF.
 */
export async function downloadReportByNavigation(page:Page,url:string,timeout:number){
  try{
    const pathname=(()=>{try{return new URL(page.url()).pathname;}catch{return "";}})();
    const activityId=new URL(url).searchParams.get("activityId")??"";
    const onList=pathname==="/aktivitas-aplikasi-pengujian";
    const linkVisible=onList&&activityId
      ? await page.locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`).count()
      : 0;
    if(linkVisible>0)return await downloadViaActivityLinkClick(page,url,timeout);
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    // Link missing is expected for older Activity IDs scrolled off the first page — use URL.
    if(!/tidak ditemukan di daftar aktivitas/i.test(message)&&!/Timeout menunggu blob PDF dari tombol Download/i.test(message)){
      // Unexpected click failure: still try the official Download URL once.
    }
  }
  return downloadViaOfficialUrl(page,url,timeout);
}
