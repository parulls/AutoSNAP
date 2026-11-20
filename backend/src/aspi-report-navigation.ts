import type {Download,Page} from "playwright-core";
import {ACTIVITY_PAGE,validateAspiDownloadPdf} from "./aspi-evidence";

/**
 * ASPI Download is not a static PDF. The portal serves HTML that runs:
 *   html2pdf(printPdf, { …jsPDF options… }); download();
 * AutoSNAP must capture that blob only — never page.pdf() / printToPDF.
 *
 * The portal calls download() immediately on load, often before logos finish.
 * We gate html2pdf via init script (same options ASPI queued), wait for #printPdf
 * assets, then run the official generator — still ASPI's code, not AutoSNAP's PDF.
 *
 * Do not use route.fetch() to rewrite HTML: Playwright's fetch bypasses the
 * browser cookie jar / context routes and can hit a bare login page.
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

/** Hold ASPI's html2pdf call until #printPdf images/fonts are ready, then replay it. */
async function installHtml2PdfGate(page:Page){
  await page.addInitScript(()=>{
    const w=window as Window&{
      __aspiAssetsReady?:boolean;
      __aspiQueuedHtml2Pdf?:{el:unknown;opts:unknown;real:(...args:unknown[])=>unknown};
      __aspiHtml2PdfSeen?:boolean;
    };
    w.__aspiAssetsReady=false;
    let real:((...args:unknown[])=>unknown)|null=null;
    Object.defineProperty(w,"html2pdf",{
      configurable:true,
      enumerable:true,
      set(fn:unknown){
        real=typeof fn==="function"?(fn as(...args:unknown[])=>unknown):null;
        w.__aspiHtml2PdfSeen=true;
      },
      get(){
        const wrapper=function(this:unknown,...args:unknown[]){
          w.__aspiHtml2PdfSeen=true;
          if(!real)throw Error("html2pdf belum dimuat.");
          if(w.__aspiAssetsReady)return real.apply(this,args);
          w.__aspiQueuedHtml2Pdf={el:args[0],opts:args[1],real};
          const fake={then(cb?:(v:unknown)=>unknown){cb?.(fake);return fake;},catch(){return fake;},finally(cb?:()=>void){cb?.();return fake;}};
          return fake;
        };
        return wrapper;
      },
    });
  });
}

async function waitForPrintPdfAssets(page:Page,budgetMs:number){
  await page.locator("#printPdf").first().waitFor({state:"attached",timeout:Math.min(15000,Math.max(1000,budgetMs))});
  await page.waitForFunction("typeof window.html2pdf === 'function' || window.__aspiHtml2PdfSeen === true",null,{timeout:Math.min(20000,Math.max(1000,budgetMs))});
  await page.evaluate(async()=>{
    const root=document.querySelector("#printPdf");
    if(!root)return;
    const images=[...root.querySelectorAll("img")];
    await Promise.all(images.map(img=>{
      if(img.complete&&img.naturalWidth>0)return Promise.resolve();
      return new Promise<void>(resolve=>{
        const done=()=>resolve();
        img.addEventListener("load",done,{once:true});
        img.addEventListener("error",done,{once:true});
        setTimeout(done,8000);
      });
    }));
    if(document.fonts?.ready)await document.fonts.ready.catch(()=>undefined);
  });
}

/**
 * Open the Download-button href in a new tab, gate ASPI's html2pdf until assets
 * are ready, then capture the blob ASPI generates.
 */
async function captureAspHtml2PdfBlob(page:Page,url:string,timeout:number){
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
    await installHtml2PdfGate(report);

    const work=(async()=>{
      // Attachment responses: Playwright rejects goto ("Download is starting"). Catch that
      // so Promise.race can still resolve via the download event.
      const navigated=report.goto(url,{waitUntil:"domcontentloaded",referer:ACTIVITY_PAGE,timeout}).then(
        response=>({kind:"response" as const,response}),
        error=>({kind:"naverror" as const,error}),
      );
      const early=await Promise.race([
        pending.then(download=>({kind:"download" as const,download})),
        navigated,
      ]);
      if(early.kind==="download"){
        await navigated.catch(()=>undefined);
        return readOfficialDownload(early.download,url);
      }
      if(early.kind==="naverror"){
        const download=await pending;
        return readOfficialDownload(download,url);
      }

      const response=early.response;
      const current=new URL(report.url()),expected=new URL(url);
      if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.searchParams.get("activityId")!==expected.searchParams.get("activityId")){
        throw Error("Sesi ASPI dialihkan dari halaman laporan Download.");
      }
      if(response&&!response.ok())throw Error(`Laporan ASPI mengembalikan HTTP ${response.status()}.`);

      const contentType=String(response?.headers()["content-type"]??"").toLowerCase();
      if(contentType.includes("application/pdf")){
        const download=await pending;
        return readOfficialDownload(download,url);
      }

      if(await report.locator('input[type="password"],form[action*="login"],form[action*="sign-in"]').count()){
        throw Error("ASPI mengembalikan halaman login, bukan PDF resmi. Bukti belum berhasil diunduh.");
      }

      const hasPrintPdf=await report.locator("#printPdf").count();
      if(!hasPrintPdf){
        throw Error("Halaman Download ASPI tidak memuat #printPdf/html2pdf resmi. AutoSNAP menolak membuat PDF pengganti.");
      }

      await waitForPrintPdfAssets(report,Math.min(25000,timeout));

      // Replay ASPI's queued html2pdf(printPdf, opts) — same options the portal passed.
      const started=await report.evaluate(()=>{
        const w=window as Window&{
          __aspiAssetsReady?:boolean;
          __aspiQueuedHtml2Pdf?:{el:unknown;opts:unknown;real:(...args:unknown[])=>unknown};
        };
        w.__aspiAssetsReady=true;
        if(w.__aspiQueuedHtml2Pdf?.real){
          w.__aspiQueuedHtml2Pdf.real(w.__aspiQueuedHtml2Pdf.el,w.__aspiQueuedHtml2Pdf.opts);
          return "queued";
        }
        const download=(w as unknown as {download?:()=>void}).download;
        if(typeof download==="function"){
          download();
          return "download";
        }
        return null;
      });
      if(!started){
        throw Error("Fungsi download()/html2pdf resmi ASPI tidak tersedia. AutoSNAP tidak membuat PDF pengganti.");
      }

      const download=await pending;
      return readOfficialDownload(download,url);
    })();

    return await Promise.race([
      work,
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          expired=true;
          if(!settled){settled=true;fail(Error("Timeout menunggu blob PDF dari download() resmi ASPI."));}
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
    report.off("download",onDownload);
    settled=true;
    await report.close().catch(()=>undefined);
  }
}

/**
 * Official ASPI Download only — single path, no silent method switching.
 * Uses the same URL as the portal Download button (target=_blank href).
 * Never page.pdf(), never AutoSNAP-built PDF, never silent fallback.
 */
export async function downloadReportByNavigation(page:Page,url:string,timeout:number){
  const parsed=new URL(url);
  if(parsed.pathname!=="/sandboxactivity/downloadreportactivity"||!parsed.searchParams.get("activityId")){
    throw Error("URL Download ASPI tidak valid.");
  }
  return captureAspHtml2PdfBlob(page,url,timeout);
}
