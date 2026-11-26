/** Shared evidence PDF filename helpers. Keep in sync with app/evidence-filename.ts. */

const object = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry);

/** Strip characters unsafe for filesystem / Content-Disposition. Keep Unicode letters and spaces. */
export function sanitizeEvidenceFilenameBase(raw: string, fallback = "API Service") {
  const cleaned = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** Registered API Service name from a persisted run snapshot. */
export function resolveRegisteredServiceName(request: Record<string, unknown> | null | undefined, activity?: Record<string, unknown> | null) {
  const req = object(request) ? request : {};
  const identity = object(req.identity) ? req.identity : null;
  const fromIdentity = String(identity?.serviceName ?? "").trim();
  if (fromIdentity) return fromIdentity;
  const service = object(req.service) ? req.service : null;
  const fromService = String(service?.name ?? "").trim();
  if (fromService) return fromService;
  const context = object(req.context) ? req.context : null;
  const fromContext = String(context?.service ?? "").trim();
  if (fromContext) return fromContext;
  const registered = String(req.registeredServiceName ?? "").trim();
  if (registered) return registered;
  if (object(activity)) {
    const fromActivity = String(activity.registeredServiceName ?? "").trim();
    if (fromActivity) return fromActivity;
  }
  return "API Service";
}

/** Single-PDF download name: "{API Service}.pdf". */
export function evidencePdfFilename(serviceName: string) {
  return `${sanitizeEvidenceFilenameBase(serviceName)}.pdf`;
}

/** Resolve PDF filename for one activity on a run. */
export function evidencePdfFilenameForRun(request: Record<string, unknown> | null | undefined, activity?: Record<string, unknown> | null) {
  return evidencePdfFilename(resolveRegisteredServiceName(request, activity));
}

/** ZIP entry names: same base as single PDF; numeric suffix only on collisions. */
export function uniqueEvidenceZipEntryNames(serviceNames: string[]) {
  const used = new Map<string, number>();
  return serviceNames.map(name => {
    const base = sanitizeEvidenceFilenameBase(name);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? `${base}.pdf` : `${base} (${count}).pdf`;
  });
}

/** Content-Disposition with ASCII fallback + RFC 5987 UTF-8 filename*. */
export function contentDispositionAttachment(filename: string) {
  const safe = sanitizeEvidenceFilenameBase(filename.replace(/\.pdf$/i, "")) + (/\.pdf$/i.test(filename) ? ".pdf" : "");
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "download.pdf";
  const encoded = encodeURIComponent(safe).replace(/['()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
