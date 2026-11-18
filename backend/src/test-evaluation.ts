import {object} from "./endpoint-config";

export type ResultCheck={label:string;passed:boolean|null;detail:string};
export type RunStatus="RUNNING"|"PASSED"|"COMPLETED"|"FAILED"|"AUTOMATION_ERROR"|"VALIDATION_ERROR"|"CANCELLED";
export type Evaluation={
  mode:"HTTP_ONLY";
  snapValidationPerformed:false;
  outcome:RunStatus;
  httpValidation:{expectedStatus:number;actualStatus:number|null;performed:boolean;matches:boolean;source:"target_api"};
  stage:"evaluation";
  stageLabel:"Validasi HTTP";
  detail:string;
  suggestion:string;
};
export const isHttpResponse=(status:unknown):status is number=>typeof status==="number"&&Number.isInteger(status)&&status>=100&&status<=599;

export function hasRecordedHttp(run:Pick<{http_status:number|null;request_json:unknown},"http_status"|"request_json">){
  const snapshot=object(run.request_json)?run.request_json:{};
  return isHttpResponse(run.http_status)||Array.isArray(snapshot.steps)&&snapshot.steps.some(step=>object(step)&&isHttpResponse(step.httpStatus));
}

/** HTTP status from the target API is the only pass/fail signal. SNAP codes are informational. */
export function evaluateTest(input:{httpStatus:number|null;expectedHttpStatus?:number|null;cancelled?:boolean;actualCode?:string|null;expectedCode?:string|null;checks?:ResultCheck[]}):{status:RunStatus;evaluation:Evaluation}{
  const expected=input.expectedHttpStatus??200;
  const performed=isHttpResponse(input.httpStatus);
  const matches=performed&&input.httpStatus===expected;
  const httpValidation={expectedStatus:expected,actualStatus:performed?input.httpStatus:null,performed,matches,source:"target_api" as const};
  const base={mode:"HTTP_ONLY" as const,snapValidationPerformed:false as const,httpValidation,stage:"evaluation" as const,stageLabel:"Validasi HTTP" as const};
  if(input.cancelled)return {status:"CANCELLED",evaluation:{...base,outcome:"CANCELLED",detail:"Pengujian dibatalkan. Request yang sudah terkirim tetap tercatat.",suggestion:"Bukti PDF dapat diproses ulang tanpa menjalankan API."}};
  if(!performed)return {status:"AUTOMATION_ERROR",evaluation:{...base,outcome:"AUTOMATION_ERROR",detail:"API target belum memberikan respons HTTP. Respons autentikasi tidak dianggap sebagai respons API target.",suggestion:"Periksa tahap automasi dan penyebab error sebelum mencoba ulang atau gunakan Lanjutkan Testing."}};
  if(!matches)return {status:"FAILED",evaluation:{...base,outcome:"FAILED",detail:`HTTP ${input.httpStatus} tidak sesuai expected ${expected}.`,suggestion:"Periksa respons aktual dan skenario HTTP yang dipilih."}};
  // HTTP matched — evidence may still be pending; callers promote to PASSED/COMPLETED after PDFs.
  return {status:"COMPLETED",evaluation:{...base,outcome:"COMPLETED",detail:`HTTP ${input.httpStatus} sesuai expected ${expected}. Pengumpulan bukti PDF belum selesai.`,suggestion:""}};
}

/** Promote after evidence PDFs finish. Never turn HTTP FAILED into PASSED. */
export function finalOutcome(evaluation:Pick<Evaluation,"outcome"|"httpValidation">,pdfsComplete:boolean):RunStatus{
  if(evaluation.outcome==="CANCELLED")return "CANCELLED";
  if(evaluation.outcome==="VALIDATION_ERROR")return "VALIDATION_ERROR";
  if(!evaluation.httpValidation?.performed||evaluation.outcome==="AUTOMATION_ERROR")return "AUTOMATION_ERROR";
  if(!evaluation.httpValidation.matches||evaluation.outcome==="FAILED")return "FAILED";
  return pdfsComplete?"PASSED":"COMPLETED";
}
