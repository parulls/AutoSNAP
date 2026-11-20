import type {RecordRow} from "./database.service";
import {object} from "./endpoint-config";

/** Capabilities stored on service.data.capabilities — drive run-time behavior without code lists in app.ts. */
export type ServiceCapabilities={
  persistFields?:string[];
  persistCustomerToken?:boolean;
  autoRegisterFromCode?:string;
  activityAliases?:string[];
  allowUnreviewed?:boolean;
};

/** Defaults keyed by SNAP service code; copied onto records at import/seed. Runtime prefers stored capabilities. */
const DEFAULT_BY_CODE:Record<string,ServiceCapabilities>={
  "01":{persistFields:["bankCardToken","accountNo","authCode","refreshToken"]},
  "03":{persistFields:["bankCardToken","accountNo","authCode","refreshToken"]},
  "04":{persistFields:["bankCardToken","accountNo","authCode","refreshToken"]},
  "07":{persistFields:["bankCardToken","accountNo","authCode","refreshToken"]},
  "08":{persistFields:["bankCardToken","accountNo","authCode","refreshToken"]},
  "11":{allowUnreviewed:true,autoRegisterFromCode:"01",activityAliases:["balanceinquiry","informasisaldo"]},
  // ASPI activity table labels often read "API Generate QR MPM" (not the path tail alone).
  "47":{activityAliases:["generateqrmpm","qrmpmgenerate","apigenerateqrmpm"]},
  "74":{persistCustomerToken:true},
};

const PATH_ACTIVITY_ALIASES:Record<string,string[]>={
  "/api/v1.0/utilities/signature-auth":["signatureauth","signatureauthentication","signatureaccesstoken"],
  "/api/v1.0/access-token/b2b":["accesstokenb2b","b2baccesstoken"],
  "/api/v1.0/utilities/signature-service":["signatureservice"],
  "/api/v1.0/qr/qr-mpm-generate":["generateqrmpm","qrmpmgenerate","apigenerateqrmpm"],
  "/api/v1.0/qr/qr-mpm-decode":["decodeqrmpm","qrmpmdecode"],
  "/api/v1.0/qr/qr-mpm-query":["queryqrmpm","qrmpmquery","querypayment"],
  "/api/v1.0/balance-inquiry":["balanceinquiry","informasisaldo"],
};

function asCapabilities(raw:unknown):ServiceCapabilities|null{
  if(!object(raw))return null;
  const persistFields=Array.isArray(raw.persistFields)?raw.persistFields.filter((item):item is string=>typeof item==="string"):undefined;
  const activityAliases=Array.isArray(raw.activityAliases)?raw.activityAliases.filter((item):item is string=>typeof item==="string"):undefined;
  return {
    ...(persistFields?.length?{persistFields}:{}),
    ...(raw.persistCustomerToken===true?{persistCustomerToken:true}:{}),
    ...(typeof raw.autoRegisterFromCode==="string"&&/^\d{2}$/.test(raw.autoRegisterFromCode)?{autoRegisterFromCode:raw.autoRegisterFromCode}:{}),
    ...(activityAliases?.length?{activityAliases}:{}),
    ...(raw.allowUnreviewed===true?{allowUnreviewed:true}:{}),
  };
}

export function capabilitiesForCode(code:string):ServiceCapabilities{
  return {...(DEFAULT_BY_CODE[code]??{})};
}

/** Merge stored service.data.capabilities with catalog defaults for that code. */
export function resolveCapabilities(service:Pick<RecordRow,"data">):ServiceCapabilities{
  const code=String(service.data.code??"");
  const stored=asCapabilities(service.data.capabilities);
  const defaults=capabilitiesForCode(code);
  if(!stored)return defaults;
  return {
    persistFields:stored.persistFields??defaults.persistFields,
    persistCustomerToken:stored.persistCustomerToken??defaults.persistCustomerToken,
    autoRegisterFromCode:stored.autoRegisterFromCode??defaults.autoRegisterFromCode,
    activityAliases:stored.activityAliases??defaults.activityAliases,
    allowUnreviewed:stored.allowUnreviewed??defaults.allowUnreviewed,
  };
}

export function annotateServiceData(data:Record<string,unknown>):Record<string,unknown>{
  const code=String(data.code??"");
  const capabilities={...capabilitiesForCode(code),...asCapabilities(data.capabilities)};
  if(!Object.keys(capabilities).length){
    const rest={...data};
    delete rest.capabilities;
    return rest;
  }
  return {...data,capabilities};
}

export function savesPrerequisite(caps:ServiceCapabilities){
  return !!(caps.persistFields?.length||caps.persistCustomerToken);
}

export function activityAliasesFor(path:string,caps?:ServiceCapabilities){
  return [...(PATH_ACTIVITY_ALIASES[path]??[]),...(caps?.activityAliases??[])];
}
