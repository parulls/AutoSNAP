import {object} from "./endpoint-config";

export type ResultCheck={label:string;passed:boolean|null;detail:string};
export type RunStatus="RUNNING"|"PASSED"|"COMPLETED"|"FAILED"|"AUTOMATION_ERROR"|"VALIDATION_ERROR"|"CANCELLED";
export type EvaluationMode="HTTP_ONLY"|"SNAP_AND_HTTP";
export type HttpSource="target_api"|"portal_metadata_verified"|"unavailable";
export type Evaluation={
  mode:EvaluationMode;
  snapValidationPerformed:boolean;
  outcome:RunStatus;
  httpValidation:{expectedStatus:number;actualStatus:number|null;performed:boolean;matches:boolean;source:HttpSource};
  snapValidation:{expectedCode:string|null;actualCode:string|null;performed:boolean;matches:boolean|null};
  stage:"evaluation";
  stageLabel:string;
  detail:string;
  suggestion:string;
  cause?:"HTTP_UNVERIFIED";
};
export const isHttpResponse=(status:unknown):status is number=>typeof status==="number"&&Number.isInteger(status)&&status>=100&&status<=599;

export function hasRecordedHttp(run:Pick<{http_status:number|null;request_json:unknown},"http_status"|"request_json">){
  const snapshot=object(run.request_json)?run.request_json:{};
  return isHttpResponse(run.http_status)||Array.isArray(snapshot.steps)&&snapshot.steps.some(step=>object(step)&&isHttpResponse(step.httpStatus));
}

/**
 * Positive with expected SNAP: require SNAP match then HTTP match (SNAP_AND_HTTP).
 * Positive without expected SNAP, or negative testing: HTTP status only (HTTP_ONLY).
 * Never treat HTTP match as PASSED when SNAP was configured but missing or mismatched.
 */
export function evaluateTest(input:{httpStatus:number|null;expectedHttpStatus?:number|null;cancelled?:boolean;actualCode?:string|null;expectedCode?:string|null;negative?:boolean;checks?:ResultCheck[];httpSource?:HttpSource}):{status:RunStatus;evaluation:Evaluation}{
  const expectedHttp=input.expectedHttpStatus??200;
  const performed=isHttpResponse(input.httpStatus);
  const httpMatches=performed&&input.httpStatus===expectedHttp;
  const expectedSnap=input.negative?null:(typeof input.expectedCode==="string"&&/^\d{7}$/.test(input.expectedCode)?input.expectedCode:null);
  const mode:EvaluationMode=expectedSnap?"SNAP_AND_HTTP":"HTTP_ONLY";
  const actualSnap=typeof input.actualCode==="string"&&input.actualCode?input.actualCode:null;
  const snapPerformed=!!expectedSnap;
  const snapMatches=snapPerformed?actualSnap===expectedSnap:null;
  const source:HttpSource=!performed?"unavailable":input.httpSource==="portal_metadata_verified"?"portal_metadata_verified":"target_api";
  const httpValidation={expectedStatus:expectedHttp,actualStatus:performed?input.httpStatus:null,performed,matches:httpMatches,source};
  const snapValidation={expectedCode:expectedSnap,actualCode:actualSnap,performed:snapPerformed,matches:snapMatches};
  const stageLabel=mode==="SNAP_AND_HTTP"?"Validasi SNAP + HTTP":"Validasi HTTP";
  const base={mode,snapValidationPerformed:snapPerformed,httpValidation,snapValidation,stage:"evaluation" as const,stageLabel};
  if(input.cancelled)return {status:"CANCELLED",evaluation:{...base,outcome:"CANCELLED",detail:"Pengujian dibatalkan. Request yang sudah terkirim tetap tercatat.",suggestion:"Bukti PDF dapat diproses ulang tanpa menjalankan API."}};
  if(!performed)return {status:"AUTOMATION_ERROR",evaluation:{...base,outcome:"AUTOMATION_ERROR",cause:"HTTP_UNVERIFIED",detail:"HTTP_UNVERIFIED. API target belum memberikan respons HTTP. Respons autentikasi, Save Result, dan responseCode SNAP tidak dianggap sebagai respons API target.",suggestion:"Periksa tahap automasi dan penyebab error sebelum mencoba ulang atau gunakan Lanjutkan Testing."}};
  if(expectedSnap){
    if(!actualSnap)return {status:"FAILED",evaluation:{...base,outcome:"FAILED",detail:`Expected SNAP ${expectedSnap} dikonfigurasi, tetapi Actual SNAP responseCode tidak tersedia. HTTP ${input.httpStatus} tidak dipakai sebagai fallback PASSED.`,suggestion:"Periksa respons API target dan pastikan responseCode SNAP dikembalikan."}};
    if(actualSnap!==expectedSnap)return {status:"FAILED",evaluation:{...base,outcome:"FAILED",detail:`Actual SNAP ${actualSnap} tidak sesuai expected ${expectedSnap}. HTTP ${input.httpStatus} tidak dipakai sebagai fallback PASSED.`,suggestion:"Perbaiki skenario atau expected SNAP responseCode pada konfigurasi endpoint."}};
    if(!httpMatches)return {status:"FAILED",evaluation:{...base,outcome:"FAILED",detail:`SNAP ${actualSnap} sesuai, tetapi HTTP ${input.httpStatus} tidak sesuai expected ${expectedHttp}.`,suggestion:"Periksa respons aktual dan expected HTTP status."}};
    return {status:"COMPLETED",evaluation:{...base,outcome:"COMPLETED",detail:`SNAP ${actualSnap} dan HTTP ${input.httpStatus} sesuai expected. Pengumpulan bukti PDF belum selesai.`,suggestion:""}};
  }
  if(!httpMatches)return {status:"FAILED",evaluation:{...base,outcome:"FAILED",detail:`HTTP ${input.httpStatus} tidak sesuai expected ${expectedHttp}.`,suggestion:"Periksa respons aktual dan skenario HTTP yang dipilih."}};
  return {status:"COMPLETED",evaluation:{...base,outcome:"COMPLETED",detail:`HTTP ${input.httpStatus} sesuai expected ${expectedHttp}. Pengumpulan bukti PDF belum selesai.`,suggestion:""}};
}

/** Promote after evidence PDFs finish. Never turn HTTP/SNAP FAILED into PASSED. */
export function finalOutcome(evaluation:Pick<Evaluation,"outcome"|"httpValidation"|"snapValidation"|"mode">,pdfsComplete:boolean):RunStatus{
  if(evaluation.outcome==="CANCELLED")return "CANCELLED";
  if(evaluation.outcome==="VALIDATION_ERROR")return "VALIDATION_ERROR";
  if(!evaluation.httpValidation?.performed||evaluation.outcome==="AUTOMATION_ERROR")return "AUTOMATION_ERROR";
  if(!evaluation.httpValidation.matches||evaluation.outcome==="FAILED")return "FAILED";
  if(evaluation.mode==="SNAP_AND_HTTP"&&evaluation.snapValidation?.matches!==true)return "FAILED";
  return pdfsComplete?"PASSED":"COMPLETED";
}
