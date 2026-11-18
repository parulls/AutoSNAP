# Audit backend AutoSNAP — 18 November 2026

> Pembaruan berikutnya pada 18 November: Expected SNAP responseCode kini opsional. Aturan di bawah yang sebelumnya mewajibkan kode/ekspektasi negatif harus dibaca bersama bagian “Expected SNAP code opsional” pada `CONFIGURATION-DRIVEN-SNAP.md`. Tidak ada fallback expected `2001100`/`4011101` dalam executor. Respons dengan expected kosong disimpan sebagai NOT_EVALUATED, terpisah dari status transport dan error input. Pengujian fixture lama sekarang memasukkan ekspektasi secara eksplisit, bukan mengandalkan default runtime.

## Keputusan dan ruang lingkup

Database **tetap Supabase**, menggantikan instruksi Neon dalam lampiran sesuai konfirmasi pengguna. Seluruh perubahan kode lokal; tidak push GitHub/deploy Vercel pada pekerjaan ini. Tidak ada kredensial, konfigurasi produksi, akun atau history yang dihapus/ditimpa. Query Supabase hanya membaca identitas metadata dan ringkasan request yang sudah tersanitasi.

## Akar masalah dan bukti

Bank Statement tidak terbukti mengirim Balance Inquiry pada run yang diperiksa. History Supabase menunjukkan:

- `RUN-20261118-B524D59C`: service API Bank Statement, `POST /api/v1.0/bank-statement`, HTTP 200, SNAP `2001400`; actual URL berakhir `:44310/api/v1.0/bank-statement`. Status akhir **Cancelled**, bukan Passed end-to-end.
- Progress frontend dan backend masih memakai `balance_inquiry`/label “Balance Inquiry” untuk semua target. Ini membuat alur keamanan bersama terlihat seperti pengujian saldo.
- Executor sudah menerima method/path, tetapi workflow keamanan selalu empat tahap, belum ditentukan capability metadata.
- Belum ada pemeriksaan silang source URL/operation ID/identitas method-path. Hubungan record saja belum cukup menolak konfigurasi endpoint yang tertukar.
- Validasi generic dan Balance terpisah; ekspektasi negatif hanya berlaku untuk saldo dan pernah dibentuk dengan pola service code. Ini tidak layak menjadi default endpoint baru.
- Body aktual di jaringan belum dibandingkan dengan input yang disiapkan untuk signature. UI/log dapat terlihat benar tanpa bukti payload actual sama.

## Arsitektur setelah refactor

1. UI mengirim ID endpoint, service, client, environment dan User SNAP terpilih.
2. Controller memeriksa privilege dan relasi client/project/environment/user/service/endpoint/template.
3. `endpoint-resolver.ts` memuat metadata yang disimpan, memeriksa review, operation ID, URL sumber, method/path, HTTP/SNAP code, dan workflow. Konfigurasi yang tidak lengkap atau tertukar berhenti sebelum browser/request API.
4. `request-builder.ts` membaca body endpoint ini saja, mengisi hanya placeholder eksplisit, memvalidasi schema, serta memisahkan body/path/query. Tidak ada payload layanan lain sebagai fallback. Path kosong, dot segment, serta placeholder path yang belum diisi ditolak.
5. `auth-workflow.ts` membentuk dependency berdasarkan capability, bukan nama service. Handler keamanan reusable di `PortalEngine` menjalankan node yang dibutuhkan saja.
6. Browser headless mengisi form resmi ASPI, menekan Execute **sekali**, mengorelasikan HTTP response dan memeriksa header/body/canonical path-query actual. Keamanan yang gagal tidak dijadikan response target.
7. Validator membandingkan HTTP, SNAP responseCode, responseMessage, response schema dan bukti actual request secara terpisah. HTTP 4xx dapat Passed jika memang ekspektasi negatif; 200/code cocok tidak menutupi schema yang gagal.
8. History menyimpan request/response tersanitasi, ID/revisi konfigurasi, workflow, ekspektasi dan log service yang benar. PDF resmi baru dikumpulkan sesudah seluruh pengujian Passed dan hasil disimpan; download/preview/ZIP menggunakan bytes tersimpan dengan ownership yang sama seperti sebelumnya.

### Workflow yang tersedia

| Capability | Perlakuan |
| --- | --- |
| B2B dengan token baru + HMAC | Signature Auth → Access Token B2B → Signature Service → target |
| Token client tersimpan | Melewati RSA/pengambilan token; expiry harus diketahui dan belum kedaluwarsa; scope client terpilih |
| Tanpa signature service | Melewati utility signature hanya bila dokumentasi tidak mewajibkan X-SIGNATURE |
| B2B2C | Menambahkan customer token dari consent User SNAP terpilih; menolak token kosong/kedaluwarsa; tidak membuat consent otomatis |
| Tanpa autentikasi | Target saja; tidak mengunjungi keamanan untuk validasi sesi |
| Token negatif | Korup token sesudah didapat; signature memakai token yang sama; tidak refresh/repair otomatis |

