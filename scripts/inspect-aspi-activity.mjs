import process from "node:process";
import { DatabaseService } from "../backend/dist/database.service.js";
import { AspiSessionManager } from "../backend/dist/aspi-session-manager.js";

process.loadEnvFile(".env.local");
const url="https://apidevportal.aspi-indonesia.or.id/aktivitas-aplikasi-pengujian";
const db=new DatabaseService();
await db.onModuleInit();
let release;
try{
  const user=await db.one("SELECT * FROM autosnap_records WHERE kind='snap_user' ORDER BY created_at LIMIT 1");
  if(!user)throw new Error("Master Data User SNAP belum tersedia.");
  const sessions=new AspiSessionManager();
  const acquired=await sessions.getAuthenticatedContext(user,"apidevportal.aspi-indonesia.or.id",async page=>{
    await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
    return !page.url().includes("/sign-in");
  });
  release=acquired.release;
  const page=acquired.page;
  await page.goto(url,{waitUntil:"networkidle",timeout:60000}).catch(()=>undefined);
  await page.waitForTimeout(1500);
  const result=await page.evaluate(()=>{
    const clean=value=>(value??"").replace(/\s+/g," ").trim();
    const tables=[...document.querySelectorAll("table")].map(table=>({
      headers:[...table.querySelectorAll("thead th")].map(cell=>clean(cell.textContent)),
      rowCount:table.querySelectorAll("tbody tr").length,
      firstRow:[...table.querySelectorAll("tbody tr:first-child td")].map((cell,index)=>({
        index,
        textLength:clean(cell.textContent).length,
        links:[...cell.querySelectorAll("a")].map(link=>({text:clean(link.textContent),href:link.getAttribute("href")})),
        buttons:[...cell.querySelectorAll("button")].map(button=>({text:clean(button.textContent),name:button.getAttribute("name"),valuePresent:!!button.getAttribute("value"),data:{...button.dataset}})),
        inputs:[...cell.querySelectorAll("input")].map(input=>({name:input.name,type:input.type,valuePresent:!!input.value}))
      }))
    }));
    const forms=[...document.querySelectorAll("form")].map(form=>({action:form.getAttribute("action"),method:form.getAttribute("method"),fields:[...form.querySelectorAll("input,select")].map(input=>({name:input.getAttribute("name"),type:input.getAttribute("type"),valuePresent:!!input.value}))}));
    return {url:location.href,title:document.title,tables,forms};
  });
  let downloadVerification=null;
  if(process.argv.includes("--verify-download")){
    const href=await page.locator('a[href*="downloadreportactivity?activityId="]').first().getAttribute("href");
    if(href){
      const response=await acquired.context.request.get(new URL(href,page.url()).toString(),{failOnStatusCode:false,maxRedirects:0,timeout:60000});
      const body=await response.body();
      const contentType=response.headers()["content-type"]??null;
      downloadVerification={status:response.status(),contentType,contentDisposition:response.headers()["content-disposition"]??null,bytes:body.length};
      if(String(contentType).includes("text/html")){
        const reportPage=await acquired.context.newPage();
        await reportPage.goto(new URL(href,page.url()).toString(),{waitUntil:"networkidle",timeout:60000}).catch(()=>undefined);
        downloadVerification.page=await reportPage.evaluate(()=>({
          url:location.href,
          title:document.title,
          embeds:[...document.querySelectorAll("iframe,embed,object")].map(item=>({tag:item.tagName.toLowerCase(),src:item.getAttribute("src")??item.getAttribute("data"),type:item.getAttribute("type")})),
          links:[...document.querySelectorAll("a")].map(item=>({text:(item.textContent??"").replace(/\s+/g," ").trim(),href:item.getAttribute("href")})).filter(item=>/pdf|download|print/i.test(`${item.text} ${item.href}`)),
          buttons:[...document.querySelectorAll("button")].map(item=>({text:(item.textContent??"").replace(/\s+/g," ").trim(),type:item.getAttribute("type")}))
        }));
        const rendered=await reportPage.pdf({format:"A4",printBackground:true,preferCSSPageSize:true,margin:{top:"12mm",right:"12mm",bottom:"12mm",left:"12mm"}});
        downloadVerification.renderedPdf={valid:rendered.subarray(0,4).toString()==="%PDF",bytes:rendered.length};
        await reportPage.close();
      }
    }
  }
  console.log(JSON.stringify({...result,downloadVerification},null,2));
}finally{
  await release?.();
  await db.onModuleDestroy();
}
