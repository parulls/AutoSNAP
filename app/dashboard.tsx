"use client";

import { useState } from "react";
import type { Api, State } from "./model";
import HistoryFilter from "./history-filter";
import { rangeForPeriod } from "./history-period";
import { useHistory } from "./use-history";

type Target =
  | "Dev Site Client"
  | "Client Simulator"
  | "Master Data"
  | "User Management";

type MetricCard = {
  label: string;
  value: number;
  target?: Target;
  status?: "passed" | "failed" | "warning";
};

export default function Dashboard({
  state,
  api,
  navigate,
}: {
  state: State;
  api: Api;
  navigate: (target: Target) => void;
}) {
  const [range, setRange] = useState(() => rangeForPeriod("today"));
  const [offset, setOffset] = useState(0);

  const history = useHistory(
    api,
    range,
    "all",
    "",
    offset,
    15,
    state.runs
  );

  const recent = history.runs;
  const { dev, simulator, passed, failed, errors } = history.summary;

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
    {
      label: "Dev Site diuji",
      value: dev,
      target: "Dev Site Client",
    },
    {
      label: "Simulator diuji",
      value: simulator,
      target: "Client Simulator",
    },
    {
      label: "Passed",
      value: passed,
      status: "passed",
    },
    {
      label: "Failed",
      value: failed,
      status: "failed",
    },
    {
      label: "Error",
      value: errors,
      status: "warning",
    },
  ];

  return (
    <div className="dashboard-page">
      <HistoryFilter
        value={range}
        onChange={(value) => {
          setRange(value);
          setOffset(0);
        }}
      />

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

              {card.status && (
                <span className={`status-badge ${card.status}`}>
                  {card.status}
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
            <div
              key={card.label}
              className="card metric-card"
            >
              {content}
            </div>
          );
        })}
      </section>

      <section className="card dashboard-history">
        <div className="section-header">
          <div>
            <h2>History Testing</h2>
            <p>
              {history.total} pengujian milik akun Anda
              pada periode terpilih.
            </p>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>WAKTU</th>
                <th>SERVICE</th>
                <th>DEV SITE CLIENT</th>
                <th>SKENARIO</th>
                <th>STATUS</th>
              </tr>
            </thead>

            <tbody>
              {recent.map((run) => {
                const context = contextOf(run);

                return (
                  <tr key={run.id}>
                    <td>
                      {new Date(run.created_at).toLocaleString(
                        "id-ID",
                        { timeZone: "Asia/Jakarta" }
                      )}
                    </td>

                    <td>
                      {String(context.service ?? "—")}
                    </td>

                    <td>
                      {String(context.environment ?? "—")}
                    </td>

                    <td>
                      {context.testType === "invalid_access_token"
                        ? "Negatif"
                        : "Positif"}
                    </td>

                    <td>
                      <span
                        className={`status-badge ${run.status.toLowerCase()}`}
                      >
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
              {history.loading
                ? "Memuat history…"
                : "Belum ada pengujian pada periode ini."}
            </p>
          )}
        </div>

        <div className="history-pagination">
          <button
            type="button"
            className="secondary-button"
            disabled={!offset || history.loading}
            onClick={() =>
              setOffset(Math.max(0, offset - 15))
            }
          >
            Sebelumnya
          </button>

          <span>
            {history.total
              ? `${offset + 1}`
              : "0 hasil"}
          </span>

          <button
            type="button"
            className="secondary-button"
            disabled={
              offset + 15 >= history.total ||
              history.loading
            }
            onClick={() => setOffset(offset + 15)}
          >
            Berikutnya
          </button>
        </div>
      </section>
    </div>
  );
}