Untuk endpoint baru, `negativeToken` harus berisi expected HTTP dan SNAP code dari dokumentasi yang ditinjau. Import otomatis hanya jika sample error token cocok unik. Jika provider memang tidak memakai SNAP code pada error itu, nilai null dapat dipilih eksplisit. Tidak semua 401 otomatis dianggap berhasil.

Signature mengikuti formula pada [dokumentasi Keamanan ASPI](https://apidevportal.aspi-indonesia.or.id/api-services/keamanan): method, relative path termasuk query, token, hash body JSON minified, timestamp. Tidak ada body berarti string kosong. Timestamp yang sama dipakai untuk header dan input signature dalam run ini.

## Database dan kompatibilitas

- Konfigurasi sumber: schema privat `autosnap`, tabel `autosnap_records`. Endpoint menyimpan method/path/portalUrl; service menyimpan config/template. Ini satu form pengguna, bukan dua modul.
- Field tambahan pada JSON service: `identity`, `workflow`, `requestBodyMode`, `negativeToken`. Tidak memerlukan ALTER TABLE, migrasi Neon, penghapusan record atau penyalinan kredensial.
- Metadata lama tanpa field baru tetap dibaca menggunakan profile auth yang ditinjau. Balance Inquiry lama hanya memakai adapter jika code 11, POST dan path `/api/v1.0/balance-inquiry` tepat. Endpoint lama/custom lain perlu impor/review, bukan diarahkan diam-diam ke saldo.
- URL, sample dan expected code lama tidak ditimpa otomatis saat startup. Import/edit menyimpan dalam transaksi dan menjaga ID existing.
- Tidak ada tabel service baru, dependency framework baru, runtime AI atau caching token lintas pengguna.

## File yang dikerjakan

| Area | File |
| --- | --- |
| Resolver | `backend/src/endpoint-resolver.ts` |
| Metadata/validator | `backend/src/endpoint-config.ts`, `backend/src/swagger-import.ts`, `backend/src/documentation-reader.ts` |
| Request | `backend/src/request-builder.ts` |
| Workflow | `backend/src/auth-workflow.ts`, `backend/src/portal-engine.ts` |
| Controller/history | `backend/src/app.ts` |
| Form headless | `backend/src/aspi-form-resolver.ts` — batched read-only DOM snapshot, pemilihan method/path unik, body kosong eksplisit |
| Direct HTTP legacy | `backend/src/run-engine.ts` — tidak mengubah token diam-diam berdasarkan akhiran scenario ID; HEAD tanpa body; pesan prerequisite generik |
| Koneksi | `backend/src/connection.ts` — deskripsi proyek tidak lagi khusus saldo |
| UI | `app/testing-panel.tsx`, `app/testing-progress.tsx`, `app/documentation-import.tsx` |
| Tes | `tests/dynamic-execution.test.mjs`, `tests/dynamic-services.test.mjs`, `tests/dynamic-ui.test.mjs`, `tests/devsite.test.mjs` |

Perubahan lain yang sudah ada di worktree sebelum audit ini dipertahankan. Tidak mereset perubahan pengguna.

## Verifikasi dan arti bukti

`tests/dynamic-execution.test.mjs` memakai Chromium headless, form portal tiruan, route interception **seluruh jaringan**, RSA/HMAC fixture, controller asli, serta database test PGlite yang terisolasi. Request aktual browser diperiksa; bukan sekadar mengganti stub hasil menjadi Passed. Fixture tidak menyatakan seluruh business rule SNAP telah dimodelkan.

| API | HTTP/path diverifikasi | Positif fixture | Token negatif fixture | Eksekusi ASPI asli pada audit ini |
| --- | --- | --- | --- | --- |
| Balance Inquiry | POST `/api/v1.0/balance-inquiry` | Lulus | Lulus | Tidak dijalankan |
| Bank Statement | POST `/api/v1.0/bank-statement` | Lulus | Lulus | Tidak dijalankan; hanya membaca history lama |
| History List | POST `/api/v1.0/transaction-history-list` | Lulus | Lulus | Belum terverifikasi |
| History Detail | POST `/api/v1.0/transaction-history-detail` | Lulus | Lulus | Belum terverifikasi |
| Create VA | POST `/api/v1.0/transfer-va/create-va` | Lulus | Lulus | Tidak dijalankan demi menghindari mutasi nyata |
| Update VA | PUT `/api/v1.0/transfer-va/update-va` | Lulus | Lulus | Tidak dijalankan demi menghindari mutasi nyata |

Setiap kasus memeriksa method/path/body, RSA/token/HMAC actual, urutan API, progress tanpa label saldo, ID/service history, pemetaan empat bukti fixture, serta sanitasi token/secret. Kasus tambahan membuktikan Bank Statement menolak payload saldo yang kehilangan required date fields; HTTP/code benar tetapi schema response salah tetap Failed; progress ID yang sama tidak mengirim ulang.

Kasus GET headless terpisah memeriksa path parameter ter-encode, query, signature hash string kosong, token provided, auth none, serta token kedaluwarsa yang tidak mengirim request. Regresi mencakup Client Simulator, privilege/ownership, User Management, cancel, CAPTCHA/password reset, history, preview/download PDF dan ZIP.

Optimasi resolver mengurangi browser round-trip pembacaan field. Suite enam API yang sama turun dari sekitar 86 detik menjadi sekitar 39–42 detik pada laptop pengujian. Ini hasil fixture lokal, bukan janji latency ASPI atau Vercel.

Hasil final: `npm.cmd run build` **lulus**, `npm.cmd run lint` **lulus**, `node --test --test-concurrency=1 tests/*.test.mjs` **72/72 lulus**, 0 gagal, 0 dilewati (sekitar 125 detik untuk seluruh suite). Pemeriksaan UI headless desktop/mobile juga lulus. `git diff --check` tidak menemukan whitespace error; peringatan konversi LF/CRLF Windows bukan kegagalan build.

## Cara memakai

1. Jalankan ulang `npm.cmd run dev` dari folder AutoSNAP sesudah proses lama dihentikan.
2. Master Data → Endpoint URL → tambah/edit → Baca dokumentasi operasi ASPI.
3. Tinjau method/path, sample/schema, autentikasi dan expected result. Buka Ubah konfigurasi hanya jika profile keamanan berbeda. Untuk B2B2C, siapkan consent/customer token yang sah; jangan memilihnya hanya karena ada header opsional.
4. Jika ingin tes negatif, aktifkan ekspektasi token negatif dan masukkan kode error yang benar dari ASPI; tidak perlu menulis token rusak sendiri.
5. Simpan setelah review. Dev Site Client → pilih User SNAP, client, endpoint/service → periksa/edit payload → Jalankan Testing.
6. Periksa log, response dan hasil tiap validasi pada History. PDF resmi yang gagal diambil tetap dicatat sebagai kegagalan bukti terpisah, bukan mengubah hasil HTTP target.

Create VA yang saat audit tersimpan dengan auth `unknown` perlu ditinjau dulu; tidak diubah menjadi B2B secara tebakan. Token provided memerlukan data `accessToken` terenkripsi dan `accessTokenExpiresAt` pada client; gunakan default pengambilan B2B jika tidak mengelola expiry secara eksplisit.

## Batas dan pekerjaan yang belum diklaim selesai

- Tidak mengeksekusi enam layanan baru di server ASPI asli. Tes VA/QRIS nyata, OTP/consent, serta PDF resmi per layanan baru tetap perlu verifikasi akun dan lingkungan uji yang diizinkan.
- Engine mendukung capability keamanan di tabel di atas; workflow kustom di luar itu membutuhkan adapter, bukan cukup mengganti nama. Generic direct bank HTTP belum dibuka untuk semua metadata portal; fokus audit ini headless ASPI.
- Validator schema yang tersedia bukan implementasi penuh JSON Schema atau sertifikasi bisnis SNAP; constraint yang tidak didukung dan kondisi lintas-request masih perlu review.
- Tidak ada jaminan “tidak bisa dibobol”. Kontrol akses, sanitasi, isolasi client, replay protection dan larangan retry tetap diperiksa lewat regresi.
- Panduan backend, Supabase dan React digunakan untuk mempertahankan NestJS yang ada, menyimpan metadata privat tanpa migrasi destruktif, serta memverifikasi batas UI → API → database → executor → history. Tidak menambah framework atau modul yang tidak diperlukan.

Referensi utama: [Riwayat Transaksi/Bank Statement ASPI](https://apidevportal.aspi-indonesia.or.id/api-services/riwayat-transaksi), [Informasi Saldo ASPI](https://apidevportal.aspi-indonesia.or.id/api-services/informasi-saldo), [Virtual Account ASPI](https://apidevportal.aspi-indonesia.or.id/api-services/transfer-kredit/virtual-account).
