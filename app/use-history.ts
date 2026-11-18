"use client";

import {useEffect,useState} from "react";
import type {Api,Run} from "./model";
import type {HistoryRange} from "./history-period";

type Summary={total:number;dev:number;simulator:number;passed:number;failed:number;errors:number;cancelled:number;notEvaluated:number;passedHttp:number};
type HistoryData={runs:Run[];total:number;summary:Summary};
const empty:HistoryData={runs:[],total:0,summary:{total:0,dev:0,simulator:0,passed:0,failed:0,errors:0,cancelled:0,notEvaluated:0,passedHttp:0}};

export function useHistory(api:Api,range:HistoryRange,mode:string,search:string,offset:number,limit:number,revision:unknown){
  const [result,setResult]=useState<{key:string;data:HistoryData;error:string}|null>(null);
  const [refresh,setRefresh]=useState(0);
  const key=JSON.stringify([range.from,range.to,mode,search,offset,limit,refresh]);
  const valid=!!range.from&&!!range.to&&range.from<=range.to;
  useEffect(()=>{
    if(!valid)return;
    let active=true;
    const timer=setTimeout(()=>{
      void api("getHistory",{from:range.from,to:range.to,mode,search,offset,limit}).then(data=>{
        if(active)setResult({key,data:data as unknown as HistoryData,error:""});
      }).catch(error=>{if(active)setResult({key,data:empty,error:(error as Error).message});});
    },150);
    return()=>{active=false;clearTimeout(timer);};
  },[api,key,valid,range.from,range.to,mode,search,offset,limit,revision]);
  const data=valid&&result?.key===key?result.data:empty;
  return {...data,loading:valid&&result?.key!==key,error:!valid?"Pilih rentang tanggal yang valid.":result?.key===key?result.error:"",refresh:()=>setRefresh(value=>value+1)};
}
