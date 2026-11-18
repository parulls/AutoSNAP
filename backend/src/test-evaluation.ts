export const notEvaluatedMessage={
  detail:"Pengujian telah dieksekusi, tetapi hasil belum dapat dievaluasi karena Expected SNAP responseCode belum ditentukan.",
  suggestion:"Konfigurasikan Expected SNAP responseCode sesuai dokumentasi ASPI SNAP dan skenario pengujian."
};
export const passedHttpMessage={detail:"API mengembalikan HTTP 200. Pengujian berhasil pada level HTTP; validasi SNAP belum dilakukan karena Expected SNAP responseCode belum ditentukan.",suggestion:notEvaluatedMessage.suggestion};
export type ResultCheck={label:string;passed:boolean|null;detail:string};
export type Evaluation={outcome:"PASSED"|"FAILED"|"PASSED_HTTP"|"NOT_EVALUATED"|"NOT_EXECUTED"|"CANCELLED";snapValidationPerformed:boolean;stage:"evaluation";stageLabel:"Validasi Hasil";detail:string;suggestion:string};
export const isHttpResponse=(status:unknown):status is number=>typeof status==="number"&&Number.isInteger(status)&&status>=100&&status<=599;

/** Execution success and test evaluation are separate. Never infer expected from actual/HTTP. */
export function evaluateTest(input:{httpStatus:number|null;actualCode:string|null;expectedCode:string|null;checks:ResultCheck[];cancelled:boolean}):{status:"Passed"|"Failed"|"PASSED_HTTP"|"NOT_EVALUATED"|"Cancelled";evaluation:Evaluation}{
  const base={stage:"evaluation",stageLabel:"Validasi Hasil",snapValidationPerformed:false} as const;
  if(input.cancelled)return {status:"Cancelled",evaluation:{...base,outcome:"CANCELLED",detail:"Pengujian dibatalkan pengguna.",suggestion:"Periksa request yang sudah terkirim pada History Testing sebelum mencoba ulang."}};
  if(!isHttpResponse(input.httpStatus))return {status:"Failed",evaluation:{...base,outcome:"NOT_EXECUTED",detail:"API target belum memberikan HTTP response; hasil belum dapat dievaluasi.",suggestion:"Periksa tahap gagal, sesi ASPI, dan koneksi sebelum mencoba kembali."}};
  if(!input.expectedCode)return input.httpStatus===200?{status:"PASSED_HTTP",evaluation:{...base,outcome:"PASSED_HTTP",...passedHttpMessage}}:{status:"NOT_EVALUATED",evaluation:{...base,outcome:"NOT_EVALUATED",...notEvaluatedMessage}};
  const passed=input.actualCode===input.expectedCode&&input.checks.every(check=>check.passed!==false);
  return {status:passed?"Passed":"Failed",evaluation:{...base,snapValidationPerformed:true,outcome:passed?"PASSED":"FAILED",detail:passed?"Hasil sesuai ekspektasi.":"Hasil tidak sesuai ekspektasi.",suggestion:passed?"":"Periksa actual response dan detail validasi terhadap ekspektasi skenario."}};
}
