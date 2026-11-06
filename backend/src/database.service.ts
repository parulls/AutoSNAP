import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type RecordRow = { id:string;kind:string;name:string;parent_id:string|null;partner_id:string|null;data:Record<string,unknown>;created_at:string;updated_at:string };
export type QueryRows = <R extends object = Record<string,unknown>>(sql:string,params?:unknown[])=>Promise<R[]>;
export type RunRow = { id:string;client_id:string;project_id:string;environment_id:string;user_id:string|null;service_id:string;endpoint_id:string;scenario_id:string|null;mode:string;status:string;http_status:number|null;response_code:string|null;expected_code:string|null;duration_ms:number|null;request_json:unknown;response_json:unknown;notes:string;created_at:string };
type CatalogItem = {code:string;name:string;method:string;endpoint:string;sourcePage:number;module:string;group:string;auth:string};

function defaultBody(code:string):Record<string,unknown>{
  if(code==="11")return {partnerReferenceNo:"{{partner_reference_no}}",accountNo:"",balanceTypes:["Cash","Coins"],additionalInfo:{}};
  if(code==="12")return {partnerReferenceNo:"{{partner_reference_no}}",accountNo:"20001001",pageSize:10,pageNumber:1,additionalInfo:{}};
  if(code==="13")return {originalReferenceNo:"{{reference_no}}",originalPartnerReferenceNo:"{{partner_reference_no}}",additionalInfo:{}};
  if(code==="14")return {partnerReferenceNo:"{{partner_reference_no}}",accountNo:"2000200202",additionalInfo:{}};
  if(code==="73")return {grantType:"client_credentials",additionalInfo:{}};
  if(code==="74")return {grantType:"AUTHORIZATION_CODE",authCode:"{{authorization_code}}",additionalInfo:{}};
  return {partnerReferenceNo:"{{partner_reference_no}}",additionalInfo:{}};
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool:Pool|null=null;
  private embedded:PGlite|null=null;

  async onModuleInit(){
    if(process.env.DATABASE_URL){
      this.pool=new Pool({
        connectionString:process.env.DATABASE_URL,
        max:Number(process.env.DATABASE_POOL_MAX??5),
        connectionTimeoutMillis:15_000,
        idleTimeoutMillis:30_000,
        keepAlive:true,
        allowExitOnIdle:true,
      });
      await this.pool.query("SELECT 1");
    }else{
      this.embedded=new PGlite(process.env.AUTOSNAP_PGLITE_DIR || join(process.cwd(),".autosnap-pg"));
      await this.embedded.waitReady;
    }
    await this.schema();
    await this.seed();
    await this.normalizeCatalogNames();
    await this.upgradeBalanceTemplate();
    await this.upgradePortalUrls();
    await this.upgradeDevSiteModel();
  }
  async onModuleDestroy(){await this.pool?.end();await this.embedded?.close();}
  async query<T extends object=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<T[]>{
    if(this.pool)return (await this.pool.query(sql,params)).rows as T[];
    if(this.embedded)return (await this.embedded.query<T>(sql,params)).rows;
    throw new Error("Database belum siap.");
  }
  async one<T extends object=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<T|null>{return (await this.query<T>(sql,params))[0]??null;}
  async transaction<T>(callback:(query:QueryRows)=>Promise<T>):Promise<T>{
    if(this.pool){
      const client=await this.pool.connect();
      try{
        await client.query("BEGIN");
        const query:QueryRows=async<R extends object>(sql:string,params:unknown[]=[]) => (await client.query(sql,params)).rows as R[];
        const result=await callback(query);
        await client.query("COMMIT");
        return result;
      }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    }
    if(this.embedded)return this.embedded.transaction(async tx=>{
      const query:QueryRows=async<R extends object>(sql:string,params:unknown[]=[]) => (await tx.query<R>(sql,params)).rows;
      return callback(query);
    });
    throw new Error("Database belum siap.");
  }
  private async schema(){
    const statements=[
      `CREATE TABLE IF NOT EXISTS autosnap_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `ALTER TABLE autosnap_users ADD COLUMN IF NOT EXISTS username TEXT`,
      `ALTER TABLE autosnap_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'tester'`,
      `ALTER TABLE autosnap_users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`,
      `UPDATE autosnap_users SET username=LOWER(email) WHERE username IS NULL`,
      `CREATE UNIQUE INDEX IF NOT EXISTS autosnap_users_username ON autosnap_users (LOWER(username))`,
      `UPDATE autosnap_users SET role='admin' WHERE id=(SELECT id FROM autosnap_users ORDER BY created_at,id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM autosnap_users WHERE role='admin')`,
      `CREATE TABLE IF NOT EXISTS autosnap_captchas (id TEXT PRIMARY KEY,answer_hash TEXT NOT NULL,expires_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS autosnap_sessions (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES autosnap_users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS autosnap_records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,parent_id TEXT,partner_id TEXT UNIQUE,data JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS autosnap_records_kind ON autosnap_records(kind)`,
      `CREATE INDEX IF NOT EXISTS autosnap_records_parent ON autosnap_records(parent_id)`,
      `CREATE TABLE IF NOT EXISTS autosnap_runs (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,project_id TEXT NOT NULL,environment_id TEXT NOT NULL,user_id TEXT,service_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,scenario_id TEXT,mode TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,response_code TEXT,expected_code TEXT,duration_ms INTEGER,request_json JSONB NOT NULL,response_json JSONB NOT NULL,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS autosnap_runs_created ON autosnap_runs(created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS autosnap_external_ids (environment_id TEXT NOT NULL,external_id TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(environment_id,external_id,day))`,
    ];
    for(const statement of statements)await this.query(statement);
  }
  private async seed(){
    const count=await this.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_records WHERE kind='service'");
    if(Number(count?.n))return;
    const catalog=JSON.parse(await readFile(join(process.cwd(),"app","snap-spec-catalog.json"),"utf8")) as CatalogItem[];
    const now=new Date().toISOString();
    for(const [index,item] of catalog.entries()){
      const serviceId=`seed-service-${index}`,endpointId=`seed-endpoint-${index}`;
      const descriptions:Record<string,string>={"11":"Mengakses informasi saldo terkini atas rekening yang diizinkan.","12":"Mengambil daftar transaksi dengan rentang waktu maksimal satu bulan dan pageSize maksimal 50.","73":"Memperoleh access token B2B menggunakan signature RSA SHA-256.","74":"Memperoleh access token konsumen melalui authorization code atau refresh token."};
      const name=item.code==="71"?"Trigger Direct Debit Transfer":item.code==="72"?"Direct Debit BI-FAST Notification":item.name;
      const entries=[
        {id:serviceId,kind:"service",name,parent:null,data:{module:item.module,group:item.group,code:item.code,auth:item.auth,description:descriptions[item.code]??`${name} sesuai spesifikasi SNAP.`,sourcePage:item.sourcePage}},
        {id:endpointId,kind:"endpoint",name,parent:serviceId,data:{method:item.method,path:item.endpoint,configured:true,...(item.code==="11"?{portalUrl:"https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry"}:{})}},
        {id:`seed-template-${index}`,kind:"template",name:`${name} - default`,parent:endpointId,data:{body:JSON.stringify(defaultBody(item.code),null,2),headers:{}}},
      ];
      for(const entry of entries)await this.query("INSERT INTO autosnap_records (id,kind,name,parent_id,partner_id,data,created_at,updated_at) VALUES ($1,$2,$3,$4,NULL,$5::jsonb,$6,$6) ON CONFLICT (id) DO NOTHING",[entry.id,entry.kind,entry.name,entry.parent,JSON.stringify(entry.data),now]);
    }
  }
  private async upgradeBalanceTemplate(){
    // Migrate only untouched, known seed examples; custom templates remain unchanged.
    const body=JSON.stringify(defaultBody("11"),null,2);
    const previous=[
      {partnerReferenceNo:"{{partner_reference_no}}",accountNo:"20001001",balanceTypes:["Cash"],additionalInfo:{}},
      {partnerReferenceNo:"{{partner_reference_no}}",accountNo:"2000100101",balanceTypes:["Cash","Coins"],additionalInfo:{}},
    ].map(value=>JSON.stringify(value,null,2));
    await this.query("UPDATE autosnap_records SET data=jsonb_set(data,'{body}',$1::jsonb),updated_at=$2 WHERE id='seed-template-10' AND data->>'body'=ANY($3::text[])",[JSON.stringify(body),new Date().toISOString(),previous]);
  }
  private async upgradePortalUrls(){
    const url="https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry";
    await this.query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE kind='endpoint' AND data->>'path'='/api/v1.0/balance-inquiry' AND COALESCE(data->>'portalUrl','')=''",[JSON.stringify({portalUrl:url}),new Date().toISOString()]);
    await this.query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE kind='environment' AND data->>'category'='Dev Site'",[JSON.stringify({securityPortalUrl:"https://apidevportal.aspi-indonesia.or.id/api-services/keamanan",rsaEncoding:"base64",hmacEncoding:"hex"}),new Date().toISOString()]);
  }
  private async upgradeDevSiteModel(){
    // Preserve IDs/history while converting the old Service -> Endpoint links.
    await this.transaction(async query=>{
      const rows=await query<RecordRow>("SELECT * FROM autosnap_records");
      for(const service of rows.filter(row=>row.kind==="service"&&!row.parent_id)){
        const endpoints=rows.filter(row=>row.kind==="endpoint"&&row.parent_id===service.id);
        // Ambiguous legacy relationships are left for explicit selection in Master Data.
        if(endpoints.length!==1)continue;
        const endpoint=endpoints[0],template=rows.find(row=>row.kind==="template"&&row.parent_id===endpoint.id);
        const patch:Record<string,unknown>={};
        if(!service.data.requestBody&&template?.data.body)patch.requestBody=template.data.body;
        await query("UPDATE autosnap_records SET parent_id=$1,data=data || $2::jsonb WHERE id=$3",[endpoint.id,JSON.stringify(patch),service.id]);
        await query("UPDATE autosnap_records SET parent_id=NULL WHERE id=$1",[endpoint.id]);
      }
      for(const site of rows.filter(row=>row.kind==="environment"&&row.data.category==="Dev Site"&&!row.data.defaultUserId)){
        const users=rows.filter(row=>row.kind==="snap_user"&&row.parent_id===site.parent_id);
        if(users.length===1)await query("UPDATE autosnap_records SET data=data || $1::jsonb WHERE id=$2",[JSON.stringify({defaultUserId:users[0].id}),site.id]);
      }
    });
  }
  private async normalizeCatalogNames(){
    const now=new Date().toISOString();
    await this.query(
      "UPDATE autosnap_records SET name=REPLACE(name,$1,$2),updated_at=$3 WHERE kind IN ('service','endpoint','template') AND POSITION($1 IN name)>0",
      ["�","–",now],
    );
  }
}
