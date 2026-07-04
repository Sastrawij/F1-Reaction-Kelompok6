-- =====================================================================
--  F1 REACTION GAME  —  DATABASE SCHEMA

-- =====================================================================

USE f1_reaction;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS _Player_Reactions_backup;
CREATE TABLE IF NOT EXISTS _Player_Reactions_backup AS
    SELECT * FROM Player_Reactions;

DROP TABLE IF EXISTS Player_Reactions;
DROP TABLE IF EXISTS Rounds;
DROP TABLE IF EXISTS Game_Sessions;
DROP TABLE IF EXISTS Players;

-- ---------------------------------------------------------------------
-- TABEL 1: Players
--    Daftar pemain unik. Sesuai proposal: Player_id, Username, Join_time.
-- ---------------------------------------------------------------------
CREATE TABLE Players (
    Player_id  INT UNSIGNED  NOT NULL AUTO_INCREMENT
               COMMENT 'ID pemain',
    Username   VARCHAR(50)   NOT NULL
               COMMENT 'Nama pemain (unik)',
    Join_time  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
               COMMENT 'Waktu masuk game',
    PRIMARY KEY (Player_id),
    UNIQUE KEY uq_username (Username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Daftar pemain unik';


-- ---------------------------------------------------------------------
-- TABEL 2: Game_Sessions
--    Satu sesi permainan (1 match). Sesuai proposal: Session_id,
--    Start_time, Total_round. Kolom room_id, mode, End_time,
--    Winner_player_id ditambahkan sebagai kebutuhan aplikasi tanpa
--    mengubah struktur inti proposal.
-- ---------------------------------------------------------------------
CREATE TABLE Game_Sessions (
    Session_id        INT UNSIGNED   NOT NULL AUTO_INCREMENT
                      COMMENT 'ID permainan',
    Room_id           VARCHAR(50)    NOT NULL
                      COMMENT 'ID room asal (ROOM-001 dll)',
    Mode              ENUM('PVP','VS_AI','MULTI') NOT NULL DEFAULT 'PVP'
                      COMMENT 'Mode permainan',
    Start_time        DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP
                      COMMENT 'Waktu permainan dimulai',
    End_time          DATETIME       NULL
                      COMMENT 'Waktu permainan selesai (diisi saat match_result terkirim)',
    Total_round       INT UNSIGNED   NOT NULL DEFAULT 0
                      COMMENT 'Jumlah ronde permainan yang benar-benar dimainkan',
    Winner_player_id  INT UNSIGNED   NULL
                      COMMENT 'Pemenang match; NULL jika seri atau belum selesai',
    Is_draw           TINYINT(1)     NOT NULL DEFAULT 0
                      COMMENT '1 jika match seri',
    PRIMARY KEY (Session_id),
    KEY idx_room (Room_id),
    KEY idx_winner (Winner_player_id),
    CONSTRAINT fk_gs_winner
        FOREIGN KEY (Winner_player_id) REFERENCES Players(Player_id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Satu sesi permainan (match)';


-- ---------------------------------------------------------------------
-- TABEL 3: Rounds
--    Ronde ke berapa dalam sebuah sesi. Sesuai proposal: Round_id,
--    Session_id (FK), Round_number, Signal_time.
-- ---------------------------------------------------------------------
CREATE TABLE Rounds (
    Round_id      INT UNSIGNED  NOT NULL AUTO_INCREMENT
                  COMMENT 'ID ronde',
    Session_id    INT UNSIGNED  NOT NULL
                  COMMENT 'ID game session (FK)',
    Round_number  INT UNSIGNED  NOT NULL
                  COMMENT 'Nomor ronde (1..5, atau lebih saat sudden death)',
    Signal_time   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                  COMMENT 'Waktu sinyal GO (lampu padam)',
    PRIMARY KEY (Round_id),
    UNIQUE KEY uq_session_round (Session_id, Round_number)
        COMMENT 'Cegah duplikasi nomor ronde dalam satu sesi',
    KEY idx_session (Session_id),
    CONSTRAINT fk_rounds_session
        FOREIGN KEY (Session_id) REFERENCES Game_Sessions(Session_id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Ronde-ronde dalam satu sesi permainan';


-- ---------------------------------------------------------------------
-- TABEL 4: Player_Reactions
--    Aksi (klik) satu pemain di satu ronde. Sesuai proposal:
--    Reaction_id, Player_id (FK), Round_id (FK), Click_time,
--    Reaction_time, Win. Kolom Round_result ditambahkan supaya
--    aplikasi bisa membedakan WIN/LOSE/DRAW/FALSE_START saat query
--    leaderboard tanpa harus menghitung ulang.
-- ---------------------------------------------------------------------
CREATE TABLE Player_Reactions (
    Reaction_id    INT UNSIGNED   NOT NULL AUTO_INCREMENT
                   COMMENT 'ID reaction',
    Player_id      INT UNSIGNED   NOT NULL
                   COMMENT 'ID pemain (FK)',
    Round_id       INT UNSIGNED   NOT NULL
                   COMMENT 'ID ronde (FK)',
    Click_time     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP
                   COMMENT 'Waktu klik pemain',
    Reaction_time  INT            NOT NULL
                   COMMENT 'Reaction time dalam ms. 99999 = FALSE START',
    Win            TINYINT(1)     NOT NULL DEFAULT 0
                   COMMENT 'Status kemenangan ronde: 1 = menang, 0 = tidak',
    Round_result   ENUM('WIN','LOSE','DRAW','FALSE_START') NOT NULL
                   COMMENT 'Detail hasil ronde untuk pemain ini',
    PRIMARY KEY (Reaction_id),
    UNIQUE KEY uq_player_round (Player_id, Round_id)
        COMMENT 'Satu pemain hanya boleh punya satu reaction per ronde',
    KEY idx_player (Player_id),
    KEY idx_round (Round_id),
    KEY idx_reaction (Reaction_time),
    CONSTRAINT fk_pr_player
        FOREIGN KEY (Player_id) REFERENCES Players(Player_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_pr_round
        FOREIGN KEY (Round_id) REFERENCES Rounds(Round_id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Aksi (klik) satu pemain di satu ronde';


-- 1) Migrasi Players
INSERT INTO Players (Username)
SELECT DISTINCT Username
FROM _Player_Reactions_backup
WHERE Username IS NOT NULL AND Username <> '';

-- 2) Migrasi Game_Sessions — 1 Room_id = 1 Session
INSERT INTO Game_Sessions (Room_id, Mode, Start_time, End_time, Total_round)
SELECT
    Room_id,
    CASE
        WHEN Room_id LIKE 'AI-%'    THEN 'VS_AI'
        WHEN Room_id LIKE '%_MULTI' THEN 'MULTI'
        ELSE 'PVP'
    END AS Mode,
    MIN(created_at) AS Start_time,
    MAX(created_at) AS End_time,
    (
        SELECT MAX(cnt) FROM (
            SELECT COUNT(*) AS cnt
            FROM _Player_Reactions_backup b2
            WHERE b2.Room_id = b.Room_id
            GROUP BY b2.Username
        ) t
    ) AS Total_round
FROM _Player_Reactions_backup b
WHERE Room_id IS NOT NULL AND Room_id <> ''
GROUP BY Room_id;

-- 3) Tebak pemenang session dari SUM(Round_result='WIN') per pemain.
--    Kalau ada seri (jumlah wins terbanyak dimiliki >1 pemain), is_draw=1.
UPDATE Game_Sessions gs
LEFT JOIN (
    SELECT
        b.Room_id,
        MIN(p.Player_id) AS Winner_player_id,
        COUNT(*)         AS n_leaders
    FROM _Player_Reactions_backup b
    JOIN Players p ON p.Username = b.Username
    WHERE b.Round_result = 'WIN'
    GROUP BY b.Room_id, p.Player_id
    HAVING SUM(1) = (
        SELECT MAX(wc) FROM (
            SELECT COUNT(*) wc
            FROM _Player_Reactions_backup b2
            WHERE b2.Room_id = b.Room_id AND b2.Round_result = 'WIN'
            GROUP BY b2.Username
        ) t
    )
) w ON w.Room_id = gs.Room_id
SET gs.Winner_player_id = CASE WHEN w.n_leaders = 1 THEN w.Winner_player_id ELSE NULL END,
    gs.Is_draw          = CASE WHEN w.n_leaders > 1 THEN 1 ELSE 0 END;

-- 4) Bikin baris Rounds. Untuk tiap session, buat ronde 1..Total_round.
INSERT INTO Rounds (Session_id, Round_number, Signal_time)
SELECT
    gs.Session_id,
    n.rn,
    gs.Start_time
FROM Game_Sessions gs
JOIN (
    -- generator angka 1..20 (cukup untuk data lama 5 ronde + sudden death)
    SELECT 1 rn UNION ALL SELECT 2  UNION ALL SELECT 3  UNION ALL SELECT 4
    UNION ALL SELECT 5  UNION ALL SELECT 6  UNION ALL SELECT 7  UNION ALL SELECT 8
    UNION ALL SELECT 9  UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
    UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16
    UNION ALL SELECT 17 UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20
) n ON n.rn <= gs.Total_round;

-- 5) Migrasi Player_Reactions dengan nomor ronde ditebak dari created_at.
SET @prev_room = '', @prev_user = '', @rn = 0;

INSERT INTO Player_Reactions
    (Player_id, Round_id, Click_time, Reaction_time, Win, Round_result)
SELECT
    p.Player_id,
    r.Round_id,
    ordered.created_at,
    ordered.Reaction_time,
    CASE WHEN ordered.Round_result = 'WIN' THEN 1 ELSE 0 END,
    ordered.Round_result
FROM (
    SELECT
        b.Username,
        b.Room_id,
        b.Reaction_time,
        b.Round_result,
        b.created_at,
        @rn := IF(@prev_room = b.Room_id AND @prev_user = b.Username, @rn + 1, 1) AS Round_number,
        @prev_room := b.Room_id,
        @prev_user := b.Username
    FROM _Player_Reactions_backup b
    ORDER BY b.Room_id, b.Username, b.created_at, b.id
) ordered
JOIN Players p       ON p.Username    = ordered.Username
JOIN Game_Sessions s ON s.Room_id     = ordered.Room_id
JOIN Rounds r        ON r.Session_id  = s.Session_id AND r.Round_number = ordered.Round_number;



SET FOREIGN_KEY_CHECKS = 1;

SELECT 'Players'          AS tabel, COUNT(*) AS jumlah FROM Players
UNION ALL SELECT 'Game_Sessions',    COUNT(*) FROM Game_Sessions
UNION ALL SELECT 'Rounds',           COUNT(*) FROM Rounds
UNION ALL SELECT 'Player_Reactions', COUNT(*) FROM Player_Reactions;

-- =====================================================================
--  QUERY REFERENSI (dokumentasi untuk endpoint & analisis)
-- =====================================================================

-- Leaderboard (dipakai oleh /api/leaderboard):
--   SELECT p.Username,
--          MIN(pr.Reaction_time)                       AS best_time,
--          ROUND(AVG(pr.Reaction_time))                AS avg_time,
--          SUM(CASE WHEN pr.Round_result='WIN' THEN 1 ELSE 0 END) AS total_wins,
--          COUNT(*)                                    AS total_rounds
--   FROM   Player_Reactions pr
--   JOIN   Players p ON p.Player_id = pr.Player_id
--   WHERE  pr.Reaction_time < 99999
--   GROUP  BY p.Player_id, p.Username
--   ORDER  BY total_wins DESC, best_time ASC
--   LIMIT  10;

-- Analisis "performa meningkat" — bandingkan R1 vs R5 per pemain:
--   SELECT p.Username,
--          AVG(CASE WHEN r.Round_number = 1 THEN pr.Reaction_time END) AS r1_avg,
--          AVG(CASE WHEN r.Round_number = 5 THEN pr.Reaction_time END) AS r5_avg
--   FROM   Player_Reactions pr
--   JOIN   Rounds r  ON r.Round_id  = pr.Round_id
--   JOIN   Players p ON p.Player_id = pr.Player_id
--   WHERE  pr.Reaction_time < 99999
--   GROUP  BY p.Player_id, p.Username
--   HAVING r1_avg IS NOT NULL AND r5_avg IS NOT NULL;

-- Riwayat pertandingan pemain:
--   SELECT s.Session_id, s.Mode, s.Start_time, s.Total_round,
--          CASE WHEN s.Winner_player_id = p.Player_id THEN 'MENANG'
--               WHEN s.Is_draw = 1                     THEN 'SERI'
--               ELSE 'KALAH' END AS Hasil
--   FROM Game_Sessions s
--   JOIN Player_Reactions pr ON pr.Round_id IN (SELECT Round_id FROM Rounds WHERE Session_id = s.Session_id)
--   JOIN Players p ON p.Player_id = pr.Player_id
--   WHERE p.Username = 'NAMA_PEMAIN'
--   GROUP BY s.Session_id
--   ORDER BY s.Start_time DESC;
