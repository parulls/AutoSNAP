import type { State } from "./model";

async function readResponse(response:Response){
  const raw=await response.text();
  if(!raw.trim())throw Error(`API memberikan respons kosong (HTTP ${response.status}).`);
  try{return JSON.parse(raw) as Record<string,unknown>;}
  catch{throw Error(`Respons API bukan JSON valid (HTTP ${response.status}). Jalankan ulang server AutoSNAP.`);}
}
export async function api(action:string,payload:Record<string,unknown>={}){
  const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,...payload})});
  const result=await readResponse(response);
  if(!response.ok)throw Error(String(result.error??`HTTP ${response.status}`));
  return result;
}
export async function fetchState(){
  const response=await fetch("/api/autosnap",{cache:"no-store"}),result=await readResponse(response);
  if(!response.ok)throw Error(String(result.error??`HTTP ${response.status}`));
  return result as unknown as State;
}
