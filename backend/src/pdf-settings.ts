function bounded(name:string,fallback:number,min:number,max:number){
  const value=Number(process.env[name]??fallback);
  return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
}
export function pdfSettings(){return {
  requestTimeoutMs:bounded("AUTOSNAP_PDF_REQUEST_TIMEOUT_MS",30000,5000,45000),
  budgetMs:bounded("AUTOSNAP_PDF_BUDGET_MS",120000,10000,120000),
  concurrency:Math.floor(bounded("AUTOSNAP_PDF_CONCURRENCY",1,1,2)),
};}
