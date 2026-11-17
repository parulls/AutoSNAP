# Pengaturan Testing dan PDF

File utama:

- `backend/src/portal-engine.ts`: urutan API dan Execute form ASPI.
- `backend/src/app.ts`: validasi, History, dan penyimpanan PDF setelah Passed. Deadline bukti tetap dibatasi 240 detik sejak awal testing agar ada waktu menyimpan hasil sebelum batas fungsi Vercel.
- `backend/src/balance.ts`: aturan validasi Balance Inquiry.
- `backend/src/aspi-evidence.ts`: membaca aktivitas dan mengambil laporan resmi ASPI.
- `backend/src/aspi-report-navigation.ts`: download native Chromium (attachment), PDF langsung atau cetak halaman laporan resmi. Jalur headless menggunakan navigasi browser, bukan AJAX fetch; halaman login dan redirect yang tidak sesuai ditolak.
- `backend/src/aspi-pdf-batch.ts`: antrean, korelasi Activity ID dan retry maksimal dua kali; tidak mengulang hit API.
- `backend/src/pdf-settings.ts`: default dan batas pengaturan PDF.
- `app/pdf-preview.tsx`: preview file tersimpan dengan pemeriksaan akses backend yang sama seperti download.

Tambahkan pada `.env.local` lalu restart `npm run dev`:

```dotenv
AUTOSNAP_PDF_REQUEST_TIMEOUT_MS=30000
AUTOSNAP_PDF_BUDGET_MS=120000
AUTOSNAP_PDF_CONCURRENCY=1
```

REQUEST_TIMEOUT adalah waktu satu permintaan (5–45 detik). BUDGET adalah anggaran total fase PDF (10–120 detik, tetap tunduk deadline testing). CONCURRENCY adalah jumlah unduhan bersamaan (1–2, default 1). Pada Vercel, atur di **auto-snap-api → Settings → Environment Variables → Production**, lalu redeploy. Jangan mengubah encryption key, DATABASE_URL atau CAPTCHA untuk memperbaiki timeout PDF.

Preview: History → Bukti ASPI → View PDF → Download. File dibaca dari database; tidak mengulang testing. Preview hanya tersedia jika PDF sudah tersimpan.

Timeout menunggu HTTP headers berarti respons laporan belum diterima. Timeout membaca body berarti HTTP sudah diterima tetapi file belum selesai dibaca. Activity ID ditemukan bukan bukti file berhasil tersedia. API Passed dan PDF tersedia adalah dua status terpisah.

Untuk memastikan sumber masalah, bandingkan download manual di ASPI dengan akun dan Activity ID yang sama. Jika manual juga gagal, hubungi pengelola ASPI. Jika manual berhasil cepat, periksa sesi/redirect/koneksi server otomasi. Menambah timeout tidak menjamin laporan tersedia. Jangan mengulang testing hanya untuk membuat ulang PDF. Jangan mencatat password, private key, cookie atau token dalam log.
