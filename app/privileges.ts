/** Mirrors backend/src/privileges.ts for UI gating. Backend remains the source of truth. */
export const privilegeOptions=[
  {key:"dashboard",label:"Dashboard"},
  {key:"dev_site",label:"Dev Site Client"},
  {key:"client_simulator",label:"Client Simulator"},
  {key:"master_data",label:"Master Data"},
  {key:"user_management",label:"User Management"},
  {key:"history_all",label:"History Semua Pengguna"},
] as const;

export type PrivilegeKey=typeof privilegeOptions[number]["key"];
type UserLike={role?:string;privileges?:string[]}|null|undefined;
type ModuleName="dashboard"|"dev_site"|"client_simulator"|"master_data"|"user_management"|"history";
type ModuleAction="view"|"create"|"update"|"delete"|"run"|"evidence"|"manage"|"view_all";

const privilegeKeys:PrivilegeKey[]=privilegeOptions.map(item=>item.key);
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

export function normalizePrivileges(value:unknown,role?:string):PrivilegeKey[]{
  if(role==="admin")return [...privilegeKeys];
  const list=Array.isArray(value)?value:["dashboard","dev_site","client_simulator"];
  const keys:PrivilegeKey[]=[];
  for(const entry of list){
    const granted=typeof entry==="string"?legacyModule[entry]:undefined;
    if(granted&&!keys.includes(granted))keys.push(granted);
  }
  return keys;
}

export function can(user:UserLike,module:ModuleName,action:ModuleAction="view"){
  if(!user)return false;
  if(user.role==="admin")return true;
  const keys=normalizePrivileges(user.privileges,user.role);
  if(module==="history"){
    if(action==="view_all")return keys.includes("history_all");
    return keys.includes("dashboard")||keys.includes("dev_site")||keys.includes("client_simulator")||keys.includes("history_all");
  }
  return keys.includes(module);
}
