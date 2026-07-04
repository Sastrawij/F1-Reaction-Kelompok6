const socket    = io();
const myName    = localStorage.getItem('f1_name');
const myRoomID  = localStorage.getItem('f1_room');

const FALSE_START_CLIENT = 99999;
let MATCH_ROUNDS_CLIENT  = parseInt(localStorage.getItem('f1_multi_rounds') || '5');

let startTime    = null;
let myScores     = [];
let winCount     = 0;
let totalRounds  = 0;
let gameActive   = false;
let lightsOn     = false;
let falseStartDone = false;
let matchEnded   = false;
let popupTimer   = null;

// Skor semua pemain (win count per name)
let allScores    = {};
let lastReactions = {};  // reaksi terakhir per player

if (!myName || !myRoomID) { window.location.href = 'index.html'; }

// Re-join room setelah navigasi dari waiting_multi
socket.emit('join_room_multi', { username: myName, roomID: myRoomID });

// ── AUDIO ──
function playBeep(freq, duration) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (e) {}
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.innerText = val;
}

function formatMs(ms) {
    if (ms == null) return '-';
    if (ms >= FALSE_START_CLIENT) return 'F/S';
    return Math.round(ms) + 'ms';
}

// ── SCOREBOARD ─────────────────────────────────────────────────────────────
function renderScoreboard(players, matchScore) {
    const tbody = document.getElementById('scoreboard-body');
    if (!tbody || !players) return;

   
    const sorted = [...players].sort((a, b) => {
        const wa = matchScore[a.username] || 0;
        const wb = matchScore[b.username] || 0;
        if (wb !== wa) return wb - wa;
        const la = lastReactions[a.username] || 999999;
        const lb = lastReactions[b.username] || 999999;
        return la - lb;
    });

    const maxWins = Math.max(...sorted.map(p => matchScore[p.username] || 0), 1);
    const medals  = ['🥇','🥈','🥉'];

    tbody.innerHTML = sorted.map((p, idx) => {
        const wins    = matchScore[p.username] || 0;
        const last    = lastReactions[p.username];
        const isMe    = p.username === myName;
        const barPct  = (wins / maxWins) * 100;
        const rankIcon = idx < 3 ? medals[idx] : (idx + 1);
        return `
            <tr style="${isMe ? 'background:rgba(0,255,102,0.07);' : ''}">
                <td class="pos-medal">${rankIcon}</td>
                <td style="color:${isMe ? '#00ff66' : '#fff'}; font-weight:${isMe ? 'bold' : 'normal'};">
                    ${p.username}${isMe ? '<span style="font-size:9px;color:#555;"> YOU</span>' : ''}
                </td>
                <td style="text-align:right; color:#e10600; font-weight:bold;">
                    ${wins}
                    <span class="score-bar-wrap"><span class="score-bar-fill" style="width:${barPct}%;"></span></span>
                </td>
                <td style="text-align:right; color:${last && last < 200 ? '#00ff66' : last && last < 300 ? '#ffd000' : '#aaa'}; font-size:11px;">
                    ${formatMs(last)}
                </td>
            </tr>
        `;
    }).join('');

    // Update ready count
    const readyCount = players.filter(p => p.ready).length;
    setText('rd-count', readyCount);
    setText('rd-total', players.length);
    setText('active-player-count', players.length);
}

// ── SOCKET EVENTS ──────────────────────────────────────────────────────────
socket.on('room_data_multi', ({ players, config }) => {
    if (config && config.rounds) MATCH_ROUNDS_CLIENT = config.rounds;

    // Inisialisasi allScores
    players.forEach(p => {
        if (allScores[p.username] == null) allScores[p.username] = 0;
    });

    // Update match score display (jika tersedia)
    renderScoreboard(players, allScores);

    // Update ready button
    const btn = document.getElementById('btn-game-ready');
    if (btn && !matchEnded) {
        const readyCount = players.filter(p => p.ready).length;
        setText('rd-count', readyCount);
        setText('rd-total', players.length);
    }
});

socket.on('room_full_multi', ({ roomID, max }) => {
    alert(`❌ Room "${roomID}" sudah penuh (${max}/${max}).`);
    window.location.href = 'index.html';
});

socket.on('player_left_multi', ({ username }) => {
    const statusEl = document.getElementById('game-status');
    if (statusEl && !matchEnded) {
        statusEl.innerText = `⚠️ ${username} keluar`;
        statusEl.style.color = '#ff6600';
        setTimeout(() => {
            statusEl.innerText = 'SIAP...';
            statusEl.style.color = '';
        }, 3000);
    }
});

