export const menuPrivilegeKeys=["dashboard","dev_site","client_simulator","master_data","user_management"] as const;
/** Granular actions. Legacy menu keys still grant full module access for backward compatibility. */
export const privilegeKeys=[
  ...menuPrivilegeKeys,
  "master_data_create","master_data_update","master_data_delete",
  "user_management_create","user_management_update","user_management_delete",
  "history_all",
  "dev_site_evidence",
  "client_simulator_manage",
] as const;
export type PrivilegeKey=typeof privilegeKeys[number];
export type AccountRole="admin"|"petugas";
export type ModuleName="dashboard"|"dev_site"|"client_simulator"|"master_data"|"user_management"|"history";
export type ModuleAction="view"|"create"|"update"|"delete"|"run"|"evidence"|"manage"|"view_all";

/** `tester` is the legacy stored value for petugas. Privileges are not derived from the label. */
export function normalizeRole(role:unknown):AccountRole|null{
  if(role==="admin")return "admin";
  if(role==="petugas"||role==="tester")return "petugas";
  return null;
}
export function assertAccountRole(role:AccountRole|null):asserts role is AccountRole{
  if(role!=="admin"&&role!=="petugas")throw {error:"Peran akun tidak valid.",status:400};
}

export function normalizedPrivileges(value:unknown,role:AccountRole|"tester"):PrivilegeKey[]{
  const canonical=normalizeRole(role)??"petugas";
  if(canonical==="admin")return [...privilegeKeys];
  if(!Array.isArray(value))return ["dashboard","dev_site","client_simulator"];
  return [...new Set(value.filter((entry):entry is PrivilegeKey=>typeof entry==="string"&&(privilegeKeys as readonly string[]).includes(entry)))];
}

export function hasPrivilege(user:{role:string;privileges?:unknown},key:PrivilegeKey){
  const role=normalizeRole(user.role)??"petugas";
  return role==="admin"||normalizedPrivileges(user.privileges,role).includes(key);
}

/** Module action check. Admin always passes. Legacy menu privilege grants all actions on that module. */
export function can(user:{role:string;privileges?:unknown},module:ModuleName,action:ModuleAction= "view"){
  const role=normalizeRole(user.role)??"petugas";
  if(role==="admin")return true;
  const keys=normalizedPrivileges(user.privileges,role);
  if(module==="history"){
    if(action==="view")return keys.includes("dashboard")||keys.includes("dev_site")||keys.includes("client_simulator")||keys.includes("history_all");
    if(action==="view_all")return keys.includes("history_all");
    return false;
  }
  const menu=module as typeof menuPrivilegeKeys[number];
  if(action==="view")return keys.includes(menu)||keys.some(key=>key.startsWith(`${module}_`));
  if(action==="run")return keys.includes(menu);
  if(action==="evidence")return keys.includes("dev_site")||keys.includes("dev_site_evidence");
  if(action==="manage")return keys.includes("client_simulator")||keys.includes("client_simulator_manage");
  if(action==="create")return keys.includes(menu)||keys.includes(`${module}_create` as PrivilegeKey);
  if(action==="update")return keys.includes(menu)||keys.includes(`${module}_update` as PrivilegeKey);
  if(action==="delete")return keys.includes(menu)||keys.includes(`${module}_delete` as PrivilegeKey);
  return false;
}

/** Prevent privilege escalation: assignees may only receive privileges the actor already holds (admins exempt). */
export function assertAssignablePrivileges(actor:{role:string;privileges?:unknown},requested:unknown){
  if(normalizeRole(actor.role)==="admin")return normalizedPrivileges(requested,"petugas");
  const allowed=new Set(normalizedPrivileges(actor.privileges,"petugas"));
  const next=normalizedPrivileges(requested,"petugas");
  if(next.some(key=>!allowed.has(key)))throw {error:"Tidak dapat memberikan privilege yang tidak Anda miliki.",status:403};
  return next;
}

export const privilegeLabels:Record<PrivilegeKey,string>={
  dashboard:"Dashboard",
  dev_site:"Dev Site Client",
  client_simulator:"Client Simulator",
  master_data:"Master Data (lihat)",
  master_data_create:"Master Data — buat",
  master_data_update:"Master Data — ubah",
  master_data_delete:"Master Data — hapus",
  user_management:"User Management (lihat)",
  user_management_create:"User Management — buat",
  user_management_update:"User Management — ubah",
  user_management_delete:"User Management — hapus",
  history_all:"History semua pengguna",
  dev_site_evidence:"Unduh bukti PDF ASPI",
  client_simulator_manage:"Kelola Penyedia Client Simulator",
};
