import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root=process.cwd();
const envPath=join(root,".env.local");
const passwordPath=join(root,".secrets","supabase-db-password");
if(!existsSync(passwordPath))throw new Error("Password database Supabase lokal tidak ditemukan.");

const projectRef="hdbhycjmwuhvpgwojrjt";
const host="aws-1-ap-southeast-1.pooler.supabase.com";
const password=encodeURIComponent(readFileSync(passwordPath,"utf8").trim());
const databaseUrl=`postgresql://postgres.${projectRef}:${password}@${host}:5432/postgres?uselibpqcompat=true&sslmode=require`;
const removed=new Set([
  "DATABASE_URL_UNPOOLED","PGHOST","PGHOST_UNPOOLED","PGUSER","PGDATABASE","PGPASSWORD",
  "POSTGRES_URL","POSTGRES_URL_NON_POOLING","POSTGRES_USER","POSTGRES_HOST","POSTGRES_PASSWORD",
  "POSTGRES_DATABASE","POSTGRES_URL_NO_SSL","POSTGRES_PRISMA_URL",
]);
const values=new Map();
for(const line of existsSync(envPath)?readFileSync(envPath,"utf8").split(/\r?\n/):[]){
  const match=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if(match&&!removed.has(match[1]))values.set(match[1],match[2]);
}
values.set("DATABASE_URL",databaseUrl);
values.set("SUPABASE_PROJECT_REF",projectRef);
values.set("DATABASE_POOL_MAX","5");
values.set("AUTOSNAP_API_BASE_URL",values.get("AUTOSNAP_API_BASE_URL")??"http://127.0.0.1:4010");
writeFileSync(envPath,[...values].map(([key,value])=>`${key}=${value}`).join("\n")+"\n",{encoding:"utf8",mode:0o600});
console.log("Environment lokal sekarang memakai Supabase. Variabel koneksi Neon telah dihapus.");
