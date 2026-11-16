export const privilegeKeys=["dashboard","dev_site","client_simulator","master_data","user_management"] as const;
export type PrivilegeKey=typeof privilegeKeys[number];

export function normalizedPrivileges(value:unknown,role:"admin"|"tester"):PrivilegeKey[]{
  if(role==="admin")return [...privilegeKeys];
  if(!Array.isArray(value))return ["dashboard","dev_site","client_simulator"];
  return [...new Set(value.filter((entry):entry is PrivilegeKey=>typeof entry==="string"&&(privilegeKeys as readonly string[]).includes(entry)))];
}

export function hasPrivilege(user:{role:"admin"|"tester";privileges?:unknown},key:PrivilegeKey){
  return user.role==="admin"||normalizedPrivileges(user.privileges,user.role).includes(key);
}
