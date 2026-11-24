export type DevSiteRecord = {
  id: string;
  kind: string;
  parentId?: string | null;
  parent_id?: string | null;
  partnerId?: string | null;
  data?: Record<string, unknown>;
};

const aliases: Record<string, string[]> = {
  deviceId: ["deviceId", "device_id", "x-device-id", "X-DEVICE-ID"],
  channelId: ["channelId", "channel_id", "CHANNEL-ID", "channel-id"],
  origin: ["origin", "ORIGIN"],
  ipAddress: ["ipAddress", "ip_address", "X-IP-ADDRESS", "x-ip-address"],
  latitude: ["latitude", "X-LATITUDE", "x-latitude"],
  longitude: ["longitude", "X-LONGITUDE", "x-longitude"],
  clientId: ["clientId", "client_id"],
  partnerIdSource: ["partnerIdSource"],
  partnerId: ["partnerId", "partner_id"],
};

export function parentOf(row: DevSiteRecord | undefined) {
  if (!row) return null;
  return row.parentId ?? row.parent_id ?? null;
}

export function fieldOf(row: DevSiteRecord | null | undefined, key: string) {
  const data = row?.data ?? {};
  for (const name of aliases[key] ?? [key]) {
    const value = data[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Environment -> project -> client, including a Dev Site whose parent is the client itself. */
export function linkDevSite<T extends DevSiteRecord>(records: T[], site: T | undefined) {
  if (!site) return { site: undefined as T | undefined, project: undefined as T | undefined, client: undefined as T | undefined };
  const parent = records.find(row => row.id === parentOf(site));
  if (parent?.kind === "client") return { site, project: undefined as T | undefined, client: parent };
  const project = parent?.kind === "project" ? parent : undefined;
  const client = project ? records.find(row => row.kind === "client" && row.id === parentOf(project)) : undefined;
  return { site, project, client };
}

/** Value sent on the wire: client first, then the Dev Site record. */
export function sentHeaderField(client: DevSiteRecord | undefined, site: DevSiteRecord | undefined, key: string) {
  return fieldOf(client, key) || fieldOf(site, key);
}
