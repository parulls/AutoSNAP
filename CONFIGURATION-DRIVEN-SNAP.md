# AutoSNAP: konfigurasi layanan dinamis

## Hasil audit awal

UI Master Data dan Dev Site sebelumnya memfilter Informasi Saldo/code 11; backend menolak modul selain Saldo/Registrasi/Keamanan. Template portal selalu memakai contoh Balance Inquiry. Response non-saldo belum divalidasi terhadap schema. Pencocokan PDF berpusat pada empat nama layanan awal.

Perbaikan menggunakan JSON `autosnap_records.data.config` pada record service. Endpoint tetap menyimpan method, path dan URL portal. Tidak ada migrasi tabel atau pengubahan data produksi. History menyimpan snapshot konfigurasi saat pengujian, bukan bergantung pada konfigurasi yang bisa berubah sesudahnya.

## Penggunaan

1. Admin membuka Master Data → Endpoint URL → Tambah Endpoint URL. Tidak ada form API Service terpisah.
2. Masukkan URL operasi lengkap dengan hash `#/Group/operationId`. Tidak ada dropdown referensi atau daftar URL contoh hardcoded. Jika hanya ada satu User SNAP, sesi dipilih otomatis; jika lebih, pilih akun sesi yang sesuai.
3. Klik Baca dokumentasi. Importer membaca Swagger/OpenAPI atau form Swagger yang dirender. Importer tidak menekan Try it out/Execute; request transaksi `/api/*` dan request selain GET/HEAD diblokir selama pembacaan. Pengecualian POST hanya untuk login portal resmi sebelum fase dokumentasi.
4. Tinjau HTTP method/path, body, parameter dan response yang terisi otomatis. Autentikasi hanya otomatis jika dokumentasi operasi menyatakannya secara eksplisit. Expected HTTP/code diambil dari response yang jelas; informasi yang tidak tersedia perlu dikonfirmasi, bukan ditebak. Pengaturan lengkap tersedia pada bagian lanjutan, bukan input rutin. Service code dicocokkan dengan katalog spesifikasi lokal berdasarkan path dan method tepat, tidak diambil dari urutan ID atau tebakan nama. Kode tidak diketahui dibiarkan kosong.
5. Centang konfirmasi lalu simpan. Endpoint dan service disimpan dalam satu transaksi. Import ulang URL yang sama memperbarui record yang sama.
6. Di Dev Site Client pilih endpoint/service baru. Template dan form berasal dari metadata; query/path/header non-managed menjadi input dinamis. Body dapat diedit melalui field schema atau JSON.
7. Testing menjalankan alur keamanan yang dikonfigurasi, lalu API target sekali. Setelah validasi, History disimpan. Jika Passed, PDF resmi ASPI dikumpulkan seperti alur sebelumnya, dengan alias dari nama service di metadata.

Template hanya diisi dari contoh request eksplisit pada dokumentasi ASPI, bukan payload yang ditebak dari nama field, nilai default schema, atau body Balance Inquiry hardcoded. Jika sample tidak tersedia, template kosong dan warning ditampilkan. POST/PUT/PATCH memerlukan body yang diisi sebelum testing; GET/HEAD tidak mengirim body. Preview template di Master Data bersifat read-only. Pengaturan lanjutan JSON tersedia untuk peninjauan, sedangkan input request aktual berada di halaman testing.

Edit konfigurasi dibuka dari baris endpoint; endpoint/service yang sudah ada mempertahankan ID-nya. Penghapusan endpoint meminta konfirmasi, lalu menghapus konfigurasi service/template terkait secara atomik; History Testing tidak ikut dihapus. Tidak ada data runtime yang otomatis dihapus oleh perubahan UI ini.

## Input minimum dan kecepatan baca

