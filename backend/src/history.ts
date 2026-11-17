import type {DatabaseService,RunRow} from "./database.service";

function dateStart(raw:unknown){
  if(typeof raw!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw {status:400,error:"Isi tanggal awal dan akhir yang valid."};
  const utc=Date.parse(`${raw}T00:00:00+07:00`);
  if(!Number.isFinite(utc)||new Date(utc+7*3600000).toISOString().slice(0,10)!==raw)throw {status:400,error:"Tanggal history tidak valid."};
  return utc;
}

export async function readHistory(db:DatabaseService,userId:string,input:Record<string,unknown>){
  const start=dateStart(input.from),last=dateStart(input.to);
  if(start>last)throw {status:400,error:"Tanggal awal tidak boleh melewati tanggal akhir."};
  const mode=String(input.mode??"all");
  if(!["all","dev_site","simulator"].includes(mode))throw {status:400,error:"Kategori history tidak valid."};
  const limit=Math.min(100,Math.max(1,Number(input.limit)||20)),offset=Math.max(0,Number(input.offset)||0);
  if(!Number.isInteger(limit)||!Number.isInteger(offset)||offset>1000000)throw {status:400,error:"Halaman history tidak valid."};
  const params:unknown[]=[userId,new Date(start).toISOString(),new Date(last+24*3600000).toISOString()];
  let where="operator_id=$1 AND created_at >= $2 AND created_at < $3";
  if(mode==="dev_site")where+=" AND mode<>'mock'";
  if(mode==="simulator")where+=" AND mode='mock'";
  const search=String(input.search??"").trim();
  if(search.length>120)throw {status:400,error:"Pencarian maksimal 120 karakter."};
  if(search){params.push(`%${search.replace(/[\\%_]/g,"\\$&")}%`);where+=` AND concat_ws(' ',status,response_code,request_json->'context'->>'service',request_json->'context'->>'environment') ILIKE $${params.length}`;}
  const [runs,summary]=await Promise.all([
    db.query<RunRow>(`SELECT * FROM autosnap_runs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]),
    db.one<{total:number;dev:number;simulator:number;passed:number;failed:number;errors:number;cancelled:number}>(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE mode<>'mock')::int AS dev,COUNT(*) FILTER (WHERE mode='mock')::int AS simulator,COUNT(*) FILTER (WHERE status='Passed')::int AS passed,COUNT(*) FILTER (WHERE status='Failed')::int AS failed,COUNT(*) FILTER (WHERE status NOT IN ('Passed','Failed','Cancelled'))::int AS errors,COUNT(*) FILTER (WHERE status='Cancelled')::int AS cancelled FROM autosnap_runs WHERE ${where}`,params)
  ]);
  return {runs:runs.map(run=>({...run,request:run.request_json,response:run.response_json})),summary,total:summary?.total??0,limit,offset};
}
