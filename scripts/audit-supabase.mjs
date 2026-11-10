import { Pool } from "pg";
import process from "node:process";

process.loadEnvFile(".env.local");
if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL Supabase belum tersedia.");
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,allowExitOnIdle:true,options:"-c search_path=autosnap,public"});
try{
  const result=await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM autosnap_users)::int AS users,
      (SELECT COUNT(*) FROM autosnap_records)::int AS records,
      (SELECT COUNT(*) FROM autosnap_runs)::int AS runs,
      has_schema_privilege('anon','autosnap','USAGE') AS anon_access,
      has_schema_privilege('authenticated','autosnap','USAGE') AS authenticated_access
  `);
  console.log(JSON.stringify({projectRef:process.env.SUPABASE_PROJECT_REF,...result.rows[0]},null,2));
}finally{await pool.end();}
