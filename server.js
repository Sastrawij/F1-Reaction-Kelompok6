const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ── DATABASE ────────────────────────────────────────────────────────────────
// FIX: koneksi DB dipindah ke ATAS, sebelum route /api/leaderboard yang memakainya.
const db = mysql.createConnection({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) console.error('❌ Database gagal konek:', err.message);
    else     console.log('✅ Database berhasil konek!');
});

// ── LEADERBOARD API ─────────────────────────────────────────────────────────
// Diurutkan: pemenang match terbanyak dulu, lalu best_time tercepat
app.get('/api/leaderboard', (req, res) => {
    db.query(`
        SELECT p.Username                                    AS Username,
               MIN(pr.Reaction_time)                         AS best_time,
               ROUND(AVG(pr.Reaction_time))                  AS avg_time,
               SUM(CASE WHEN pr.Round_result='WIN' THEN 1 ELSE 0 END) AS total_wins,
               COUNT(*)                                      AS total_rounds
        FROM Player_Reactions pr
        JOIN Players p ON p.Player_id = pr.Player_id
        WHERE pr.Reaction_time < 99999
        GROUP BY p.Player_id, p.Username
        ORDER BY total_wins DESC, best_time ASC
        LIMIT 10
    `, (err, results) => {
        if (err) { console.error('Leaderboard error:', err); return res.json([]); }
        res.json(results);
    });
});

// ── HELPER DATABASE (skema proposal: Players, Game_Sessions, Rounds, Player_Reactions) ──
// Cache Username → Player_id supaya tidak SELECT tiap ronde
const playerIdCache = new Map();

// Pastikan pemain ada di tabel Players, kembalikan Player_id-nya
function ensurePlayerId(username) {
    if (!username) return Promise.resolve(null);
    if (playerIdCache.has(username)) return Promise.resolve(playerIdCache.get(username));
    return new Promise((resolve) => {
        db.query('INSERT IGNORE INTO Players (Username) VALUES (?)', [username], (err) => {
            if (err) { console.error('Players INSERT error:', err.message); return resolve(null); }
            db.query('SELECT Player_id FROM Players WHERE Username = ?', [username], (err2, rows) => {
                if (err2 || !rows || !rows.length) {
                    console.error('Players SELECT error:', err2 && err2.message);
                    return resolve(null);
                }
                const id = rows[0].Player_id;
                playerIdCache.set(username, id);
                resolve(id);
            });
        });
    });
}

// Buat baris Game_Sessions baru, kembalikan Session_id
function createGameSession(roomId, mode) {
    return new Promise((resolve) => {
        db.query(
            'INSERT INTO Game_Sessions (Room_id, Mode) VALUES (?, ?)',
            [roomId, mode],
            (err, r) => {
                if (err) { console.error('Game_Sessions INSERT error:', err.message); return resolve(null); }
                resolve(r.insertId);
            }
        );
    });
}

// Buat baris Rounds baru (satu per ronde), kembalikan Round_id
function createRoundRow(sessionId, roundNumber) {
    if (!sessionId) return Promise.resolve(null);
    return new Promise((resolve) => {
        db.query(
            'INSERT INTO Rounds (Session_id, Round_number, Signal_time) VALUES (?, ?, CURRENT_TIMESTAMP)',
            [sessionId, roundNumber],
            (err, r) => {
                if (err) { console.error('Rounds INSERT error:', err.message); return resolve(null); }
                resolve(r.insertId);
            }
        );
    });
}

