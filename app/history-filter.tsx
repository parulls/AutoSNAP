"use client";

import {rangeForPeriod,type HistoryRange,type Period} from "./history-period";
import type {HistoryFilters,Item,Operator} from "./model";

type Props={
  value:HistoryRange;
  onChange:(range:HistoryRange)=>void;
  filters?:HistoryFilters;
  onFiltersChange?:(filters:HistoryFilters)=>void;
  isAdmin?:boolean;
  operators?:Operator[];
  services?:Item[];
  endpoints?:Item[];
  showMode?:boolean;
  mode?:string;
  onModeChange?:(mode:string)=>void;
};

const statuses=["","PASSED","COMPLETED","FAILED","AUTOMATION_ERROR","VALIDATION_ERROR","CANCELLED"];

export default function HistoryFilter({value,onChange,filters={},onFiltersChange,isAdmin=false,operators=[],services=[],endpoints=[],showMode=false,mode="all",onModeChange}:Props){
  const setFilter=(patch:Partial<HistoryFilters>)=>onFiltersChange?.({...filters,...patch});
  return <div className="history-filter">
    <label><span>Periode</span><select aria-label="Periode" value={value.period} onChange={event=>{const period=event.target.value as Period;onChange(period==="custom"?{...value,period}:rangeForPeriod(period));}}><option value="today">Hari ini</option><option value="week">Minggu ini</option><option value="month">Bulan ini</option><option value="custom">Rentang khusus</option></select></label>
    {value.period==="custom"&&<><label><span>Dari tanggal</span><input type="date" aria-label="Dari tanggal" value={value.from} max={value.to||undefined} onChange={event=>onChange({...value,from:event.target.value})}/></label><label><span>Sampai tanggal</span><input type="date" aria-label="Sampai tanggal" value={value.to} min={value.from||undefined} onChange={event=>onChange({...value,to:event.target.value})}/></label></>}
    {showMode&&onModeChange&&<label><span>Sumber</span><select aria-label="Sumber pengujian" value={mode} onChange={event=>onModeChange(event.target.value)}><option value="all">Semua</option><option value="dev_site">Dev Site Client</option><option value="simulator">Client Simulator</option></select></label>}
    <label><span>Status</span><select aria-label="Status history" value={filters.status??""} onChange={event=>setFilter({status:event.target.value||undefined})}><option value="">Semua status</option>{statuses.filter(Boolean).map(status=><option key={status} value={status}>{status}</option>)}</select></label>
    {services.length>0&&<label><span>API Service</span><select aria-label="API Service history" value={filters.serviceId??""} onChange={event=>setFilter({serviceId:event.target.value||undefined,endpointId:undefined})}><option value="">Semua service</option>{services.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {endpoints.length>0&&<label><span>Endpoint</span><select aria-label="Endpoint history" value={filters.endpointId??""} onChange={event=>setFilter({endpointId:event.target.value||undefined})}><option value="">Semua endpoint</option>{endpoints.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {isAdmin&&<>
      <label><span>Cakupan</span><select aria-label="Cakupan history" value={filters.scope??"all"} onChange={event=>setFilter({scope:event.target.value as "all"|"mine"})}><option value="all">Semua Pengguna</option><option value="mine">Pengujian Saya</option></select></label>
      <label><span>Role</span><select aria-label="Role pelaksana" value={filters.operatorRole??""} onChange={event=>setFilter({operatorRole:event.target.value||undefined})}><option value="">Semua role</option><option value="admin">Admin</option><option value="petugas">Petugas</option></select></label>
      <label><span>Pengguna</span><select aria-label="Pengguna pelaksana" value={filters.operatorId??""} onChange={event=>setFilter({operatorId:event.target.value||undefined})}><option value="">Semua pengguna</option>{operators.map(item=><option key={item.id} value={item.id}>{item.name} (@{item.username}) · {item.role==="admin"?"Admin":"Petugas"}</option>)}</select></label>
      <label><span>Cari pengguna</span><input aria-label="Cari nama atau username" value={filters.operatorSearch??""} placeholder="Nama atau username" onChange={event=>setFilter({operatorSearch:event.target.value||undefined})}/></label>
    </>}
  </div>;
}
