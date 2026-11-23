import type {Download,Page} from "playwright-core";
import {ACTIVITY_PAGE,validateAspiDownloadPdf} from "./aspi-evidence";

/**
 * ASPI Download is HTML that calls its own download() → html2pdf().
 * AutoSNAP only captures that browser download. It does not delay, wrap, or
 * replay html2pdf — doing so changes the snapshot versus a normal Chrome click.
 */

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

/** Open the Download href and wait for the file ASPI's own script downloads. */
async function captureAspHtml2PdfBlob(page:Page,url:string,timeout:number){
  const report=await page.context().newPage();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired=false;
  const downloadPromise=report.waitForEvent("download",{timeout});
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
      if(early.kind==="download"){
        await navigated.catch(()=>undefined);
        return readOfficialDownload(early.download,url);
      }
      if(early.kind==="naverror")return readOfficialDownload(await downloadPromise,url);

      const response=early.response;
      const current=new URL(report.url()),expected=new URL(url);
      if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.searchParams.get("activityId")!==expected.searchParams.get("activityId")){
        throw Error("Sesi ASPI dialihkan dari halaman laporan Download.");
      }
      if(response&&!response.ok())throw Error(`Laporan ASPI mengembalikan HTTP ${response.status()}.`);
      const contentType=String(response?.headers()["content-type"]??"").toLowerCase();
      if(contentType.includes("application/pdf"))return readOfficialDownload(await downloadPromise,url);
      if(await report.locator('input[type="password"],form[action*="login"],form[action*="sign-in"]').count()){
        throw Error("ASPI mengembalikan halaman login, bukan PDF resmi. Bukti belum berhasil diunduh.");
      }
      if(!(await report.locator("#printPdf").count())&&!/html2pdf|function\s+download\s*\(/.test(await report.content())){
        throw Error("Halaman Download ASPI tidak memuat skrip html2pdf resmi. AutoSNAP tidak membuat PDF pengganti.");
      }
      // html2canvas keeps running after DOMContentLoaded. Wait for ASPI's download only.
      return readOfficialDownload(await downloadPromise,url);
    })();
    return await Promise.race([
      work,
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          expired=true;
          reject(Error("Timeout menunggu blob PDF dari download() resmi ASPI. AutoSNAP tidak membuat PDF pengganti."));
          void report.close().catch(()=>undefined);
        },timeout);
      }),
    ]);
  }catch(error){
    if(expired)throw Error("Timeout menunggu blob PDF dari download() resmi ASPI. AutoSNAP tidak membuat PDF pengganti.");
    throw error;
  }finally{
    if(timer)clearTimeout(timer);
    await report.close().catch(()=>undefined);
  }
}

/** Click the activity-row Download link and take the file that click produces. */
async function captureViaDownloadLinkClick(page:Page,url:string,timeout:number){
  const activityId=new URL(url).searchParams.get("activityId");
  if(!activityId)throw Error("URL Download ASPI tidak valid.");
  const location=(()=>{try{return new URL(page.url());}catch{return null;}})();
  if(!location||location.origin!=="https://apidevportal.aspi-indonesia.or.id"||location.pathname!=="/aktivitas-aplikasi-pengujian"){
    const response=await page.goto(ACTIVITY_PAGE,{waitUntil:"domcontentloaded",timeout:Math.min(20000,timeout)});
    const here=new URL(page.url());
    if(here.pathname!=="/aktivitas-aplikasi-pengujian")throw Error("Tidak dapat membuka daftar aktivitas ASPI untuk klik Download.");
    if(response&&!response.ok())throw Error(`Halaman aktivitas ASPI mengembalikan HTTP ${response.status()}.`);
  }
  const link=page.locator(`a[href*="downloadreportactivity"][href*="activityId=${activityId}"]`).first();
  if(!(await link.count()))throw Error(`Tombol Download untuk Activity ID ${activityId} tidak ditemukan di tabel aktivitas ASPI.`);
  const downloadPromise=page.context().waitForEvent("download",{timeout});
  await link.click({timeout:Math.min(10000,timeout)});
  return readOfficialDownload(await downloadPromise,url);
}

/**
 * Official ASPI Download only. The page script runs untouched.
 * Click the activity Download link first; if it is missing, open the same href.
 */
export async function downloadReportByNavigation(page:Page,url:string,timeout:number){
  const parsed=new URL(url);
  if(parsed.pathname!=="/sandboxactivity/downloadreportactivity"||!parsed.searchParams.get("activityId")){
    throw Error("URL Download ASPI tidak valid.");
  }
  try{
    return await captureViaDownloadLinkClick(page,url,timeout);
  }catch(clickError){
    const reason=clickError instanceof Error?clickError.message:String(clickError);
    try{
      return await captureAspHtml2PdfBlob(page,url,timeout);
    }catch(navError){
      const navReason=navError instanceof Error?navError.message:String(navError);
      throw Error(`Unduhan Download ASPI gagal. Klik tombol: ${reason.slice(0,180)}. Buka href Download: ${navReason.slice(0,180)}. AutoSNAP tidak membuat PDF pengganti.`);
    }
  }
}