- User SNAP: akun/sesi portal yang sah; dipilih otomatis jika hanya satu akun. Email/password tetap dikelola pada User SNAP, tidak disalin ke konfigurasi endpoint.
- Dev Site Client: kredensial serta CHANNEL-ID tetap satu kali di master client; token, timestamp, external ID dan signature bukan input endpoint.
- Endpoint: URL operasi, nama, HTTP method/path, template request eksplisit, parameter/schema dan response, autentikasi, expected HTTP/SNAP code serta status review. URL diinput pengguna; metadata lainnya dibaca otomatis sejauh tersedia. Nilai yang tidak terdokumentasi dibiarkan kosong/perlu review.
- Pembaca hanya satu kali membuka URL saat sesi masih valid, membaca state/network Swagger tanpa menunggu panel terlihat, dan memblokir image/font/media yang tidak dibutuhkan. Halaman publik dengan tautan Sign In tidak dianggap sebagai sesi pengujian yang sah. Swagger JSON pada port HTTPS berbeda di hostname ASPI yang sama diizinkan khusus untuk path `/swagger/*.json`; `/api/*` tetap diblokir.
- Jika Swagger tidak memuat sample response, Code Snippets resmi menjadi pelengkap hanya bila method/path cocok unik dan kode sesuai HTTP/service. Template request Swagger/sandbox tetap diprioritaskan. Tidak ada response code yang disusun secara asumtif dari HTTP + service code.
- Hasil cache memori maksimal 5 menit/40 operasi, terpisah per User SNAP dan revisi kredensial. Panggilan identik bersamaan digabung; salinan hasil diberikan ke setiap pemanggil. Cache tidak menyimpan password mentah/browser session dan tidak mengubah metadata database. Pada cold start Vercel cache dapat kosong.
- Tidak ada daftar referensi layanan yang disimpan ke runtime. Pemeriksaan Supabase pada 17 November 2026 menemukan 0 reference/seed record; endpoint Balance Inquiry dan Bank Statement pengguna dipertahankan. Katalog spesifikasi lokal tetap diperlukan untuk mencocokkan service code secara tepat, bukan sebagai dropdown atau sumber payload palsu.

## Metadata tersimpan

`version`, `sourceUrl`, `operationId`, `identity` (method/path), `authFlow`, `workflow`, `negativeToken`, `parameters`, `requestSchema`, `requestBodyMode`, `responses`, `responseFormat`, `expectedHttpStatus`, `expectedCode`, `reviewed`, `warnings`.

Auth `unknown` tidak dapat dieksekusi. Profile `b2b` yang ditinjau secara default memakai Signature Auth → Access Token B2B → Signature Service → target. `workflow` dapat mengatur sumber token dan kebutuhan signature sesuai dokumentasi. Token client tersimpan hanya boleh digunakan bila masa berlakunya diketahui dan masih valid. Profile `b2b2c` menambahkan customer token terenkripsi dari User SNAP terpilih; token harus diperoleh secara sah sesuai persetujuan pelanggan. Sistem tidak membuat token pelanggan atau melewati OTP/MFA/CAPTCHA. `none` hanya menjalankan target, tanpa utility keamanan. Kombinasi workflow yang bertentangan dengan header keamanan wajib ditolak.

GET/HEAD tidak mengirim JSON body. `requestBodyMode` membedakan required/optional/none berdasarkan definisi Swagger, bukan asumsi semua POST mempunyai body. Metadata lama tanpa field ini tetap mewajibkan body untuk non-GET/HEAD. Fallback dokumentasi DOM yang tidak lengkap tidak dianggap membuktikan body opsional. Query/path masuk form Swagger, path/query aktual dipakai dalam signature. Untuk request tanpa body, utility signature menerima body kosong, bukan `{}`. Header yang dikelola sistem tidak dapat diganti dari input parameter. Method didukung: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS sesuai dokumentasi.

## Validasi dan keamanan

