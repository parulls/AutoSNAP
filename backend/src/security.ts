import { createCipheriv, createDecipheriv, createHash, pbkdf2 as pbkdf2Callback, randomBytes, sign as signRsa, createHmac } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2=promisify(pbkdf2Callback);
export const secretFields=new Set(["clientSecret","privateKey","password","accessToken","customerToken","refreshToken","accountNo","bankCardToken","authCode"]);
export const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
export async function hashPassword(password:string,salt=randomBytes(16).toString("hex")){
  const hash=(await pbkdf2(password,Buffer.from(salt,"hex"),210000,32,"sha256")).toString("hex");
  return {salt,hash};
}
function key(){
  const value=process.env.AUTOSNAP_ENCRYPTION_KEY;
  if(!value)throw new Error("Set AUTOSNAP_ENCRYPTION_KEY sebelum menyimpan kredensial.");
  const bytes=Buffer.from(value,"base64");
  if(bytes.length!==32)throw new Error("AUTOSNAP_ENCRYPTION_KEY harus 32 byte dalam base64.");
  return bytes;
}
export function encrypt(value:string){
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(),iv);
  const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final(),cipher.getAuthTag()]);
  return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
}
export function decrypt(value:string){
  const [ivHex,encryptedHex]=value.split(":");
  if(!ivHex||!encryptedHex)throw new Error("Format kredensial terenkripsi tidak valid.");
  const bytes=Buffer.from(encryptedHex,"hex"),tag=bytes.subarray(bytes.length-16),ciphertext=bytes.subarray(0,bytes.length-16);
  const decipher=createDecipheriv("aes-256-gcm",key(),Buffer.from(ivHex,"hex"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8");
}
export function rsaSignature(privateKey:string,input:string,encoding:"hex"|"base64"="base64"){return signRsa("RSA-SHA256",Buffer.from(input),privateKey).toString(encoding);}
export function hmacSignature(secret:string,input:string,encoding:"hex"|"base64"="hex"){return createHmac("sha512",secret).update(input).digest(encoding);}
export function redact(value:unknown):unknown{
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/(authorization|cookie|token|secret|password|private.?key|signature|carddata|cardno|cardnumber|accountno|authcode|seamlessdata|seamlesssign|phone|msisdn|email|otp|pin)/i.test(k)?"[REDACTED]":redact(v)]));
  return value;
}