// Simpan aksi (klik) satu pemain di satu ronde ke Player_Reactions
function insertPlayerReaction(playerId, roundId, reactionTime, roundResult) {
    if (!playerId || !roundId) return;
    const win = roundResult === 'WIN' ? 1 : 0;
    db.query(
        `INSERT INTO Player_Reactions
             (Player_id, Round_id, Click_time, Reaction_time, Win, Round_result)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
        [playerId, roundId, reactionTime, win, roundResult],
        (err) => { if (err) console.error('Player_Reactions INSERT error:', err.message); }
    );
}

// Finalisasi Game_Sessions saat match selesai
function finalizeGameSession(sessionId, winnerPlayerId, isDraw, totalRounds) {
    if (!sessionId) return;
    db.query(
        `UPDATE Game_Sessions
         SET Winner_player_id = ?, Is_draw = ?, Total_round = ?, End_time = CURRENT_TIMESTAMP
         WHERE Session_id = ?`,
        [winnerPlayerId || null, isDraw ? 1 : 0, totalRounds, sessionId],
        (err) => { if (err) console.error('Game_Sessions finalize error:', err.message); }
    );
}

// ── KONFIGURASI MATCH ────────────────────────────────────────────────────────
const FALSE_START      = 99999;          // sentinel skor untuk false start
const MATCH_ROUNDS     = 5;              // jumlah ronde utama per match
const SUDDEN_DEATH_CAP = 10;             // batas ronde sudden-death (pengaman anti loop tak berujung)
const MATCH_TIE_MODE   = 'sudden_death'; // 'sudden_death' = lanjut ronde sampai ada pemenang
                                         // 'draw'         = langsung dinyatakan seri setelah 5 ronde

// Pre-defined rooms
const PRESET_ROOMS = [
    { id: 'ROOM-001', name: 'Arena Cepat 1' },
    { id: 'ROOM-002', name: 'Arena Cepat 2' },
    { id: 'ROOM-003', name: 'Arena Cepat 3' },
    { id: 'ROOM-004', name: 'Arena Cepat 4' },
    { id: 'ROOM-005', name: 'Arena Cepat 5' },
];

const rooms = {};

// ── MULTI ROOMS (2-8 pemain) ─────────────────────────────────────────────────
const multiRooms = {};

function getMultiRoom(roomID) {
    if (!multiRooms[roomID]) {
        multiRooms[roomID] = {
            players    : [],   // [{id, username, ready, scores:[]}]
            roundScores: {},   // username → score ronde berjalan
            matchScore : {},   // username → wins
            round      : 0,
            inGame     : false,
            matchOver  : false,
            hostID     : null,
            config     : { maxPlayers: 4, rounds: 5, minPlayers: 2 },
        };
    }
    return multiRooms[roomID];
}

function broadcastMultiRoom(roomID) {
    const room = multiRooms[roomID];
    if (!room) return;
    io.to(roomID).emit('room_data_multi', {
        players: room.players.map(p => {
            const valid = p.scores.filter(s => s < FALSE_START);
            return {
                username : p.username,
                ready    : p.ready,
                isAI     : false,
                avg      : valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
            };
        }),
        config: room.config,
    });
}

// FIX: fungsi ini HANYA memulai ronde (dipanggil saat semua pemain sudah di
// halaman game dan menekan READY). Pemeriksaan "semua siap" dilakukan di
// handler set_ready_multi supaya lobby & game bisa dibedakan.
function startMultiRound(roomID) {
    const room = multiRooms[roomID];
    if (!room) return;

    room.players.forEach(p => { p.ready = false; });
    room.roundScores = {};
    room.inGame      = true;
    room.round++;

    if (room.round === 1) {
        // Reset statistik di awal match baru
        room.players.forEach(p => { p.scores = []; });
        room.matchScore = {};
        room.players.forEach(p => { room.matchScore[p.username] = 0; });
        room.matchOver = false;
        console.log(`🏁 Multi match baru di room ${roomID} (${room.config.rounds} ronde, ${room.players.length} pemain)`);

        // Skema proposal: buat Game_Sessions di awal match, lalu pastikan
        // Player_id semua peserta ter-cache (untuk INSERT Player_Reactions).
        createGameSession(roomID + '_MULTI', 'MULTI').then(sessionId => {
            room.sessionId = sessionId;
            if (!sessionId) return;
            room.players.forEach(p => {
                ensurePlayerId(p.username).then(pid => { p.playerId = pid; });
            });
            // Buat baris Rounds ronde 1
            createRoundRow(sessionId, 1).then(rid => { room.currentRoundId = rid; });
        });
    } else {
        console.log(`➡️  Multi ronde ${room.round} di room ${roomID}`);
        // Buat baris Rounds untuk ronde berikutnya
        createRoundRow(room.sessionId, room.round).then(rid => { room.currentRoundId = rid; });
    }

    io.to(roomID).emit('start_game_multi_nav', {
        maxRounds : room.config.rounds,
        players   : room.players.map(p => ({ username: p.username })),
    });
}

function checkMultiRoundComplete(roomID) {
    const room = multiRooms[roomID];
    if (!room || !room.inGame || room.matchOver) return;
    if (room.players.some(p => room.roundScores[p.username] === undefined)) return;

    room.inGame = false;

    // Hitung pemenang ronde
    const reactions = {};
    room.players.forEach(p => { reactions[p.username] = room.roundScores[p.username]; });

    const validEntries = Object.entries(reactions)
        .filter(([, s]) => s < FALSE_START)
        .sort((a, b) => a[1] - b[1]);

    let winners = [], isDraw = false;
    if (validEntries.length === 0) {
        isDraw  = true;
        winners = room.players.map(p => p.username);
    } else {
        const best = validEntries[0][1];
        winners = validEntries.filter(([, s]) => s === best).map(([n]) => n);
        isDraw  = winners.length > 1;
        if (!isDraw) {
            room.matchScore[winners[0]] = (room.matchScore[winners[0]] || 0) + 1;
        }
    }

    // Simpan ke DB (skema proposal) — capture Round_id lokal
    const roundIdLocal = room.currentRoundId;
    const roundLocal   = room.round;
    room.players.forEach(p => {
        const sc = reactions[p.username];
        let result;
        if (sc >= FALSE_START)             result = 'FALSE_START';
        else if (isDraw)                   result = 'DRAW';
        else if (winners.includes(p.username)) result = 'WIN';
        else                               result = 'LOSE';

        Promise.resolve(p.playerId || ensurePlayerId(p.username)).then(pid => {
            p.playerId = pid;
            insertPlayerReaction(pid, roundIdLocal, sc, result);
            console.log(`✅ DB Multi: ${p.username} R${roundLocal} | ${sc}ms | ${result}`);
        });
    });

    // Cek match selesai
    let matchOver = false, matchWinner = null, isMatchDraw = false;
    if (room.round >= room.config.rounds) {
        matchOver = true;
        const sorted = Object.entries(room.matchScore).sort((a, b) => b[1] - a[1]);
        if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
            isMatchDraw = true;
        } else if (sorted.length > 0) {
            matchWinner = sorted[0][0];
        } else {
            isMatchDraw = true;
        }
    }

    const payload = {
        winner     : winners[0] || null,
        winners,
        isDraw,
        reactions,
        matchScore : { ...room.matchScore },
        roundNum   : room.round,
        matchOver,
        matchWinner,
        isMatchDraw,
        players    : room.players.map(p => {
            const valid = p.scores.filter(s => s < FALSE_START);
            return {
                username : p.username,
                avg      : valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
            };
        }),
    };

    console.log(`🏆 Multi ronde ${room.round}: ${winners[0] || 'SERI'} | ${JSON.stringify(room.matchScore)}`);
    io.to(roomID).emit('round_result_multi', payload);

    room.roundScores = {};
    if (matchOver) {
        room.matchOver = true;
        // Finalisasi baris Game_Sessions sebelum reset (pakai sessionId lokal)
        const finishedRounds = roundLocal;
        const sessionIdLocal = room.sessionId;
        if (matchWinner) {
            Promise.resolve(
                room.players.find(p => p.username === matchWinner)?.playerId ||
                ensurePlayerId(matchWinner)
            ).then(winnerId => finalizeGameSession(sessionIdLocal, winnerId, false, finishedRounds));
        } else {
            finalizeGameSession(sessionIdLocal, null, isMatchDraw, finishedRounds);
        }
        room.round        = 0; // siap match baru
        room.sessionId    = null;
        room.currentRoundId = null;
        console.log(`🎉 Multi match selesai ${roomID}: ${matchWinner || 'SERI'}`);
    }
}

const AI_DIFFICULTY = {
    easy:   { min: 300, max: 400, name: 'Mudah'  },
    medium: { min: 200, max: 280, name: 'Sedang' },
    hard:   { min: 150, max: 210, name: 'Sulit'  },
    pro:    { min: 120, max: 170, name: 'Pro'     },
};

function getAIReactionTime(difficulty) {
    const d = AI_DIFFICULTY[difficulty] || AI_DIFFICULTY.medium;
    return Math.floor(Math.random() * (d.max - d.min) + d.min);
}

function getRoomList() {
    return PRESET_ROOMS.map(pr => {
        const r = rooms[pr.id];
        return {
            id:          pr.id,
            name:        pr.name,
            playerCount: r ? r.players.filter(p => !p.isAI).length : 0,
            maxPlayers:  2,
            status:      r && r.inGame ? 'playing' : 'waiting'
        };
    });
}

function publicPlayers(players) {
    return players.map(p => ({ username: p.username, ready: p.ready, isAI: p.isAI }));
}

function makeRoom(extra = {}) {
    return {
        players:     [],
        inGame:      false,
        vsAI:        false,
        roundScores: {},     // skor ronde berjalan { username: score }
        round:       0,      // ronde yang SUDAH selesai (0 = match belum mulai)
        suddenDeath: false,
        matchOver:   false,
        ...extra
    };
}

function makePlayer({ id, username, isAI = false, ready = false }) {
    return { id, username, ready, isAI, scores: [], wins: 0, losses: 0, lastAvg: 0, lastCons: 0 };
}

// FIX: reset statistik HANYA saat match baru dimulai
function resetMatchTally(room) {
    room.suddenDeath = false;
    room.matchOver   = false;
    room.players.forEach(p => {
        p.scores   = [];
        p.wins     = 0;
        p.losses   = 0;
        p.lastAvg  = 0;
        p.lastCons = 0;
    });
}

function clearMatch(room) {
    room.inGame      = false;
    room.matchOver   = false;
    room.suddenDeath = false;
    room.round       = 0;
    room.roundScores = {};
    room.players.forEach(p => { p.scores = []; p.wins = 0; p.losses = 0; });
}

// FIX: penentu pemenang ronde yang adil — skor sama = seri (bukan menang acak)
function computeRoundOutcome(players, roundScores) {
    let minScore = Infinity;
    players.forEach(p => {
        const s = roundScores[p.username];
        if (typeof s === 'number' && s < FALSE_START && s < minScore) minScore = s;
    });
    if (minScore === Infinity) return { winner: null, losers: [], isDraw: true };

    const winners = players.filter(p => {
        const s = roundScores[p.username];
        return typeof s === 'number' && s < FALSE_START && s === minScore;
    });
    if (winners.length !== 1) return { winner: null, losers: [], isDraw: true };

    const winner = winners[0];
    const losers = players.filter(p => p.username !== winner.username && roundScores[p.username] !== undefined);
    return { winner, losers, isDraw: false };
}

io.on('connection', (socket) => {
    console.log(`🔌 Connect: ${socket.id}`);
    socket.emit('room_list', getRoomList());

    socket.on('get_rooms', () => socket.emit('room_list', getRoomList()));

    // ── JOIN ROOM ──────────────────────────────────────────────────────────────
    socket.on('join_room', ({ username, roomID }) => {
        if (!roomID || !username) return;

        if (!rooms[roomID]) rooms[roomID] = makeRoom();
        const room = rooms[roomID];

        const existing = room.players.find(p => p.username === username && !p.isAI);
        if (existing) {
            existing.id    = socket.id;
            existing.ready = false;
        } else {
            const humanCount = room.players.filter(p => !p.isAI).length;
            if (humanCount >= 2) {
                socket.emit('room_full', { roomID });
                return;
            }
            room.players.push(makePlayer({ id: socket.id, username }));
        }

        socket.join(roomID);
        socket.username = username;
        socket.roomID   = roomID;

        console.log(`👤 ${username} joined room ${roomID} (${room.players.filter(p => !p.isAI).length}/2)`);

        io.to(roomID).emit('room_data', publicPlayers(room.players));
        io.emit('room_list', getRoomList());
    });

    // ── VS AI ──────────────────────────────────────────────────────────────────
    socket.on('join_vs_ai', ({ username, difficulty }) => {
        if (!username) return;
        const roomID = `AI-${socket.id}`;
        const aiName = `🤖 Bot (${AI_DIFFICULTY[difficulty]?.name || 'Sedang'})`;

        rooms[roomID] = makeRoom({ vsAI: true, aiDifficulty: difficulty || 'medium' });

        socket.join(roomID);
        socket.username = username;
        socket.roomID   = roomID;

        rooms[roomID].players.push(
            makePlayer({ id: socket.id, username }),
            makePlayer({ id: 'AI', username: aiName, isAI: true, ready: true })
        );

        socket.emit('room_data', publicPlayers(rooms[roomID].players));
        socket.emit('vs_ai_joined', { roomID, aiName, difficulty });
    });

    // ── CHAT ────────────────────────────────────────────────────────────────────
    socket.on('send_chat', (message) => {
        if (socket.roomID) {
            io.to(socket.roomID).emit('receive_chat', { username: socket.username, message });
        }
    });

    // ── READY ────────────────────────────────────────────────────────────────────
    socket.on('set_ready', () => {
        const room = rooms[socket.roomID];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.ready) return;

        player.ready = true;
        io.to(socket.roomID).emit('room_data', publicPlayers(room.players));

        const humanPlayers  = room.players.filter(p => !p.isAI);
        const allHumanReady = humanPlayers.length >= 2 && humanPlayers.every(p => p.ready);
        const vsAIReady     = room.vsAI && humanPlayers.length >= 1 && humanPlayers.every(p => p.ready);

        if (allHumanReady || vsAIReady) {
            if (room.round === 0) {
                resetMatchTally(room);
                console.log(`🏁 Match baru di room ${socket.roomID} (best of ${MATCH_ROUNDS})`);

                const mode = room.vsAI ? 'VS_AI' : 'PVP';
                createGameSession(socket.roomID, mode).then(sessionId => {
                    room.sessionId = sessionId;
                    if (!sessionId) return;
                    room.players.forEach(p => {
                        if (p.isAI) return;
                        ensurePlayerId(p.username).then(pid => { p.playerId = pid; });
                    });
                    createRoundRow(sessionId, 1).then(rid => { room.currentRoundId = rid; });
                });
            } else {
                console.log(`➡️  Ronde ${room.round + 1} dimulai di room ${socket.roomID}`);
                createRoundRow(room.sessionId, room.round + 1).then(rid => {
                    room.currentRoundId = rid;
                });
            }
            room.inGame      = true;
            room.roundScores = {};
            room.players.forEach(p => { if (!p.isAI) p.ready = false; });
            io.to(socket.roomID).emit('start_game_nav', { maxRounds: MATCH_ROUNDS });
            io.emit('room_list', getRoomList());
        }
    });

    // ── SUBMIT SCORE ────────────────────────────────────────────────────────────
    socket.on('submit_score', ({ score, avg, cons }) => {
        const roomID = socket.roomID;
        const room   = rooms[roomID];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (!room.inGame || room.matchOver) return;
        if (room.roundScores[socket.username] !== undefined) return;

        // FIX: validasi input
        let s = Number(score);
        if (!Number.isFinite(s)) return;
        if (s >= FALSE_START) s = FALSE_START;

        room.roundScores[socket.username] = s;
        player.lastAvg  = Number.isFinite(Number(avg))  ? Number(avg)  : s;
        player.lastCons = Number.isFinite(Number(cons)) ? Number(cons) : 0;
        player.scores.push(s);

        console.log(`📊 Score: ${socket.username} = ${s}ms (ronde ${room.round + 1}) in ${roomID}`);

        // VS AI: generate skor AI saat human submit
        if (room.vsAI) {
            const aiPlayer = room.players.find(p => p.isAI);
            if (aiPlayer && room.roundScores[aiPlayer.username] === undefined) {
                const aiTime = getAIReactionTime(room.aiDifficulty);
                room.roundScores[aiPlayer.username] = aiTime;
                aiPlayer.scores.push(aiTime);
                console.log(`🤖 AI score: ${aiTime}ms`);
            }
        }

        // Tunggu semua human submit
        const humanPlayers = room.players.filter(p => !p.isAI);
        const allSubmitted = humanPlayers.length > 0 &&
                             humanPlayers.every(p => room.roundScores[p.username] !== undefined);
        if (!allSubmitted) {
            console.log(`⏳ Menunggu pemain lain di ${roomID}...`);
            return;
        }

        // ── Hitung hasil ronde ──
        const { winner, losers, isDraw } = computeRoundOutcome(room.players, room.roundScores);
        if (winner) {
            winner.wins++;
            losers.forEach(l => l.losses++);
        }

        room.round++;
        const roundsPlayed = room.round;
        const roundIdLocal = room.currentRoundId; 
        // ── Simpan tiap human ke DB (skema proposal) ──
        humanPlayers.forEach(p => {
            const sc = room.roundScores[p.username];
            let result;
            if (sc === FALSE_START)                            result = 'FALSE_START';
            else if (isDraw)                                   result = 'DRAW';
            else if (winner && p.username === winner.username) result = 'WIN';
            else                                               result = 'LOSE';

            Promise.resolve(p.playerId || ensurePlayerId(p.username)).then(pid => {
                p.playerId = pid;
                insertPlayerReaction(pid, roundIdLocal, sc, result);
                console.log(`✅ DB saved: ${p.username} R${roundsPlayed} | ${sc}ms | ${result}`);
            });
        });

        // ── Skor match ──
        const matchScore = {};
        room.players.forEach(p => { matchScore[p.username] = p.wins; });

        // ── Tentukan match berlanjut atau selesai ──
        const maxWins  = Math.max(...room.players.map(p => p.wins));
        const leaders  = room.players.filter(p => p.wins === maxWins);
        const mainDone = roundsPlayed >= MATCH_ROUNDS;

        let matchOver   = false;
        let matchWinner = null;
        let isMatchDraw = false;

        if (!mainDone) {
            matchOver = false;
        } else if (leaders.length === 1) {
            matchOver   = true;
            matchWinner = leaders[0];
        } else if (MATCH_TIE_MODE === 'draw') {
            matchOver   = true;
            isMatchDraw = true;
        } else {
            // Mode sudden death — lanjut ronde tambahan
            room.suddenDeath = true;
            if (roundsPlayed - MATCH_ROUNDS >= SUDDEN_DEATH_CAP) {
                matchOver   = true;
                isMatchDraw = true;
            } else {
                matchOver = false;
            }
        }

        // ── Kirim hasil ronde ──
        const resultData = {
            winner:      winner ? winner.username : null,
            isDraw,
            scores:      {},
            round:       roundsPlayed,
            maxRounds:   MATCH_ROUNDS,
            suddenDeath: room.suddenDeath,
            matchScore,
            matchOver,
            matchWinner: matchWinner ? matchWinner.username : null,
            isMatchDraw,
            nextRound:   matchOver ? null : roundsPlayed + 1
        };
        room.players.forEach(p => { resultData.scores[p.username] = room.roundScores[p.username] ?? null; });

        console.log(`🏆 Ronde ${roundsPlayed}: ${resultData.winner || 'SERI'} | skor match: ${JSON.stringify(matchScore)}`);
        io.to(roomID).emit('round_result', resultData);

        // ── Transisi ──
        room.roundScores = {};
        if (matchOver) {
            room.inGame    = false;
            room.matchOver = true;
            room.round     = 0; // reset agar match berikutnya mulai bersih
            console.log(`🎉 Match selesai di ${roomID}: ${matchWinner ? matchWinner.username + ' MENANG' : 'SERI'} (${roundsPlayed} ronde)`);

            // Finalisasi Game_Sessions — pakai sessionId lokal
            const sessionIdLocal = room.sessionId;
            if (matchWinner) {
                Promise.resolve(matchWinner.playerId || ensurePlayerId(matchWinner.username)).then(wid => {
                    finalizeGameSession(sessionIdLocal, wid, false, roundsPlayed);
                });
            } else {
                finalizeGameSession(sessionIdLocal, null, isMatchDraw, roundsPlayed);
            }
            room.sessionId      = null;
            room.currentRoundId = null;

            io.to(roomID).emit('match_result', {
                matchWinner: matchWinner ? matchWinner.username : null,
                isMatchDraw,
                matchScore,
                totalRounds: roundsPlayed,
                suddenDeath: room.suddenDeath
            });
        }

        io.emit('room_list', getRoomList());
    });

    // ── MULTI: JOIN ──────────────────────────────────────────────────────────────
    socket.on('join_room_multi', ({ username, roomID }) => {
        if (!roomID || !username) return;
        const room = getMultiRoom(roomID);

        const existing = room.players.find(p => p.username === username);
        if (existing) {
            existing.id    = socket.id;
            existing.ready = false;
        } else {
            if (room.players.length >= room.config.maxPlayers) {
                socket.emit('room_full_multi', { roomID, max: room.config.maxPlayers });
                return;
            }
            room.players.push({ id: socket.id, username, ready: false, scores: [], lastAvg: 0, lastCons: 0 });
            if (room.matchScore[username] == null) room.matchScore[username] = 0;
        }

        socket.join(roomID);
        socket.multiRoomID = roomID;
        socket.username    = socket.username || username;

        // Assign host ke pemain pertama
        if (!room.hostID) {
            room.hostID = socket.id;
            socket.emit('you_are_host');
        } else if (room.hostID === socket.id) {
            socket.emit('you_are_host');
        } else {
            socket.emit('not_host');
        }

        console.log(`👥 ${username} joined multi room ${roomID} (${room.players.length}/${room.config.maxPlayers})`);
        broadcastMultiRoom(roomID);
    });

    // ── MULTI: CONFIG (host only) ─────────────────────────────────────────────
    socket.on('update_room_config', (cfg) => {
        const roomID = socket.multiRoomID;
        if (!roomID) return;
        const room = multiRooms[roomID];
        if (!room || room.hostID !== socket.id) return;
        room.config = { ...room.config, ...cfg };
        io.to(roomID).emit('room_config_updated', room.config);
        broadcastMultiRoom(roomID);
        console.log(`⚙️  Multi room ${roomID} config updated:`, room.config);
    });

    // ── MULTI: READY ──────────────────────────────────────────────────────────
    socket.on('set_ready_multi', ({ phase } = {}) => {
        const roomID = socket.multiRoomID;
        if (!roomID) return;
        const room = multiRooms[roomID];
        if (!room) return;

       
        if (room.inGame) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.ready) return;
        player.ready = true;
        broadcastMultiRoom(roomID);

        if (room.players.length < room.config.minPlayers) return;
        if (!room.players.every(p => p.ready)) return;

        if (phase === 'game') {

            startMultiRound(roomID);
        } else {
            room.players.forEach(p => { p.ready = false; });
            io.to(roomID).emit('start_game_multi_nav', {
                maxRounds: room.config.rounds,
                players  : room.players.map(p => ({ username: p.username })),
            });
            console.log(`🚪 Multi room ${roomID}: semua siap di lobby → navigasi ke game`);
        }
    });

    // ── MULTI: SUBMIT SCORE ────────────────────────────────────────────────────
    socket.on('submit_score_multi', ({ score, avg, cons }) => {
        const roomID = socket.multiRoomID;
        if (!roomID) return;
        const room = multiRooms[roomID];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        if (room.roundScores[player.username] !== undefined) return;
        let s = Number(score);
        if (!Number.isFinite(s)) return;
        if (s >= FALSE_START) s = FALSE_START;

        room.roundScores[player.username] = s;
        player.scores.push(s);
        player.lastAvg  = Number.isFinite(Number(avg))  ? Number(avg)  : s;
        player.lastCons = Number.isFinite(Number(cons)) ? Number(cons) : 0;

        console.log(`📊 Multi score: ${player.username} = ${s}ms (ronde ${room.round}) in ${roomID}`);
        checkMultiRoundComplete(roomID);
    });

    // ── MULTI: CHAT ───────────────────────────────────────────────────────────
    socket.on('send_chat_multi', (message) => {
        if (socket.multiRoomID) {
            io.to(socket.multiRoomID).emit('receive_chat_multi', {
                username: socket.username,
                message,
            });
        }
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`🔌 Disconnect: ${socket.id} (${socket.username})`);

        // ── PvP cleanup (tidak berubah) ──
        const roomID = socket.roomID;
        if (roomID && rooms[roomID]) {
            const room = rooms[roomID];
            room.players = room.players.filter(p => p.id !== socket.id);
            clearMatch(room);
            io.to(roomID).emit('room_data', publicPlayers(room.players));
            io.to(roomID).emit('opponent_left', { username: socket.username });
            if (room.players.filter(p => !p.isAI).length === 0) {
                delete rooms[roomID];
                console.log(`🗑️  Room ${roomID} deleted (empty)`);
            }
            io.emit('room_list', getRoomList());
        }

        // ── Multi cleanup ──
        const multiRoomID = socket.multiRoomID;
        if (multiRoomID && multiRooms[multiRoomID]) {
            const room = multiRooms[multiRoomID];
            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                delete multiRooms[multiRoomID];
                console.log(`🗑️  Multi room ${multiRoomID} deleted (empty)`);
            } else {
                if (room.hostID === socket.id) {
                    room.hostID = room.players[0].id;
                    io.to(room.hostID).emit('you_are_host');
                    console.log(`👑 Host multi room ${multiRoomID} pindah ke ${room.players[0].username}`);
                }
                broadcastMultiRoom(multiRoomID);
                io.to(multiRoomID).emit('player_left_multi', { username: socket.username });
                checkMultiRoundComplete(multiRoomID);
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
