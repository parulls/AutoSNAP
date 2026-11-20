import {object} from "./endpoint-config";
import type {HitResult} from "./run-engine";
import {isHttpResponse} from "./test-evaluation";
import {sha256} from "./security";
import type {AspiActivity} from "./aspi-evidence";

export type EvidenceOperation={key:string;path:string;method:string;service:string;httpStatus:number;startedAt?:string;finishedAt?:string;activity?:AspiActivity;pdfReady:boolean;attempts:number;error?:string;contentSha256?:string;contentFingerprint?:string;byteSize?:number;pdfProducer?:string;downloadedAt?:string;authenticity?:"aspi-html2pdf-download"|"unverified"};
export type EvidencePlan={version:1;beforeIds?:string[];accountHash:string;operations:EvidenceOperation[];phase:"PENDING"|"COLLECTING"|"COMPLETE"|"INCOMPLETE";retryCount:number};
export function buildEvidencePlan(result:HitResult,path:string,method:string,service:string,email:string):EvidencePlan{
  const steps=Array.isArray(result.request.steps)?result.request.steps.filter(object):[];
  const actual=[...steps,...(isHttpResponse(result.status)?[{...result.request,name:path,method,httpStatus:result.status}]:[])];
  const operations=actual.filter(step=>isHttpResponse(step.httpStatus)&&typeof step.name==="string").map((step,index)=>{
    const operationPath=String(step.name),operationMethod=String(step.method??"POST");
    return {key:sha256(`${index}|${operationMethod}|${operationPath}`).slice(0,24),path:operationPath,method:operationMethod,service:index===actual.length-1&&isHttpResponse(result.status)?service:operationPath,httpStatus:Number(step.httpStatus),...(typeof step.startedAt==="string"?{startedAt:step.startedAt}:{}),...(typeof step.finishedAt==="string"?{finishedAt:step.finishedAt}:{}),pdfReady:false,attempts:0};
  });
  return {version:1,beforeIds:result.activityBaseline,accountHash:sha256(email.trim().toLowerCase()),operations,phase:"PENDING",retryCount:0};
}
