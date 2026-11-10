import {mkdir,writeFile} from "node:fs/promises";
import {testingHistoryPdf} from "../backend/dist/report-pdf.js";

const validation=[
  {label:"HTTP status",detail:"Expected 200, received 200.",passed:true},
  {label:"SNAP responseCode",detail:"Expected 2001100, received 2001100.",passed:true},
  {label:"Response JSON",detail:"Response harus berupa object JSON.",passed:true},
  {label:"responseMessage",detail:"Wajib string, maksimal 150 karakter.",passed:false},
];
const repeated=Array.from({length:35},(_,i)=>({balanceType:i%2?"Coins":"Cash",amount:{value:`${1000000+i}.00`,currency:"IDR"},note:"Data panjang untuk memeriksa pembungkusan JSON dan pergantian halaman tanpa menimpa footer."}));
const run={id:"RUN-20261109-PREVIEW",client_id:"c",project_id:"p",environment_id:"e",user_id:"u",service_id:"s",endpoint_id:"ep",scenario_id:null,mode:"portal",status:"Failed",http_status:200,response_code:"2001100",expected_code:"2001100",duration_ms:1842,request_json:{method:"POST",path:"/api/v1.0/balance-inquiry",headers:{Authorization:"[REDACTED]","X-SIGNATURE":"[REDACTED]"},body:{accountNo:"[REDACTED]",bankCardToken:"[REDACTED]",balanceTypes:["Cash","Coins"]},context:{service:"Balance Inquiry",endpoint:"Balance Inquiry",environment:"SNAP Bank Sumut",user:"Ronaldo",useCase:"B2B",testType:"positive"},validation},response_json:{responseCode:"2001100",responseMessage:"Successful",accountInfos:repeated},notes:"Status Failed karena satu validasi responseMessage tidak sesuai walaupun HTTP status dan responseCode sesuai.",created_at:new Date().toISOString()};
const output="output/pdf/autosnap-history-preview.pdf";
await mkdir("output/pdf",{recursive:true});
await writeFile(output,await testingHistoryPdf(run));
process.stdout.write(output+"\n");
