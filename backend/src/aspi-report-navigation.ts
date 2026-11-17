import type {Download,Page} from "playwright-core";
import {ACTIVITY_PAGE,validateOfficialPdf} from "./aspi-evidence";

/** Navigate like a browser download, rather than fetching an attachment through AJAX. */
export async function downloadReportByNavigation(page:Page,url:string,timeout:number){
  const report=await page.context().newPage();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let expired=false;
  try{
    const pending=new Promise<Download>(resolve=>report.once("download",resolve));
    const work=(async()=>{
      let response;
      try{response=await report.goto(url,{waitUntil:"domcontentloaded",referer:ACTIVITY_PAGE,timeout});}
      catch(error){
        // Chromium aborts document navigation when Content-Disposition is attachment.
        if(!(error instanceof Error)||!/ERR_ABORTED|Download is starting/i.test(error.message))throw error;
      }
      if(!response){
        const download=await pending;
        const actual=new URL(download.url()),expected=new URL(url);
        if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||actual.searchParams.get("activityId")!==expected.searchParams.get("activityId"))throw Error("URL laporan ASPI dialihkan.");
        const stream=await download.createReadStream();
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>15*1024*1024){stream.destroy();await download.cancel();throw Error("Laporan ASPI melebihi 15 MB.");}chunks.push(bytes);}
        return validateOfficialPdf(Buffer.concat(chunks));
      }
      const current=new URL(report.url()),expected=new URL(url);
      if(current.origin!==expected.origin||current.pathname!==expected.pathname||current.searchParams.get("activityId")!==expected.searchParams.get("activityId"))throw Error("Sesi ASPI dialihkan dari halaman laporan.");
      if(!response.ok())throw Error(`Laporan ASPI mengembalikan HTTP ${response.status()}.`);
      if(response.headers()["content-type"]?.includes("application/pdf"))return validateOfficialPdf(await response.body());
      if(await report.locator('input[type="password"],form[action*="login"],form[action*="sign-in"]').count())throw Error("ASPI mengembalikan halaman login, bukan laporan.");
      const text=await report.locator("body").innerText({timeout});
      if(!/request/i.test(text)||!/response/i.test(text))throw Error("Halaman ASPI bukan laporan hasil pengujian.");
      await report.emulateMedia({media:"print"});
      return validateOfficialPdf(await report.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:"12mm",bottom:"12mm",left:"12mm",right:"12mm"}}));
    })();
    return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error("Timeout navigasi/download laporan ASPI."));void report.close().catch(()=>undefined);},timeout);})]);
  }catch(error){if(expired)throw Error("Timeout navigasi/download laporan ASPI.");throw error;}
  finally{if(timer)clearTimeout(timer);await report.close().catch(()=>undefined);}
}
