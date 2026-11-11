import { NextRequest } from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;

async function readBoundedBody(request:NextRequest){
  const reader=request.body?.getReader();
  if(!reader)return "";
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>256*1024){await reader.cancel();throw new RangeError("Body too large");}chunks.push(item.value);}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString("utf8");
}

async function forward(request:NextRequest){
  const origin=request.headers.get("origin");
  if((origin&&origin!==new URL(request.url).origin)||request.headers.get("sec-fetch-site")==="cross-site")return Response.json({error:"Origin tidak diizinkan."},{status:403});
  if(request.method==="POST"&&!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type")??""))return Response.json({error:"Content-Type harus application/json."},{status:415});
  const internalToken=process.env.AUTOSNAP_INTERNAL_TOKEN;
  if(process.env.NODE_ENV==="production"&&(!internalToken||internalToken.length<32))return Response.json({error:"Konfigurasi keamanan server belum lengkap."},{status:503});
  const port=Number(process.env.AUTOSNAP_API_PORT??4010);
  const apiBaseUrl=(process.env.AUTOSNAP_API_BASE_URL??`http://127.0.0.1:${port}`).replace(/\/$/,"");
  const headers=new Headers({"Content-Type":"application/json","X-AutoSnap-Host":new URL(request.url).hostname,"X-AutoSnap-Proto":new URL(request.url).protocol.replace(":","")});
  if(internalToken)headers.set("X-AutoSnap-Internal-Token",internalToken);
  // Vercel overwrites its own forwarded IP header; never forward client proxy headers.
  headers.set("X-AutoSnap-Client-IP",process.env.VERCEL?request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()??"unknown":"local");
  const cookie=request.headers.get("cookie");if(cookie)headers.set("Cookie",cookie);
  const timeoutMs=request.method==="POST"
    ?Math.max(180000,Number(process.env.AUTOSNAP_PROXY_TIMEOUT_MS??600000))
    :30000;
  try{
    const backendUrl=new URL(apiBaseUrl);
    if(backendUrl.username||backendUrl.password||(process.env.VERCEL&&backendUrl.protocol!=="https:"))throw new Error("Invalid backend URL");
    const upstream=await fetch(`${apiBaseUrl}/autosnap`,{method:request.method,headers,body:request.method==="POST"?await readBoundedBody(request):undefined,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(timeoutMs)});
    const responseHeaders=new Headers({"Content-Type":upstream.headers.get("content-type")??"application/json","Cache-Control":"no-store"});
    const disposition=upstream.headers.get("content-disposition");if(disposition)responseHeaders.set("Content-Disposition",disposition);
    for(const value of upstream.headers.getSetCookie())responseHeaders.append("Set-Cookie",value);
    return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
  }catch(error){
    if(error instanceof RangeError)return Response.json({error:"Ukuran request maksimal 256 KB."},{status:413});
    if(error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError")){
      return Response.json({error:`Proses testing belum selesai dalam ${Math.round(timeoutMs/60000)} menit. Backend tetap berjalan; periksa History Testing sebelum mencoba ulang agar request tidak terkirim dua kali.`,code:"UPSTREAM_TIMEOUT"},{status:504});
    }
    return Response.json({error:"Backend AutoSNAP tidak dapat dihubungi. Pastikan backend NestJS aktif dan konfigurasi API benar.",code:"BACKEND_UNREACHABLE"},{status:503});
  }
}
export const GET=forward;
export const POST=forward;
