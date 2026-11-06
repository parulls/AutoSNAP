import pg from "pg";
import {existsSync} from "node:fs";
import {join,resolve} from "node:path";

const root=resolve(import.meta.dirname,".."),envFile=join(root,".env.local");
if(existsSync(envFile))process.loadEnvFile(envFile);
const connectionString=String(process.env.DATABASE_URL??"").trim();
if(!connectionString)throw new Error("DATABASE_URL belum tersedia di .env.local.");
const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:15_000,allowExitOnIdle:true});
try{
  const info=(await pool.query("SELECT current_database() AS database,current_user AS username")).rows[0];
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'autosnap_%' ORDER BY tablename")).rows;
  process.stdout.write(`Neon terhubung ke database ${info.database} sebagai ${info.username}.\n`);
  for(const {tablename} of tables){
    const count=(await pool.query(`SELECT COUNT(*)::int AS count FROM ${tablename}`)).rows[0].count;
    process.stdout.write(`${tablename}: ${count} baris\n`);
  }
  if(!tables.length)process.stdout.write("Belum ada tabel AutoSNAP. Jalankan npm.cmd run dev satu kali untuk membuat schema.\n");
}finally{await pool.end();}
