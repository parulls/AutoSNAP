"use client";

import type { ReactNode } from "react";

type Props = {
  columns: string[];
  busy?: boolean;
  error?: string;
  empty?: string;
  search?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  hasRows: boolean;
};

export default function DataTable({ columns, busy = false, error = "", empty = "Belum ada data.", search, footer, children, hasRows }: Props) {
  return (
    <div className="data-table-shell">
      {search && <div className="data-table-toolbar">{search}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="table-wrap" aria-busy={busy}>
        <table>
          <thead>
            <tr>{columns.map((col) => <th key={col}>{col}</th>)}</tr>
          </thead>
          <tbody>{hasRows ? children : null}</tbody>
        </table>
        {!hasRows && !busy && !error && <p className="empty-note">{empty}</p>}
        {busy && !hasRows && <p className="empty-note">Memuat data…</p>}
      </div>
      {footer}
    </div>
  );
}
