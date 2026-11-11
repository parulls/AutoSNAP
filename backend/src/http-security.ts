import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/** Only the trusted frontend server may supply proxy context to the API. */
export function requireTrustedProxy(req:Request,res:Response,next:NextFunction){
  res.setHeader("Cache-Control","no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  const secret=process.env.AUTOSNAP_INTERNAL_TOKEN;
  if(!secret&&process.env.NODE_ENV!=="production")return next();
  if(!secret||secret.length<32)return res.status(503).json({error:"Konfigurasi keamanan backend belum lengkap."});
  const supplied=req.headers["x-autosnap-internal-token"];
  const actual=Buffer.from(typeof supplied==="string"?supplied:"");
  const expected=Buffer.from(secret);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(403).json({error:"Akses backend tidak diizinkan."});
  return next();
}

export function clientAddress(req:Request){
  // Never trust arbitrary X-Forwarded-For sent directly to a public backend.
  return process.env.AUTOSNAP_INTERNAL_TOKEN
    ?String(req.headers["x-autosnap-client-ip"]??"unknown").slice(0,80)
    :req.ip??"local";
}
