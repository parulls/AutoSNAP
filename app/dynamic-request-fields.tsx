"use client";
type Schema={properties?:Record<string,{type?:string;description?:string;enum?:unknown[]}>;required?:string[]};
export default function DynamicRequestFields({schema,body,onChange,disabled}:{schema:Schema;body:string;onChange:(body:string)=>void;disabled:boolean}){
  let values:Record<string,unknown>;try{values=JSON.parse(body);}catch{return null;}
  function update(name:string,text:string,type?:string){
    let value:unknown=text;
    if(type==="number"||type==="integer")value=text===""?undefined:Number(text);
    if(type==="boolean")value=text==="true";
    if(type==="object"||type==="array"){try{value=JSON.parse(text);}catch{return;}}
    onChange(JSON.stringify({...values,[name]:value},null,2));
  }
  return <div className="form-grid wide">{Object.entries(schema.properties??{}).map(([name,field])=><label key={name} className="form-field"><span>{name}{schema.required?.includes(name)?" *":" (opsional menurut schema)"}</span>{field.type==="object"||field.type==="array"?<textarea disabled={disabled} defaultValue={JSON.stringify(values[name]??(field.type==="array"?[]:{}),null,2)} onBlur={e=>update(name,e.target.value,field.type)}/>:field.enum?<select disabled={disabled} value={String(values[name]??"")} onChange={e=>update(name,e.target.value,field.type)}><option value="">Pilih nilai</option>{field.enum.map(value=><option key={String(value)}>{String(value)}</option>)}</select>:field.type==="boolean"?<select disabled={disabled} value={String(values[name]??false)} onChange={e=>update(name,e.target.value,field.type)}><option value="true">true</option><option value="false">false</option></select>:<input disabled={disabled} type={field.type==="integer"||field.type==="number"?"number":"text"} value={String(values[name]??"")} onChange={e=>update(name,e.target.value,field.type)}/>}<small className="helper">{field.description}</small></label>)}</div>;
}
