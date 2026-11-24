import type {DatabaseService,RunRow} from "./database.service";
import {can} from "./privileges";

export type HistoryViewer={id:string;role?:string;privileges?:unknown};
type HistoryRun=RunRow&{
  request:unknown;
  response:unknown;
  operator:{id:string|null;name:string;username:string;role:string;mine:boolean;source:"snapshot"|"live"|"unknown"};
};

function dateStart(raw:unknown){
  if(typeof raw!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw {status:400,error:"Isi tanggal awal dan akhir yang valid."};
  const utc=Date.parse(`${raw}T00:00:00+07:00`);
  if(!Number.isFinite(utc)||new Date(utc+7*3600000).toISOString().slice(0,10)!==raw)throw {status:400,error:"Tanggal history tidak valid."};
  return utc;
}

function asViewer(viewer:string|HistoryViewer):HistoryViewer{
  return typeof viewer==="string"?{id:viewer,role:"petugas"}:{id:viewer.id,role:viewer.role??"petugas",privileges:viewer.privileges};
}

function normalizeRole(raw:unknown){
  const role=String(raw??"").toLowerCase();
  if(role==="admin")return "admin";
  if(role==="petugas"||role==="tester")return "petugas";
  return "";
}

function escapeLike(value:string){return value.replace(/[\\%_]/g,"\\$&");}

/** Admin or history_all may view all runs; others only own. Filters applied in SQL — never trust frontend-only scoping. */
export async function readHistory(db:DatabaseService,viewerInput:string|HistoryViewer,input:Record<string,unknown>){
  const viewer=asViewer(viewerInput);
  const canViewAll=viewer.role==="admin"||can({role:viewer.role??"petugas",privileges:viewer.privileges},"history","view_all");
  const start=dateStart(input.from),last=dateStart(input.to);
  if(start>last)throw {status:400,error:"Tanggal awal tidak boleh melewati tanggal akhir."};
  const mode=String(input.mode??"all");
  if(!["all","dev_site","simulator"].includes(mode))throw {status:400,error:"Kategori history tidak valid."};
  const limit=Math.min(100,Math.max(1,Number(input.limit)||20)),offset=Math.max(0,Number(input.offset)||0);
  if(!Number.isInteger(limit)||!Number.isInteger(offset)||offset>1000000)throw {status:400,error:"Halaman history tidak valid."};

  const scope=String(input.scope??(canViewAll?"all":"mine"));
  if(!["all","mine"].includes(scope))throw {status:400,error:"Cakupan history tidak valid."};
  if(!canViewAll&&scope==="all")throw {status:403,error:"Anda hanya dapat melihat History milik sendiri tanpa privilege History Semua Pengguna."};

  const params:unknown[]=[new Date(start).toISOString(),new Date(last+24*3600000).toISOString()];
  let where="r.created_at >= $1 AND r.created_at < $2";
  if(!canViewAll||scope==="mine"){
    params.push(viewer.id);
    where+=` AND r.operator_id=$${params.length}`;
  }

  if(mode==="dev_site")where+=" AND r.mode<>'mock' AND r.mode<>'client_sim'";
  if(mode==="simulator")where+=" AND r.mode IN ('mock','client_sim')";

  const status=String(input.status??"").trim().toUpperCase();
  const allowedStatus=new Set(["PASSED","COMPLETED","FAILED","AUTOMATION_ERROR","VALIDATION_ERROR","CANCELLED"]);
  if(status){
    if(!allowedStatus.has(status))throw {status:400,error:"Status history tidak valid."};
    params.push(status);
    where+=` AND UPPER(r.status)=$${params.length}`;
  }

  if(canViewAll){
    const operatorId=String(input.operatorId??"").trim();
    if(operatorId){
      if(operatorId.length>80)throw {status:400,error:"Filter pengguna tidak valid."};
      params.push(operatorId);
      where+=` AND r.operator_id=$${params.length}`;
    }
    const role=normalizeRole(input.operatorRole);
    if(String(input.operatorRole??"").trim()&&!role)throw {status:400,error:"Filter role tidak valid. Gunakan Admin atau Petugas."};
    if(role){
      params.push(role);
      where+=` AND LOWER(COALESCE(r.request_json->'operator'->>'role', CASE WHEN u.role='tester' THEN 'petugas' ELSE u.role END))=$${params.length}`;
    }
    const operatorSearch=String(input.operatorSearch??"").trim();
    if(operatorSearch.length>120)throw {status:400,error:"Pencarian pengguna maksimal 120 karakter."};
    if(operatorSearch){
      params.push(`%${escapeLike(operatorSearch)}%`);
      where+=` AND concat_ws(' ',COALESCE(r.request_json->'operator'->>'name',u.name),COALESCE(r.request_json->'operator'->>'username',u.username),u.email) ILIKE $${params.length}`;
    }
  }else if(input.operatorId||input.operatorRole||input.operatorSearch){
    throw {status:403,error:"Filter pengguna memerlukan privilege History Semua Pengguna."};
  }

  const serviceId=String(input.serviceId??"").trim();
  if(serviceId){
    if(serviceId.length>80)throw {status:400,error:"Filter API Service tidak valid."};
    params.push(serviceId);
    where+=` AND r.service_id=$${params.length}`;
  }
  const endpointId=String(input.endpointId??"").trim();
  if(endpointId){
    if(endpointId.length>80)throw {status:400,error:"Filter Endpoint tidak valid."};
    params.push(endpointId);
    where+=` AND r.endpoint_id=$${params.length}`;
  }

  const search=String(input.search??"").trim();
  if(search.length>120)throw {status:400,error:"Pencarian maksimal 120 karakter."};
  if(search){
    params.push(`%${escapeLike(search)}%`);
    where+=` AND concat_ws(' ',r.status,r.response_code,r.notes,r.request_json->>'activityName',r.request_json->'context'->>'service',r.request_json->'service'->>'name',r.request_json->'context'->>'environment',r.request_json->'provider'->>'name',r.request_json->'context'->>'endpoint',COALESCE(r.request_json->'operator'->>'name',u.name),COALESCE(r.request_json->'operator'->>'username',u.username)) ILIKE $${params.length}`;
  }

  const known="('PASSED','COMPLETED','FAILED','AUTOMATION_ERROR','VALIDATION_ERROR','CANCELLED','RUNNING','Passed','Failed','Cancelled','NOT_EVALUATED','PASSED_HTTP')";
  const from=`FROM autosnap_runs r LEFT JOIN autosnap_users u ON u.id=r.operator_id WHERE ${where}`;
  type Row=RunRow&{op_name:string|null;op_username:string|null;op_role:string|null;op_active:boolean|null};
  const [rows,summary,byOperator]=await Promise.all([
    db.query<Row>(`SELECT r.*,u.name AS op_name,u.username AS op_username,u.role AS op_role,u.active AS op_active ${from} ORDER BY r.created_at DESC,r.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,limit,offset]),
    db.one<{total:number;dev:number;simulator:number;passed:number;completed:number;failed:number;errors:number;cancelled:number}>(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE r.mode<>'mock' AND r.mode<>'client_sim')::int AS dev,COUNT(*) FILTER (WHERE r.mode IN ('mock','client_sim'))::int AS simulator,COUNT(*) FILTER (WHERE r.status IN ('PASSED','Passed'))::int AS passed,COUNT(*) FILTER (WHERE r.status='COMPLETED')::int AS completed,COUNT(*) FILTER (WHERE r.status IN ('FAILED','Failed'))::int AS failed,COUNT(*) FILTER (WHERE r.status IN ('AUTOMATION_ERROR','VALIDATION_ERROR') OR r.status NOT IN ${known})::int AS errors,COUNT(*) FILTER (WHERE r.status IN ('CANCELLED','Cancelled'))::int AS cancelled ${from}`,params),
    canViewAll
      ? db.query<{operator_id:string|null;name:string;username:string;role:string;total:number;passed:number;failed:number;completed:number}>(`SELECT r.operator_id,COALESCE(MAX(r.request_json->'operator'->>'name'),MAX(u.name),'Tidak diketahui') AS name,COALESCE(MAX(r.request_json->'operator'->>'username'),MAX(u.username),'-') AS username,COALESCE(MAX(r.request_json->'operator'->>'role'),MAX(CASE WHEN u.role='tester' THEN 'petugas' ELSE u.role END),'unknown') AS role,COUNT(*)::int AS total,COUNT(*) FILTER (WHERE r.status IN ('PASSED','Passed'))::int AS passed,COUNT(*) FILTER (WHERE r.status IN ('FAILED','Failed'))::int AS failed,COUNT(*) FILTER (WHERE r.status='COMPLETED')::int AS completed ${from} GROUP BY r.operator_id ORDER BY total DESC,name ASC LIMIT 50`,params)
      : Promise.resolve([]),
  ]);

  const runs:HistoryRun[]=rows.map(row=>{
    const request=row.request_json&&typeof row.request_json==="object"&&!Array.isArray(row.request_json)?row.request_json as Record<string,unknown>:{};
    const snap=request.operator&&typeof request.operator==="object"&&!Array.isArray(request.operator)?request.operator as Record<string,unknown>:null;
    const snapRole=normalizeRole(snap?.role)||"";
    const liveRole=normalizeRole(row.op_role)||"";
    const hasSnap=!!(snap&&(snap.name||snap.username||snap.id));
    const id=row.operator_id??(typeof snap?.id==="string"?snap.id:null);
    const name=String(snap?.name??row.op_name??"").trim()||(id?"Pengguna tidak tersedia":"Tidak diketahui");
    const username=String(snap?.username??row.op_username??"").trim()||"-";
    const role=snapRole||liveRole||"unknown";
    return {
      id:row.id,operator_id:row.operator_id,client_id:row.client_id,project_id:row.project_id,environment_id:row.environment_id,user_id:row.user_id,service_id:row.service_id,endpoint_id:row.endpoint_id,scenario_id:row.scenario_id,mode:row.mode,status:row.status,http_status:row.http_status,response_code:row.response_code,expected_code:row.expected_code,duration_ms:row.duration_ms,request_json:row.request_json,response_json:row.response_json,notes:row.notes,created_at:row.created_at,
      request:row.request_json,response:row.response_json,
      operator:{id,name,username,role:role==="admin"?"admin":role==="petugas"?"petugas":"unknown",mine:!!id&&id===viewer.id,source:hasSnap?"snapshot":id&&row.op_name!=null?"live":"unknown"},
    };
  });

  return {runs,summary,byOperator:canViewAll?byOperator:[],total:summary?.total??0,limit,offset,scope:canViewAll?scope:"mine"};
}

export function canAccessRun(viewer:HistoryViewer,run:{operator_id:string|null}|null|undefined){
  if(!run)return false;
  if(viewer.role==="admin"||can({role:viewer.role??"petugas",privileges:viewer.privileges},"history","view_all"))return true;
  return !!run.operator_id&&run.operator_id===viewer.id;
}
