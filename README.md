# 🏁 F1 Reaction Racing Arena

Game refleks balap Formula 1 berbasis WebSocket dengan sistem multiplayer real-time.
Pemain diuji kecepatan reaksinya terhadap lampu start F1 khas — siapa cepat, dia menang.

**Mata Kuliah:** Cloud Computing

---

##  Anggota Kelompok

| Nama | NPM | Peran |
|---|---|---|
| Rayhan Ahmad Ghani   | 2410010270 | Frontend,|
| Muhammad Nuril Fahmi | 2410010068 | Backend  |
| Sukma Sastra Wijaya  | 2410010462 | Database |
| Ajeng Siti Nurazizah | 2410010628 | Statistik|
| Satria Putra Pratama | 2410010584 | Statistik|

---

##  Link Penting

| Item | Link |
|---|---|
|    Video Demo    | [Tonton di YouTube](https://youtu.be/_bDADERFOQ4?feature=shared) |
|   Proposal PDF   | [Buka di Google Drive](https://drive.google.com/file/d/1kBM4rGn3EkjINKbIF6eF-jwphcnfds-R/view?usp=sharing)  |

| Laporan Akhir PDF| [Buka di Google Drive](https://drive.google.com/file/d/1u0roJexe0cHlnsBRu7BtKLtZcjOaltcp/view?usp=sharing)  |
|Slide Presentasi PDF| [Buka di Google Drive](https://docs.google.com/presentation/d/1HxhrmNf-dfpk8LDfnqdyoRSTAsjeBvQZ/edit?usp=sharing&ouid=112608645265763914439&rtpof=true&sd=true) |

---

## Teknologi yang Digunakan

- **Node.js** runtime JavaScript untuk server
- **Express** framework HTTP server
- **Socket.IO** komunikasi real-time berbasis WebSocket
- **MySQL** / **MariaDB** basis data relasional untuk menyimpan riwayat pertandingan
- **HTML5**, **CSS3**, **JavaScript (vanilla)** antarmuka klien
- **dotenv** pengelolaan variabel konfigurasi

---

## Screenshot Sistem

### 1. Halaman Utama (Lobby)
Tampilan pembuka: pemain memasukkan nama, memilih room, atau langsung masuk ke mode latihan vs AI. Leaderboard 10 pemain teratas juga tampil di sisi kanan.

[![Halaman Utama](https://drive.google.com/uc?export=view&id=1qTsK5t0FqcvfQ2-pcL5-Xcrdfzkc_1st)](https://drive.google.com/file/d/1qTsK5t0FqcvfQ2-pcL5-Xcrdfzkc_1st/view?usp=sharing)


### 2. Halaman Lobby Multiplayer (2+ Pemain)
Ruang tunggu multiplayer untuk 2 sampai 8 pemain. Menampilkan status ready tiap pemain dan chat real-time.

[![Halaman Lobby Multiplayer](https://drive.google.com/uc?export=view&id=1sLFmDKRc3YlViBbx2p5P8p557w623jlj)](https://drive.google.com/file/d/1sLFmDKRc3YlViBbx2p5P8p557w623jlj/view?usp=sharing)


### 3. Halaman Statistik
Ringkasan performa pemain: rata-rata reaction time, konsistensi (selisih tercepat vs terlambat), dan perubahan performa setelah 5 ronde.

[![Halaman Statistik](https://drive.google.com/uc?export=view&id=1NDLHeG_tUYnC1I8FnmYJQCn1Ktsm5nyW)](https://drive.google.com/file/d/1NDLHeG_tUYnC1I8FnmYJQCn1Ktsm5nyW/view?usp=sharing)


##  Cara Menjalankan Sistem

### Persyaratan

- **Node.js** 18 atau lebih baru — [nodejs.org](https://nodejs.org)
- **MySQL 8.x** atau **MariaDB 10.4+** — biasanya sudah ada di XAMPP / Laragon
- Browser modern (Chrome, Edge, Firefox)

### 1. Siapkan basis data

Buka phpMyAdmin (atau MySQL client apa pun), lalu buat basis data:

```sql
CREATE DATABASE f1_reaction
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

Jalankan `database_schema.sql` di basis data itu:

```bash
mysql -u root -p f1_reaction < database_schema.sql
```

Atau tempel isinya di tab **SQL** phpMyAdmin. Script akan otomatis membuat 4 tabel: `Players`, `Game_Sessions`, `Rounds`, dan `Player_Reactions`, lengkap dengan foreign key.

### 2. Konfigurasi database

Salin `.env.example` menjadi `.env`, lalu isi sesuai konfigurasi MySQL-mu:

```bash
cp .env.example .env
```

Isi `.env`:
```
DB_HOST=localhost
DB_USER=root
DB_PASS=
DB_NAME=f1_reaction
```

### 3. Pasang dependency

```bash
npm install
```

### 4. Jalankan server

```bash
node server.js
```

Kalau berhasil, terminal akan menampilkan:
```
Database berhasil konek!
Server running on http://localhost:8080
```

### 5. Buka di browser

Buka `http://localhost:8080` di browser. Untuk mode multiplayer, buka beberapa tab (atau minta teman) untuk bergabung ke room yang sama.

---

## Skema Database (4 Tabel)

| Tabel | Isi |
|---|---|
| `Players` | Daftar pemain unik (Player_id, Username, Join_time) |
| `Game_Sessions` | Tiap pertandingan (Session_id, Room_id, Mode, Start_time, End_time, Total_round, Winner_player_id) |
| `Rounds` | Ronde-ronde dalam suatu sesi (Round_id, Session_id, Round_number, Signal_time) |
| `Player_Reactions` | Aksi klik pemain per ronde (Reaction_id, Player_id, Round_id, Click_time, Reaction_time, Win, Round_result) |

Skema lengkap ada di `database_schema.sql`.