- Admin-only untuk import/simpan; privilege eksekusi, ownership History/PDF, rate limit dan sesi lama tetap digunakan.
- Operation ID harus cocok unik. Hanya URL HTTPS portal ASPI yang diizinkan. Referensi schema eksternal tidak diambil otomatis.
- Konfigurasi belum ditinjau, auth unknown, dan expected HTTP yang kosong ditolak sebelum request. Expected SNAP responseCode bersifat opsional: kosong tidak menghalangi eksekusi dan tidak diisi dari nilai default, service code, HTTP status atau actual response.
- Validasi schema meliputi object/array/type, required, enum, maxLength serta allOf/oneOf/anyOf. Ini bukan sertifikasi atau implementasi penuh semua keyword JSON Schema maupun seluruh aturan bisnis SNAP. Aturan kondisional, regex/format khusus, hubungan lintas-request dan ketentuan bank perlu ditinjau; jangan menganggap aturan tersebut sudah diuji hanya karena status Passed.
- Expected HTTP, expected responseCode, responseMessage dan constraint schema yang tersedia dicek terpisah. Balance Inquiry mempertahankan validator spesifiknya.
- Progress ID yang sudah diterima tidak dapat mengeksekusi run lagi. Execute tidak diulang demi mengambil PDF.
- Nilai query/path dinamis serta pseudo-header HTTP/2 tidak disimpan mentah dalam History. Token/credential tetap disanitasi.

## Batas yang belum diverifikasi

Tes regresi memakai portal fixture dan database test terisolasi. Pembacaan dokumentasi ASPI asli untuk Balance Inquiry dan Bank Statement telah diuji secara read-only pada 17 November 2026: method/path, sample request dan 13 parameter terbaca, tanpa Execute/transaksi. Pengujian transaksi VA/QRIS nyata, customer consent B2B2C, serta PDF resmi untuk masing-masing layanan baru belum dilakukan terhadap ASPI asli. Perubahan HTML/Swagger ASPI dapat memerlukan penyesuaian pembaca dokumentasi, bukan pengubahan setiap service.

Jika hanya sample tersedia, schema/required body tidak ditandai pasti. Operator harus meninjau warning dan melengkapi data dari dokumentasi yang sah. Alur auth di luar capability yang tersedia tidak otomatis didukung hanya dengan memasukkan URL. Tes token negatif tersedia lintas-layanan yang menggunakan token, walaupun expected code belum diisi. Import hanya mengisi ekspektasi otomatis dari sample error token yang cocok unik; tidak menyusun kode negatif berdasarkan service code. Fallback expected code Balance Inquiry lama juga dihapus; bila tidak ada ekspektasi tersimpan atau skenario yang dipilih eksplisit, hasilnya NOT_EVALUATED.

### Expected SNAP code opsional

