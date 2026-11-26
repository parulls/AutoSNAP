"use client";

type Props = {
  page: number;
  pageSize: number;
  total: number;
  busy?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

export default function PaginationBar({ page, pageSize, total, busy = false, onPageChange, onPageSizeChange }: Props) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(total, current * pageSize);
  return (
    <div className="pagination-bar" role="navigation" aria-label="Navigasi halaman">
      <span className="pagination-meta">{total ? `${from}–${to} dari ${total}` : "0 data"}</span>
      <div className="pagination-controls">
        {onPageSizeChange && (
          <label className="pagination-size">
            <span>Per halaman</span>
            <select aria-label="Jumlah per halaman" disabled={busy} value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
              {[10, 20, 50].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="secondary-button" disabled={busy || current <= 1} onClick={() => onPageChange(current - 1)} aria-label="Halaman sebelumnya">Sebelumnya</button>
        <span className="pagination-page">Hal {current}/{pages}</span>
        <button type="button" className="secondary-button" disabled={busy || current >= pages} onClick={() => onPageChange(current + 1)} aria-label="Halaman berikutnya">Berikutnya</button>
      </div>
    </div>
  );
}
