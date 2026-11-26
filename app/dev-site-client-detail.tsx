"use client";

import { useEffect, useMemo, useState } from "react";
import type { Api, Item } from "./model";
import IconButton from "./icon-button";
import DataTable from "./data-table";
import PaginationBar from "./pagination-bar";
import { fieldOf, linkDevSite } from "./dev-site-link";

const value = (item: Item | undefined, key: string) => String(item?.data[key] ?? "");

type Props = {
  site: Item;
  records: Item[];
  users: Item[];
  api: Api;
  busy: boolean;
  canMutate: boolean;
  onClose: () => void;
  onEditClient: () => void;
  onImportService: (endpoint?: Item, service?: Item) => void;
  onDeleteService: (service: Item) => void;
  setError: (s: string) => void;
  setNotice: (s: string) => void;
  reload: () => Promise<void>;
};

export default function DevSiteClientDetail({ site, records, users, api, busy, canMutate, onClose, onEditClient, onImportService, onDeleteService, setError, setNotice, reload }: Props) {
  const linked = linkDevSite(records, site);
  const owner = users.find((user) => user.id === value(site, "defaultUserId"));
  const linkedIds = useMemo(
    () => (Array.isArray(site.data.linkedServiceIds) ? site.data.linkedServiceIds.map(String) : []),
    [site.data.linkedServiceIds],
  );
  const linkedKey = linkedIds.join("|");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [catalog, setCatalog] = useState<Item[]>([]);
  const [selectedLink, setSelectedLink] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void api("listMasterData", {
        kind: "service",
        page,
        pageSize,
        search,
        linkedOnly: linkedIds.length > 0,
        linkedServiceIds: linkedIds,
      }).then((result) => {
        if (!active) return;
        setItems(Array.isArray(result.items) ? result.items as Item[] : []);
        setTotal(Number(result.total ?? 0));
        setListError("");
        setLoading(false);
      }).catch((error) => {
        if (!active) return;
        setListError((error as Error).message);
        setItems([]);
        setTotal(0);
        setLoading(false);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [page, pageSize, search, site.id, linkedKey, api, linkedIds]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api("listMasterData", { kind: "service", page: 1, pageSize: 50, search: "" }).then((result) => {
        if (!active) return;
        setCatalog(Array.isArray(result.items) ? result.items as Item[] : []);
      }).catch(() => {
        if (!active) return;
        setCatalog([]);
      });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [site.id, api]);

  async function linkSelected() {
    if (!selectedLink) return;
    const next = Array.from(new Set([...linkedIds, selectedLink]));
    try {
      await api("linkClientServices", { environmentId: site.id, serviceIds: next });
      await reload();
      setNotice("API Service ditautkan ke Client.");
      setSelectedLink("");
    } catch (error) {
      setError((error as Error).message);
    }
  }

  async function unlink(serviceId: string) {
    const next = linkedIds.filter((id) => id !== serviceId);
    try {
      await api("linkClientServices", { environmentId: site.id, serviceIds: next });
      await reload();
      setNotice("Tautan API Service dilepas.");
    } catch (error) {
      setError((error as Error).message);
    }
  }

  const available = catalog.filter((item) => !linkedIds.includes(item.id));

  return (
    <div className="client-detail-panel" role="region" aria-label={`Detail ${site.name}`}>
      <div className="section-header">
        <div>
          <h3>{site.name}</h3>
          <div className="client-detail-meta">
            <span>User SNAP: {owner?.name ?? "—"}</span>
            <span>{[fieldOf(linked.client, "channelId") && `CHANNEL-ID ${fieldOf(linked.client, "channelId")}`, fieldOf(linked.client, "deviceId") && `X-DEVICE-ID ${fieldOf(linked.client, "deviceId")}`, linked.client?.partnerId && `X-PARTNER-ID ${linked.client.partnerId}`].filter(Boolean).join(" · ") || "Header identitas belum lengkap"}</span>
          </div>
        </div>
        <div className="inline-actions">
          {canMutate && <IconButton action="edit" showLabel label="Edit Client" disabled={busy} onClick={onEditClient} />}
          <IconButton action="close" showLabel label="Tutup" disabled={busy} onClick={onClose} />
        </div>
      </div>

      <div>
        <div className="section-header">
          <div><h3>API Service</h3><p>Layanan Dev Site yang ditautkan ke Client ini. Tidak termasuk API Service Client Simulator.</p></div>
        </div>
        <DataTable
          columns={["NAMA", "METHOD / PATH", "DIPERBARUI", "AKSI"]}
          busy={loading}
          error={listError}
          empty={linkedIds.length ? "Tidak ada API Service yang cocok." : "Belum ada API Service. Tambah baru atau tautkan dari katalog (data lama tanpa tautan menampilkan seluruh katalog)."}
          hasRows={items.length > 0}
          search={
            <div className="form-grid">
              <label className="form-field"><span>Cari API Service</span><input aria-label="Cari API Service Client" value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Nama, method, atau path" /></label>
              {canMutate && (
                <label className="form-field"><span>Tautkan dari katalog</span>
                  <div className="inline-actions" style={{ marginTop: 4 }}>
                    <select aria-label="Pilih API Service katalog" value={selectedLink} onChange={(e) => setSelectedLink(e.target.value)} disabled={busy || !available.length}>
                      <option value="">{available.length ? "Pilih API Service" : "Semua sudah ditautkan"}</option>
                      {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    <IconButton action="link" showLabel label="Tautkan" disabled={busy || !selectedLink} onClick={() => void linkSelected()} />
                  </div>
                </label>
              )}
            </div>
          }
          footer={
            <>
              <PaginationBar page={page} pageSize={pageSize} total={total} busy={loading} onPageChange={setPage} onPageSizeChange={(size) => { setPage(1); setPageSize(size); }} />
              {canMutate && (
                <div className="table-footer-actions">
                  <IconButton action="add" tone="primary" showLabel label="Tambah API Service" disabled={busy} onClick={() => onImportService()} />
                </div>
              )}
            </>
          }
        >
          {items.map((item) => {
            const endpoint = records.find((row) => row.id === item.parentId && row.kind === "endpoint");
            return (
              <tr key={item.id}>
                <td><strong>{item.name}</strong><span className="cell-caption">{endpoint?.name ?? "Endpoint"}</span></td>
                <td>{[value(item, "method") || "POST", value(item, "path") || value(item, "serviceUrl")].filter(Boolean).join(" ")}</td>
                <td>{new Date(item.updatedAt).toLocaleDateString("id-ID")}</td>
                <td>
                  <div className="inline-actions">
                    {canMutate && <IconButton action="edit" disabled={busy} onClick={() => onImportService(endpoint, item)} />}
                    {canMutate && linkedIds.includes(item.id) && <IconButton action="link" label="Lepas tautan" title="Lepas tautan" disabled={busy} onClick={() => void unlink(item.id)} />}
                    {canMutate && <IconButton action="delete" tone="danger" disabled={busy} onClick={() => onDeleteService(item)} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      </div>
    </div>
  );
}
