const aliases: Record<string, string[]> = {
  deviceId: ["deviceId", "device_id", "x-device-id", "X-DEVICE-ID"],
  channelId: ["channelId", "channel_id", "CHANNEL-ID", "channel-id"],
  origin: ["origin", "ORIGIN"],
  ipAddress: ["ipAddress", "ip_address", "X-IP-ADDRESS", "x-ip-address"],
  latitude: ["latitude", "X-LATITUDE", "x-latitude"],
  longitude: ["longitude", "X-LONGITUDE", "x-longitude"],
  clientId: ["clientId", "client_id"],
};

export function profileField(data: Record<string, unknown> | undefined, key: string) {
  const source = data ?? {};
  for (const name of aliases[key] ?? [key]) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Client Master Data wins. Dev Site record fills the same header when the client field is empty. */
export function sentProfileField(client: { data?: Record<string, unknown> } | undefined, site: { data?: Record<string, unknown> } | undefined, key: string) {
  return profileField(client?.data, key) || profileField(site?.data, key);
}

const profileKeys = ["clientId", "deviceId", "channelId", "origin", "ipAddress", "latitude", "longitude"] as const;

/** Copy the header values that will be sent onto the client passed to portal and live engines. */
export function withSentProfile<T extends { data: Record<string, unknown> }>(client: T, site?: { data?: Record<string, unknown> }) {
  const data = { ...client.data };
  for (const key of profileKeys) {
    const resolved = sentProfileField(client, site, key);
    if (resolved) data[key] = resolved;
  }
  if (!profileField(data, "channelId")) data.channelId = "95221";
  return { ...client, data };
}