socket.on('receive_chat_multi', ({ username, message }) => {
    appendChat(username, message, username === myName ? '#00ff66' : '#fff');
});

socket.on('room_config_updated', (cfg) => {
    if (cfg.rounds) MATCH_ROUNDS_CLIENT = cfg.rounds;
    renderRoundLabel(totalRounds + 1);
});

// ── GAME START (dari waiting ke game) ──────────────────────────────────────
socket.on('start_game_multi_nav', (info) => {
    if (info && info.maxRounds) MATCH_ROUNDS_CLIENT = info.maxRounds;
    localStorage.setItem('f1_multi_rounds', MATCH_ROUNDS_CLIENT);
    
    if (window.location.pathname.includes('waiting_multi')) {
        window.location.href = 'game_multi.html';
        return;
    }
    
    if (window.location.pathname.includes('game_multi')) {
        startSequence();
    }
});

// ── READY ──────────────────────────────────────────────────────────────────
function sendReadyMulti() {
    if (matchEnded) return;
    socket.emit('set_ready_multi', { phase: 'game' });
    const btn = document.getElementById('btn-game-ready');
    if (btn) { btn.disabled = true; btn.innerText = 'WAITING...'; }
}

// ── ROUND LABEL ────────────────────────────────────────────────────────────
function renderRoundLabel(roundNum) {
    const label = document.getElementById('round-label');
    if (!label) return;
    label.innerHTML = `RONDE: <span id="current-round-text" style="color:#fff;">${roundNum}</span>/${MATCH_ROUNDS_CLIENT}`;
}

// ── LIGHTS SEQUENCE ────────────────────────────────────────────────────────
function startSequence() {
    gameActive = false; lightsOn = false; falseStartDone = false; startTime = null;
    closeRoundPopup();

    const statusEl = document.getElementById('game-status');
    if (statusEl) { statusEl.innerText = 'WATCH THE LIGHTS'; statusEl.style.color = ''; }
    document.querySelectorAll('.bulb').forEach(b => { b.classList.remove('red'); b.style.background = ''; b.style.boxShadow = ''; });

    renderRoundLabel(totalRounds + 1);

    let i = 1;
    const interval = setInterval(() => {
        if (i === 1) lightsOn = true;
        const unit = document.getElementById(`l${i}`);
        if (unit) {
            unit.querySelectorAll('.bulb').forEach(b => b.classList.add('red'));
            playBeep(440, 0.1);
        }
        i++;
        if (i > 5) {
            clearInterval(interval);
            const delay = Math.random() * 3000 + 1000;
            setTimeout(() => {
                if (falseStartDone) return;
                lightsOn = false;
                document.querySelectorAll('.bulb').forEach(b => b.classList.remove('red'));
                if (statusEl) statusEl.innerText = 'GO!';
                playBeep(880, 0.4);
                startTime = performance.now();
                gameActive = true;
            }, delay);
        }
    }, 1000);
}

// ── REAKSI ─────────────────────────────────────────────────────────────────
document.addEventListener('mousedown',  handleReaction);
document.addEventListener('touchstart', handleReaction, { passive: true });

function handleReaction(e) {
    if (!window.location.pathname.includes('game_multi')) return;
    if (matchEnded) return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;

    if (lightsOn && !falseStartDone && !gameActive) {
        falseStartDone = true;
        lightsOn = false;
        myScores.push(FALSE_START_CLIENT);
        totalRounds++;

        const statusEl = document.getElementById('game-status');
        if (statusEl) { statusEl.innerText = '🚨 FALSE START!'; statusEl.style.color = '#ff0000'; }

        document.querySelectorAll('.bulb').forEach(b => {
            b.style.background = 'radial-gradient(circle, #ff6600, #883300)';
            b.style.boxShadow  = '0 0 30px #ff6600';
        });
        setTimeout(() => document.querySelectorAll('.bulb').forEach(b => {
            b.style.background = ''; b.style.boxShadow = ''; b.classList.remove('red');
        }), 800);

        const avg = myScores.reduce((a, b) => a + b, 0) / myScores.length;
        const cons = myScores.length > 1 ? Math.max(...myScores) - Math.min(...myScores) : 0;
        lastReactions[myName] = FALSE_START_CLIENT;
        socket.emit('submit_score_multi', { score: FALSE_START_CLIENT, avg, cons });
        return;
    }

    if (!gameActive || !startTime) return;

    const react = performance.now() - startTime;
    startTime = null;
    gameActive = false;
    myScores.push(react);
    totalRounds++;
    lastReactions[myName] = react;

    const avg  = myScores.reduce((a, b) => a + b, 0) / myScores.length;
    const cons = myScores.length > 1 ? Math.max(...myScores) - Math.min(...myScores) : 0;

    const statusEl = document.getElementById('game-status');
    if (statusEl) statusEl.innerText = `${react.toFixed(0)}ms — Menunggu lawan...`;

    updateMyStats(react, avg, cons);
    socket.emit('submit_score_multi', { score: react, avg, cons });
}

