import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { pbkdf2 as pbkdf2Callback, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const pbkdf2 = promisify(pbkdf2Callback);
const envFile = join(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function hiddenQuestion(label) {
  if (!process.stdin.isTTY) throw new Error("Jalankan perintah ini langsung dari terminal interaktif.");
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") return finish(new Error("Reset dibatalkan."));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

let pool;
let embedded;
try {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await prompt.question("Username AutoSNAP (atau email akun lama): ")).trim().toLowerCase();
  prompt.close();
  if (!email) throw new Error("Username wajib diisi.");

  const password = await hiddenQuestion("Password baru (minimal 12 karakter): ");
  const confirmation = await hiddenQuestion("Ulangi password baru: ");
  if (password.length < 12) throw new Error("Password minimal 12 karakter.");
  if (password !== confirmation) throw new Error("Konfirmasi password tidak sama.");

  if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  } else {
    embedded = new PGlite(process.env.AUTOSNAP_PGLITE_DIR || join(process.cwd(), ".autosnap-pg"));
    await embedded.waitReady;
  }
  const query = (sql, params = []) => pool ? pool.query(sql, params) : embedded.query(sql, params);
  const account = await query("SELECT id, name FROM autosnap_users WHERE LOWER(email)=$1 OR LOWER(username)=$1", [email]);
  if (!account.rows.length) throw new Error("Akun dengan email tersebut tidak ditemukan.");

  const salt = randomBytes(16).toString("hex");
  const hash = (await pbkdf2(password, Buffer.from(salt, "hex"), 210000, 32, "sha256")).toString("hex");
  await query("UPDATE autosnap_users SET salt=$1, password_hash=$2 WHERE id=$3", [salt, hash, account.rows[0].id]);
  await query("DELETE FROM autosnap_sessions WHERE user_id=$1", [account.rows[0].id]);
  process.stdout.write(`Password ${account.rows[0].name} berhasil di-reset. Silakan login kembali.\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Reset gagal: ${detail}\n`);
  if (/lock|already in use|directory/i.test(detail)) process.stderr.write("Hentikan npm run dev terlebih dahulu, lalu ulangi perintah reset.\n");
  process.exitCode = 1;
} finally {
  await pool?.end();
  await embedded?.close();
}
