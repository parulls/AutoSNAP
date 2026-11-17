"use client";

import {rangeForPeriod,type HistoryRange,type Period} from "./history-period";

export default function HistoryFilter({value,onChange}:{value:HistoryRange;onChange:(range:HistoryRange)=>void}){
  return <div className="history-filter">
    <label><span>Periode</span><select aria-label="Periode" value={value.period} onChange={event=>{const period=event.target.value as Period;onChange(period==="custom"?{...value,period}:rangeForPeriod(period));}}><option value="today">Hari ini</option><option value="week">Minggu ini</option><option value="month">Bulan ini</option><option value="custom">Rentang khusus</option></select></label>
    {value.period==="custom"&&<><label><span>Dari tanggal</span><input type="date" aria-label="Dari tanggal" value={value.from} max={value.to||undefined} onChange={event=>onChange({...value,from:event.target.value})}/></label><label><span>Sampai tanggal</span><input type="date" aria-label="Sampai tanggal" value={value.to} min={value.from||undefined} onChange={event=>onChange({...value,to:event.target.value})}/></label></>}
  </div>;
}
