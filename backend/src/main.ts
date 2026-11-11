import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app";
import { DatabaseService } from "./database.service";
import { initializeLocalSecurity } from "./local-security";
import { requireTrustedProxy } from "./http-security";

async function main(){
  const envFile=join(process.cwd(),".env.local");
  if(existsSync(envFile))process.loadEnvFile(envFile);
  const app=await NestFactory.create(AppModule,{logger:["error","warn","log"],bodyParser:false});
  app.use(requireTrustedProxy);
  app.use(json({limit:"256kb",strict:true}));
  app.enableShutdownHooks();
  try{
    await app.init();
    const db=app.get(DatabaseService);
    await initializeLocalSecurity(db,process.cwd());
    await app.listen(Number(process.env.PORT??process.env.AUTOSNAP_API_PORT??4010),process.env.AUTOSNAP_API_HOST??(process.env.VERCEL?"0.0.0.0":"127.0.0.1"));
  }catch(error){await app.close();throw error;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
