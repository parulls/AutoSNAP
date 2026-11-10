import { NextRequest } from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";

async function forward(request:NextRequest){
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return Response.json({error:"Origin tidak diizinkan."},{status:403});
  const port=Number(process.env.AUTOSNAP_API_PORT??4010);
  const apiBaseUrl=(process.env.AUTOSNAP_API_BASE_URL??`http://127.0.0.1:${port}`).replace(/\/$/,"");
  const headers=new Headers({"Content-Type":"application/json","X-AutoSnap-Host":new URL(request.url).hostname,"X-AutoSnap-Proto":new URL(request.url).protocol.replace(":","")});
  const cookie=request.headers.get("cookie");if(cookie)headers.set("Cookie",cookie);
  const timeoutMs=request.method==="POST"
    ?Math.max(180000,Number(process.env.AUTOSNAP_PROXY_TIMEOUT_MS??600000))
    :30000;
  try{
    const upstream=await fetch(`${apiBaseUrl}/autosnap`,{method:request.method,headers,body:request.method==="POST"?await request.text():undefined,cache:"no-store",signal:AbortSignal.timeout(timeoutMs)});
    const responseHeaders=new Headers({"Content-Type":upstream.headers.get("content-type")??"application/json","Cache-Control":"no-store"});
    const disposition=upstream.headers.get("content-disposition");if(disposition)responseHeaders.set("Content-Disposition",disposition);
    for(const value of upstream.headers.getSetCookie())responseHeaders.append("Set-Cookie",value);
    return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
  }catch(error){
    if(error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError")){
      return Response.json({error:`Proses testing belum selesai dalam ${Math.round(timeoutMs/60000)} menit. Backend tetap berjalan; periksa History Testing sebelum mencoba ulang agar request tidak terkirim dua kali.`,code:"UPSTREAM_TIMEOUT"},{status:504});
    }
    const detail=error instanceof Error?error.message:"Koneksi ke backend gagal.";
    return Response.json({error:`Backend AutoSNAP tidak dapat dihubungi di ${apiBaseUrl}. Pastikan backend NestJS aktif dan AUTOSNAP_API_BASE_URL benar.`,code:"BACKEND_UNREACHABLE",detail},{status:503});
  }
}
export const GET=forward;
export const POST=forward;
