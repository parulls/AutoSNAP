import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "./bootstrap";

async function main(){
  const envFile=join(process.cwd(),".env.local");
  if(existsSync(envFile))process.loadEnvFile(envFile);
  const app=await createApplication();
  app.enableShutdownHooks();
  try{
    await app.listen(Number(process.env.PORT??process.env.AUTOSNAP_API_PORT??4010),process.env.AUTOSNAP_API_HOST??(process.env.VERCEL?"0.0.0.0":"127.0.0.1"));
  }catch(error){await app.close();throw error;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
