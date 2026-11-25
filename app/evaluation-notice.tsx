"use client";

import type { Run } from "./model";

const object = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry);

export default function EvaluationNotice({ run }: { run: Run | null | undefined }) {
  const evaluation = object(run?.request) && object(run.request.evaluation) ? run.request.evaluation : null;
  if (!evaluation || !["COMPLETED", "PASSED", "FAILED", "AUTOMATION_ERROR", "CANCELLED", "VALIDATION_ERROR"].includes(String(evaluation.outcome))) return null;
  const mode = String(evaluation.mode ?? "HTTP_ONLY") === "SNAP_AND_HTTP" ? "SNAP + HTTP" : "HTTP Only";
  const http = object(evaluation.httpValidation) ? evaluation.httpValidation : null;
  const snap = object(evaluation.snapValidation) ? evaluation.snapValidation : null;
  return <aside className="evaluation-notice" role="status" aria-label="Hasil pengujian"><strong>Outcome: {String(evaluation.outcome)}</strong><p>Validasi: {mode}</p><p>Tahap: {String(evaluation.stageLabel ?? "Validasi")}</p>{http ? <p>HTTP: expected {String(http.expectedStatus ?? "—")}, actual {http.actualStatus == null ? "belum terverifikasi" : String(http.actualStatus)}, sumber {String(http.source ?? "—")}</p> : null}{snap && snap.performed ? <p>SNAP: expected {String(snap.expectedCode ?? "—")}, actual {String(snap.actualCode ?? "—")}</p> : null}<p>{String(evaluation.detail)}</p>{evaluation.suggestion ? <p>Saran: {String(evaluation.suggestion)}</p> : null}</aside>;
}
