import {MetadataError,type AuthWorkflow,type EndpointConfig} from "./endpoint-config";

export type AuthStage="signature_auth"|"access_token"|"customer_token"|"signature_service"|"api_request";
export type WorkflowNode={stage:AuthStage;dependsOn:AuthStage[]};

/** Capabilities, not service names, determine dependencies. No user-supplied code/URLs. */
export function authenticationWorkflow(config:Pick<EndpointConfig,"authFlow"|"workflow"|"parameters">):{profile:AuthWorkflow;nodes:WorkflowNode[]}{
  if(config.authFlow==="unknown")throw new MetadataError("Jenis autentikasi belum ditinjau.");
  const profile:AuthWorkflow=config.workflow??{
    token:config.authFlow==="none"?"none":"b2b",
    signature:config.authFlow==="none"?"none":"hmac",
    customerToken:config.authFlow==="b2b2c"?"stored":"none"
  };
  const required=(name:string)=>config.parameters.some(p=>p.in==="header"&&p.required&&p.name.toLowerCase()===name);
  if(config.authFlow==="none"&&(profile.token!=="none"||profile.signature!=="none"||profile.customerToken!=="none"))throw new MetadataError("Tanpa autentikasi tidak boleh menjalankan workflow keamanan.");
  if(config.authFlow!=="none"&&profile.token==="none")throw new MetadataError("Alur B2B/B2B2C memerlukan sumber access token.");
  if(profile.signature==="hmac"&&profile.token==="none")throw new MetadataError("Signature service memerlukan access token.");
  if(config.authFlow==="b2b2c"&&profile.customerToken!=="stored"||config.authFlow!=="b2b2c"&&profile.customerToken!=="none")throw new MetadataError("Customer token harus sesuai use case B2B2C.");
  if(required("x-signature")&&profile.signature==="none"||required("authorization")&&profile.token==="none"||required("authorization-customer")&&profile.customerToken==="none")throw new MetadataError("Workflow tidak memenuhi header keamanan wajib pada dokumentasi.");
  const nodes:WorkflowNode[]=[];
  if(profile.token==="b2b")nodes.push({stage:"signature_auth",dependsOn:[]});
  if(profile.token!=="none")nodes.push({stage:"access_token",dependsOn:profile.token==="b2b"?["signature_auth"]:[]});
  if(profile.customerToken==="stored")nodes.push({stage:"customer_token",dependsOn:[]});
  if(profile.signature==="hmac")nodes.push({stage:"signature_service",dependsOn:["access_token"]});
  nodes.push({stage:"api_request",dependsOn:nodes.map(node=>node.stage)});
  return {profile,nodes};
}

export async function executeWorkflow(nodes:WorkflowNode[],handlers:Record<AuthStage,()=>Promise<void>>){
  const complete=new Set<AuthStage>();
  for(const node of nodes){
    if(!node.dependsOn.every(stage=>complete.has(stage)))throw new MetadataError(`Dependency workflow ${node.stage} belum terpenuhi.`);
    await handlers[node.stage]();complete.add(node.stage);
  }
}
