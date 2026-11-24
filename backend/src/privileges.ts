/** Module access. A granted module includes every feature in that module. */
export const privilegeKeys=[
  "dashboard",
  "dev_site",
  "client_simulator",
  "master_data",
  "user_management",
  "history_all",
] as const;
export type PrivilegeKey=typeof privilegeKeys[number];
export type AccountRole="admin"|"petugas";
export type ModuleName="dashboard"|"dev_site"|"client_simulator"|"master_data"|"user_management"|"history";
export type ModuleAction="view"|"create"|"update"|"delete"|"run"|"evidence"|"manage"|"view_all";

const defaultPrivileges:PrivilegeKey[]=["dashboard","dev_site","client_simulator"];

/** Old CRUD and split keys keep the module they already unlocked. */
const legacyModule:Record<string,PrivilegeKey>={
  dashboard:"dashboard",
  dev_site:"dev_site",
  dev_site_evidence:"dev_site",
  client_simulator:"client_simulator",
  client_simulator_manage:"client_simulator",
  master_data:"master_data",
  master_data_create:"master_data",
  master_data_update:"master_data",
  master_data_delete:"master_data",
  user_management:"user_management",
  user_management_create:"user_management",
  user_management_update:"user_management",
  user_management_delete:"user_management",
  history_all:"history_all",
};

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
  if(normalizeRole(role)==="admin")return [...privilegeKeys];
  if(!Array.isArray(value))return [...defaultPrivileges];
  const keys:PrivilegeKey[]=[];
  for(const entry of value){
    const granted=typeof entry==="string"?legacyModule[entry]:undefined;
    if(granted&&!keys.includes(granted))keys.push(granted);
  }
  return keys;
}

export function hasPrivilege(user:{role:string;privileges?:unknown},key:PrivilegeKey){
  const role=normalizeRole(user.role)??"petugas";
  return role==="admin"||normalizedPrivileges(user.privileges,role).includes(key);
}

/** Any action on a module is allowed once that module privilege is held. History Semua Pengguna stays separate. */
export function can(user:{role:string;privileges?:unknown},module:ModuleName,action:ModuleAction="view"){
  const role=normalizeRole(user.role)??"petugas";
  if(role==="admin")return true;
  const keys=normalizedPrivileges(user.privileges,role);
  if(module==="history"){
    if(action==="view_all")return keys.includes("history_all");
    return keys.includes("dashboard")||keys.includes("dev_site")||keys.includes("client_simulator")||keys.includes("history_all");
  }
  return keys.includes(module);
}

/** Prevent privilege escalation: assignees may only receive privileges the actor already holds (admins exempt). */
export function assertAssignablePrivileges(actor:{role:string;privileges?:unknown},requested:unknown){
  const next=normalizedPrivileges(requested,"petugas");
  if(normalizeRole(actor.role)==="admin")return next;
  const allowed=new Set(normalizedPrivileges(actor.privileges,"petugas"));
  if(next.some(key=>!allowed.has(key)))throw {error:"Tidak dapat memberikan privilege yang tidak Anda miliki.",status:403};
  return next;
}

export const privilegeLabels:Record<PrivilegeKey,string>={
  dashboard:"Dashboard",
  dev_site:"Dev Site Client",
  client_simulator:"Client Simulator",
  master_data:"Master Data",
  user_management:"User Management",
  history_all:"History Semua Pengguna",
};
