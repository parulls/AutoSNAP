import {object,methods,type EndpointConfig,type Parameter} from "./endpoint-config";

export function documentationUrl(raw:string){
  const url=new URL(raw);
  if(url.origin!=="https://apidevportal.aspi-indonesia.or.id"||url.username||url.password||!url.pathname.startsWith("/api-services/")||!url.hash)throw Error("Gunakan URL operasi ASPI lengkap dengan #/Group/operationId.");
  return url;
}
function descriptionSample(description:unknown,kind:"request"|"response"):unknown{
  if(typeof description!=="string"||description.length>150000)return undefined;
  const label=new RegExp(`(?:sample|contoh)\\s+${kind}`,"i").exec(description);if(!label)return undefined;
  const text=description.slice(label.index+label[0].length).split(/(?:sample|contoh)\s+(?:request|response)/i)[0].replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
  const start=text.indexOf("{");if(start<0)return undefined;
  let depth=0,string=false,escape=false;
  for(let i=start;i<text.length;i++){
    const ch=text[i];if(string){if(escape)escape=false;else if(ch==="\\")escape=true;else if(ch==='"')string=false;continue;}
    if(ch==='"')string=true;else if(ch==="{")depth++;else if(ch==="}"&&--depth===0){try{return JSON.parse(text.slice(start,i+1));}catch{return undefined;}}
  }
  return undefined;
}
function documentedAuth(operation:Record<string,unknown>,fields:Parameter[]):EndpointConfig["authFlow"]{
  // Only explicit statements about THIS operation, never generic Bearer/header descriptions.
  const text=String(operation.description??"").replace(/<[^>]+>/g," ");
  const matches=[...text.matchAll(/(?:authentication|auth(?:entication)?\s+flow|autentikasi|use\s+case)\s*[:=]\s*(b2b2c|b2b)\b/gi)].map(match=>match[1].toLowerCase());
  const unique=[...new Set(matches)];
  if(unique.length===1)return unique[0] as "b2b"|"b2b2c";
  if(Array.isArray(operation.security)&&!operation.security.length&&!fields.some(field=>field.in==="header"&&field.required&&/^(?:authorization(?:-customer)?|x-signature)$/i.test(field.name)))return "none";
  return "unknown";
}

