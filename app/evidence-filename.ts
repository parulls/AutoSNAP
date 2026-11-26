/** Shared evidence PDF filename helpers. Keep in sync with backend/src/evidence-filename.ts. */

const object = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry);

/** Friendly ASPI labels for prerequisite utility paths (Dev Site multi-activity runs). */
export const EVIDENCE_PATH_LABELS: Record<string, string> = {
  "/api/v1.0/utilities/signature-auth": "Signature Authentication",
  "/api/v1.0/access-token/b2b": "Access Token B2B",
  "/api/v1.0/utilities/signature-service": "Signature Service",
};

export function evidencePathLabel(pathOrName: string) {
  const raw = String(pathOrName ?? "").trim();
  if (!raw) return "";
  if (EVIDENCE_PATH_LABELS[raw]) return EVIDENCE_PATH_LABELS[raw];
  if (raw.startsWith("/")) {
    const tail = raw.split("/").filter(Boolean).at(-1) ?? raw;
    if (/signature-auth/i.test(tail)) return "Signature Authentication";
    if (/access-token/i.test(tail)) return "Access Token B2B";
    if (/signature-service/i.test(tail)) return "Signature Service";
  }
  return raw;
}

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

/** Registered API Service name from a persisted run snapshot (main/target service of the run). */
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

function activityServiceLabel(activity: Record<string, unknown> | null | undefined) {
  if (!object(activity)) return "";
  for (const key of ["service", "serviceName"] as const) {
    const raw = String(activity[key] ?? "").trim();
    if (!raw) continue;
    return evidencePathLabel(raw);
  }
  return "";
}

function operationServiceForActivity(request: Record<string, unknown>, activityId: string) {
  const evidence = object(request.evidence) ? request.evidence : null;
  if (!evidence || !Array.isArray(evidence.operations) || !activityId) return "";
  for (const entry of evidence.operations) {
    if (!object(entry)) continue;
    const linked = object(entry.activity) ? entry.activity : null;
    if (!linked || String(linked.activityId ?? "").trim() !== activityId) continue;
    const fromService = String(entry.service ?? "").trim();
    if (fromService) return evidencePathLabel(fromService);
    const fromPath = String(entry.path ?? "").trim();
    if (fromPath) return evidencePathLabel(fromPath);
    const fromLinked = activityServiceLabel(linked);
    if (fromLinked) return fromLinked;
  }
  return "";
}

/**
 * Base name for evidence PDF download.
 * Client Simulator: ASPI HTML service name = "Penyedia - Service - Skenario".
 * Dev Site Client: per-activity ASPI service label (Signature Authentication, Balance Inquiry, …),
 * never the last-selected/main run service for a different activityId.
 */
export function resolveEvidencePdfBaseName(request: Record<string, unknown> | null | undefined, activity?: Record<string, unknown> | null) {
  const req = object(request) ? request : {};
  const clientSim = req.mode === "client_sim" || !!String(req.aspiServiceName ?? "").trim();
  if (clientSim) {
    const identity = object(req.identity) ? req.identity : null;
    for (const candidate of [
      String(req.aspiServiceName ?? "").trim(),
      String(req.activityName ?? "").trim(),
      String(identity?.aspiServiceName ?? "").trim(),
      activityServiceLabel(activity),
    ]) if (candidate) return candidate;
  }

  const fromActivity = activityServiceLabel(activity);
  if (fromActivity) return fromActivity;

  const activityId = object(activity) ? String(activity.activityId ?? "").trim() : "";
  const fromOperation = operationServiceForActivity(req, activityId);
  if (fromOperation) return fromOperation;

  return resolveRegisteredServiceName(request, activity);
}

/** Resolve PDF filename for one activity on a run. */
export function evidencePdfFilenameForRun(request: Record<string, unknown> | null | undefined, activity?: Record<string, unknown> | null) {
  return evidencePdfFilename(resolveEvidencePdfBaseName(request, activity));
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
