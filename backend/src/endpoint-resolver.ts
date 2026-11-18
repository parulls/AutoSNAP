import type {RecordRow} from "./database.service";
import {MetadataError,methods,optionalExpectedCode,object,validateConfig,type EndpointConfig,type Expectation} from "./endpoint-config";
import {authenticationWorkflow} from "./auth-workflow";

const value=(row:RecordRow,key:string)=>String(row.data[key]??"");
export function assertOperationIdentity(method:string,path:string,portalUrl:string,config:EndpointConfig){
  let url:URL,source:URL;
  try{url=new URL(portalUrl);source=new URL(config.sourceUrl);}catch{throw new MetadataError("Referensi URL operasi tidak valid.");}
  if(url.origin!=="https://apidevportal.aspi-indonesia.or.id"||url.username||url.password||!url.pathname.startsWith("/api-services/")||source.toString()!==url.toString()||decodeURIComponent(url.hash.split("/").at(-1)??"")!==config.operationId)throw new MetadataError("URL, Operation ID dan referensi dokumentasi tidak sesuai. Baca ulang dokumentasi endpoint ini.");
  if(!methods.includes(method)||!/^\/(?!\/)[^\s?#\\]+$/.test(path))throw new MetadataError("Method atau path endpoint tidak valid.");
  if(config.identity&&(config.identity.method!==method||config.identity.path!==path))throw new MetadataError("Method/path berbeda dari identitas operasi yang diimpor. Baca ulang dokumentasi.");
  // Older ASPI imports have no identity yet. Their generated operation IDs still bind method/path.
  if(!config.identity&&/^(get|post|put|patch|delete|head|options)_api_/i.test(config.operationId)&&config.operationId!==method.toLowerCase()+path.replace(/\W/g,"_"))throw new MetadataError("Operation ID berbeda dari method/path endpoint.");
}

export function resolveEndpoint(endpoint:RecordRow,service:RecordRow){
  if(service.parent_id!==endpoint.id&&endpoint.parent_id!==service.id)throw new MetadataError("API service tidak melekat pada endpoint terpilih.");
  const method=value(endpoint,"method"),path=value(endpoint,"path"),portalUrl=value(endpoint,"portalUrl"),serviceCode=value(service,"code");
  const config=service.data.config?validateConfig(service.data.config):null;
  const legacyBalance=!config&&serviceCode==="11"&&method==="POST"&&path==="/api/v1.0/balance-inquiry";
  if(!config&&!legacyBalance)throw new MetadataError("Endpoint memerlukan konfigurasi dari dokumentasi yang sudah ditinjau; tidak ada fallback layanan lain.");
  if(config){
    assertOperationIdentity(method,path,portalUrl,config);
    if(!config.reviewed||config.authFlow==="unknown"||config.expectedHttpStatus===null)throw new MetadataError("Tinjau autentikasi dan expected HTTP status pada konfigurasi endpoint.");
    authenticationWorkflow(config);
  }
  return {method,path,portalUrl,serviceCode,config,legacyBalance};
}

export function scenarioExpectation(config:EndpointConfig|null,legacyBalance:boolean,negative:boolean,legacyData:Record<string,unknown>={}):Expectation{
  if(negative&&config?.authFlow==="none")throw new MetadataError("Tes token tidak berlaku untuk endpoint tanpa autentikasi.");
  const source=config??(legacyBalance?legacyData:{});
  const selected=negative?(object(source.negativeToken)?source.negativeToken:{}):source;
  return {expectedHttpStatus:typeof selected.expectedHttpStatus==="number"?selected.expectedHttpStatus:negative?401:200,expectedCode:optionalExpectedCode(selected.expectedCode)};
}
