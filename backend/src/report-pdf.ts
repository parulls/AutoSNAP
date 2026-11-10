import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import type { RunRow } from "./database.service";
import { redact } from "./security";

const margin=42.52;
const topMargin=60;
const colors={ink:"#172033",muted:"#667085",line:"#D9E0EA",soft:"#F4F6F8",primary:"#1D4ED8",success:"#166534",successBg:"#DCFCE7",danger:"#991B1B",dangerBg:"#FEE2E2",neutral:"#475569",neutralBg:"#E2E8F0"};
const safe=(value:unknown)=>value===null||value===undefined||value===""?"-":String(value);
const asObject=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};

export function testingHistoryPdf(run:RunRow){
  return new Promise<Buffer>((resolve,reject)=>{
    const doc=new PDFDocument({size:"A4",margins:{top:topMargin,right:margin,bottom:margin,left:margin},bufferPages:true,info:{Title:`AutoSNAP Testing History ${run.id}`,Author:"AutoSNAP"}});
    const chunks:Buffer[]=[];
    doc.on("data",chunk=>chunks.push(Buffer.from(chunk)));doc.on("error",reject);doc.on("end",()=>resolve(Buffer.concat(chunks)));
    const arial="C:\\Windows\\Fonts\\arial.ttf",arialBold="C:\\Windows\\Fonts\\arialbd.ttf",consolas="C:\\Windows\\Fonts\\consola.ttf";
    const normal=existsSync(arial)?(doc.registerFont("ReportNormal",arial),"ReportNormal"):"Helvetica";
    const bold=existsSync(arialBold)?(doc.registerFont("ReportBold",arialBold),"ReportBold"):"Helvetica-Bold";
    const mono=existsSync(consolas)?(doc.registerFont("ReportMono",consolas),"ReportMono"):"Courier";
    const width=doc.page.width-margin*2,bottom=doc.page.height-margin;
    const request=asObject(run.request_json),context=asObject(request.context),validation=Array.isArray(request.validation)?request.validation.map(asObject):[];
    const sanitizedRequest=redact(run.request_json),sanitizedResponse=redact(run.response_json);
    const pageOptions={size:"A4" as const,margins:{top:topMargin,right:margin,bottom:margin,left:margin}};
    const newPage=()=>{doc.addPage(pageOptions);doc.x=margin;doc.y=topMargin;};
    const body=()=>doc.font(normal).fontSize(10.5).fillColor(colors.ink);
    const ensure=(height:number)=>{if(doc.y+height>bottom)newPage();};
    const title=(text:string)=>{ensure(34);doc.x=margin;doc.font(bold).fontSize(14).fillColor(colors.ink).text(text,{width});doc.moveDown(.35);doc.strokeColor(colors.line).lineWidth(.7).moveTo(margin,doc.y).lineTo(doc.page.width-margin,doc.y).stroke();doc.moveDown(.55);};
    const statusStyle=(status:string)=>status.toLowerCase()==="passed"?{fg:colors.success,bg:colors.successBg,label:"PASSED"}:status.toLowerCase()==="failed"?{fg:colors.danger,bg:colors.dangerBg,label:"FAILED"}:status.toLowerCase()==="running"?{fg:colors.primary,bg:"#DBEAFE",label:"RUNNING"}:{fg:colors.neutral,bg:colors.neutralBg,label:status.toUpperCase()};
    const badge=(status:string,x:number,y:number,w=72)=>{const style=statusStyle(status);doc.roundedRect(x,y,w,22,11).fillAndStroke(style.bg,style.fg);doc.font(bold).fontSize(9).fillColor(style.fg).text(style.label,x,y+6,{width:w,align:"center",lineBreak:false});};
    const infoCell=(label:string,value:unknown,x:number,y:number,w:number)=>{doc.font(bold).fontSize(8.5).fillColor(colors.muted).text(label.toUpperCase(),x,y,{width:w});doc.font(normal).fontSize(10.5).fillColor(colors.ink).text(safe(value),x,y+14,{width:w,height:28,ellipsis:true});};
    const metric=(label:string,value:unknown,x:number,y:number,w:number)=>{doc.roundedRect(x,y,w,54,6).fillAndStroke(colors.soft,colors.line);doc.font(bold).fontSize(8).fillColor(colors.muted).text(label.toUpperCase(),x+9,y+9,{width:w-18});doc.font(bold).fontSize(13).fillColor(colors.ink).text(safe(value),x+9,y+27,{width:w-18,ellipsis:true});};
    const wrapMono=(text:string,maxWidth:number)=>{doc.font(mono).fontSize(8.5);const output:string[]=[];for(const raw of text.split("\n")){if(!raw){output.push("");continue;}const indent=raw.match(/^\s*/)?.[0]??"";let rest=raw;while(doc.widthOfString(rest)>maxWidth){let cut=1;while(cut<rest.length&&doc.widthOfString(rest.slice(0,cut+1))<=maxWidth)cut++;const space=rest.lastIndexOf(" ",cut);if(space>indent.length+8)cut=space;output.push(rest.slice(0,cut));rest=indent+"  "+rest.slice(cut).trimStart();}output.push(rest);}return output;};
    const jsonBlock=(value:unknown)=>{const lines=wrapMono(JSON.stringify(value,null,2),width-20),lineHeight=12.5;let cursor=0;while(cursor<lines.length){const available=bottom-doc.y-40;let count=Math.floor((available-20)/lineHeight);if(count<2){newPage();continue;}const remaining=lines.length-cursor;count=Math.min(count,40,remaining);if(remaining>count&&remaining-count<8&&count>8)count=remaining-8;const h=count*lineHeight+20,x=margin,y=doc.y;doc.roundedRect(x,y,width,h,5).fillAndStroke(colors.soft,colors.line);doc.font(mono).fontSize(8.5).fillColor("#243044");for(let i=0;i<count;i++)doc.text(lines[cursor+i],x+10,y+10+i*lineHeight,{width:width-20,height:lineHeight,lineBreak:false});doc.y=y+h;cursor+=count;if(cursor<lines.length)newPage();}};

    doc.font(bold).fontSize(20).fillColor(colors.ink).text("Laporan History Testing",{align:"left"});doc.font(normal).fontSize(11).fillColor(colors.muted).text("SNAP API Automation Testing",{align:"left"});badge(run.status,doc.page.width-margin-78,margin+1,78);
    doc.x=margin;doc.y=103;title("Identitas Pengujian");
    const gap=22,col=(width-gap)/2,startY=doc.y,left=margin,right=margin+col+gap;
    const leftItems=[["ID Testing",run.id],["Waktu",new Date(run.created_at).toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})],["User SNAP",context.user],["Dev Site",context.environment]];
    const rightItems=[["API Service",context.service],["Endpoint",context.endpoint],["Use Case",context.useCase],["Jenis Testing",context.testType==="invalid_access_token"?"Tes Negatif - Access Token Tidak Valid":"Tes Positif"]];
    for(let i=0;i<4;i++){infoCell(String(leftItems[i][0]),leftItems[i][1],left,startY+i*43,col);infoCell(String(rightItems[i][0]),rightItems[i][1],right,startY+i*43,col);}doc.y=startY+174;
    title("Ringkasan Hasil");const metricGap=8,metricWidth=(width-metricGap*3)/4,metricY=doc.y;
    [["HTTP Status",run.http_status],["Response Code",run.response_code],["Expected Code",run.expected_code],["Durasi",run.duration_ms===null?null:`${run.duration_ms} ms`]].forEach(([label,value],i)=>metric(String(label),value,margin+i*(metricWidth+metricGap),metricY,metricWidth));
    doc.x=margin;doc.y=metricY+65;body().font(bold).text("Catatan",{width});doc.font(normal).fillColor(colors.muted).text(safe(run.notes),{width});doc.moveDown(.8);title("Hasil Validasi Expected vs Actual");
    if(!validation.length)body().fillColor(colors.muted).text("Tidak ada hasil validasi yang tersimpan untuk eksekusi ini.");
    else for(const item of validation){ensure(42);const passed=item.passed===true,fg=passed?colors.success:colors.danger,bg=passed?colors.successBg:colors.dangerBg,y=doc.y;doc.roundedRect(margin,y,width,34,5).fillAndStroke("#FFFFFF",colors.line);doc.roundedRect(margin+8,y+8,50,18,9).fill(bg);doc.font(bold).fontSize(8).fillColor(fg).text(passed?"PASS":"FAIL",margin+8,y+13,{width:50,align:"center",lineBreak:false});doc.font(bold).fontSize(9.5).fillColor(colors.ink).text(safe(item.label),margin+68,y+6,{width:width-78,height:13,ellipsis:true});doc.font(normal).fontSize(9).fillColor(colors.muted).text(safe(item.detail),margin+68,y+19,{width:width-78,height:12,ellipsis:true});doc.y=y+40;}

    newPage();doc.font(bold).fontSize(18).fillColor(colors.ink).text("Request Detail");doc.moveDown(.25);doc.font(normal).fontSize(10).fillColor(colors.muted).text("Request, context, dan hasil validasi yang telah disanitasi.");doc.moveDown(.8);jsonBlock(sanitizedRequest);
    newPage();doc.font(bold).fontSize(18).fillColor(colors.ink).text("Response Detail");doc.moveDown(.25);doc.font(normal).fontSize(10).fillColor(colors.muted).text("Response API yang telah disanitasi.");doc.moveDown(.8);jsonBlock(sanitizedResponse);

    const range=doc.bufferedPageRange();for(let index=range.start;index<range.start+range.count;index++){doc.switchToPage(index);const oldTop=doc.page.margins.top,oldBottom=doc.page.margins.bottom;doc.page.margins.top=0;doc.page.margins.bottom=0;doc.strokeColor(colors.line).lineWidth(.6).moveTo(margin,45).lineTo(doc.page.width-margin,45).stroke();doc.font(bold).fontSize(9).fillColor(colors.ink).text("AutoSNAP",margin,28,{width:100,lineBreak:false});doc.font(normal).fontSize(8.5).fillColor(colors.muted).text(`ID: ${run.id}`,margin+110,28,{width:doc.page.width-margin*2-110,align:"right",lineBreak:false});doc.strokeColor(colors.line).moveTo(margin,doc.page.height-30).lineTo(doc.page.width-margin,doc.page.height-30).stroke();doc.font(normal).fontSize(8).fillColor(colors.muted).text(`Halaman ${index-range.start+1} dari ${range.count}`,margin,doc.page.height-23,{width,align:"center",lineBreak:false});doc.page.margins.top=oldTop;doc.page.margins.bottom=oldBottom;}doc.end();
  });
}
