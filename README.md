# AutoSNAP

Pendaftaran akun dilindungi Google reCAPTCHA v2 Checkbox. Isi `AUTOSNAP_RECAPTCHA_SITE_KEY`, `AUTOSNAP_RECAPTCHA_SECRET_KEY`, dan `AUTOSNAP_RECAPTCHA_HOSTNAMES` pada `.env.local` sebelum mendaftarkan akun. Secret key hanya dibaca backend dan tidak dikirim ke browser.

Database produksi dapat memakai Neon PostgreSQL melalui `DATABASE_URL`. Lihat [NEON-SETUP.md](./NEON-SETUP.md) untuk konfigurasi dan pemindahan data dari PGlite lokal.

**Alur terbaru:** Master Data (User SNAP → Dev Site Client → Endpoint URL → API Service) → API Testing (pilih endpoint/service → periksa body dan channel → pilih User SNAP/Dev Site → jalankan). History berada di bawah hasil testing. Lihat [panduan terbaru](PANDUAN-PENGGUNAAN.md).

Pengujian aktif tahap ini: **Balance Inquiry Dev Site Bank Sumut**, dengan token API Keamanan diambil otomatis. Konfigurasi belum lengkap boleh disimpan, lalu dilengkapi mentor. Login/pendaftaran AutoSNAP menggunakan username, password dan Google reCAPTCHA v2; akun baru diaktifkan admin melalui User Management.

Menu aktif hanya Master Data, API Testing (termasuk history), dan User Management. Client Simulator dan katalog layanan lain dari versi lama tidak ditampilkan pada alur utama.

## Stack

- Frontend: Next.js, React, TypeScript.
- Backend: NestJS, TypeScript.
- HTTP automation: Playwright Core APIRequestContext. Pengujian SNAP adalah HTTP API, sehingga tidak memerlukan browser untuk setiap hit.
- Database: PostgreSQL melalui DATABASE_URL. Untuk penggunaan lokal tanpa server PostgreSQL, PGlite menyimpan database PostgreSQL di folder .autosnap-pg.

## Menjalankan lokal

Node.js 22.13+ diperlukan.

```powershell
cd 'C:\Magang SUMUT\AutoSNAP'
npm.cmd install
npm.cmd run dev
```

Buka http://localhost:3000. Next.js meneruskan /api/autosnap ke NestJS di 127.0.0.1:4010. Pada instalasi baru, buat akun admin (password minimal 12 karakter). Folder .autosnap-pg menyimpan data lokal; jangan hapus jika ingin mempertahankan data.

Untuk menjalankan hasil build:

```powershell
npm.cmd run build
npm.cmd run start
```

## PostgreSQL server

Salin .env.example ke .env.local lalu isi DATABASE_URL. Backend akan memakai server PostgreSQL itu saat dimulai ulang. Tanpa DATABASE_URL, backend memakai PGlite lokal. Jangan jalankan dua backend sekaligus pada folder PGlite yang sama.

Jika pernah menggunakan versi D1 lokal, jalankan sekali `npm.cmd run db:import:d1` saat server berhenti. Script mengimpor akun, master data, dan riwayat dari .wrangler ke PGlite tanpa menimpa record yang sudah ada. Data D1 asli tetap tersimpan.

## Konfigurasi live hit

Mode mock dapat dipakai tanpa kredensial. Saat startup lokal baru, backend menyiapkan AUTOSNAP_ENCRYPTION_KEY (32 byte acak dalam base64) di .env.local secara otomatis jika belum ada key dan belum ada kredensial lama. Key yang sudah ada dipertahankan; data lama tanpa key memerlukan pemulihan key sebelumnya. Untuk live, isi AUTOSNAP_ALLOWED_HOSTS (hostname API dipisahkan koma). AUTOSNAP_SETUP_TOKEN diperlukan saat membuat admin pertama melalui host selain localhost. Ganti key enkripsi hanya jika seluruh secret akan diisi ulang.

Pada server produksi, sediakan key melalui secret server (tidak dibuat otomatis ketika NODE_ENV=production). Contoh membuat key untuk konfigurasi server baru di PowerShell:

```powershell
$keyBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
[Convert]::ToBase64String($keyBytes)
```

## Alur

1. Buat User SNAP di Master Data, lalu buat Dev Site Client dan pilih pemiliknya.
2. Buat Endpoint URL, lalu buat API Service Informasi Saldo dengan memilih endpoint tersebut.
3. Pada API Testing, pilih endpoint, service, User SNAP, dan Dev Site Client. Body berasal dari service, CHANNEL-ID dari Client (default resmi 95221).
4. Backend menghitung Signature Auth, mengambil token aplikasi dari Keamanan, menghitung Signature Service, lalu mengirim request saldo.
5. Hasil/validasi dan history tersanitasi berada pada halaman API Testing yang sama.

Form utama menggunakan token B2B otomatis dan tidak meminta input token manual. Engine tetap menyimpan dukungan kompatibilitas lama untuk konfigurasi khusus. Timestamp pada header dan signature konsisten dalam request terkait. X-EXTERNAL-ID unik per Dev Site per hari. Akun AutoSNAP, akun SNAP portal, dan kredensial API adalah data berbeda.

Katalog skenario berasal dari lampiran Skenario Functional Test V3.2 (320 skenario); service/method/path dari SNAP Standar Data Spesifikasi Teknis, dan alur keamanan dari SNAP Standar Teknis Keamanan serta pedoman ASPI. Payload spesifik provider dan hasil verifikasi live masih memerlukan akses API yang disetujui.

Folder konfigurasi Sites, Wrangler, D1, dan Vite dari versi lama masih ada di repository, tetapi tidak dipakai oleh perintah dev, build, dan start di atas.

Daftar pertanyaan integrasi dan pesan siap kirim ke mentor ada di [PERTANYAAN-UNTUK-MENTOR.md](PERTANYAAN-UNTUK-MENTOR.md).

Kebutuhan agar Dev Site dapat mengirim request API langsung dijelaskan dalam [KEBUTUHAN-HIT-API.md](KEBUTUHAN-HIT-API.md). Label sandbox dan tombol rekening khususnya telah dihapus dari UI; koneksi lama dipertahankan.
