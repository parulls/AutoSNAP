import express from "express";
import {createRequire} from "node:module";
import type {INestApplication} from "@nestjs/common";

const require=createRequire(import.meta.url);
const {createApplication}=require("./backend/dist/bootstrap.js") as {createApplication:()=>Promise<INestApplication>};
const {requireTrustedProxy}=require("./backend/dist/http-security.js") as {requireTrustedProxy:express.RequestHandler};
const server=express();
server.disable("x-powered-by");
let initialization:Promise<INestApplication>|undefined;

server.get("/",(_req,res)=>res.json({status:"ok",service:"autosnap-api",message:"Backend AutoSNAP aktif. Gunakan frontend untuk login dan menjalankan pengujian.",health:"/health"}));
server.get("/health",(_req,res)=>res.json({status:"ok",service:"autosnap-api"}));
server.all("/autosnap",requireTrustedProxy,async(req,res)=>{
  try{
    initialization??=createApplication().catch(error=>{initialization=undefined;throw error;});
    const app=await initialization;
    app.getHttpAdapter().getInstance()(req,res);
  }catch{
    res.status(503).json({error:"Backend belum siap. Periksa konfigurasi database dan secret server."});
  }
});

export default server;
