/** Mirrors backend/src/privileges.ts for UI gating. Backend remains the source of truth. */
export const privilegeOptions=[
  {key:"dashboard",label:"Dashboard"},
  {key:"dev_site",label:"Dev Site Client"},
  {key:"dev_site_evidence",label:"Unduh bukti PDF ASPI"},
  {key:"client_simulator",label:"Client Simulator"},
  {key:"client_simulator_manage",label:"Kelola Penyedia Client Simulator"},
  {key:"master_data",label:"Master Data (lihat + kelola penuh)"},
  {key:"master_data_create",label:"Master Data — buat"},
  {key:"master_data_update",label:"Master Data — ubah"},
  {key:"master_data_delete",label:"Master Data — hapus"},
  {key:"user_management",label:"User Management (lihat + kelola penuh)"},
  {key:"user_management_create",label:"User Management — buat"},
  {key:"user_management_update",label:"User Management — ubah"},
  {key:"user_management_delete",label:"User Management — hapus"},
  {key:"history_all",label:"History semua pengguna"},
] as const;

type UserLike={role?:string;privileges?:string[]}|null|undefined;
type ModuleName="dashboard"|"dev_site"|"client_simulator"|"master_data"|"user_management"|"history";
type ModuleAction="view"|"create"|"update"|"delete"|"run"|"evidence"|"manage"|"view_all";

export function can(user:UserLike,module:ModuleName,action:ModuleAction="view"){
  if(!user)return false;
  if(user.role==="admin")return true;
  const keys=user.privileges??["dashboard","dev_site","client_simulator"];
  if(module==="history"){
    if(action==="view")return keys.includes("dashboard")||keys.includes("dev_site")||keys.includes("client_simulator")||keys.includes("history_all");
    if(action==="view_all")return keys.includes("history_all");
    return false;
  }
  if(action==="view")return keys.includes(module)||keys.some(key=>key.startsWith(`${module}_`));
  if(action==="run")return keys.includes(module);
  if(action==="evidence")return keys.includes("dev_site")||keys.includes("dev_site_evidence");
  if(action==="manage")return keys.includes("client_simulator")||keys.includes("client_simulator_manage");
  if(action==="create")return keys.includes(module)||keys.includes(`${module}_create`);
  if(action==="update")return keys.includes(module)||keys.includes(`${module}_update`);
  if(action==="delete")return keys.includes(module)||keys.includes(`${module}_delete`);
  return false;
}
