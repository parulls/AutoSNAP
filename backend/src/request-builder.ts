import {MetadataError,object,schemaErrors,type EndpointConfig,type Parameter} from "./endpoint-config";
import {randomInt} from "node:crypto";

export const managedHeaders=new Set(["content-type","authorization","authorization-customer","x-timestamp","x-signature","x-partner-id","x-external-id","channel-id","x-device-id"]);

/** Resolve explicit variables only. Never borrow a payload or parameter from another service. */
export function prepareBody(raw:unknown,method:string,config:EndpointConfig|null,deviceId:string,readSecret:(field:string)=>string):Record<string,unknown>{
  const text=String(raw??""),noBody=["GET","HEAD"].includes(method)||config?.requestBodyMode==="none";
  if(!text.trim()&&!noBody&&config?.requestBodyMode!=="optional")throw new MetadataError("Template request belum tersedia. Isi Request Body sesuai dokumentasi sebelum testing.");
  let parsed:unknown;
  try{parsed=JSON.parse(text.trim()?text:"{}");}catch{throw new MetadataError("Request body harus JSON valid.");}
  if(!object(parsed))throw new MetadataError("Request body harus objek JSON.");
  if(noBody&&Object.keys(parsed).length)throw new MetadataError("Endpoint ini tidak memakai JSON body; gunakan parameter sesuai dokumentasi.");
  const variables:Record<string,string>={"{{registration.accountNo}}":"accountNo","{{registration.bankCardToken}}":"bankCardToken","{{authorization_code}}":"authCode","{{refresh_token}}":"refreshToken"};
  const resolve=(entry:unknown):unknown=>{
    if(Array.isArray(entry))return entry.map(resolve);
    if(object(entry))return Object.fromEntries(Object.entries(entry).map(([key,item])=>[key,resolve(item)]));
    if(entry==="{{partner_reference_no}}")return Date.now().toString()+String(randomInt(0,1_000_000_000)).padStart(9,"0");
    if(entry==="{{client.deviceId}}")return deviceId;
    if(typeof entry==="string"&&Object.hasOwn(variables,entry))return readSecret(variables[entry]);
    return entry;
  };
  const body=resolve(parsed) as Record<string,unknown>;
  const errors=config&&!noBody&&(text.trim()||config.requestBodyMode!=="optional")?schemaErrors(body,config.requestSchema):[];
  if(errors.length)throw new MetadataError(errors.join(" "));
  return body;
}

export function resolveRequestPath(path:string,definitions:Parameter[],parameters:Record<string,unknown>){
  let resolved=path;
  for(const p of definitions.filter(p=>p.in==="path")){
    const value=parameters[p.name];
    if(value===undefined||value===""||value==="."||value==="..")throw new MetadataError(`Path parameter ${p.name} wajib dan tidak boleh dot segment.`);
    resolved=resolved.replaceAll(`{${p.name}}`,encodeURIComponent(String(value)));
  }
  if(/\{[^}]+\}/.test(resolved))throw new MetadataError("Path parameter belum terisi atau belum didefinisikan pada dokumentasi.");
  if(!/^\/(?!\/)[^\s?#\\]+$/.test(resolved)||resolved.split("/").some(part=>part==="."||part===".."))throw new MetadataError("Path endpoint tidak aman.");
  const query=new URLSearchParams();
  for(const p of definitions.filter(p=>p.in==="query"))if(parameters[p.name]!==undefined&&parameters[p.name]!=="")query.append(p.name,String(parameters[p.name]));
  return resolved+(query.size?`?${query}`:"");
}