- Setelah respons HTTP target diterima, expected code kosong menghasilkan status/outcome `NOT_EVALUATED`, bukan Passed, Failed atau VALIDATION_ERROR. HTTP, actual code dan body tetap disimpan; check perbandingan SNAP mempunyai `passed: null` (tidak dijalankan).
- Detail: “Pengujian telah dieksekusi, tetapi hasil belum dapat dievaluasi karena Expected SNAP responseCode belum ditentukan.” Saran: “Konfigurasikan Expected SNAP responseCode sesuai dokumentasi ASPI SNAP dan skenario pengujian.”
- Expected yang tersedia dibandingkan dengan actual code, HTTP dan pemeriksaan schema/request lain. `evaluation.outcome` dan outcome run menjadi `PASSED` atau `FAILED`; status lama Passed/Failed dipertahankan untuk kompatibilitas UI. Klasifikasi teknis asli disimpan terpisah dalam `executionOutcome`.
- Error transport/login/prasyarat yang tidak menghasilkan HTTP target tidak diubah menjadi NOT_EVALUATED. Input/configuration wajib yang tidak valid tetap ditolak sebelum API.
- Progress memakai tahap “Validasi Hasil” dengan level netral `not_evaluated`. History/dashboard menghitungnya terpisah dari Error/Failed. Snapshot hasil menyimpan pesan, saran, ekspektasi null, actual HTTP/code, respons tersanitasi dan detail checks untuk laporan/detail hasil.
- Kebijakan bukti tetap: PDF dikumpulkan setelah Passed. NOT_EVALUATED tetap disimpan dan dijelaskan di log, tetapi belum memicu pengambilan PDF. PDF resmi ASPI yang sudah ada tetap asli, tidak ditulis ulang untuk mengubah hasil ASPI menjadi hasil evaluasi AutoSNAP.
- Tidak perlu ALTER TABLE: status bertipe text, expected_code sudah nullable dan detail evaluasi disimpan pada request_json. Tidak mengubah hasil history lama atau metadata Supabase secara diam-diam.
- Verifikasi pembaruan ini: build produksi dan lint lulus; 75/75 tes lulus tanpa skip. Kasus baru meliputi expected kosong/hilang/whitespace, expected tidak cocok, HTTP 401 negatif tanpa expected, login/transport yang belum menghasilkan respons target, progress/history/count dashboard, dan tampilan browser tanpa pop-up error. Alur empat request Bank Statement juga diuji headless saat expected positif maupun negatif kosong. Semua memakai fixture terisolasi, bukan hit ASPI asli. Pemeriksaan read-only Supabase memastikan schema menerima null dan agregasi NOT_EVALUATED terpisah dari Error.

## Audit lanjutan 18 November 2026

Database tetap Supabase, sesuai konfirmasi pengguna. Pemeriksaan read-only menunjukkan Bank Statement di history sudah menggunakan `POST /api/v1.0/bank-statement` dan menerima `2001400`. Run tersebut berstatus Cancelled, sehingga bukan bukti run lengkap beserta PDF berhasil. Penyebab tampilan menyesatkan adalah stage progress statis `balance_inquiry`. Refactor tidak berhenti pada penggantian label: resolver memeriksa identitas operasi, builder memisahkan body/path/query, orchestrator menjalankan dependency keamanan, dan browser memeriksa header, canonical path/query serta body request aktual. Snapshot history mencatat ID dan revisi endpoint/service.

Satu form endpoint tetap menyimpan dua record internal (routing endpoint dan metadata service) untuk menjaga foreign key serta history lama, bukan menambah modul/form layanan terpisah. Tidak ada migrasi SQL destruktif atau perubahan kredensial/koneksi produksi. Field JSON baru bersifat tambahan dan metadata lama dibaca dengan adapter terbatas untuk endpoint Balance Inquiry yang dikenali; tidak ada fallback saldo untuk endpoint lain.

Laporan bukti dan batas verifikasi: lihat `BACKEND-AUDIT-2026-11-18.md`.

## File utama

- `backend/src/swagger-import.ts`: parser metadata OpenAPI/Swagger.
- `backend/src/documentation-reader.ts`: pembaca headless read-only.
- `backend/src/endpoint-config.ts`: kontrak metadata dan validator generik.
- `backend/src/endpoint-resolver.ts`: pemeriksaan identitas endpoint dan ekspektasi per skenario.
- `backend/src/request-builder.ts`: body, placeholder eksplisit, path dan query.
- `backend/src/auth-workflow.ts`: rencana dependency dan eksekusi capability keamanan.
- `backend/src/portal-engine.ts`: eksekusi portal dan signature.
- `backend/src/app.ts`: izin, penyimpanan, validasi, history dan bukti.
- `app/documentation-import.tsx`: import/review.
- `app/dynamic-request-fields.tsx`: field body berbasis schema.

Tidak ada AI pada proses import, testing atau validasi. Penambahan endpoint dengan alur yang sudah didukung dilakukan melalui Master Data. Dokumentasi yang tidak cukup tidak dianggap lengkap secara otomatis.
