import assert from "node:assert/strict";
import test from "node:test";
import {createRequire} from "node:module";
import {existsSync} from "node:fs";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
const require=createRequire(import.meta.url),{chromium}=require("playwright-core");
const chrome=[process.env.AUTOSNAP_CHROME_PATH,"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean).find(existsSync);

test("CAPTCHA widget handles script reuse, expiration, network errors and render exceptions without allowing submission",{skip:!chrome,timeout:30000},async()=>{
  const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const server=spawn(process.execPath,[require.resolve("next/dist/bin/next"),"start","--hostname","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:"ignore"});let browser;
  try{
    const base=`http://127.0.0.1:${port}`;
    for(let i=0;i<50;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    browser=await chromium.launch({executablePath:chrome,headless:true});const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/api/autosnap",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({loginRequired:true,recaptchaConfigured:true,recaptchaSiteKey:"fixture-site"})}));
    await page.route("https://www.google.com/recaptcha/api.js**",route=>route.fulfill({contentType:"text/javascript",body:"window.grecaptcha={render:function(target,options){window.captchaCallbacks=options;target.textContent='Captcha fixture';return 1;},reset:function(){}};"}));
    await page.goto(base);const signup=()=>page.getByRole("button",{name:"Belum punya akun? Daftar",exact:true}).click();await signup();await page.getByText("Captcha fixture",{exact:true}).waitFor();
    const submit=page.getByRole("button",{name:"Daftar",exact:true});assert.equal(await submit.isDisabled(),true);
    await page.evaluate(()=>window.captchaCallbacks.callback("fixture-token"));await page.waitForFunction(()=>!document.querySelector(".auth-card .primary-button").disabled);
    await page.evaluate(()=>window.captchaCallbacks["expired-callback"]());await page.getByText("Verifikasi kedaluwarsa. Centang kembali reCAPTCHA.",{exact:true}).waitFor();assert.equal(await submit.isDisabled(),true);
    await page.evaluate(()=>window.captchaCallbacks["error-callback"]());await page.getByRole("alert").filter({hasText:"Google reCAPTCHA gagal memverifikasi"}).waitFor();assert.equal(await submit.isDisabled(),true);
    await page.getByRole("button",{name:"Kembali ke halaman masuk",exact:true}).click();await signup();await page.getByText("Captcha fixture",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Kembali ke halaman masuk",exact:true}).click();await page.evaluate(()=>{window.grecaptcha.render=()=>{throw Error("fixture invalid key");};});await signup();await page.getByRole("alert").filter({hasText:"reCAPTCHA tidak dapat ditampilkan"}).waitFor();assert.equal(await submit.isDisabled(),true);assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();}
});
