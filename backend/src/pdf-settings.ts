function bounded(name:string,fallback:number,min:number,max:number){
  const value=Number(process.env[name]??fallback);
  return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
}
export function pdfSettings(){return {
  // ASPI HTML shell + client-side blob PDF often needs >30s end-to-end.
  requestTimeoutMs:bounded("AUTOSNAP_PDF_REQUEST_TIMEOUT_MS",45000,5000,60000),
  budgetMs:bounded("AUTOSNAP_PDF_BUDGET_MS",180000,10000,240000),
  concurrency:Math.floor(bounded("AUTOSNAP_PDF_CONCURRENCY",1,1,2)),
};}
