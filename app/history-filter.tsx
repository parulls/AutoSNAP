"use client";

import {rangeForPeriod,type HistoryRange,type Period} from "./history-period";
import type {HistoryFilters} from "./model";

type Props={
  value:HistoryRange;
  onChange:(range:HistoryRange)=>void;
  filters?:HistoryFilters;
  onFiltersChange?:(filters:HistoryFilters)=>void;
  isAdmin?:boolean;
  showMode?:boolean;
  mode?:string;
  onModeChange?:(mode:string)=>void;
};

const statuses=["PASSED","COMPLETED","FAILED","AUTOMATION_ERROR","VALIDATION_ERROR","CANCELLED"];

export default function HistoryFilter({value,onChange,filters={},onFiltersChange,isAdmin=false,showMode=false,mode="all",onModeChange}:Props){
  const setFilter=(patch:Partial<HistoryFilters>)=>onFiltersChange?.({...filters,...patch});
  return <div className="history-filter">
    <label><span>Periode</span><select aria-label="Periode" value={value.period} onChange={event=>{const period=event.target.value as Period;onChange(period==="custom"?{...value,period}:rangeForPeriod(period));}}><option value="today">Hari ini</option><option value="week">Minggu ini</option><option value="month">Bulan ini</option><option value="custom">Rentang khusus</option></select></label>
    {value.period==="custom"&&<><label><span>Dari tanggal</span><input type="date" aria-label="Dari tanggal" value={value.from} max={value.to||undefined} onChange={event=>onChange({...value,from:event.target.value})}/></label><label><span>Sampai tanggal</span><input type="date" aria-label="Sampai tanggal" value={value.to} min={value.from||undefined} onChange={event=>onChange({...value,to:event.target.value})}/></label></>}
    {showMode&&onModeChange&&<label><span>Sumber</span><select aria-label="Sumber pengujian" value={mode} onChange={event=>onModeChange(event.target.value)}><option value="all">Semua</option><option value="dev_site">Dev Site Client</option><option value="simulator">Client Simulator</option></select></label>}
    <label><span>Status</span><select aria-label="Status history" value={filters.status??""} onChange={event=>setFilter({status:event.target.value||undefined})}><option value="">Semua status</option>{statuses.map(status=><option key={status} value={status}>{status}</option>)}</select></label>
    {isAdmin&&<label><span>Cakupan</span><select aria-label="Cakupan history" value={filters.scope??"all"} onChange={event=>setFilter({scope:event.target.value as "all"|"mine"})}><option value="all">Semua pengguna</option><option value="mine">Pengujian saya</option></select></label>}
  </div>;
}
