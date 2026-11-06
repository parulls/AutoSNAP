# Konfigurasi Neon untuk AutoSNAP

## 1. Hubungkan Neon dari Vercel

1. Buka project AutoSNAP pada Vercel.
2. Buka **Storage / Marketplace**, pilih **Neon**, lalu tekan **Install**.
3. Buat database baru atau hubungkan akun Neon yang sudah ada.
4. Hubungkan resource tersebut ke project AutoSNAP untuk Production, Preview, dan Development sesuai kebutuhan.
5. Pastikan Vercel membuat environment variable `DATABASE_URL`. Gunakan pooled connection untuk aplikasi.

## 2. Konfigurasi AutoSNAP

Hentikan AutoSNAP, lalu isi file `.env.local`:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST-POOLER.neon.tech/DATABASE?sslmode=require&channel_binding=require
DATABASE_POOL_MAX=5
```

Pertahankan `AUTOSNAP_ENCRYPTION_KEY` yang sudah ada. Kunci itu diperlukan untuk membuka Client Secret, Private Key, dan password yang sudah terenkripsi.

Untuk lokal, salin nilai `DATABASE_URL` dari pengaturan environment Vercel/Neon ke `.env.local`. Jangan masukkan connection string ke source code atau Git.

Jalankan AutoSNAP satu kali agar tabel Neon dibuat otomatis:

```powershell
npm.cmd run dev
```

Setelah backend berhasil aktif, hentikan kembali dengan `Ctrl + C`.

## 3. Pindahkan data lokal (opsional)

Untuk mempertahankan akun, Master Data, dan history dari `.autosnap-pg`:

```powershell
npm.cmd run db:migrate:neon
```

Jalankan migrasi hanya ketika AutoSNAP berhenti. Session login tidak dipindahkan, sehingga semua pengguna perlu login kembali.

## 4. Jalankan dengan Neon

```powershell
npm.cmd run dev
```

Jika `DATABASE_URL` terisi, backend memakai Neon. Jika kosong, backend kembali memakai PGlite lokal.

Periksa koneksi dan jumlah data tanpa menampilkan password database:

```powershell
npm.cmd run db:check:neon
```

## Dataset AutoSNAP

| Tabel | Data yang disimpan |
| --- | --- |
| `autosnap_users` | Akun pengguna dashboard AutoSNAP, role, status aktif, dan password hash. |
| `autosnap_sessions` | Session login dashboard yang memiliki masa berlaku. |
| `autosnap_records` | Master Data: User SNAP, Dev Site Client, endpoint, API service, dan request template. Secret disimpan dalam bentuk terenkripsi. |
| `autosnap_runs` | History testing, status, HTTP status, durasi, request/response yang sudah disanitasi. |
| `autosnap_external_ids` | X-EXTERNAL-ID yang sudah digunakan per environment dan tanggal agar tidak duplikat. |
| `autosnap_captchas` | Tabel kompatibilitas dari CAPTCHA lama; reCAPTCHA Google tidak menyimpan jawaban CAPTCHA. |

Data yang tidak disimpan ke Neon: CAPTCHA/OTP ASPI, access token mentah, signature mentah, dan cookie login ASPI. Cookie portal berada hanya pada profil Chrome lokal yang sudah masuk `.gitignore`.

## Tentang Portal ASPI

AutoSNAP mengisi Aplikasi Pengujian ASPI melalui Chrome. URL halaman Keamanan sudah menjadi konfigurasi internal. Master Data tidak meminta URL Keamanan, Encoding RSA, atau Encoding HMAC.
