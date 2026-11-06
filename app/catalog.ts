import spec from "./snap-spec-catalog.json";

const descriptions:Record<string,string>={
  "11":"Mengakses informasi saldo terkini atas rekening yang diizinkan.",
  "12":"Mengambil daftar transaksi dengan rentang waktu maksimal satu bulan dan pageSize maksimal 50.",
  "13":"Mengambil detail satu transaksi berdasarkan referensi asal.",
  "14":"Mengakses rekening koran dengan otorisasi pemilik rekening.",
  "17":"Transfer dalam satu bank dari rekening sumber ke rekening tujuan.",
  "18":"Transfer antarbank melalui penyelenggara infrastruktur pembayaran.",
  "54":"Pembayaran direct debit setelah persetujuan atau binding konsumen.",
  "73":"Memperoleh access token B2B menggunakan signature RSA SHA-256.",
  "74":"Memperoleh access token konsumen melalui authorization code atau refresh token.",
};
const names:Record<string,string>={
  "71":"Trigger Direct Debit Transfer",
  "72":"Direct Debit BI-FAST Notification",
};

export const services=spec.map(item=>({
  ...item,
  name:names[item.code]??item.name,
  description:descriptions[item.code]??`${item.name} sesuai spesifikasi SNAP service ${item.code}.`,
}));
