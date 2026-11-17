# AutoSNAP

Pendaftaran akun dilindungi Google reCAPTCHA v2 Checkbox. Isi `AUTOSNAP_RECAPTCHA_SITE_KEY`, `AUTOSNAP_RECAPTCHA_SECRET_KEY`, dan `AUTOSNAP_RECAPTCHA_HOSTNAMES` pada `.env.local` sebelum mendaftarkan akun. Secret key hanya dibaca backend dan tidak dikirim ke browser.

**Alur:** Master Data (User SNAP → Dev Site Client → Endpoint URL → API Service) → API Testing (pilih endpoint/service → periksa body dan channel → pilih User SNAP/Dev Site → jalankan). History berada di bawah hasil testing.

Pengujian aktif tahap ini: **Balance Inquiry Dev Site Bank Sumut**, dengan token API Keamanan diambil otomatis. Konfigurasi belum lengkap boleh disimpan, lalu dilengkapi mentor. Login/pendaftaran AutoSNAP menggunakan username, password dan Google reCAPTCHA v2; akun baru diaktifkan admin melalui User Management.

Menu aktif hanya Master Data, API Testing (termasuk history), dan User Management. Client Simulator dan katalog layanan lain dari versi lama tidak ditampilkan pada alur utama.

## Stack

- Frontend: Next.js, React, TypeScript.
- Backend: NestJS, TypeScript.
- Portal automation: Playwright Core menjalankan ASPI Developer Portal secara headless.
- Database runtime: PostgreSQL Supabase. PGlite hanya dipakai oleh test otomatis dan alat backup data lama.

## Menjalankan lokal

Node.js 22.17+ diperlukan.

```powershell
cd 'C:\Magang SUMUT\AutoSNAP'
npm.cmd install
npm.cmd run dev
```

Salin `.env.example` menjadi `.env.local`, lalu isi `DATABASE_URL` dengan Session Pooler Supabase (port 5432, SSL required). Buka http://localhost:3000. Next.js meneruskan `/api/autosnap` ke URL pada `AUTOSNAP_API_BASE_URL` (lokal: `http://127.0.0.1:4010`). Pada instalasi baru, buat akun admin dengan password minimal 12 karakter.

Untuk menjalankan hasil build:

```powershell
npm.cmd run build
npm.cmd run start
```

## Database Supabase

Semua akun, master data, relasi Dev Site Client, dan history runtime disimpan pada schema privat `autosnap` di Supabase. Reset password admin memakai `npm.cmd run admin:reset-password` dan langsung menulis ke Supabase yang dikonfigurasi.

Untuk memeriksa ringkasan jumlah data dan izin database runtime, jalankan `npm.cmd run db:inspect` (alias `db:audit:supabase`). Perintah ini tidak lagi membuka database PGlite lama. Penambahan dan perubahan data dilakukan melalui UI Master Data agar secret terenkripsi dan relasi Client → Project → Environment tetap valid.

## Pemeliharaan kode

- `npm.cmd test`: build dan seluruh tes regresi.
- `npm.cmd run lint`: pemeriksaan kode; compiler frontend/backend juga menolak variabel dan parameter tidak terpakai.
- `npm.cmd run pdf:preview`: membuat contoh laporan di `outputs/pdf/`, bukan bagian dari history testing nyata.
- `scripts/backup-pglite.mjs` hanya dipertahankan untuk pemulihan data lokal lama; bukan database runtime.
- Hasil build, preview sementara, dan cache TypeScript tidak dimasukkan ke Git. Folder sesi browser, `.env.local`, backup, dan database lokal lama bukan sampah build dan tidak dihapus otomatis.

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

# Headless ASPI

Portal ASPI selalu dijalankan dengan Chromium `headless: true`. Setiap akun portal dan environment memakai subfolder profil terpisah di `AUTOSNAP_PORTAL_PROFILE_DIR`; cookie Chrome dilindungi oleh mekanisme profil sistem operasi dan seluruh folder profil diabaikan Git. Jangan menyalin profil tersebut ke server atau akun lain.

- `AUTOSNAP_CHROME_PATH`: lokasi executable Google Chrome/Chromium.
- `AUTOSNAP_PORTAL_PROFILE_DIR`: root profil sesi headless; default `.autosnap-browser-profile`.
- `AUTOSNAP_PORTAL_AUTH_TIMEOUT_MS`: batas menunggu form login resmi, default 30000 ms.

Jika ASPI meminta CAPTCHA, OTP, MFA, atau interaksi lain, run berhenti dengan outcome `AUTH_INTERACTION_REQUIRED`. AutoSNAP tidak melakukan bypass. Mode Portal Headless dan Direct SNAP API tetap eksplisit dan tidak saling fallback otomatis.

