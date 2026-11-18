export const privilegeKeys=["dashboard","dev_site","client_simulator","master_data","user_management"] as const;
export type PrivilegeKey=typeof privilegeKeys[number];
export type AccountRole="admin"|"petugas";

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
