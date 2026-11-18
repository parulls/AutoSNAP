import {Injectable} from "@nestjs/common";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {sha256} from "./security";
import type {Page,Response as BrowserResponse} from "playwright-core";
import {AspiSessionManager} from "./aspi-session-manager";
import type {RecordRow} from "./database.service";
import {documentationUrl,parseOperation,supplementSnippets} from "./swagger-import";

type Draft=ReturnType<typeof parseOperation>;
const CACHE_MS=5*60_000,CACHE_LIMIT=40,READ_TIMEOUT_MS=12_000;

@Injectable()
export class DocumentationReader{
  private readonly cache=new Map<string,{expires:number;draft:Draft}>();
  private readonly pending=new Map<string,Promise<Draft>>();
  private catalog?:Promise<Record<string,unknown>[]>;
  constructor(private readonly sessions:AspiSessionManager){}

  async inspect(user:RecordRow,urlText:string){
    const url=documentationUrl(urlText);
    // Separate users and credential revisions. Never cache credentials or browser sessions.
    const key=sha256(JSON.stringify([user.id,user.updated_at,user.data.email,user.data.username,user.data.password,url.toString()]));
    const cached=this.cache.get(key);
    if(cached&&cached.expires>Date.now())return structuredClone(cached.draft);
    if(cached)this.cache.delete(key);
    let pending=this.pending.get(key);
    if(!pending){
      pending=this.read(user,url).then(draft=>{
        for(const [id,entry]of this.cache)if(entry.expires<=Date.now())this.cache.delete(id);
        if(this.cache.size>=CACHE_LIMIT)this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key,{expires:Date.now()+CACHE_MS,draft:structuredClone(draft)});
        return draft;
      });
      this.pending.set(key,pending);
    }
    try{return structuredClone(await pending);}finally{if(this.pending.get(key)===pending)this.pending.delete(key);}
  }

  private async read(user:RecordRow,url:URL):Promise<Draft>{
    const catalog=await(this.catalog??=readFile(join(process.cwd(),"app","snap-spec-catalog.json"),"utf8").then(JSON.parse));
    const specs:unknown[]=[];
    const operationId=decodeURIComponent(url.hash.split("/").at(-1)??"");
    const attached=new WeakSet<Page>();
    let result:Draft|undefined;
    const capture=(response:BrowserResponse)=>{
      if(response.request().method()!=="GET"||!response.headers()["content-type"]?.includes("json")||specs.length>=8)return;
      void(async()=>{try{
        if(Number(response.headers()["content-length"])>2_000_000)return;
        const text=await response.text();if(text.length>2_000_000)return;
        const value=JSON.parse(text);if(value?.paths&&specs.length<8)specs.push(value);
      }catch{/* Not a readable Swagger response. */}})();
    };
    const session=await this.sessions.getAuthenticatedContext(user,url.hostname,async page=>{
      if(!attached.has(page)){
        attached.add(page);page.on("response",capture);
        // Read-only from the FIRST page load. Only official login may POST.
        await page.context().route("**/*",route=>{
          const request=route.request(),target=new URL(request.url()),method=request.method();
          if(["image","font","media"].includes(request.resourceType()))return route.abort();
          if(target.protocol!=="https:"||/^\/api\//i.test(target.pathname))return route.abort();
          const login=method==="POST"&&target.origin===url.origin&&/^\/(?:sign-in|account\/login|account\/sign-in)\/?$/i.test(target.pathname);
          if(!["GET","HEAD"].includes(method)&&!login)return route.abort();
          // ASPI serves Swagger JSON on the SAME hostname with a separate HTTPS port.
          // Permit that exact document class, not API paths or arbitrary cross-origin XHR.
          const swagger=method==="GET"&&target.hostname===url.hostname&&/^\/swagger\/[\w./-]+\.json$/i.test(target.pathname);
          if(target.origin!==url.origin&&!swagger&&!["script","stylesheet"].includes(request.resourceType()))return route.abort();
          return route.fallback();
        });
      }
      await page.goto(url.toString(),{waitUntil:"domcontentloaded",timeout:30_000});
      const deadline=Date.now()+READ_TIMEOUT_MS;
      let panelOpened=false;
      do{
        if(/\/sign-in(?:\/|$)/i.test(new URL(page.url()).pathname)||await page.locator('input[type="password"]:visible').count())return false;
        for(const spec of specs){try{result=parseOperation(spec,url.toString(),catalog);return true;}catch{/* Other operation/document. */}}
        // Swagger state often arrives before the visible panel: no opblock wait is needed.
        const frames=await Promise.all(page.frames().map(frame=>frame.evaluate(readFrame,operationId).catch(()=>null)));
        for(const data of frames){
          if(!data)continue;
          for(const spec of data.specs){try{result=parseOperation(spec,url.toString(),catalog);return true;}catch{/* Other operation/document. */}}
          if(data.rendered){
            try{
              result=parseOperation(data.rendered,url.toString(),catalog);
              result.config.warnings.push("Dokumentasi form/sample: schema dan required body belum dapat dipastikan.");
              // A partially rendered form is not proof that a POST has no body.
              if(!["GET","HEAD"].includes(result.method))result.config.requestBodyMode="required";
              return true;
            }catch{/* Swagger is still rendering. */}
          }
        }
        const signIn=page.getByRole("link",{name:/^sign\s*in$|^login$|^masuk$/i}).first();
        if(await signIn.isVisible().catch(()=>false))return false;
        if(!panelOpened){
          const panel=page.locator('button[data-target="#sandBoxCollapse"]').first();
          if(await panel.isVisible().catch(()=>false)){
            panelOpened=true;
            if(await panel.getAttribute("aria-expanded")!=="true")await panel.click({timeout:1500});
          }
        }
        await page.waitForTimeout(150);
      }while(Date.now()<deadline);
      // An unreadable schema is not evidence that valid portal credentials are wrong.
      return true;
    });
    try{
      if(result){
        const snippets=session.page.locator("#codeSnippetsCollapse");
        if(await snippets.count())supplementSnippets(result,await snippets.textContent()??"");
        return result;
      }
      throw Error("Schema Swagger operasi tidak dapat dibaca. Tidak ada transaksi dijalankan. Periksa akses User SNAP dan URL operasi lengkap.");
    }finally{await session.release();}
  }
}

