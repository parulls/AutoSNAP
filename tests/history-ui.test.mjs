import assert from "node:assert/strict";
import test from "node:test";
import {existsSync} from "node:fs";
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
const require=createRequire(import.meta.url),{chromium}=require("playwright-core");
const chrome=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);

test("Refresh clears filled testing form and response, retains history, and both pages send date filters",{skip:!chrome,timeout:45000},async()=>{
  const portProbe=createServer();portProbe.listen(0,"127.0.0.1");await once(portProbe,"listening");const port=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
  const server=spawn(process.execPath,[require.resolve("next/dist/bin/next"),"start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:"ignore"});
  let browser;
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,150));}assert.ok(ready,"production web server must start");
    browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage();
    const records=[{id:"user",kind:"snap_user",name:"User SNAP QA",data:{}},{id:"client",kind:"client",name:"Client QA",partnerId:"client-key",data:{clientId:"client-key",clientSecret:"fixture-secret",privateKey:"fixture-key",channelId:"95221"}},{id:"project",kind:"project",name:"Project QA",parentId:"client",data:{}},{id:"site",kind:"environment",name:"Dev Site QA",parentId:"project",data:{mode:"portal",category:"Dev Site",defaultUserId:"user"}},{id:"endpoint",kind:"endpoint",name:"Balance Inquiry",data:{method:"POST",path:"/api/v1.0/balance-inquiry",portalUrl:"https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo"}},{id:"service",kind:"service",name:"Balance Inquiry",parentId:"endpoint",data:{module:"Informasi Saldo",code:"11"}}];
    const run={id:"new-run",operator_id:"operator",environment_id:"site",service_id:"service",endpoint_id:"endpoint",user_id:"user",mode:"portal",status:"Passed",http_status:200,response_code:"2001100",duration_ms:50,created_at:new Date().toISOString(),request:{context:{service:"Balance Inquiry",environment:"Dev Site QA"}},response:{responseCode:"2001100",responseMessage:"Successful"}};
    let ran=false;const historyRequests=[];
    await page.route("**/api/autosnap",async route=>{
      const body=route.request().method()==="POST"?route.request().postDataJSON():{},action=body.action;
      let data;
      if(!action)data={user:{id:"operator",username:"qa",role:"admin",active:true},records,runs:ran?[run]:[],scenarios:[]};
      else if(action==="getHistory"){historyRequests.push(body);data={runs:ran?[run]:[],total:ran?1:0,summary:{total:ran?1:0,dev:ran?1:0,simulator:0,passed:ran?1:0,failed:0,errors:0,cancelled:0}};}
      else if(action==="run"){ran=true;data={id:run.id,status:"Passed",httpStatus:200};}
      else if(action==="getProgress")data={status:"completed",stage:"finished",steps:[]};
      else throw Error(`Unexpected test action ${action}`);
      await route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    });
    await page.goto(base);await page.getByRole("navigation").getByRole("button",{name:"Dev Site Client",exact:true}).click();
    const choose=async()=>{for(const [label,id] of [["User SNAP","user"],["Dev Site Client","site"],["Endpoint URL","endpoint"],["API Service","service"]])await page.getByRole("combobox",{name:label,exact:true}).selectOption(id);};
    await choose();await page.getByLabel("Request Body",{exact:true}).fill('{"accountNo":"edited-draft"}');await page.getByRole("button",{name:"Jalankan Testing",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Tutup",exact:true}).click();
    await page.locator(".response-card").getByText("2001100",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Refresh",exact:true}).click();
    for(const label of ["User SNAP","Dev Site Client","Endpoint URL","API Service"])assert.equal(await page.getByRole("combobox",{name:label,exact:true}).inputValue(),"");
    assert.equal(await page.locator("textarea").count(),0);assert.doesNotMatch(await page.locator(".response-card").innerText(),/2001100/);
    await choose();assert.doesNotMatch(await page.getByLabel("Request Body",{exact:true}).inputValue(),/edited-draft/);assert.doesNotMatch(await page.locator(".response-card").innerText(),/2001100/);
    await page.getByLabel("Periode",{exact:true}).selectOption("custom");await page.getByLabel("Dari tanggal").fill("2025-01-01");
    const filtered=page.waitForResponse(response=>response.url().endsWith("/api/autosnap")&&response.request().postDataJSON()?.to==="2025-01-05");
    await page.getByLabel("Sampai tanggal").fill("2025-01-05");await filtered;
    assert.ok(historyRequests.some(item=>item.from==="2025-01-01"&&item.to==="2025-01-05"&&item.mode==="dev_site"));assert.equal(ran,true,"refresh must retain saved history");
    await page.getByRole("navigation").getByRole("button",{name:"Dashboard",exact:true}).click();
    const dashboard=page.waitForResponse(response=>response.url().endsWith("/api/autosnap")&&response.request().postDataJSON()?.mode==="all");
    await page.getByLabel("Periode",{exact:true}).selectOption("month");await dashboard;
    assert.ok(historyRequests.some(item=>item.mode==="all"&&item.from.endsWith("-01")));
  }finally{await browser?.close();server.kill();}
});
