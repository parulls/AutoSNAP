import assert from "node:assert/strict";
import test from "node:test";
import {existsSync} from "node:fs";
import {createRequire} from "node:module";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
const require=createRequire(import.meta.url),{chromium}=require("playwright-core");
const chrome=["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);

test("admin saves HTTP-only service and headless UI shows COMPLETED without an error dialog",{skip:!chrome,timeout:45000},async()=>{
  const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const server=spawn(process.execPath,[require.resolve("next/dist/bin/next"),"start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:"ignore"});let browser;
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,150));}assert.ok(ready);
    browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    const records=[{id:"snap",kind:"snap_user",name:"QA SNAP",data:{}},{id:"client",kind:"client",name:"QA Client",partnerId:"partner",data:{clientId:"fixture",clientSecret:"fixture",privateKey:"fixture",channelId:"95221"}},{id:"project",kind:"project",parentId:"client",name:"QA Project",data:{}},{id:"site",kind:"environment",name:"QA Dev Site",parentId:"project",data:{category:"Dev Site",mode:"portal",defaultUserId:"snap"}}];
    const url="https://apidevportal.aspi-indonesia.or.id/api-services/transfer-kredit/virtual-account#/VirtualAccount/put_api_v1_0_transfer_va_update_va";
    const draft={name:"Update VA",module:"Transfer Kredit",code:"28",method:"PUT",path:"/api/v1.0/transfer-va/update-va",portalUrl:url,requestBody:'{"virtualAccountNo":"123"}',config:{version:1,sourceUrl:url,operationId:"updateVA",authFlow:"unknown",reviewed:false,expectedHttpStatus:200,expectedCode:null,warnings:[],parameters:[{name:"merchantId",in:"query",required:true}],requestSchema:{type:"object",required:["virtualAccountNo"],properties:{virtualAccountNo:{type:"string"}}},responses:{}}};
    let runs=0;
    const evaluation={mode:"HTTP_ONLY",snapValidationPerformed:false,outcome:"COMPLETED",stage:"evaluation",stageLabel:"Validasi HTTP",detail:"HTTP 200 sesuai expected 200. Pengumpulan bukti PDF belum selesai.",suggestion:"",httpValidation:{expectedStatus:200,actualStatus:200,performed:true,matches:true,source:"target_api"}};
    const run={id:"fixture",operator_id:"admin",environment_id:"site",service_id:"service",endpoint_id:"endpoint",user_id:"snap",mode:"portal",status:"COMPLETED",http_status:200,response_code:"2002800",expected_code:null,duration_ms:30,created_at:new Date().toISOString(),request:{outcome:"COMPLETED",evaluation,pdfCounts:{ready:0,required:4},reprocess:{retryEvidence:true,resumeTesting:false},context:{service:"Update VA",environment:"QA Dev Site"}},response:{responseCode:"2002800",responseMessage:"Actual fixture"}};
    await page.route("**/api/autosnap",async route=>{
      const input=route.request().method()==="POST"?route.request().postDataJSON():{};let data;
      if(!input.action)data={user:{id:"admin",username:"qa",role:"admin",active:true},records,runs:runs?[run]:[],scenarios:[]};
      else if(input.action==="getHistory")data={runs:runs?[{...run,operator:{id:"admin",name:"QA",username:"qa",role:"admin",mine:true,source:"snapshot"}}]:[],total:runs?1:0,summary:{total:runs?1:0,dev:runs?1:0,simulator:0,passed:0,completed:runs?1:0,failed:0,errors:0,cancelled:0,running:0},byOperator:runs?[{operator_id:"admin",name:"QA",username:"qa",role:"admin",total:1,passed:0,failed:0,completed:1}]:[],scope:"all"};
      else if(input.action==="inspectDocumentation"){assert.equal(input.url,url);await new Promise(resolve=>setTimeout(resolve,250));data=draft;}
      else if(input.action==="saveImportedService"){
        assert.equal(input.draft.config.authFlow,"b2b");assert.equal(input.draft.config.reviewed,true);assert.equal(input.draft.config.expectedCode,null,"optional expected stays null when saved");
        records.push({id:"endpoint",kind:"endpoint",name:"Update VA",data:{method:"PUT",path:draft.path,portalUrl:url}},{id:"service",kind:"service",parentId:"endpoint",name:"Update VA",data:{module:draft.module,code:"28",requestBody:draft.requestBody,config:input.draft.config}});data={ok:true};
      }else if(input.action==="getProgress")data={status:"completed",stage:"finished",steps:[{stage:"evaluation",status:"completed",detail:"COMPLETED — HTTP 200 sesuai expected 200."}]};
      else if(input.action==="run"){runs++;assert.equal(input.serviceId,"service");assert.equal(input.parameters.merchantId,"merchant-qa");assert.equal(JSON.parse(input.body).virtualAccountNo,"456");data={id:"fixture",status:"COMPLETED",outcome:"COMPLETED",evaluation,httpStatus:200,responseCode:"2002800",expectedCode:null,pdfCounts:{ready:0,required:4},reprocess:{retryEvidence:true}};}
      else if(input.action==="aspiBusy")data={busyUserIds:[]};
      else throw Error(`Unexpected UI action ${input.action}`);
      return route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    });
    await page.goto(base);await page.getByRole("navigation").getByRole("button",{name:"Master Data",exact:true}).click();
    assert.equal(await page.getByRole("tab",{name:"API Service",exact:true}).count(),0);
    await page.getByRole("tab",{name:"Dev Site Endpoint",exact:true}).click();await page.getByRole("button",{name:"Tambah",exact:true}).click();
    const dialog=page.getByRole("dialog");
    assert.equal(await dialog.getByRole("combobox",{name:"User SNAP untuk sesi portal"}).count(),0,"single SNAP user is selected automatically");
    assert.equal(await dialog.getByRole("combobox",{name:"Referensi layanan"}).count(),0,"no hardcoded service reference picker");
    await dialog.getByLabel("URL operasi ASPI").fill(url);await dialog.getByRole("button",{name:"Baca dokumentasi"}).click();
    await dialog.getByRole("status").waitFor();assert.equal(await dialog.getByLabel("URL operasi ASPI").isDisabled(),true);
    await dialog.getByLabel("Template request dari ASPI").waitFor();
    assert.equal(await dialog.getByLabel("Template request dari ASPI").inputValue(),draft.requestBody);assert.equal(await dialog.getByLabel("Template request dari ASPI").getAttribute("readonly"),"");
    assert.equal(await dialog.getByText("Default Request Body",{exact:true}).count(),0);
    await dialog.getByLabel("Autentikasi import").selectOption("b2b");
    const confirmation=dialog.locator(".documentation-confirmation").filter({hasText:"Saya telah meninjau"}),checkbox=confirmation.getByRole("checkbox");
    for(const width of [1200,390]){
      await page.setViewportSize({width,height:900});await checkbox.scrollIntoViewIfNeeded();
      const box=await checkbox.boundingBox(),label=await confirmation.locator("span").boundingBox();
      assert.ok(box.width>=15&&box.width<=17&&box.height>=15&&box.height<=17,"checkbox stays compact despite global input styles");
      assert.ok(label.x>=box.x+box.width+8,"confirmation text stays beside checkbox");
      assert.ok(label.y<=box.y+3&&label.y>=box.y-4,"checkbox aligns with first text line");
      assert.equal(await confirmation.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,"confirmation has no horizontal overflow");
      assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,"modal has no horizontal overflow");
      await page.screenshot({path:`.next/documentation-modal-${width}.png`});
      const footer=await dialog.locator("footer").boundingBox();assert.ok(footer.y+footer.height<=900,`actions stay visible while content scrolls: ${JSON.stringify({width,footer,modal:await dialog.boundingBox()})}`);
    }
    await confirmation.locator("span").click();assert.equal(await checkbox.isChecked(),true);
    await checkbox.focus();await page.keyboard.press("Space");assert.equal(await checkbox.isChecked(),false);
    await page.keyboard.press("Space");assert.equal(await checkbox.isChecked(),true);
    await page.setViewportSize({width:1200,height:900});
    await dialog.getByText("Pengaturan lanjutan",{exact:true}).click();
    const advanced=dialog.getByLabel("Konfigurasi endpoint (JSON)");await advanced.fill("{invalid");
    await dialog.getByRole("button",{name:"Terapkan JSON",exact:true}).click();
    assert.equal(await dialog.getByRole("alert").count(),1);assert.equal(await advanced.inputValue(),"{invalid","invalid edits stay editable without losing the imported draft");
    await advanced.fill(JSON.stringify({...draft,config:{...draft.config,authFlow:"b2b"}}));
    await dialog.getByRole("button",{name:"Terapkan JSON",exact:true}).click();
    await checkbox.check();
    await dialog.getByRole("button",{name:"Simpan",exact:true}).click();await dialog.waitFor({state:"hidden"});
    await page.getByRole("navigation").getByRole("button",{name:"Dev Site Client",exact:true}).click();
    for(const [label,id]of [["User SNAP","snap"],["Dev Site Client","site"],["Dev Site Endpoint","endpoint"],["API Service","service"]])await page.getByRole("combobox",{name:label,exact:true}).selectOption(id);
    assert.equal(JSON.parse(await page.getByLabel("Request Body",{exact:true}).inputValue()).virtualAccountNo,"123");
    await page.getByLabel(/merchantId \(query\)/).fill("merchant-qa");await page.getByLabel("virtualAccountNo *",{exact:true}).fill("456");await page.getByRole("button",{name:"Jalankan Testing",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:"Tutup",exact:true}).click();assert.equal(runs,1);
    assert.equal(await page.getByRole("alertdialog").count(),0,"COMPLETED is not a validation error");
    const result=page.locator(".response-card");await result.getByText("Outcome: COMPLETED",{exact:true}).waitFor();
    assert.match(await result.innerText(),/Validasi HTTP|HTTP Only/);assert.match(await result.locator("pre").innerText(),/2002800/);
    await result.screenshot({path:".next/completed-http-result.png"});
    await page.locator(".history-card tbody").getByText("COMPLETED",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Detail Testing",exact:true}).click();await page.locator(".run-modal").getByText("Outcome: COMPLETED",{exact:true}).waitFor();await page.locator(".run-modal").getByRole("button",{name:"Tutup",exact:true}).click();
    await page.getByRole("navigation").getByRole("button",{name:"Dashboard",exact:true}).click();await page.locator(".dashboard-history .status-badge.completed, .dashboard-grid .status-badge.completed").filter({hasText:"COMPLETED"}).first().waitFor();assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();}
});
