"use client";

import {useEffect,useState} from "react";
import type {Api,HistoryFilters,Run} from "./model";
import type {HistoryRange} from "./history-period";

type Summary={total:number;dev:number;simulator:number;passed:number;completed:number;failed:number;errors:number;cancelled:number};
type OperatorStat={operator_id:string|null;name:string;username:string;role:string;total:number;passed:number;failed:number;completed:number};
type HistoryData={runs:Run[];total:number;summary:Summary;byOperator:OperatorStat[];scope:string};
const empty:HistoryData={runs:[],total:0,summary:{total:0,dev:0,simulator:0,passed:0,completed:0,failed:0,errors:0,cancelled:0},byOperator:[],scope:"mine"};

export function useHistory(api:Api,range:HistoryRange,mode:string,search:string,offset:number,limit:number,revision:unknown,filters:HistoryFilters={}){
  const [result,setResult]=useState<{key:string;data:HistoryData;error:string}|null>(null);
  const [refresh,setRefresh]=useState(0);
  const key=JSON.stringify([range.from,range.to,mode,search,offset,limit,refresh,filters]);
  const valid=!!range.from&&!!range.to&&range.from<=range.to;
  useEffect(()=>{
    if(!valid)return;
    let active=true;
    const timer=setTimeout(()=>{
      const payload:Record<string,unknown>={from:range.from,to:range.to,mode,search,offset,limit};
      if(filters.scope)payload.scope=filters.scope;
      if(filters.status)payload.status=filters.status;
      if(filters.operatorId)payload.operatorId=filters.operatorId;
      if(filters.operatorRole)payload.operatorRole=filters.operatorRole;
      if(filters.operatorSearch)payload.operatorSearch=filters.operatorSearch;
      if(filters.serviceId)payload.serviceId=filters.serviceId;
      if(filters.endpointId)payload.endpointId=filters.endpointId;
      void api("getHistory",payload).then(data=>{
        if(active)setResult({key,data:{...empty,...(data as unknown as HistoryData),byOperator:Array.isArray((data as {byOperator?:unknown}).byOperator)?(data as {byOperator:OperatorStat[]}).byOperator:[]},error:""});
      }).catch(error=>{if(active)setResult({key,data:empty,error:(error as Error).message});});
    },150);
    return()=>{active=false;clearTimeout(timer);};
  },[api,key,valid,range.from,range.to,mode,search,offset,limit,revision,filters]);
  const data=valid&&result?.key===key?result.data:empty;
  return {...data,loading:valid&&result?.key!==key,error:!valid?"Pilih rentang tanggal yang valid.":result?.key===key?result.error:"",refresh:()=>setRefresh(value=>value+1)};
}

export function operatorLabel(run:Run){
  const op=run.operator;
  if(!op)return {text:"Tidak diketahui",mine:false,role:""};
  const role=op.role==="admin"?"Admin":op.role==="petugas"?"Petugas":"";
  const base=`${op.name}${op.username&&op.username!=="-"?` (@${op.username})`:""}${role?` · ${role}`:""}`;
  return {text:op.mine?`${base} · Saya`:base||"Tidak diketahui",mine:op.mine,role};
}
