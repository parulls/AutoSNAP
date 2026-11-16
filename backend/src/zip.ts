import { Buffer } from "node:buffer";

type ZipEntry={name:string;data:Buffer};

const crcTable=Array.from({length:256},(_,value)=>{
  let current=value;
  for(let bit=0;bit<8;bit++)current=(current&1)!==0?0xedb88320^(current>>>1):current>>>1;
  return current>>>0;
});

function crc32(data:Buffer){
  let crc=0xffffffff;
  for(const byte of data)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function dosDateTime(date=new Date()){
  const year=Math.max(1980,date.getFullYear());
  const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
  const day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  return {time,day};
}

/** Minimal ZIP writer using the store method. PDFs are already compressed. */
export function createZip(entries:ZipEntry[]){
  if(!entries.length)throw new Error("Tidak ada bukti PDF untuk dibuat menjadi ZIP.");
  const localParts:Buffer[]=[],centralParts:Buffer[]=[];
  let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name.replace(/[\\/:*?"<>|]+/g,"-"),"utf8"),crc=crc32(entry.data),{time,day}=dosDateTime();
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x0800,6);local.writeUInt16LE(0,8);
    local.writeUInt16LE(time,10);local.writeUInt16LE(day,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(entry.data.length,18);local.writeUInt32LE(entry.data.length,22);local.writeUInt16LE(name.length,26);
    localParts.push(local,name,entry.data);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(0,10);
    central.writeUInt16LE(time,12);central.writeUInt16LE(day,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(entry.data.length,20);central.writeUInt32LE(entry.data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    centralParts.push(central,name);
    offset+=local.length+name.length+entry.data.length;
  }
  const centralSize=centralParts.reduce((total,part)=>total+part.length,0),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...localParts,...centralParts,end]);
}
