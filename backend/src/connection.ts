import { randomUUID } from "node:crypto";
import type { DatabaseService, RecordRow } from "./database.service";
import { object, validateHeaderProfile } from "./balance";
import { encrypt } from "./security";

const fail=(error:string,status=400):never=>{throw {error,status};};
const text=(value:unknown)=>typeof value==="string"?value.trim():"";
const mask="••••••••";

/** Save the existing Client -> Project -> Environment model with a single atomic form. */
export async function saveConnection(db:DatabaseService,input:Record<string,unknown>){
  const incomingClient=object(input.client)?input.client:{};
  const incomingEnvironment=object(input.environment)?input.environment:{};
  return db.transaction(async query=>{
    const rows=await query<RecordRow>("SELECT * FROM autosnap_records WHERE kind IN ('client','project','environment','snap_user') FOR UPDATE");
    const environmentId=text(input.environmentId);
    const oldEnvironment=rows.find(x=>x.id===environmentId&&x.kind==="environment");
    if(environmentId&&!oldEnvironment)fail("Koneksi tidak ditemukan. Muat ulang halaman.",404);
    const oldProject=oldEnvironment?rows.find(x=>x.id===oldEnvironment.parent_id&&x.kind==="project"):undefined;
    const oldClient=oldProject?rows.find(x=>x.id===oldProject.parent_id&&x.kind==="client"):undefined;
    if(oldEnvironment&&(!oldProject||!oldClient))fail("Relasi koneksi tidak lengkap. Periksa Master Data.");
    const name=text(input.name)||oldEnvironment?.name||"";
    if(!name)fail("Isi nama Dev Site Client.");
    if(name.length>120)fail("Nama koneksi maksimal 120 karakter.");
    const environment={...(oldEnvironment?.data??{})};
    for(const field of ["mode","executionMode","useCase","baseUrl","tokenPath","authFlow","rsaEncoding","hmacEncoding"])if(field in incomingEnvironment)environment[field]=text(incomingEnvironment[field]);
    environment.category="Dev Site";
    environment.mode=environment.mode||"portal";
    if(environment.mode==="portal"){
      delete environment.securityPortalUrl;
      delete environment.rsaEncoding;
      delete environment.hmacEncoding;
    }
    environment.useCase="B2B";
    environment.authFlow="token_b2b";
    if(!["portal","live","mock"].includes(String(environment.mode)))fail("Mode Dev Site tidak valid.");
    if(!["B2B","B2B2C"].includes(String(environment.useCase)))fail("Pilih use case B2B atau B2B2C.");
    if(!["token_b2b","provided_token"].includes(String(environment.authFlow)))fail("Koneksi saldo memerlukan token B2B otomatis atau token tersimpan.");
    if(environment.mode!=="portal")for(const field of ["rsaEncoding","hmacEncoding"])if(environment[field]&&!["hex","base64"].includes(String(environment[field])))fail("Encoding signature harus hex atau base64.");
    if(environment.mode==="live"&&environment.baseUrl){
      let url:URL;try{url=new URL(text(environment.baseUrl));}catch{fail("Base URL API langsung tidak valid.");}
      if(url!.protocol!=="https:"||url!.username||url!.password||url!.search||url!.hash)fail("Base URL API langsung harus HTTPS tanpa query atau fragment.");
    }
    const requestedSource=text(incomingClient.partnerIdSource)||String(oldClient?.data.partnerIdSource??"client_id");
    const requestedPartner=requestedSource==="client_id"?text(incomingClient.clientId):text(incomingClient.partnerId);
    const reusableClient=!oldClient&&requestedPartner?rows.find(x=>x.kind==="client"&&x.partner_id===requestedPartner):undefined;
    const reusableProjects=reusableClient?rows.filter(x=>x.kind==="project"&&x.parent_id===reusableClient.id):[];
    const reusableProject=!oldProject&&reusableClient?reusableProjects.find(project=>!rows.some(x=>x.kind==="environment"&&x.parent_id===project.id)):undefined;
    const existingEnvironment=reusableProjects.map(project=>rows.find(x=>x.kind==="environment"&&x.parent_id===project.id)).find(Boolean);
    if(reusableClient&&existingEnvironment)fail(`Client ID sudah digunakan oleh Dev Site Client ${existingEnvironment.name}. Edit data tersebut.`,409);
    const baseClient=oldClient??reusableClient,baseProject=oldProject??reusableProject;
    const client={...(baseClient?.data??{})};
    for(const field of ["clientId","channelId","deviceId","origin","ipAddress","latitude","longitude"])if(field in incomingClient)client[field]=text(incomingClient[field]);
    if(environment.mode==="portal")delete client.publicKey;
    client.channelId=client.channelId||"95221";
    if(client.clientId&&!/^[A-Za-z0-9._-]{1,36}$/.test(text(client.clientId)))fail("Client ID maksimal 36 karakter tanpa spasi.");
    if("partnerIdSource" in incomingClient)client.partnerIdSource=text(incomingClient.partnerIdSource);
    client.partnerIdSource=client.partnerIdSource||"client_id";
    if(!["client_id","custom"].includes(String(client.partnerIdSource)))fail("Sumber Partner ID tidak valid.");
    const partnerId=(client.partnerIdSource==="client_id"?text(client.clientId):("partnerId" in incomingClient?text(incomingClient.partnerId):baseClient?.partner_id))||null;
    if(partnerId&&!/^[A-Za-z0-9._-]{1,36}$/.test(partnerId))fail("Partner ID maksimal 36 karakter tanpa spasi.");
    if(partnerId&&rows.some(x=>x.kind==="client"&&x.partner_id===partnerId&&x.id!==baseClient?.id))fail("Client ID / Partner ID sudah tersimpan pada client lain.",409);
    const errors=validateHeaderProfile(client);if(errors.length)fail(errors.join(" "));
    if(text(client.channelId).length>5)fail("CHANNEL-ID maksimal 5 karakter.");
    for(const field of ["clientSecret","privateKey"]){
      const value=text(incomingClient[field]);
      if(value&&value!==mask)client[field]=encrypt(value);
    }
    const clientId=baseClient?.id??randomUUID(),projectId=baseProject?.id??randomUUID(),id=oldEnvironment?.id??randomUUID();
    if(text(incomingClient.appName).length>120)fail("Nama aplikasi maksimal 120 karakter.");
    const userId=text(input.userId)||text(environment.defaultUserId);
    const oldUser=rows.find(x=>x.id===userId&&x.kind==="snap_user");
    if(!oldUser)fail("Pilih User SNAP sebelum menyimpan Dev Site Client.");
    const savedUserId=oldUser!.id;
    environment.defaultUserId=savedUserId;
    const now=new Date().toISOString();
    const write=async(recordId:string,kind:string,recordName:string,parentId:string|null,partner:string|null,data:Record<string,unknown>)=>{
      await query("INSERT INTO autosnap_records (id,kind,name,parent_id,partner_id,data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,parent_id=EXCLUDED.parent_id,partner_id=EXCLUDED.partner_id,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at",[recordId,kind,recordName,parentId,partner,JSON.stringify(data),now]);
    };
    try{
      await write(clientId,"client",text(incomingClient.appName)||oldClient?.name||name,null,partnerId!,client);
      if(!baseProject)await write(projectId,"project",name,clientId,null,{description:"Pengujian Balance Inquiry"});
      await write(id,"environment",name,projectId,null,environment);
    }catch(error){if((error as {code?:string}).code==="23505")fail("Client ID sudah digunakan. Pilih koneksi yang telah tersimpan.",409);throw error;}
    return {ok:true,id,clientId,projectId,userId:savedUserId??null};
  });
}
