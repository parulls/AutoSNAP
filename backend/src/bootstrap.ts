import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
import { AppModule } from "./app";
import { DatabaseService } from "./database.service";
import { initializeLocalSecurity } from "./local-security";
import { requireTrustedProxy } from "./http-security";

/** Shared bootstrap for the local listener and Vercel's request-bound adapter. */
export async function createApplication(){
  const app=await NestFactory.create(AppModule,{logger:["error","warn","log"],bodyParser:false});
  app.use(requireTrustedProxy);
  app.use(json({limit:"256kb",strict:true}));
  try{
    await app.init();
    await initializeLocalSecurity(app.get(DatabaseService),process.cwd());
    return app;
  }catch(error){await app.close();throw error;}
}