## Persiapan release publik

### Membuka data dan menambah admin

Project Supabase AutoSNAP: `hdbhycjmwuhvpgwojrjt`. Buka Table Editor, lalu ubah schema dari `public` ke `autosnap`. Akun aplikasi ada di `autosnap_users`, master data di `autosnap_records`, history di `autosnap_runs`, dan PDF resmi di `autosnap_evidence_pdfs`. Login AutoSNAP memakai akun serta session dari backend NestJS, bukan Supabase Auth; menu Authentication Supabase dapat kosong meskipun akun AutoSNAP tersedia.

Untuk menambah admin, masuk dengan admin yang ada → User Management → Tambah Akun → pilih Peran Admin. Backend membuat salt dan hash password. Jangan mengisi password biasa langsung ke kolom `password_hash`. Untuk melihat akun melalui SQL Editor:

```sql
SELECT id, username, email, role, active
FROM autosnap.autosnap_users
ORDER BY created_at;
```

### reCAPTCHA pada domain publik

Pada Google reCAPTCHA Admin Console, gunakan kunci reCAPTCHA v2 checkbox. Daftarkan `autosnap-web-two.vercel.app` pada Domains tanpa `https://` atau path; tambahkan `localhost` jika diperlukan untuk development. Domain Google dan allowlist backend adalah dua pengaturan berbeda. Error Google "Domain tidak valid untuk kunci situs" harus diperbaiki pada konfigurasi kunci Google, bukan dengan menonaktifkan verifikasi.

Di proyek Vercel **auto-snap-api**, set `AUTOSNAP_RECAPTCHA_SITE_KEY`, `AUTOSNAP_RECAPTCHA_SECRET_KEY`, dan `AUTOSNAP_RECAPTCHA_HOSTNAMES` untuk Production. Site key boleh dikirim ke browser; secret key tetap server-only. Gunakan pasangan kunci dari situs Google yang sama. Jangan memakai kunci pengujian Google pada produksi.

### Memperbarui versi publik

Setelah mengubah kode, jalankan `npm.cmd run build`, `npm.cmd run lint`, dan test yang sesuai. Periksa `git status`, commit file yang diubah, kemudian `git push origin main`. Repository `parulls/AutoSNAP` terhubung ke proyek Vercel `autosnap-web` dan `auto-snap-api`; push main memicu deployment Production keduanya. Tunggu status Ready pada menu Deployments. File `.env.local`, profil browser, dan secret tidak boleh di-commit.

Untuk perubahan environment variable, simpan pada proyek yang benar → Deployments → deployment terbaru → Redeploy. Mengubah variabel Vercel tidak memperbarui deployment lama. Mengubah kode tidak otomatis mengubah struktur tabel Supabase; perubahan schema memerlukan migrasi terpisah.

Alamat penggunaan:

- Frontend utama (`autosnap-web`): https://autosnap-web-two.vercel.app
- Backend: https://auto-snap-api.vercel.app (status layanan), `/health` untuk liveness.
- Akses `/autosnap` backend secara langsung tanpa secret memang ditolak. Pengguna login dan menjalankan testing dari frontend, bukan dari dashboard `vercel.com`.
- Setiap proyek Vercel menyimpan environment sendiri. Menambah secret di proyek `auto-snap` tidak otomatis mengisi proyek `autosnap-web`. Perubahan environment memerlukan deployment baru; URL deployment lama tetap menunjuk versi lamanya.