/** Fill gaps from the official Code Snippets for this exact method/path only. */
export function supplementSnippets(draft:ReturnType<typeof parseOperation>,text:string){
  if(text.length>400_000)return draft;
  const sections=text.split(/(?:sample|contoh)\s+request/i).slice(1).filter(section=>{
    const request=/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+HTTP\//i.exec(section);
    if(!request||request[1].toUpperCase()!==draft.method)return false;
    const path=request[2].replace(/^\.{3}/,"");
    return path===draft.path||`/api${path}`===draft.path;
  });
  if(sections.length!==1)return draft;
  const section=sections[0];
  if(!draft.requestBody){
    const sample=descriptionSample(`Sample Request ${section}`,"request");
    if(object(sample)){
      draft.requestBody=JSON.stringify(sample,null,2);
      draft.config.warnings=draft.config.warnings.filter(warning=>!warning.startsWith("Sample request tidak tersedia"));
    }
  }
  if(!draft.config.expectedCode){
    const sample=descriptionSample(section,"response"),code=object(sample)?String(sample.responseCode):"";
    if(/^\d{7}$/.test(code)&&code.startsWith(String(draft.config.expectedHttpStatus))&&(!draft.code||code.slice(3,5)===draft.code)){
      draft.config.expectedCode=code;
      const key=String(draft.config.expectedHttpStatus),response=draft.config.responses[key];
      draft.config.responses[key]={...(object(response)?response:{}),example:sample};
      draft.config.warnings=draft.config.warnings.filter(warning=>!warning.startsWith("Expected responseCode belum tersedia"));
    }
  }
  return draft;
}
export function parseOperation(spec:unknown,urlText:string,catalog:Record<string,unknown>[]=[]) {
  const url=documentationUrl(urlText),id=decodeURIComponent(url.hash.split("/").at(-1)??"");
  if(!object(spec)||!object(spec.paths))throw Error("Dokumentasi Swagger/OpenAPI tidak ditemukan.");
  const resolve=(value:unknown,seen=new Set<string>(),depth=0):unknown=>{
    if(depth>20)return {};
    if(Array.isArray(value))return value.map(item=>resolve(item,seen,depth+1));
    if(!object(value))return value;
    if(typeof value.$ref==="string"){
      if(!value.$ref.startsWith("#/" )||seen.has(value.$ref))return {$ref:value.$ref};
      let target:unknown=spec;for(const key of value.$ref.slice(2).split("/"))target=object(target)?target[key.replace(/~1/g,"/").replace(/~0/g,"~")]:undefined;
      return resolve(target,new Set([...seen,value.$ref]),depth+1);
    }
    return Object.fromEntries(Object.entries(value).filter(([key])=>!["__proto__","constructor","prototype"].includes(key)).map(([key,item])=>[key,resolve(item,seen,depth+1)]));
  };
  const found:Array<{path:string;method:string;operation:Record<string,unknown>;pathItem:Record<string,unknown>}>=[];
  for(const [path,entry]of Object.entries(spec.paths))if(object(entry))for(const [method,operation]of Object.entries(entry))if(methods.includes(method.toUpperCase())&&object(operation)&&(operation.operationId===id||!operation.operationId&&method.toLowerCase()+path.replace(/\W/g,"_")===id))found.push({path,method:method.toUpperCase(),operation,pathItem:entry});
  if(found.length!==1)throw Error("Operation ID tidak cocok secara unik; tidak memilih endpoint lain secara otomatis.");
  const {path,method,operation,pathItem}=found[0];
  const parameters=[...(Array.isArray(pathItem.parameters)?pathItem.parameters:[]),...(Array.isArray(operation.parameters)?operation.parameters:[])].map(p=>resolve(p)).filter(object);
  const bodyParam=parameters.find(p=>p.in==="body"),requestBody=resolve(operation.requestBody);
  const content=object(requestBody)&&object(requestBody.content)?requestBody.content["application/json"]:null;
  const schema=object(content)&&object(content.schema)?content.schema:object(bodyParam?.schema)?bodyParam.schema:null;
  const example=(s:unknown):unknown=>{if(!object(s))return undefined;if(s.example!==undefined)return s.example;if(s.default!==undefined)return s.default;if(Array.isArray(s.enum))return s.enum[0];if(object(s.properties))return Object.fromEntries(Object.entries(s.properties).map(([key,v])=>[key,example(v)]).filter(([,v])=>v!==undefined));return undefined;};
  const singleExample=(examples:unknown)=>{if(!object(examples))return undefined;const values=Object.values(examples);return values.length===1?(object(values[0])&&values[0].value!==undefined?values[0].value:values[0]):undefined;};
  // A request template must come from an explicit documented sample, not guessed fields/defaults.
  const sample=(object(content)?content.example??singleExample(content.examples)??schema?.example:schema?.example??bodyParam?.example??bodyParam?.["x-example"])??descriptionSample(operation.description,"request");
  const fields:Parameter[]=parameters.filter(p=>["header","query","path"].includes(String(p.in))).map(p=>({name:String(p.name),in:String(p.in),required:p.required===true,type:String(p.type??(object(p.schema)?p.schema.type:"string")??"string"),description:String(p.description??""),example:p.example??(object(p.schema)?p.schema.example:undefined)}));
  const responses=resolve(operation.responses) as Record<string,unknown>??{};
  for(const response of Object.values(responses))if(object(response)&&object(response.content)&&object(response.content["application/json"]))Object.assign(response,response.content["application/json"]);
  const known=catalog.find(row=>row.endpoint===path&&row.method===method);
  const success=Object.keys(responses).filter(status=>/^2\d\d$/.test(status));
  const successResponse=success.length===1&&object(responses[success[0]])?responses[success[0]] as Record<string,unknown>:null;
  const responseExample=successResponse?.example??(object(successResponse?.examples)?successResponse.examples["application/json"]??singleExample(successResponse.examples):undefined)??example(successResponse?.schema)??descriptionSample(successResponse?.description,"response")??descriptionSample(operation.description,"response");
  const rawCode=object(responseExample)?String(responseExample.responseCode):"";
  const expectedCode=success.length===1&&/^\d{7}$/.test(rawCode)&&rawCode.startsWith(success[0])?rawCode:null;
  const authFlow=documentedAuth(operation,fields);
  const config:EndpointConfig={version:1,sourceUrl:url.toString(),operationId:id,authFlow,responseFormat:method==="HEAD"?"none":"json",parameters:fields,requestSchema:schema,responses,expectedHttpStatus:success.length===1?Number(success[0]):null,expectedCode,reviewed:false,warnings:[...(authFlow==="unknown"?["Pilih autentikasi sesuai use case; Bearer saja tidak membedakan B2B dan B2B2C."]:[]),...(!schema&&!["GET","HEAD"].includes(method)?["Schema request tidak tersedia; kewajiban field belum dapat dipastikan."]:[]),...(!expectedCode?["Expected responseCode belum tersedia pada sample response; isi dari spesifikasi yang terverifikasi."]:[])]};
  config.identity={method,path};
  config.requestBodyMode=["GET","HEAD"].includes(method)?"none":bodyParam?.required===true||object(requestBody)&&requestBody.required===true?"required":bodyParam||object(requestBody)||object(sample)?"optional":"none";
  const tokenFailures=Object.entries(responses).filter(([status,response])=>/^4\d\d$/.test(status)&&object(response)).map(([status,response])=>{
    const r=response as Record<string,unknown>;
    const sample=r.example??(object(r.examples)?r.examples["application/json"]??singleExample(r.examples):undefined)??descriptionSample(r.description,"response");
    return {status:Number(status),sample};
  }).filter(item=>object(item.sample)&&/access\s*token\s*(?:invalid|expired)|invalid\s*access\s*token/i.test(String(item.sample.responseMessage))&&/^\d{7}$/.test(String(item.sample.responseCode))&&String(item.sample.responseCode).startsWith(String(item.status)));
  if(tokenFailures.length===1){const entry=tokenFailures[0];config.negativeToken={expectedHttpStatus:entry.status,expectedCode:String((entry.sample as Record<string,unknown>).responseCode)};}
  if(!object(sample)&&!["GET","HEAD"].includes(method))config.warnings.push("Sample request tidak tersedia; template dibiarkan kosong. Isi body di halaman pengujian sesuai dokumentasi.");
  return {name:String(operation.summary??known?.name??id),module:String(known?.module??"Layanan SNAP"),code:known?.code??"",method,path,portalUrl:url.toString(),requestBody:object(sample)?JSON.stringify(sample,null,2):"",config};
}
