function bounded(name:string,fallback:number,min:number,max:number){
  const value=Number(process.env[name]??fallback);
  return Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
}
export function pdfSettings(){return {
  // Per-PDF stage budget. Bank Statement needs up to 4 sequential downloads.
  requestTimeoutMs:bounded("AUTOSNAP_PDF_REQUEST_TIMEOUT_MS",60000,5000,90000),
  // Shared run budget must cover listing + 4 PDFs with one alternate-strategy retry each.
  budgetMs:bounded("AUTOSNAP_PDF_BUDGET_MS",300000,10000,480000),
  concurrency:Math.floor(bounded("AUTOSNAP_PDF_CONCURRENCY",1,1,2)),
};}