// ── MY STATS ───────────────────────────────────────────────────────────────
function updateMyStats(lastReact, avg, cons) {
    const wr = totalRounds > 0 ? ((winCount / totalRounds) * 100).toFixed(0) : 0;
    setText('st-re', formatMs(lastReact));
    setText('st-wr', `${wr}%`);
    setText('st-av', avg >= FALSE_START_CLIENT ? 'F/S' : `${avg.toFixed(0)}ms`);
    setText('st-cs', `${cons.toFixed(0)}ms`);

    // Save ke history
    let h = JSON.parse(localStorage.getItem('f1_history')) || [];
    h.push({ name: myName, score: lastReact, avg, cons, time: new Date().toLocaleTimeString() });
    localStorage.setItem('f1_history', JSON.stringify(h));
}

// ── ROUND RESULT ───────────────────────────────────────────────────────────
socket.on('round_result_multi', (data) => {
   
    if (data.matchScore) allScores = { ...data.matchScore };
    if (data.reactions)  lastReactions = { ...data.reactions };

    const wonRound = Array.isArray(data.winners)
        ? data.winners.includes(myName)
        : data.winner === myName;
    if (wonRound) winCount++;

    setText('st-wr', totalRounds > 0 ? `${((winCount / totalRounds) * 100).toFixed(0)}%` : '0%');

    // Render scoreboard
    if (data.players) renderScoreboard(data.players, allScores);

    // Status text
    const statusEl = document.getElementById('game-status');
    if (statusEl) {
        if (wonRound) {
            statusEl.innerText = '🏆 RONDE INI MENANG!';
            statusEl.style.color = '#00ff66';
        } else if (data.isDraw) {
            statusEl.innerText = '🤝 RONDE SERI';
            statusEl.style.color = '#ffd000';
        } else {
            const wName = Array.isArray(data.winners) ? data.winners[0] : data.winner;
            statusEl.innerText = `❌ ${wName} menang ronde ini`;
            statusEl.style.color = '#e10600';
        }
    }

    if (data.matchOver) {
        matchEnded = true;
        showMatchResultMulti(data);
        lockBtn();
    } else {
        showRoundResultMulti(data, wonRound);
        enableNextRoundBtn();
    }
});

// ── ROUND POPUP ────────────────────────────────────────────────────────────
function showRoundResultMulti(data, wonRound) {
    const popup  = document.getElementById('result-popup');
    const title  = document.getElementById('res-title');
    const detail = document.getElementById('res-detail');
    const scoresList = document.getElementById('res-scores-list');
    if (!popup || !title) return;

    if (wonRound) {
        title.innerText = '🏆 RONDE WIN!'; title.style.color = '#00ff66';
        detail.innerText = 'Kamu tercepat ronde ini!';
    } else if (data.isDraw) {
        title.innerText = '🤝 DRAW!'; title.style.color = '#ffd000';
        detail.innerText = 'Waktu reaksi sama!';
    } else {
        title.innerText = '❌ RONDE KALAH'; title.style.color = '#e10600';
        const wName = Array.isArray(data.winners) ? data.winners[0] : data.winner;
        detail.innerText = `${wName} lebih cepat ronde ini.`;
    }
    title.style.fontSize = '42px';

    if (scoresList && data.reactions) {
        const sorted = Object.entries(data.reactions).sort((a, b) => a[1] - b[1]);
        const medals = ['🥇','🥈','🥉'];
        scoresList.innerHTML = sorted.map(([name, ms], idx) => {
            const isMe    = name === myName;
            const icon    = idx < 3 ? medals[idx] : (idx + 1);
            const color   = ms >= FALSE_START_CLIENT ? '#ff6600' : ms < 200 ? '#00ff66' : ms < 300 ? '#ffd000' : '#aaa';
            return `
                <div style="display:flex; justify-content:space-between; padding:5px 8px; border-bottom:1px solid #1a1a1a; font-size:13px; ${isMe ? 'background:rgba(0,255,102,0.06);border-radius:4px;' : ''}">
                    <span>${icon} <span style="color:${isMe ? '#00ff66' : '#fff'}">${name}</span></span>
                    <span style="color:${color}; font-weight:bold;">${formatMs(ms)}</span>
                </div>
            `;
        }).join('');
    }

    popup.classList.remove('hidden');
    clearTimeout(popupTimer);
    popupTimer = setTimeout(closeRoundPopup, 4000);
}

