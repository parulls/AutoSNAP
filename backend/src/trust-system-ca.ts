import tls from "node:tls";

/** Node ships Mozilla CAs only. Bank Sumut's chain is trusted by Windows, so merge the OS store before any HTTPS call. */
const getCertificates=tls.getCACertificates;
const setCertificates=tls.setDefaultCACertificates;
if(typeof getCertificates==="function"&&typeof setCertificates==="function"){
  try{
    const system=getCertificates("system");
    if(system.length){
      const merged=new Set([...getCertificates("default"),...system]);
      setCertificates([...merged]);
    }
  }catch(error){
    console.error(`CA sistem tidak dimuat: ${(error as Error).message}`);
  }
}
