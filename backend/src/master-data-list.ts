import type { DatabaseService, RecordRow } from "./database.service";
import { can } from "./privileges";
import { secretFields } from "./security";

export type MasterListKind = "snap_user" | "dev_site" | "endpoint" | "sim_provider" | "sim_service" | "service";

type Viewer = { id: string; role: string; privileges?: unknown };

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function toPublic(row: RecordRow) {
  const data = { ...row.data };
  if (row.kind === "sim_provider") {
    const clientId = String(data.clientId ?? "").trim();
    const legacyKey = String(data.clientKey ?? "").trim();
    if (!clientId && legacyKey) data.clientId = legacyKey;
    else if (clientId && legacyKey && clientId !== legacyKey) data.clientIdConflict = true;
    else if (clientId && legacyKey && clientId === legacyKey) delete data.clientKey;
  }
  for (const field of secretFields) if (data[field]) data[field] = "••••••••";
  return { id: row.id, kind: row.kind, name: row.name, parentId: row.parent_id, partnerId: row.partner_id, data, createdAt: row.created_at, updatedAt: row.updated_at };
}

function assertAccess(viewer: Viewer, kind: MasterListKind) {
  const isSim = kind === "sim_provider" || kind === "sim_service";
  if (isSim) {
    if (!(can(viewer, "client_simulator") || can(viewer, "master_data"))) throw { status: 403, error: "Anda tidak memiliki privilege Client Simulator atau Master Data." };
    return;
  }
  if (!can(viewer, "master_data")) throw { status: 403, error: "Anda tidak memiliki privilege Master Data." };
}

/** Server-side Master Data list with search, filter, and pagination. */
export async function listMasterData(db: DatabaseService, viewer: Viewer, input: Record<string, unknown>) {
  const kind = String(input.kind ?? "") as MasterListKind;
  if (!["snap_user", "dev_site", "endpoint", "sim_provider", "sim_service", "service"].includes(kind)) throw { status: 400, error: "Jenis Master Data tidak valid." };
  assertAccess(viewer, kind);

  const page = Math.max(1, Number(input.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(input.pageSize) || 20));
  if (!Number.isInteger(page) || !Number.isInteger(pageSize) || page > 100000) throw { status: 400, error: "Parameter halaman tidak valid." };
  const search = String(input.search ?? "").trim().slice(0, 120);
  const parentId = String(input.parentId ?? input.filterParentId ?? "").trim();
  const linkedOnly = input.linkedOnly === true;
  const linkedIds = Array.isArray(input.linkedServiceIds)
    ? input.linkedServiceIds.map((id) => String(id)).filter((id) => /^[0-9a-f-]{8,}$/i.test(id)).slice(0, 200)
    : [];
  const sort = String(input.sort ?? "updated_at_desc");
  const orderSql =
    sort === "name_asc" ? "name ASC, updated_at DESC"
    : sort === "name_desc" ? "name DESC, updated_at DESC"
    : sort === "created_at_asc" ? "created_at ASC"
    : "updated_at DESC";

  const params: unknown[] = [];
  let where = "";

  if (kind === "dev_site") {
    where = `((kind='environment' AND COALESCE(LOWER(data->>'category'),'') <> 'client simulator') OR (kind='client' AND NOT EXISTS (
      SELECT 1 FROM autosnap_records p
      JOIN autosnap_records e ON e.kind='environment' AND e.parent_id=p.id
      WHERE p.kind='project' AND p.parent_id=autosnap_records.id
    )))`;
  } else {
    const dbKind = kind === "service" ? "service" : kind;
    params.push(dbKind);
    where = `kind=$${params.length}`;
  }

  if ((kind === "sim_service" || kind === "service") && parentId) {
    if (!/^[0-9a-f-]{8,}$/i.test(parentId)) throw { status: 400, error: "Filter induk tidak valid." };
    params.push(parentId);
    where += ` AND parent_id=$${params.length}`;
  }

  if (kind === "service" && linkedOnly) {
    if (!linkedIds.length) return { items: [], total: 0, page, pageSize };
    params.push(linkedIds);
    where += ` AND id = ANY($${params.length}::text[])`;
  }

  if (search) {
    params.push(`%${escapeLike(search.toLowerCase())}%`);
    const idx = params.length;
    where += ` AND (
      LOWER(name) LIKE $${idx} ESCAPE '\\'
      OR LOWER(COALESCE(data->>'email','')) LIKE $${idx} ESCAPE '\\'
      OR LOWER(COALESCE(data->>'path','')) LIKE $${idx} ESCAPE '\\'
      OR LOWER(COALESCE(data->>'method','')) LIKE $${idx} ESCAPE '\\'
      OR LOWER(COALESCE(data->>'baseUrl','')) LIKE $${idx} ESCAPE '\\'
      OR LOWER(COALESCE(data->>'portalUrl','')) LIKE $${idx} ESCAPE '\\'
      OR LOWER(COALESCE(partner_id,'')) LIKE $${idx} ESCAPE '\\'
    )`;
  }

  // Compact option lists for dropdowns (id+name) — not a substitute for paginated tables.
  if (input.options === true) {
    const optionLimit = Math.min(200, Math.max(1, Number(input.optionLimit) || 200));
    params.push(optionLimit);
    const rows = await db.query<RecordRow>(
      `SELECT id, kind, name, parent_id, partner_id, data, created_at, updated_at FROM autosnap_records WHERE ${where} ORDER BY name ASC, updated_at DESC LIMIT $${params.length}`,
      params,
    );
    return {
      items: rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, parentId: row.parent_id, partnerId: row.partner_id, data: {}, createdAt: row.created_at, updatedAt: row.updated_at })),
      total: rows.length,
      page: 1,
      pageSize: optionLimit,
      options: true,
    };
  }

  const totalRow = await db.one<{ n: string }>(`SELECT COUNT(*)::text AS n FROM autosnap_records WHERE ${where}`, params);
  const total = Number(totalRow?.n ?? 0);
  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);
  const rows = await db.query<RecordRow>(
    `SELECT * FROM autosnap_records WHERE ${where} ORDER BY ${orderSql} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.map(toPublic), total, page, pageSize };
}
