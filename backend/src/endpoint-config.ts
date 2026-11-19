export const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export const methods=["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"];
export class MetadataError extends Error{readonly status=400;readonly error:string;constructor(message:string){super(message);this.error=message;}}
export type Parameter={name:string;in:string;required:boolean;type?:string;description?:string;example?:unknown};
export type Expectation={expectedHttpStatus:number|null;expectedCode:string|null};
export type AuthWorkflow={token:"b2b"|"provided"|"none";signature:"hmac"|"none";customerToken:"stored"|"none"};
export function optionalExpectedCode(value:unknown):string|null{
  if(value===undefined||value===null||typeof value==="string"&&!value.trim())return null;
  if(typeof value!=="string"||!/^\d{7}$/.test(value.trim()))throw new MetadataError("Expected responseCode harus tujuh digit atau kosong.");
  return value.trim();
}
export type EndpointConfig=Expectation&{version:1;sourceUrl:string;operationId:string;identity?:{method:string;path:string};authFlow:"unknown"|"b2b"|"b2b2c"|"none";workflow?:AuthWorkflow;negativeToken?:Expectation;requestBodyMode?:"required"|"optional"|"none";responseFormat?:"json"|"none";parameters:Parameter[];requestSchema:Record<string,unknown>|null;responses:Record<string,unknown>;reviewed:boolean;warnings:string[]};
export function validateConfig(raw:unknown):EndpointConfig{
  if(!object(raw)||raw.version!==1||!Array.isArray(raw.parameters)||!["unknown","none","b2b","b2b2c"].includes(String(raw.authFlow)))throw new MetadataError("Konfigurasi endpoint tidak valid.");
  if(!object(raw.responses)||(raw.requestSchema!==null&&!object(raw.requestSchema))||typeof raw.reviewed!=="boolean"||!Array.isArray(raw.warnings)||typeof raw.operationId!=="string"||raw.responseFormat!==undefined&&!["json","none"].includes(String(raw.responseFormat)))throw new MetadataError("Schema atau response konfigurasi tidak valid.");
  if(raw.parameters.length>100||raw.parameters.some(p=>!object(p)||typeof p.name!=="string"||!p.name||!['header','query','path'].includes(String(p.in))))throw new MetadataError("Parameter endpoint tidak valid.");
  const names=raw.parameters.map(p=>String(p.name).toLowerCase());if(new Set(names).size!==names.length)throw new MetadataError("Nama parameter ganda memerlukan pemetaan yang tidak ambigu.");
  const expectedCode=optionalExpectedCode(raw.expectedCode);
  if(raw.expectedHttpStatus!==null&&(!Number.isInteger(raw.expectedHttpStatus)||Number(raw.expectedHttpStatus)<100||Number(raw.expectedHttpStatus)>599))throw new MetadataError("Expected HTTP status tidak valid.");
  if(typeof raw.sourceUrl!=="string"||!raw.sourceUrl)throw new MetadataError("Referensi dokumentasi wajib diisi.");
  if(raw.identity!==undefined&&(!object(raw.identity)||!methods.includes(String(raw.identity.method))||typeof raw.identity.path!=="string"))throw new MetadataError("Identitas operasi tidak valid.");
  if(raw.requestBodyMode!==undefined&&!["required","optional","none"].includes(String(raw.requestBodyMode)))throw new MetadataError("Kebutuhan body endpoint tidak valid.");
  if(raw.workflow!==undefined){
    const w=raw.workflow;
    if(!object(w)||!["b2b","provided","none"].includes(String(w.token))||!["hmac","none"].includes(String(w.signature))||!["stored","none"].includes(String(w.customerToken)))throw new MetadataError("Workflow keamanan tidak valid.");
  }
  if(raw.negativeToken!==undefined){
    const n=raw.negativeToken;
    if(!object(n)||!Number.isInteger(n.expectedHttpStatus)||Number(n.expectedHttpStatus)<400||Number(n.expectedHttpStatus)>499)throw new MetadataError("Ekspektasi HTTP tes token negatif harus HTTP 4xx.");
  }
  if(JSON.stringify(raw).length>150000)throw new MetadataError("Konfigurasi terlalu besar.");
  return {...raw,expectedCode,...(object(raw.negativeToken)?{negativeToken:{expectedHttpStatus:Number(raw.negativeToken.expectedHttpStatus),expectedCode:null}}:{})} as unknown as EndpointConfig;
}
export function schemaErrors(value:unknown,schema:unknown,path="body",depth=0):string[]{
  if(!object(schema)||depth>20)return [];
  const errors:string[]=[];
  if(schema.$ref)return [`${path}: schema reference belum di-resolve.`];
  if(Array.isArray(schema.allOf))for(const child of schema.allOf)errors.push(...schemaErrors(value,child,path,depth+1));
  if(Array.isArray(schema.oneOf)&&schema.oneOf.filter(child=>schemaErrors(value,child,path,depth+1).length===0).length!==1)errors.push(`${path}: oneOf tidak cocok secara unik.`);
  if(Array.isArray(schema.anyOf)&&!schema.anyOf.some(child=>schemaErrors(value,child,path,depth+1).length===0))errors.push(`${path}: anyOf tidak cocok.`);
  if(Array.isArray(schema.enum)&&!schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)))errors.push(`${path}: nilai tidak termasuk enum.`);
  const type=String(schema.type??(schema.properties?"object":""));
  if(type==="object"){
    if(!object(value))return [...errors,`${path} harus object.`];
    for(const key of Array.isArray(schema.required)?schema.required:[])if(typeof key==="string"&&value[key]===undefined)errors.push(`${path}.${key} wajib.`);
    if(object(schema.properties))for(const [key,child]of Object.entries(schema.properties))if(value[key]!==undefined)errors.push(...schemaErrors(value[key],child,`${path}.${key}`,depth+1));
  }else if(type==="array"){
    if(!Array.isArray(value))errors.push(`${path} harus array.`);else for(const [index,item]of value.entries())errors.push(...schemaErrors(item,schema.items,`${path}[${index}]`,depth+1));
  }else if(type==="string"){
    if(typeof value!=="string")errors.push(`${path} harus string.`);
    else if(typeof schema.maxLength==="number"&&value.length>schema.maxLength)errors.push(`${path} melebihi panjang maksimum.`);
  }else if(type==="integer"&&!Number.isInteger(value))errors.push(`${path} harus integer.`);
  else if(type==="number"&&typeof value!=="number")errors.push(`${path} harus number.`);
  else if(type==="boolean"&&typeof value!=="boolean")errors.push(`${path} harus boolean.`);
  return errors;
}
export function configuredChecks(status:number|null,body:unknown,config:EndpointConfig,expectation:Expectation=config,options:{negative?:boolean}={}){
  const expected=options.negative?null:expectation.expectedCode;
  const actual=object(body)?String(body.responseCode??""):"";
  const checks:Array<{label:string;passed:boolean|null;detail:string}>=[{label:"HTTP status",passed:status===expectation.expectedHttpStatus,detail:`Expected ${expectation.expectedHttpStatus??"belum dikonfigurasi"}, actual ${status??"tidak ada response"}.`}];
  if(expected){
    const snapOk=!!actual&&actual===expected;
    checks.push({label:"SNAP responseCode",passed:snapOk,detail:snapOk?`Actual ${actual} sesuai expected ${expected}.`:`Expected ${expected}; actual ${actual||"missing"}.`});
    checks.push({label:"SNAP responseMessage",passed:null,detail:object(body)&&typeof body.responseMessage==="string"?`responseMessage: ${String(body.responseMessage).slice(0,150)}`:"responseMessage tidak tersedia (informasional)."});
  }
  if(config.responseFormat!=="none")checks.push({label:"Response JSON",passed:object(body),detail:"Response harus object JSON."});
  const response=object(config.responses[String(status)])?config.responses[String(status)] as Record<string,unknown>:null;
  if(response?.schema)for(const error of schemaErrors(body,response.schema,"response"))checks.push({label:"Response schema",passed:null,detail:`${error} (informasional).`});
  return checks;
}
