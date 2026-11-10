import { Injectable } from "@nestjs/common";
import type { Frame, Locator, Page } from "playwright-core";
import { AspiAutomationError } from "./aspi-types";

export function normalizedParameterName(entry:string){
  const cleaned=entry.replaceAll("\u200B","").replace(/\s+/g," ").trim();
  // Swagger menaruh bantuan setelah " - ", misalnya
  // "X-CLIENT-KEY - Please use your client id". Bantuan bukan bagian nama field.
  const prefix=cleaned.split(/\s*\*\s*|\s+required\b|\s+string\b|\s+\(header\)|\s+-\s+/i,1)[0];
  return prefix.replace(/\s*-\s*/g,"-").replace(/\s+/g,"").toUpperCase();
}
type Scope=Page|Frame;
const optional=new Set(["Authorization-Customer","X-DEVICE-ID","ORIGIN","X-IP-ADDRESS","X-LATITUDE","X-LONGITUDE"]);

@Injectable()
export class AspiFormResolver{
  async scope(page:Page):Promise<Scope>{
    if(await page.locator(".opblock:visible").count())return page;
    for(const frame of page.frames())if(frame!==page.mainFrame()&&await frame.locator(".opblock:visible").count())return frame;
    throw new AspiAutomationError("FORM_NOT_READY","Swagger Aplikasi Pengujian belum siap.",{iframeCount:page.frames().length-1});
  }
  async operation(page:Page,path:string,method:string){
    const scope=await this.scope(page),operations=scope.locator(".opblock:visible");
    const count=await operations.count(),available:string[]=[];
    for(let i=0;i<count;i++){
      const item=operations.nth(i),shown=((await item.locator(".opblock-summary-path").textContent().catch(()=>""))??"").replaceAll("\u200B","").trim();
      const shownMethod=((await item.locator(".opblock-summary-method").textContent().catch(()=>""))??"").trim().toUpperCase();
      available.push(`${shownMethod} ${shown}`.trim());
      if(this.samePath(shown,path)&&(!shownMethod||shownMethod===method.toUpperCase()))return {scope,operation:item};
    }
    throw new AspiAutomationError("FORM_NOT_READY",`Operasi ${method.toUpperCase()} ${path} tidak ditemukan.`,{availableOperations:available,iframeCount:page.frames().length-1});
  }
  async activateTryOut(operation:Locator,path:string){
    const button=operation.locator("button.try-out__btn, .try-out button").first();
    const hasButton=await button.count()>0;
    if(hasButton&&await button.isVisible()){
      const text=((await button.textContent())??"").trim();
      if(/try\s*it\s*out/i.test(text))await button.click();
    }
    for(let attempt=0;attempt<40;attempt++){
      const state=hasButton?((await button.textContent().catch(()=>""))??"").trim():"";
      // Swagger mengganti label menjadi Cancel hanya setelah mode edit aktif.
      if(/cancel/i.test(state))return;
      // Sebagian versi Swagger mempertahankan label tombol. Dalam varian itu,
      // pastikan parameter header bernama (bukan sekadar editor body) aktif.

for (let attempt = 0; attempt < 40; attempt++) {
  const state = hasButton
    ? (await button.textContent().catch(() => ""))?.trim() ?? ""
    : "";

  if (hasButton) {
    if (/^cancel$/i.test(state)) return;
  } else {
    const controls = operation.locator(
      'input:not([type="hidden"]):not([disabled]), ' +
      'textarea:not([disabled]), ' +
      'select:not([disabled])'
    );

    if (await controls.count()) return;
  }

  await operation.page().waitForTimeout(250);
}

throw new AspiAutomationError(
  "FORM_NOT_READY",
  `Try it out belum aktif untuk ${path}.`,
  await this.diagnostic(operation)
);
      // Fallback untuk varian Swagger yang tidak menyediakan tombol tersebut.
      if(!hasButton){
        const controls=operation.locator("input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])");
        if(await controls.count())return;
      }
      await operation.page().waitForTimeout(250);
    }
    throw new AspiAutomationError("FORM_NOT_READY",`Form ${path} belum editable setelah Try it out.`,await this.diagnostic(operation));
  }
  async fillParameter(operation:Locator,name:string,value:string){
    const expected=normalizedParameterName(name),controls=await this.controls(operation),match=controls.find(item=>item.names.includes(expected));
    if(!match){if(optional.has(name))return {state:"optional-missing" as const};throw new AspiAutomationError("FORM_FIELD_NOT_FOUND",`Field ${name} tidak ditemukan pada form Aplikasi Pengujian ASPI.`,await this.diagnostic(operation,{requested:name}));}
    let disabled=await match.control.isDisabled().catch(()=>false),readonly=(await match.control.getAttribute("readonly"))!==null;
    // DOM Swagger kadang baru mengaktifkan parameter beberapa saat sesudah
    // tombol Try it out diklik. Coba aktifkan ulang secara sah, tanpa memaksa DOM.
    if((disabled||readonly)&&expected!=="CONTENT-TYPE"){
      const tryOut=operation.locator("button.try-out__btn, .try-out button").first();
      const label=((await tryOut.textContent().catch(()=>""))??"").trim();
      if(/try\s*it\s*out/i.test(label)){
        await tryOut.click();
        await match.control.waitFor({state:"visible",timeout:5000}).catch(()=>undefined);
        for(let attempt=0;attempt<20&&await match.control.isDisabled().catch(()=>true);attempt++)await operation.page().waitForTimeout(250);
        disabled=await match.control.isDisabled().catch(()=>false);readonly=(await match.control.getAttribute("readonly"))!==null;
      }
    }
    if(disabled||readonly){
      if(expected==="CONTENT-TYPE"&&value.toLowerCase()==="application/json")return {state:"swagger-managed" as const};
      throw new AspiAutomationError("FORM_FIELD_DISABLED",`Field ${name} ditemukan tetapi ${disabled?"disabled":"readonly"}; nilai tidak dipaksa melalui DOM.`,await this.diagnostic(operation,{requested:name}));
    }
    if(!await match.control.isEditable().catch(()=>false))throw new AspiAutomationError("FORM_FIELD_DISABLED",`Field ${name} tidak editable.`,await this.diagnostic(operation,{requested:name}));
    if(await match.control.evaluate(element=>element.tagName.toLowerCase()==="select"))await match.control.selectOption({label:value}).catch(()=>match.control.selectOption(value));else await match.control.fill(value);
    return {state:"filled" as const};
  }
  async fillBody(operation:Locator,body:Record<string,unknown>){
    const input=operation.locator("textarea.body-param__text, .body-param textarea, textarea").last();
    if(!await input.count())throw new AspiAutomationError("FORM_FIELD_NOT_FOUND","Editor request body tidak ditemukan.",await this.diagnostic(operation));
    if(!await input.isEditable().catch(()=>false))throw new AspiAutomationError("FORM_FIELD_DISABLED","Editor request body tidak editable setelah Try it out.",await this.diagnostic(operation));
    await input.fill(JSON.stringify(body,null,2));
  }
  async diagnostic(operation:Locator,extra:Record<string,unknown>={}){
    const fields=[] as Record<string,unknown>[],controls=operation.locator("input:not([type='hidden']),textarea,select"),count=await controls.count();
    for(let i=0;i<count;i++){const input=controls.nth(i);fields.push({name:await input.getAttribute("name"),placeholder:await input.getAttribute("placeholder"),ariaLabel:await input.getAttribute("aria-label"),visible:await input.isVisible().catch(()=>false),enabled:await input.isEnabled().catch(()=>false),editable:await input.isEditable().catch(()=>false),disabled:await input.isDisabled().catch(()=>false),readonly:(await input.getAttribute("readonly"))!==null});}
    const tryOut=operation.locator("button.try-out__btn, .try-out button").first(),tryOutLabel=((await tryOut.textContent().catch(()=>""))??"").trim();
    return {...extra,tryItOutActive:/cancel/i.test(tryOutLabel),tryItOutLabel:tryOutLabel||null,fields};
  }
  private samePath(shown:string,expected:string){const normalize=(entry:string)=>entry.replaceAll("\u200B","").trim().replace("/v1.0/","/v1/");return normalize(shown)===normalize(expected);}
  private async controls(operation:Locator){
    const output:{control:Locator;names:string[]}[]=[],controls=operation.locator("input:not([type='hidden']),textarea,select"),count=await controls.count();
    for(let i=0;i<count;i++){
      const control=controls.nth(i);if(!await control.isVisible().catch(()=>false))continue;
      const direct=[await control.getAttribute("name"),await control.getAttribute("placeholder"),await control.getAttribute("aria-label"),await control.getAttribute("data-param-name")].filter((item):item is string=>!!item);
      // Atribut kontrol adalah sumber tercepat dan paling stabil pada Swagger ASPI.
      // Baca teks row hanya bila atribut belum memberikan nama yang dapat dipakai.
      const directNames=[...new Set(direct.map(normalizedParameterName).filter(Boolean))];
      if(directNames.length){output.push({control,names:directNames});continue;}
      const row=control.locator("xpath=ancestor::*[self::tr or contains(@class,'parameter__item') or contains(@class,'parameters')][1]");
      const label=await row.count()?await row.locator(".parameters-col_name,.parameter__name,label,dt,th,td:first-child").first().textContent().catch(()=>""):"";
      const descriptors=[label,...direct].filter((item):item is string=>!!item);
      output.push({control,names:[...new Set(descriptors.map(normalizedParameterName).filter(Boolean))]});
    }
    return output;
  }
}
