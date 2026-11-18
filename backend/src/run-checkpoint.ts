import type {AuthStage,WorkflowNode} from "./auth-workflow";

export type StageStatus="PENDING"|"RUNNING"|"COMPLETED"|"FAILED"|"SKIPPED";
export type CheckpointStage={id:string;status:StageStatus;at:string;detail?:string;error?:string};
export type RunCheckpoint={version:1;stages:CheckpointStage[]};

const postApi=["evaluation","evidence"] as const;

export function buildCheckpoint(nodes:WorkflowNode[],options:{registration?:boolean}={}):RunCheckpoint{
  const ids:string[]=[
    "preparing",
    ...(options.registration?["registration"]:[]),
    ...nodes.map(node=>node.stage),
    ...postApi,
    "finished",
  ];
  const unique=[...new Set(ids)];
  const at=new Date().toISOString();
  return {version:1,stages:unique.map(id=>({id,status:id==="preparing"?"RUNNING":"PENDING",at}))};
}

export function markStage(checkpoint:RunCheckpoint,id:string,status:StageStatus,detail="",error=""){
  const at=new Date().toISOString();
  const stages=checkpoint.stages.map(stage=>{
    if(stage.id!==id)return stage;
    return {...stage,status,at,...(detail?{detail}:{}),...(error?{error}:status==="COMPLETED"?{error:undefined}:{})};
  });
  if(!stages.some(stage=>stage.id===id))stages.push({id,status,at,...(detail?{detail}:{}),...(error?{error}:{})});
  return {version:1 as const,stages};
}

export function failedStage(checkpoint:RunCheckpoint|null|undefined){
  return checkpoint?.stages.find(stage=>stage.status==="FAILED")??null;
}

export function stageCompleted(checkpoint:RunCheckpoint|null|undefined,id:string){
  return checkpoint?.stages.some(stage=>stage.id===id&&stage.status==="COMPLETED")??false;
}

export function authStagesFromNodes(nodes:WorkflowNode[]):AuthStage[]{
  return nodes.map(node=>node.stage).filter((stage):stage is AuthStage=>stage!=="api_request");
}

export function canRetryEvidence(input:{status:string;httpMatched:boolean;evidenceIncomplete:boolean}){
  return input.httpMatched&&input.evidenceIncomplete&&["COMPLETED","PASSED","RUNNING"].includes(input.status);
}

export function canResumeTesting(input:{status:string;hasTargetHttp:boolean;failedStageId:string|null}){
  if(input.hasTargetHttp)return false;
  if(!["AUTOMATION_ERROR","FAILED","CANCELLED","RUNNING"].includes(input.status))return false;
  const id=input.failedStageId??"";
  return !!id&&id!=="api_request"&&id!=="evaluation"&&id!=="evidence"&&id!=="finished";
}

export function requiresMutatingConfirm(method:string,hasTargetHttp:boolean,failedAtApi:boolean){
  if(hasTargetHttp||!failedAtApi)return false;
  return ["POST","PUT","PATCH","DELETE"].includes(method.toUpperCase());
}
