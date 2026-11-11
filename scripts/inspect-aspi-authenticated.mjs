import process from "node:process";
import { DatabaseService } from "../backend/dist/database.service.js";
import { AspiSessionManager } from "../backend/dist/aspi-session-manager.js";
import { AspiFormResolver } from "../backend/dist/aspi-form-resolver.js";

process.loadEnvFile(".env.local");
const inspectBalance=process.argv.includes("--balance");
const inspectToken=process.argv.includes("--token");
const url=inspectBalance
  ? "https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry"
  : inspectToken
    ? "https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_access_token_b2b"
  : "https://apidevportal.aspi-indonesia.or.id/api-services/keamanan#/Keamanan/post_api_v1_0_utilities_signature_auth";
const pathNeedle=inspectBalance?"balance-inquiry":inspectToken?"access-token/b2b":"signature-auth";
const operationLabel=inspectBalance?"Balance Inquiry":inspectToken?"Access Token B2B":"Signature Auth";
const db=new DatabaseService();
await db.onModuleInit();
let release;
try{
  const user=await db.one("SELECT * FROM autosnap_records WHERE kind='snap_user' ORDER BY created_at LIMIT 1");
  if(!user)throw new Error("Master Data User SNAP belum tersedia.");
  const sessions=new AspiSessionManager();
  const acquired=await sessions.getAuthenticatedContext(user,"apidevportal.aspi-indonesia.or.id",async page=>{
    await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
    const button=page.locator('button[data-target="#sandBoxCollapse"]').first();
    if(await button.count()&&await button.getAttribute("aria-expanded")!=="true")await button.click();
    await page.waitForTimeout(1500);
    return await page.locator(".opblock:visible").count()>0;
  });
  release=acquired.release;
  const page=acquired.page;
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000});
  const panel=page.locator('button[data-target="#sandBoxCollapse"]').first();
  if(await panel.count()&&await panel.getAttribute("aria-expanded")!=="true")await panel.click();
  await page.waitForTimeout(1500);
  let scope=page;
  for(const frame of page.frames())if(await frame.locator(".opblock:visible").count()){scope=frame;break;}
  const operation=scope.locator(".opblock:visible").filter({has:scope.locator('.opblock-summary-path',{hasText:pathNeedle})}).first();
  if(!await operation.count()){
    const paths=[];
    for(const frame of page.frames())for(let index=0;index<await frame.locator(".opblock:visible .opblock-summary-path").count();index++)paths.push((await frame.locator(".opblock:visible .opblock-summary-path").nth(index).textContent())?.replace(/\s+/g," ").trim());
    const alert=(await page.locator("#sandBoxCollapse .alert").first().textContent().catch(()=>""))?.replace(/\s+/g," ").trim();
    throw new Error(`Operasi ${operationLabel} tidak terlihat setelah login. URL=${page.url()} paths=${JSON.stringify(paths)} alert=${alert||"none"}`);
  }
  if(!(await operation.getAttribute("class"))?.includes("is-open"))await operation.locator(".opblock-summary").click();
  await operation.locator(".opblock-body").waitFor({state:"visible",timeout:15000});
  const before=await operation.evaluate(element=>({
    className:element.getAttribute("class"),
    buttons:[...element.querySelectorAll("button")].map(item=>({text:(item.textContent??"").replace(/\s+/g," ").trim(),className:item.className,disabled:item.disabled})),
    fields:[...element.querySelectorAll("input,textarea,select")].map(item=>({placeholder:item.getAttribute("placeholder"),disabled:item.disabled,readOnly:"readOnly" in item?item.readOnly:false}))
  }));
  const tryButton=operation.locator("button.try-out__btn, .try-out button").first();
  const resolver=new AspiFormResolver();
  if(process.argv.includes("--resolver")){
    await resolver.activateTryOut(operation,inspectBalance?"/api/v1.0/balance-inquiry":inspectToken?"/api/v1.0/access-token/b2b":"/api/v1.0/utilities/signature-auth");
  }else if(await tryButton.count()&&await tryButton.isVisible())await tryButton.click();
  let simulation=null;
  if(inspectToken&&process.argv.includes("--simulate")){
    let dispatched=false;
    await page.context().route("**/api/v1.0/access-token/b2b",async route=>{
      dispatched=true;
      await route.fulfill({status:200,contentType:"application/json",body:'{"accessToken":"intercepted"}'});
    });
    await resolver.fillParameter(operation,"Content-Type","application/json");
    await resolver.fillParameter(operation,"X-TIMESTAMP","2026-11-11T01:42:17+07:00");
    await resolver.fillParameter(operation,"X-CLIENT-KEY","diagnostic-client");
    await resolver.fillParameter(operation,"X-SIGNATURE","diagnostic-signature");
    await resolver.fillBody(operation,{grantType:"client_credentials",additionalInfo:{}});
    const contentTypeBeforeExecute=!!(await operation.locator('input[placeholder^="Content-Type"]').inputValue().catch(()=>""));
    await operation.getByRole("button",{name:/^execute$/i}).first().click();
    await page.waitForTimeout(1000);
    simulation={dispatched,contentTypeBeforeExecute,errorElementCount:await operation.locator('.errors-wrapper,.validation-error,[role="alert"],.error,.invalid-feedback').count()};
    await page.context().unroute("**/api/v1.0/access-token/b2b");
  }
  await page.waitForTimeout(1000);
  const after=await operation.evaluate(element=>({
    className:element.getAttribute("class"),
    buttons:[...element.querySelectorAll("button")].map(item=>({text:(item.textContent??"").replace(/\s+/g," ").trim(),className:item.className,disabled:item.disabled})),
    fields:[...element.querySelectorAll("input,textarea,select")].map(item=>({tag:item.tagName.toLowerCase(),type:item.getAttribute("type"),className:item.className,placeholder:item.getAttribute("placeholder"),disabled:item.disabled,readOnly:"readOnly" in item?item.readOnly:false}))
  }));
  console.log(JSON.stringify({before,after,simulation},null,2));
}finally{
  await release?.();
  await db.onModuleDestroy();
}
