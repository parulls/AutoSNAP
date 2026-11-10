import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type RecordRow = { id:string;kind:string;name:string;parent_id:string|null;partner_id:string|null;data:Record<string,unknown>;created_at:string;updated_at:string };
export type QueryRows = <R extends object = Record<string,unknown>>(sql:string,params?:unknown[])=>Promise<R[]>;
export type RunRow = { id:string;client_id:string;project_id:string;environment_id:string;user_id:string|null;service_id:string;endpoint_id:string;scenario_id:string|null;mode:string;status:string;http_status:number|null;response_code:string|null;expected_code:string|null;duration_ms:number|null;request_json:unknown;response_json:unknown;notes:string;created_at:string };
type CatalogItem = {code:string;name:string;method:string;endpoint:string;sourcePage:number;module:string;group:string;auth:string};

function defaultBody(code:string):Record<string,unknown>{
  if(code==="11")return {partnerReferenceNo:"{{partner_reference_no}}",bankCardToken:"6d7963617264746f6b656e",accountNo:"2000100101",balanceTypes:["Cash","Coins"],additionalInfo:{deviceId:"12345679237",channel:"mobilephone"}};
  return {partnerReferenceNo:"{{partner_reference_no}}",additionalInfo:{}};
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool:Pool|null=null;
  private embedded:PGlite|null=null;

  async onModuleInit(){
    if(process.env.NODE_ENV==="test"&&process.env.AUTOSNAP_TEST_PGLITE){
      this.embedded=new PGlite(process.env.AUTOSNAP_TEST_PGLITE);
      await this.embedded.waitReady;
    }else{
      const connectionString=process.env.DATABASE_URL;
      if(!connectionString)throw new Error("DATABASE_URL Supabase wajib tersedia. Tidak ada fallback database lokal.");
      this.pool=new Pool({connectionString,max:Number(process.env.DATABASE_POOL_MAX??5),connectionTimeoutMillis:15_000,idleTimeoutMillis:30_000,keepAlive:true,allowExitOnIdle:true,options:"-c search_path=autosnap,public"});
      await this.pool.query("SELECT 1");
    }
    await this.migrate();
    // Data contoh hanya tersedia pada database test terisolasi. Database runtime mulai kosong.
    if(this.embedded)await this.seed();
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
  private async migrate(){
    const directory=join(process.cwd(),"migrations"),files=(await readdir(directory)).filter(file=>/^\d+.*\.sql$/.test(file)).sort();
    await this.query("CREATE TABLE IF NOT EXISTS autosnap_migrations (name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const file of files){
      if(await this.one("SELECT name FROM autosnap_migrations WHERE name=$1",[file]))continue;
      const sql=await readFile(join(directory,file),"utf8");
      if(this.embedded){
        await this.embedded.transaction(async tx=>{
          await tx.exec(sql);
          await tx.query("INSERT INTO autosnap_migrations (name,applied_at) VALUES ($1,$2)",[file,new Date().toISOString()]);
        });
      }else{
        await this.transaction(async query=>{await query(sql);await query("INSERT INTO autosnap_migrations (name,applied_at) VALUES ($1,$2)",[file,new Date().toISOString()]);});
      }
    }
    await this.query("UPDATE autosnap_users SET role='admin' WHERE id=(SELECT id FROM autosnap_users ORDER BY created_at,id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM autosnap_users WHERE role='admin')");
  }
  private async seed(){
    const catalog=JSON.parse(await readFile(join(process.cwd(),"app","snap-spec-catalog.json"),"utf8")) as CatalogItem[];
    const now=new Date().toISOString();
    for(const [index,item] of catalog.entries()){
      if(item.code!=="11")continue;
      const serviceId=`seed-service-${index}`,endpointId=`seed-endpoint-${index}`;
      const description="Mengakses informasi saldo terkini atas rekening yang diizinkan.";
      const name=item.name;
      const entries=[
        {id:serviceId,kind:"service",name,parent:null,data:{module:item.module,group:item.group,code:item.code,auth:item.auth,description,sourcePage:item.sourcePage}},
        {id:endpointId,kind:"endpoint",name,parent:serviceId,data:{method:item.method,path:item.endpoint,configured:true,...(item.code==="11"?{portalUrl:"https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo#/BalanceInquiry/post_api_v1_0_balance_inquiry"}:{})}},
        {id:`seed-template-${index}`,kind:"template",name:`${name} - default`,parent:endpointId,data:{body:JSON.stringify(defaultBody(item.code),null,2),headers:{}}},
      ];
      for(const entry of entries)await this.query("INSERT INTO autosnap_records (id,kind,name,parent_id,partner_id,data,created_at,updated_at) VALUES ($1,$2,$3,$4,NULL,$5::jsonb,$6,$6) ON CONFLICT (id) DO NOTHING",[entry.id,entry.kind,entry.name,entry.parent,JSON.stringify(entry.data),now]);
    }
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
      for(const site of rows.filter(row=>row.kind==="environment"&&row.data.category!=="Client Simulator"&&!row.data.defaultUserId)){
        const users=rows.filter(row=>row.kind==="snap_user"&&row.parent_id===site.parent_id);
        if(users.length===1)await query("UPDATE autosnap_records SET data=data || $1::jsonb WHERE id=$2",[JSON.stringify({defaultUserId:users[0].id}),site.id]);
      }
      // Normalisasi koneksi lama agar tetap muncul pada UI Dev Site.
      for(const site of rows.filter(row=>row.kind==="environment"&&row.data.category!=="Client Simulator")){
        const project=rows.find(row=>row.id===site.parent_id&&row.kind==="project");
        const client=project&&rows.find(row=>row.id===project.parent_id&&row.kind==="client");
        if(project&&client&&site.data.category!=="Dev Site")await query("UPDATE autosnap_records SET data=data || $1::jsonb,updated_at=$2 WHERE id=$3",[JSON.stringify({category:"Dev Site"}),new Date().toISOString(),site.id]);
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
