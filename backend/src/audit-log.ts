import { randomUUID } from "node:crypto";
import type { DatabaseService } from "./database.service";
import { redact } from "./security";

export async function writeAudit(db:DatabaseService,actorId:string|null,action:string,targetKind:string|null,targetId:string|null,detail:Record<string,unknown>={}){
  await db.query(
    "INSERT INTO autosnap_audit_log (id,actor_id,action,target_kind,target_id,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)",
    [randomUUID(),actorId,action,targetKind,targetId,JSON.stringify(redact(detail)),new Date().toISOString()]
  );
}
