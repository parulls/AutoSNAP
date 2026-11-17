import type { State } from "./model";

export class ApiError extends Error{
  constructor(message:string,readonly status:number,readonly code:string){super(message);this.name="ApiError";}
}

async function readResponse(response:Response){
  const raw=await response.text();
  const code=response.status===504?"UPSTREAM_TIMEOUT":response.status===503?"BACKEND_UNREACHABLE":"INVALID_RESPONSE";
  if(!raw.trim())throw new ApiError(`API memberikan respons kosong (HTTP ${response.status}).`,response.status,code);
  try{return JSON.parse(raw) as Record<string,unknown>;}
  catch{throw new ApiError(`Respons API bukan JSON valid (HTTP ${response.status}). Periksa status server dan History Testing.`,response.status,code);}
}
export async function api(action:string,payload:Record<string,unknown>={}){
  const response=await fetch("/api/autosnap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,...payload})});
  const result=await readResponse(response);
  if(!response.ok)throw new ApiError(String(result.error??`HTTP ${response.status}`),response.status,String(result.code??(response.status===504?"UPSTREAM_TIMEOUT":response.status===400||response.status===422?"VALIDATION_ERROR":"HTTP_ERROR")));
  return result;
}
export async function fetchState(){
  const response=await fetch("/api/autosnap",{cache:"no-store"}),result=await readResponse(response);
  if(!response.ok)throw new ApiError(String(result.error??`HTTP ${response.status}`),response.status,String(result.code??"HTTP_ERROR"));
  return result as unknown as State;
}
