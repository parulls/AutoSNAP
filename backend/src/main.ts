import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { json } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app";
import { DatabaseService } from "./database.service";
import { initializeLocalSecurity } from "./local-security";

async function main(){
  const envFile=join(process.cwd(),".env.local");
  if(existsSync(envFile))process.loadEnvFile(envFile);
  const app=await NestFactory.create(AppModule,{logger:["error","warn","log"]});
  app.use(json({limit:"2mb"}));
  app.enableShutdownHooks();
  try{
    await app.init();
    const db=app.get(DatabaseService);
    await initializeLocalSecurity(db,process.cwd());
    await app.listen(Number(process.env.AUTOSNAP_API_PORT??4010),"127.0.0.1");
  }catch(error){await app.close();throw error;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