/** Runs inside the document. Never opens Try it out or executes a service. */
function readFrame(id:string){
  type Ui={specSelectors?:{specJson:()=>{toJS:()=>unknown}};getSystem?:()=>{specSelectors?:{specJson:()=>{toJS:()=>unknown}}}};
  const globals=window as unknown as Record<string,Ui>;
  const specs:unknown[]=[];
  for(const name of ["ui","swaggerUI","swaggerUi"]){
    try{const ui=globals[name],selectors=ui?.specSelectors??ui?.getSystem?.().specSelectors,value=selectors?.specJson?.().toJS?.();if(value)specs.push(value);}catch{/* Loading. */}
  }
  const blocks=[...document.querySelectorAll<HTMLElement>(".opblock")].filter(node=>node.id.endsWith(`-${id}`));
  if(blocks.length!==1)return {specs,rendered:null};
  const node=blocks[0],clean=(s:string)=>(s??"").replace(/[\u200B-\u200D\uFEFF]/g,"").trim();
  const method=clean(node.querySelector(".opblock-summary-method")?.textContent??"").toLowerCase(),path=clean(node.querySelector(".opblock-summary-path")?.textContent??"");
  if(!method||!path)return {specs,rendered:null};
  // Expanding documentation is safe; never click Try it out or Execute.
  const summary=node.querySelector<HTMLElement>('.opblock-summary[aria-expanded="false"]');
  if(summary){summary.click();return {specs,rendered:null};}
  if(!node.querySelector('.parameters tbody tr,.responses-table tbody tr,textarea.body-param__text,.body-param__example'))return {specs,rendered:null};
  const parameters:unknown[]=[...node.querySelectorAll(".parameters tbody tr")].flatMap(row=>{
    const name=clean(row.querySelector(".parameter__name")?.childNodes[0]?.textContent??"").replace(/\s*\*$/,""),location=clean(row.querySelector(".parameter__in")?.textContent??"").replace(/[()]/g,"");
    return name&&["header","query","path"].includes(location)?[{name,in:location,required:!!row.querySelector(".required"),type:"string",description:clean(row.querySelector(".parameters-col_description")?.textContent??"")}]:[];
  });
  const text=node.querySelector<HTMLTextAreaElement>("textarea.body-param__text")?.value??node.querySelector(".body-param__example")?.textContent??"";
  try{parameters.push({in:"body",name:"body",schema:{example:JSON.parse(text)}});}catch{/* No explicit JSON sample. */}
  const responses=Object.fromEntries([...node.querySelectorAll(".responses-table tbody tr")].flatMap(row=>{
    const status=clean(row.querySelector(".response-col_status")?.textContent??"");
    let example;try{example=JSON.parse(row.querySelector(".highlight-code,.microlight")?.textContent??"");}catch{}
    return /^\d{3}$/.test(status)?[[status,{description:clean(row.querySelector(".response-col_description")?.textContent??""),...(example?{example}:{})}]]:[];
  }));
  return {specs,rendered:{paths:{[path]:{[method]:{operationId:id,summary:clean(node.querySelector(".opblock-summary-description")?.textContent??id),description:node.querySelector(".opblock-description-wrapper")?.textContent??"",parameters,responses}}}}};
}