- Frontend dan backend wajib memiliki `AUTOSNAP_INTERNAL_TOKEN` yang sama (secret acak minimal 32 karakter). Ini autentikasi antarserver, bukan token SNAP. Jangan menambahkan awalan `NEXT_PUBLIC_`.
- `AUTOSNAP_DEPLOYMENT_ROLE=api` hanya pada proyek backend Vercel. `vercel.ts` memilih adapter Express yang meneruskan request ke NestJS; proyek frontend tetap Next.js. Keduanya memakai repository dan build masing-masing, bukan dua salinan frontend.
- Frontend: `AUTOSNAP_API_BASE_URL` harus URL HTTPS backend yang benar. Jangan mengarahkan ke frontend sendiri.
- Backend: pertahankan `DATABASE_URL`, `AUTOSNAP_ENCRYPTION_KEY` lama, serta konfigurasi Google reCAPTCHA. Jangan membuat key enkripsi baru untuk database berisi kredensial.
- `AUTOSNAP_RECAPTCHA_HOSTNAMES` wajib memuat hostname frontend publik yang juga terdaftar pada Google reCAPTCHA.
- `AUTOSNAP_SETUP_TOKEN` diperlukan untuk membuat admin pertama pada produksi. Akun baru berikutnya tetap menunggu aktivasi admin.
- Migrasi keamanan menambahkan rate limit persisten dan mengaktifkan RLS tanpa policy publik pada schema privat `autosnap`. Aplikasi memakai koneksi database backend; browser tidak diberi akses langsung ke tabel.
- Di Vercel, Chromium diekstrak ke `/tmp`, bukan folder Windows atau filesystem proyek. Profil sementara dapat hilang; login ulang resmi otomatis tetap diperlukan dan CAPTCHA/MFA tidak dilewati.
- Penguncian sesi ASPI tersimpan di database agar akun yang sama tidak dipakai dua instance sekaligus. Jika proses terhenti mendadak, lock berakhir setelah 5 menit 30 detik di Vercel (batas fungsi 5 menit ditambah waktu tenggang) atau 15 menit pada runtime lokal.
- Jalankan `npm test`, `npm run lint`, dan `npm audit` sebelum release. Uji login, akses tanpa sesi, testing positif/negatif, dan download PDF pada deployment preview sebelum promosi.

Audit kode dan tes otomatis mengurangi risiko, tetapi bukan jaminan aplikasi kebal serangan. Produksi tetap membutuhkan pemantauan, backup, pembaruan dependensi, dan pengujian penetrasi terotorisasi.

# Bukti PDF resmi ASPI

Progress testing menampilkan log bertimestamp dari backend. Tombol Cancel Testing mengirim permintaan pembatalan milik pengguna ke database agar instance backend lain dapat menerimanya. Browser headless ditutup, tahap berikutnya dihentikan, dan hasil disimpan sebagai Cancelled. Request API yang sudah terkirim tidak dapat dibatalkan di sisi ASPI. Log proses dan kegagalan PDF per service tersimpan pada `request_json.progressLog` di History Testing. Execute API tidak diulang untuk mengambil bukti.

Urutan proses: Signature Auth → Access Token B2B → Signature Service → Balance Inquiry → validasi → simpan History → download PDF jika hasil skenario Passed. Tes negatif yang menghasilkan penolakan sesuai expected tetap termasuk Passed. Jika hasil Failed atau Cancelled, download dilewati. Tidak ada download PDF di antara hit API.

Daftar aktivitas awal diambil sekali sebelum rangkaian API. Setelah seluruh API selesai dan validasi Passed, sistem memakai sesi ASPI akun yang sama untuk mengambil satu daftar aktivitas bersama. Hanya Activity ID baru yang cocok secara unik dengan service yang dipakai; ID lama, aktivitas ambigu, atau service berulang yang tidak bisa dibedakan tidak ditebak. PDF diunduh maksimal dua file bersamaan, maksimal dua percobaan per file, dengan anggaran total fase bukti 60 detik dan dihentikan paling lambat 240 detik sejak fase testing dimulai. PDF disimpan di `autosnap.autosnap_evidence_pdfs` bersama ID History Testing. Kegagalan download tidak mengubah hasil validasi API: hasil tetap disimpan, sedangkan kegagalan bukti tercatat pada `request_json.evidenceErrors` dan log proses.

Proxy frontend Vercel menunggu maksimal 280 detik agar masih bisa mengirim error JSON sebelum batas fungsi 300 detik. Timeout ditampilkan sebagai TIMEOUT, bukan VALIDATION_ERROR. Timeout bukan bukti API belum terkirim atau backend masih hidup; periksa History sebelum mencoba ulang. Batas ini tidak menjamin layanan ASPI akan selalu menyediakan PDF tepat waktu.

History menyediakan PDF per service dan ZIP seluruh PDF yang telah tersimpan. Download pengguna membaca database server, tidak membuka browser atau menghubungi ASPI lagi. Akses dibatasi ke pemilik history. Pada fase bukti headless, laporan diminta lewat koneksi Chromium dari halaman ASPI yang terautentikasi (same-origin, cookie sesi, tanpa redirect). Jika ASPI mengirim file PDF, byte aslinya disimpan. Jika tautan resmi memberikan halaman laporan cetak HTML, halaman resmi tersebut dicetak ke PDF tanpa template AutoSNAP. Halaman login, halaman error, atau ID ambigu ditolak. Tidak ada screenshot atau laporan custom AutoSNAP. Validasi API tetap mengikuti response aktual, terpisah dari status penyimpanan bukti.

