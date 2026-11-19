"use client";

import {useEffect,useMemo,useRef,useState} from "react";
import type {Api,Item} from "./model";
import type {EndpointConfig} from "../backend/src/endpoint-config";

type Draft={name:string;module:string;code:string;method:string;path:string;portalUrl:string;requestBody:string;config:EndpointConfig};
type Props={users:Item[];endpoint?:Item;service?:Item;api:Api;reload:()=>Promise<void>;onClose:()=>void};

export default function DocumentationImport({users,endpoint,service,api,reload,onClose}:Props){
  const initial=endpoint&&service?.data.config?JSON.stringify({name:service.name,module:service.data.module,code:service.data.code,method:endpoint.data.method,path:endpoint.data.path,portalUrl:endpoint.data.portalUrl,requestBody:service.data.requestBody??"",config:service.data.config},null,2):"";
  const [url,setUrl]=useState(String(endpoint?.data.portalUrl??""));
  const [userId,setUserId]=useState(users.length===1?users[0].id:"");
  const [draft,setDraft]=useState(initial),[error,setError]=useState("");
  const [working,setWorking]=useState<"reading"|"saving"|null>(null);
  const [confirmed,setConfirmed]=useState(false),[overrides,setOverrides]=useState(false);
  const busy=working!==null,dialog=useRef<HTMLElement>(null),urlInput=useRef<HTMLInputElement>(null);
  const parsed=useMemo(()=>{try{return JSON.parse(draft) as Draft;}catch{return null;}},[draft]);
  const config=parsed?.config;
  const missing=config?[config.authFlow==="unknown"?"autentikasi":"",!config.expectedHttpStatus?"HTTP status":""].filter(Boolean):[];
  const changeUrl=(text:string)=>{setUrl(text);setDraft("");setConfirmed(false);setError("");setOverrides(false);};
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    urlInput.current?.focus();
    return()=>previous?.focus();
  },[]);
  async function inspect(){
    if(busy)return;
    setWorking("reading");setError("");setDraft("");setConfirmed(false);setOverrides(false);
    try{setDraft(JSON.stringify(await api("inspectDocumentation",{url:url.trim(),userId}),null,2));}
    catch(cause){setError((cause as Error).message);}
    finally{setWorking(null);}
  }
  async function save(){
    if(busy||!parsed||!confirmed)return;
    setWorking("saving");setError("");
    try{
      await api("saveImportedService",{draft:{...parsed,config:{...parsed.config,reviewed:true},endpointId:endpoint?.id,serviceId:service?.id}});
      await reload();onClose();
    }catch(cause){setError((cause as Error).message);}
    finally{setWorking(null);}
  }
  function setConfig(key:keyof EndpointConfig,value:unknown){
    if(!parsed)return;
    setDraft(JSON.stringify({...parsed,config:{...parsed.config,[key]:value,...(key==="authFlow"?{workflow:undefined}:{})}},null,2));setConfirmed(false);
  }
  return <div className="modal-backdrop documentation-backdrop">
    <section ref={dialog} className="card edit-modal documentation-modal" role="dialog" aria-modal="true" aria-labelledby="import-title"
      onKeyDown={event=>{
        if(event.key==="Escape"&&!busy){event.preventDefault();onClose();}
        if(event.key!=="Tab")return;
        const items=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary');
        const visible=Array.from(items??[]).filter(item=>item.getClientRects().length);
        const first=visible[0],last=visible.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }}>
      <header className="documentation-heading">
        <h2 id="import-title">{endpoint?"Edit Endpoint URL":"Tambah Endpoint URL"}</h2>
        <p>Tempel URL operasi ASPI untuk mengambil konfigurasi dan sample request.</p>
      </header>
      <div className="documentation-content" aria-busy={working==="reading"}>
        {users.length>1?<label className="form-field">
          <span>User SNAP untuk sesi portal</span>
          <select disabled={busy} value={userId} onChange={event=>{setUserId(event.target.value);setDraft("");setConfirmed(false);}}>
            <option value="">Pilih User SNAP</option>{users.map(user=><option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>:<p className="helper documentation-session">Sesi: {users[0]?.name??"Tambahkan User SNAP terlebih dahulu"}</p>}
        <div className="documentation-url-row">
          <label className="form-field"><span>URL operasi ASPI</span>
            <input ref={urlInput} type="url" disabled={busy} value={url} placeholder="https://apidevportal.aspi-indonesia.or.id/api-services/…#/Group/operationId"
              onChange={event=>changeUrl(event.target.value)}
              onKeyDown={event=>{if(event.key==="Enter"&&url.trim()&&userId){event.preventDefault();void inspect();}}}/>
          </label>
          <button type="button" className="primary-button" disabled={busy||!url.trim()||!userId} onClick={()=>void inspect()}>
            {working==="reading"?<><span className="button-spinner" aria-hidden="true"/>Membaca…</>:"Baca dokumentasi"}
          </button>
        </div>
        {working==="reading"&&<p className="documentation-reading" role="status">Membaca dokumentasi ASPI…</p>}
        {error&&<p role="alert" className="form-error">{error}</p>}
        {parsed&&config&&<div className="documentation-result">
          <div className="documentation-identity">
            <strong>{parsed.name}</strong>
            <div><span className="mode-badge blue">{parsed.method}</span><code>{parsed.path}</code></div>
          </div>
          <div className="documentation-columns">
            <section className="documentation-template">
              <label className="form-field"><span>Template request dari ASPI</span>
                <textarea className="code-editor" readOnly rows={12} value={parsed.requestBody??""} spellCheck={false}
                  placeholder="Sample request tidak tersedia. Isi body saat testing sesuai dokumentasi."/>
              </label>
            </section>
            <section className="documentation-settings">
              <h3>Autentikasi & validasi</h3>
              <dl className="documentation-values">
                <div><dt>Autentikasi</dt><dd>{({unknown:"Perlu dipilih",b2b:"B2B",b2b2c:"B2B2C",none:"Tanpa autentikasi"})[config.authFlow]??"Perlu dipilih"}</dd></div>
                <div><dt>HTTP status</dt><dd>{config.expectedHttpStatus??"Belum tersedia"}</dd></div>
                <div><dt>SNAP code</dt><dd>{config.expectedCode??"Belum tersedia"}</dd></div>
                <div><dt>Parameter</dt><dd>{config.parameters?.length??0} dari dokumentasi</dd></div>
              </dl>
              {missing.length>0&&<p className="helper">Perlu dilengkapi: {missing.join(", ")}.</p>}
              <button type="button" className="text-button" aria-expanded={overrides} disabled={busy} onClick={()=>setOverrides(!overrides)}>{overrides?"Tutup pengaturan":"Ubah konfigurasi"}</button>
              {(overrides||missing.length>0||!config.expectedCode)&&<div className="documentation-config-fields">
                {(overrides||config.authFlow==="unknown")&&<label className="form-field"><span>Autentikasi</span>
                  <select aria-label="Autentikasi import" disabled={busy} value={config.authFlow} onChange={event=>setConfig("authFlow",event.target.value)}>
                    <option value="unknown">Belum dipastikan</option><option value="b2b">B2B</option>
                    <option value="b2b2c">B2B2C</option><option value="none">Tanpa autentikasi</option>
                  </select>
                </label>}
                {(overrides||!config.expectedHttpStatus)&&<label className="form-field"><span>Expected HTTP Status</span>
                  <input aria-label="Expected HTTP Status import" disabled={busy} type="number" min="100" max="599" value={config.expectedHttpStatus??""}
                    onChange={event=>setConfig("expectedHttpStatus",event.target.value?Number(event.target.value):null)}/>
                </label>}
                {(overrides||!config.expectedCode)&&<label className="form-field"><span>Expected SNAP Response Code (opsional)</span>
                  <input aria-label="Expected SNAP Response Code import" disabled={busy} inputMode="numeric" maxLength={7} value={config.expectedCode??""}
                    onChange={event=>setConfig("expectedCode",event.target.value||null)} aria-describedby="expected-snap-code-help"/>
                  <small id="expected-snap-code-help" className="helper">Boleh kosong. API tetap dijalankan, tetapi hasil menjadi NOT_EVALUATED sampai expected code ditentukan.</small>
                </label>}
              </div>}
              {overrides&&config.authFlow!=="unknown"&&config.authFlow!=="none"&&<div className="documentation-config-fields">
                <label className="form-field"><span>Sumber token B2B</span><select disabled={busy} value={config.workflow?.token??"b2b"} onChange={event=>setConfig("workflow",{token:event.target.value,signature:config.workflow?.signature??"hmac",customerToken:config.authFlow==="b2b2c"?"stored":"none"})}>
                  <option value="b2b">Ambil melalui API Keamanan</option><option value="provided">Token client tersimpan (wajib belum kedaluwarsa)</option>
                </select></label>
                <label className="form-field"><span>Signature service</span><select disabled={busy} value={config.workflow?.signature??"hmac"} onChange={event=>setConfig("workflow",{token:config.workflow?.token??"b2b",signature:event.target.value,customerToken:config.authFlow==="b2b2c"?"stored":"none"})}>
                  <option value="hmac">HMAC melalui utility ASPI</option><option value="none">Tidak diperlukan menurut dokumentasi</option>
                </select></label>
                {config.authFlow==="b2b2c"&&<p className="helper">Customer token berasal dari consent User SNAP terpilih; consent tidak dibuat otomatis.</p>}
              </div>}
              {config.authFlow!=="none"&&<details className="documentation-details"><summary>Ekspektasi tes token negatif</summary>
                <p className="helper">Opsional. Isi dari dokumentasi skenario, bukan disamakan dengan hasil sukses.</p>
                <label className="documentation-confirmation"><input type="checkbox" disabled={busy} checked={!!config.negativeToken} onChange={event=>setConfig("negativeToken",event.target.checked?{expectedHttpStatus:null,expectedCode:null}:undefined)}/><span>Aktifkan tes token tidak valid</span></label>
                {config.negativeToken&&<div className="documentation-config-fields">
                  <label className="form-field"><span>Expected HTTP negatif</span><input aria-label="Expected HTTP negatif" disabled={busy} type="number" min="400" max="499" value={config.negativeToken.expectedHttpStatus??""} onChange={event=>setConfig("negativeToken",{...config.negativeToken,expectedHttpStatus:event.target.value?Number(event.target.value):null})}/></label>
                  <label className="form-field"><span>Expected SNAP negatif (opsional)</span><input aria-label="Expected SNAP negatif" disabled={busy} inputMode="numeric" maxLength={7} value={config.negativeToken.expectedCode??""} onChange={event=>setConfig("negativeToken",{...config.negativeToken,expectedCode:event.target.value||null})}/><small className="helper">Boleh kosong; hasil menjadi NOT_EVALUATED sampai expected code ditentukan.</small></label>
                </div>}
              </details>}
            </section>
          </div>
          {config.warnings?.length>0&&<details className="documentation-details">
            <summary>Catatan dokumentasi ({config.warnings.length})</summary>
            <ul className="helper">{config.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>
          </details>}
          <details className="documentation-details"><summary>Parameter & schema</summary>
            {config.parameters?.length>0?<div className="table-wrap"><table><thead><tr><th>PARAMETER</th><th>LOKASI</th><th>WAJIB</th></tr></thead>
              <tbody>{config.parameters.map((parameter,index)=><tr key={index}><td>{parameter.name}</td><td>{parameter.in}</td><td>{parameter.required?"Ya":"Tidak / kondisional"}</td></tr>)}</tbody>
            </table></div>:<p className="helper">Parameter tidak tercantum pada dokumentasi yang terbaca.</p>}
            <pre className="response-code">{JSON.stringify({requestSchema:config.requestSchema,responses:config.responses},null,2)}</pre>
          </details>
          <details className="documentation-details"><summary>Pengaturan lanjutan</summary>
            <ConfigurationEditor key={draft} draft={draft} disabled={busy} onApply={text=>{setDraft(text);setConfirmed(false);}}/>
          </details>
          <label className="documentation-confirmation">
            <input type="checkbox" disabled={busy} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>
            <span>Saya telah meninjau method, parameter, autentikasi, dan ekspektasi.</span>
          </label>
        </div>}
      </div>
      <footer className="form-actions documentation-footer">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Tutup</button>
        <button type="button" className="primary-button" disabled={busy||!parsed||!confirmed} onClick={()=>void save()}>
          {working==="saving"?<><span className="button-spinner" aria-hidden="true"/>Menyimpan…</>:"Simpan"}
        </button>
      </footer>
    </section>
  </div>;
}

function ConfigurationEditor({draft,disabled,onApply}:{draft:string;disabled:boolean;onApply:(draft:string)=>void}){
  const [text,setText]=useState(draft),[error,setError]=useState("");
  function apply(){
    try{
      const data=JSON.parse(text) as Draft;
      const config=data?.config;
      if(!config||![data.name,data.method,data.path,data.portalUrl].every(value=>typeof value==="string"&&value.trim())||typeof data.requestBody!=="string"
        ||!Array.isArray(config.parameters)||!config.parameters.every(parameter=>parameter&&typeof parameter.name==="string"&&typeof parameter.in==="string"&&typeof parameter.required==="boolean")
        ||!Array.isArray(config.warnings)||!config.warnings.every(warning=>typeof warning==="string")
        ||!["unknown","b2b","b2b2c","none"].includes(config.authFlow)
        ||config.expectedHttpStatus!==null&&(!Number.isInteger(config.expectedHttpStatus)||config.expectedHttpStatus<100||config.expectedHttpStatus>599)
        ||config.expectedCode!=null&&(typeof config.expectedCode!=="string"||config.expectedCode.trim()!==""&&!/^\d{7}$/.test(config.expectedCode.trim())))throw Error("Struktur konfigurasi belum lengkap.");
      onApply(JSON.stringify({...data,config:{...config,expectedCode:config.expectedCode?.trim()||null}},null,2));setError("");
    }catch{setError("JSON tidak valid atau struktur konfigurasi belum lengkap. Perbaiki sebelum diterapkan.");}
  }
  return <><label className="form-field"><span>Konfigurasi endpoint (JSON)</span>
    <textarea className="code-editor" rows={12} spellCheck={false} disabled={disabled} value={text} onChange={event=>setText(event.target.value)}/>
  </label>{error&&<p className="field-error" role="alert">{error}</p>}
    <button type="button" className="text-button" disabled={disabled||text===draft} onClick={apply}>Terapkan JSON</button>
  </>;
}
