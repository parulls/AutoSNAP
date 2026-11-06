import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { DatabaseService } from "./database.service";
import { secretFields } from "./security";

type Options = {
  projectDir: string;
  hasStoredCredentials: boolean;
  environment?: NodeJS.ProcessEnv;
};

function validate(value: string) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, "base64").length !== 32) {
    throw new Error("AUTOSNAP_ENCRYPTION_KEY tidak valid. Gunakan key base64 32 byte yang benar; jangan mengganti key jika sudah ada kredensial tersimpan.");
  }
  return value;
}

export async function initializeLocalSecurity(db:DatabaseService,projectDir:string,environment:NodeJS.ProcessEnv=process.env){
  const stored=await db.one<{n:string}>("SELECT COUNT(*)::text AS n FROM autosnap_records WHERE kind IN ('client','snap_user') AND EXISTS (SELECT 1 FROM jsonb_each(data) AS field WHERE field.key=ANY($1::text[]) AND field.value<>'null'::jsonb AND field.value<>'\"\"'::jsonb)",[[...secretFields]]);
  return ensureLocalEncryptionKey({projectDir,hasStoredCredentials:Number(stored?.n)>0,environment});
}

/** Local bootstrap only. Never rotate a configured key or manufacture a key for old ciphertext. */
export function ensureLocalEncryptionKey({ projectDir, hasStoredCredentials, environment = process.env }: Options): "environment" | "file" | "created" {
  if (environment.AUTOSNAP_ENCRYPTION_KEY?.trim()) {
    validate(environment.AUTOSNAP_ENCRYPTION_KEY.trim());
    return "environment";
  }
  const envPath = join(projectDir, ".env.local");
  const readConfigured = () => existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")).AUTOSNAP_ENCRYPTION_KEY : undefined;
  const configured = readConfigured();
  if (configured?.trim()) {
    environment.AUTOSNAP_ENCRYPTION_KEY = validate(configured.trim());
    return "file";
  }
  if (hasStoredCredentials) throw new Error("Key enkripsi untuk kredensial lama tidak ditemukan. Pulihkan AUTOSNAP_ENCRYPTION_KEY yang sebelumnya dipakai; AutoSNAP tidak membuat key pengganti karena data lama akan tidak terbaca.");
  if (environment.NODE_ENV === "production") throw new Error("Konfigurasikan AUTOSNAP_ENCRYPTION_KEY melalui secret server produksi. Pembuatan otomatis hanya untuk penggunaan lokal.");

  const lockPath = join(projectDir, ".autosnap-security.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch { throw new Error("Persiapan enkripsi lokal sedang berlangsung atau folder proyek tidak dapat ditulis. Pastikan hanya satu backend berjalan lalu mulai ulang."); }
  try {
    const concurrentKey = readConfigured();
    if (concurrentKey?.trim()) {
      environment.AUTOSNAP_ENCRYPTION_KEY = validate(concurrentKey.trim());
      return "file";
    }
    const value = randomBytes(32).toString("base64");
    const line = "\n# AutoSNAP: local credential encryption; keep this key with database backups.\nAUTOSNAP_ENCRYPTION_KEY=" + value + "\n";
    if (existsSync(envPath)) appendFileSync(envPath, line, { encoding: "utf8" });
    else writeFileSync(envPath, line.trimStart(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    environment.AUTOSNAP_ENCRYPTION_KEY = value;
    return "created";
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