function closeRoundPopup() {
    const popup = document.getElementById('result-popup');
    if (popup) popup.classList.add('hidden');
}

// ── MATCH END POPUP ────────────────────────────────────────────────────────
function showMatchResultMulti(data) {
    const popup = document.getElementById('result-popup-multi');
    const title = document.getElementById('multi-res-title');
    const sub   = document.getElementById('multi-res-sub');
    if (!popup || !title) return;
    clearTimeout(popupTimer);
    closeRoundPopup();

    const matchScore = data.matchScore || allScores;
    const mWinner    = data.matchWinner;

    if (mWinner === myName) {
        title.innerText = '🏆 KAMU MENANG!';
        title.style.color = '#00ff66';
    } else if (data.isMatchDraw) {
        title.innerText = '🤝 MATCH SERI';
        title.style.color = '#ffd000';
    } else {
        title.innerText = `❌ MATCH KALAH`;
        title.style.color = '#e10600';
    }

    // Sub text
    if (sub) {
        if (mWinner && mWinner !== myName) {
            sub.innerText = `${mWinner} adalah juara match ini!`;
        } else if (data.isMatchDraw) {
            sub.innerText = 'Tidak ada pemenang — semua skor sama.';
        } else {
            sub.innerText = 'Performa terbaikmu! 🎉';
        }
    }

    // Podium
    const podiumEl = document.getElementById('podium-list');
    if (podiumEl && data.players) {
        const sorted = [...data.players].sort((a, b) => (matchScore[b.username] || 0) - (matchScore[a.username] || 0));
        const medals = ['🥇','🥈','🥉'];
        podiumEl.innerHTML = sorted.map((p, idx) => {
            const isMe    = p.username === myName;
            const icon    = idx < 3 ? medals[idx] : (idx + 1);
            const wins    = matchScore[p.username] || 0;
            const avgRaw  = p.avg || null;
            return `
                <div class="podium-entry ${isMe ? 'me' : ''}">
                    <span class="podium-pos">${icon}</span>
                    <span class="podium-name" style="color:${isMe ? '#00ff66' : '#fff'}">${p.username}${isMe ? ' <small style="color:#555;">(YOU)</small>' : ''}</span>
                    <span class="podium-wins">${wins} WIN${wins !== 1 ? 'S' : ''}</span>
                    <span class="podium-avg">${avgRaw ? avgRaw.toFixed(0) + 'ms' : '-'}</span>
                </div>
            `;
        }).join('');
    }

    // My final stats
    const valid    = myScores.filter(s => s !== FALSE_START_CLIENT);
    const finalAvg = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length) : 0;
    const finalCons= valid.length > 1 ? (Math.max(...valid) - Math.min(...valid)) : 0;

    // Rank
    const allSorted = data.players
        ? [...data.players].sort((a, b) => (matchScore[b.username] || 0) - (matchScore[a.username] || 0))
        : [];
    const myRank = allSorted.findIndex(p => p.username === myName) + 1 || '-';
    const total  = allSorted.length;

    setText('mf-wins', winCount);
    setText('mf-avg',  finalAvg ? finalAvg.toFixed(1) + 'ms' : 'N/A');
    setText('mf-cons', finalCons ? finalCons.toFixed(0) + 'ms' : '0ms');
    setText('mf-rank', myRank ? `P${myRank} dari ${total}` : '-');

    popup.classList.remove('hidden');
}

// ── BUTTON CONTROLS ────────────────────────────────────────────────────────
function lockBtn() {
    const btn = document.getElementById('btn-game-ready');
    if (btn) { btn.disabled = true; btn.innerText = 'MATCH SELESAI'; btn.onclick = null; }
}

function enableNextRoundBtn() {
    const btn = document.getElementById('btn-game-ready');
    setTimeout(() => {
        if (matchEnded) return;
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'READY RONDE BERIKUTNYA';
            btn.onclick   = sendReadyMulti;
        }
        const statusEl = document.getElementById('game-status');
        if (statusEl) { statusEl.innerText = 'SIAP...'; statusEl.style.color = ''; }
    }, 2500);
}

// ── CHAT ───────────────────────────────────────────────────────────────────
function sendChat() {
    const input = document.getElementById('chat-input');
    if (input && input.value.trim()) {
        socket.emit('send_chat_multi', input.value.trim());
        input.value = '';
    }
}

function appendChat(username, message, color = '#fff') {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.style.cssText = `margin:4px 0; color:${color}`;
    div.innerHTML = `<b>${username}:</b> ${message}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}
