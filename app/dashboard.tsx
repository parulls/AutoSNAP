"use client";

import { useState } from "react";
import type { Api, HistoryFilters, State } from "./model";
import HistoryFilter from "./history-filter";
import { rangeForPeriod } from "./history-period";
import { operatorLabel, useHistory } from "./use-history";
import { can } from "./privileges";
import { clientSimulatorHistoryLabel } from "./client-simulator-name";

type Target =
  | "Dev Site Client"
  | "Client Simulator"
  | "Master Data"
  | "User Management";

type MetricCard = {
  label: string;
  value: number;
  target?: Target;
  status?: string;
  badge?: string;
};

function statusClass(status: string) {
  const key = status.toLowerCase();
  if (key === "passed") return "passed";
  if (key === "failed") return "failed";
  if (key === "completed") return "completed";
  if (key === "automation_error" || key === "validation_error") return "automation_error";
  if (key === "cancelled") return "cancelled";
  if (key === "running") return "running";
  return key;
}

export default function Dashboard({
  state,
  api,
  navigate,
  reload,
}: {
  state: State;
  api: Api;
  navigate: (target: Target) => void;
  reload?: () => Promise<void>;
}) {
  const isAdmin = can(state.user, "history", "view_all");
  const [range, setRange] = useState(() => rangeForPeriod("today"));
  const [offset, setOffset] = useState(0);
  const [mode, setMode] = useState("all");
  const [filters, setFilters] = useState<HistoryFilters>({ scope: isAdmin ? "all" : "mine" });
  const [refreshing, setRefreshing] = useState(false);

  const history = useHistory(api, range, mode, "", offset, 15, state.runs, filters);

  const recent = history.runs;
  const { dev, simulator, passed, failed, errors, completed = 0, cancelled = 0 } = history.summary as typeof history.summary & { completed?: number; cancelled?: number };

  async function refreshDashboard() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await reload?.();
      history.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  const contextOf = (run: (typeof recent)[number]) =>
    run.request &&
    typeof run.request === "object" &&
    !Array.isArray(run.request) &&
    "context" in run.request &&
    run.request.context &&
    typeof run.request.context === "object" &&
    !Array.isArray(run.request.context)
      ? (run.request.context as Record<string, unknown>)
      : {};

  const cards: MetricCard[] = [
    { label: "Dev Site diuji", value: dev, target: "Dev Site Client" },
    { label: "Simulator diuji", value: simulator, target: "Client Simulator" },
    { label: "PASSED", value: passed, status: "passed", badge: "PASSED" },
    { label: "FAILED", value: failed, status: "failed", badge: "FAILED" },
    { label: "AUTOMATION / VALIDATION ERROR", value: errors, status: "automation_error", badge: "ERROR" },
    ...(completed ? [{ label: "COMPLETED", value: completed, status: "completed", badge: "COMPLETED" }] : []),
    ...(cancelled ? [{ label: "CANCELLED", value: cancelled, status: "cancelled", badge: "CANCELLED" }] : []),
  ];

  const scopeLabel = isAdmin
    ? filters.scope === "mine"
      ? "pengujian Anda"
      : "seluruh pengguna AutoSNAP"
    : "pengujian milik akun Anda";

  return (
    <div className="dashboard-page">
      <div className="dashboard-toolbar">
        <HistoryFilter
          value={range}
          onChange={(value) => {
            setRange(value);
            setOffset(0);
          }}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next);
            setOffset(0);
          }}
          isAdmin={isAdmin}
          showMode
          mode={mode}
          onModeChange={(next) => {
            setMode(next);
            setOffset(0);
          }}
        />

        <button
          type="button"
          className="secondary-button"
          disabled={refreshing || history.loading}
          onClick={() => void refreshDashboard()}
        >
          {refreshing ? "Memperbarui…" : "Refresh"}
        </button>
      </div>

      {history.error && (
        <p role="alert" className="field-error">
          {history.error}
        </p>
      )}

      <section className="dashboard-grid">
        {cards.map((card) => {
          const content = (
            <>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              {card.badge && (
                <span className={`status-badge ${card.status}`}>
                  {card.badge}
                </span>
              )}
            </>
          );

          return card.target ? (
            <button
              key={card.label}
              type="button"
              className="card metric-card"
              onClick={() => navigate(card.target!)}
            >
              {content}
            </button>
          ) : (
            <div key={card.label} className="card metric-card">
              {content}
            </div>
          );
        })}
      </section>

      {isAdmin && filters.scope !== "mine" && history.byOperator.length > 0 && (
        <section className="card dashboard-history">
          <div className="section-header">
            <div>
              <h2>Ringkasan per Pengguna</h2>
              <p>Jumlah pengujian pada filter dan periode terpilih.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PENGGUNA</th>
                  <th>ROLE</th>
                  <th>TOTAL</th>
                  <th>PASSED</th>
                  <th>FAILED</th>
                  <th>COMPLETED</th>
                </tr>
              </thead>
              <tbody>
                {history.byOperator.map((row) => (
                  <tr key={row.operator_id ?? row.username}>
                    <td>{row.name}{row.username && row.username !== "-" ? ` (@${row.username})` : ""}</td>
                    <td>{row.role === "admin" ? "Admin" : row.role === "petugas" ? "Petugas" : "—"}</td>
                    <td>{row.total}</td>
                    <td>{row.passed}</td>
                    <td>{row.failed}</td>
                    <td>{row.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card dashboard-history">
        <div className="section-header">
          <div>
            <h2>History Testing</h2>
            <p>
              {history.total} {scopeLabel} pada periode terpilih.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>WAKTU</th>
                {isAdmin && <th>PELAKSANA</th>}
                <th>SERVICE</th>
                <th>DEV SITE / PENYEDIA</th>
                <th>JENIS</th>
                <th>STATUS</th>
              </tr>
            </thead>

            <tbody>
              {recent.map((run) => {
                const context = contextOf(run);
                const request = run.request && typeof run.request === "object" && !Array.isArray(run.request) ? run.request as Record<string, unknown> : {};
                const named = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) && "name" in value ? String((value as { name?: unknown }).name ?? "") : "";
                const actor = operatorLabel(run);
                const kindLabel = clientSimulatorHistoryLabel({ scenarioName: request.scenarioName, testType: request.testType ?? context.testType });
                return (
                  <tr key={run.id}>
                    <td>
                      {new Date(run.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}
                    </td>
                    {isAdmin && <td>{actor.text}</td>}
                    <td>{String(context.service || named(request.service) || "—")}</td>
                    <td>{String(context.environment || named(request.provider) || "—")}</td>
                    <td>{kindLabel}</td>
                    <td>
                      <span className={`status-badge ${statusClass(run.status)}`}>
                        {run.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {!recent.length && (
            <p className="empty-note">
              {history.loading ? "Memuat history…" : "Belum ada pengujian pada periode ini."}
            </p>
          )}
        </div>

        <div className="history-pagination">
          <button type="button" className="secondary-button" disabled={!offset || history.loading} onClick={() => setOffset(Math.max(0, offset - 15))}>
            Sebelumnya
          </button>
          <span>{history.total ? `${offset + 1}-${Math.min(offset + recent.length, history.total)} dari ${history.total}` : "0 hasil"}</span>
          <button type="button" className="secondary-button" disabled={offset + 15 >= history.total || history.loading} onClick={() => setOffset(offset + 15)}>
            Berikutnya
          </button>
        </div>
      </section>
    </div>
  );
}
