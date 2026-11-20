import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "scripts/.pdf-compare";
function strip(buf) {
  let s = buf.toString("latin1");
  s = s.replace(/\/CreationDate\s*\([^)]*\)/g, "/CreationDate()");
  s = s.replace(/\/ModDate\s*\([^)]*\)/g, "/ModDate()");
  s = s.replace(/\/ID\s*\[\s*<[^>]+>\s*<[^>]+>\s*\]/g, "/ID[<><>]");
  return createHash("sha256").update(Buffer.from(s, "latin1")).digest("hex");
}
function info(p) {
  const buf = readFileSync(join(dir, p));
  const latin = buf.toString("latin1");
  return {
    p,
    bytes: buf.length,
    raw: createHash("sha256").update(buf).digest("hex"),
    fingerprint: strip(buf),
    creation: (latin.match(/\/CreationDate\s*\(([^)]*)\)/) || [])[1],
    producer: (latin.match(/\/Producer\s*\(([^)]{0,40})\)/) || [])[1],
  };
}
const files = readdirSync(dir).filter((f) => f.endsWith(".pdf"));
const rows = files.map(info);
console.log(JSON.stringify(rows, null, 2));
console.log("unique_fingerprints", [...new Set(rows.map((r) => r.fingerprint))]);
