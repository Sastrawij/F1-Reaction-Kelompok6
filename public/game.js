const socket = io();
const myName   = localStorage.getItem('f1_name');
const myRoomID = localStorage.getItem('f1_room');

const FALSE_START_CLIENT = 99999;
let MATCH_ROUNDS_CLIENT  = 5;

let startTime = null, myScores = [], winCount = 0, totalRounds = 0;
let gameActive = false, lightsOn = false, falseStartDone = false;

let matchEnded        = false;
let clientSuddenDeath = false;
let popupTimer        = null;

if (myName && myRoomID) {
    socket.emit('join_room', { username: myName, roomID: myRoomID });
} else {
    window.location.href = 'index.html';
}

const isWaiting = window.location.pathname.includes('waiting.html');
const isGame    = window.location.pathname.includes('game.html');

if (isWaiting) {
    const roomDisplay = document.getElementById('display-room');
    if (roomDisplay) roomDisplay.innerText = myRoomID;
}

// ── AUDIO ────────────────────────────────────────────────────────────────────
function playBeep(freq, duration) {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + duration);
    } catch (e) {
        console.log("Audio ditangguhkan:", e);
    }
}

// ── EVENTS ───────────────────────────────────────────────────────────────────
socket.on('room_full', ({ roomID }) => {
    alert(`❌ Room "${roomID}" sudah penuh (2/2). Coba room lain.`);
    window.location.href = 'index.html';
});

socket.on('opponent_left', ({ username }) => {
    const statusEl = document.getElementById('game-status');
    if (statusEl) {
        statusEl.innerText = `⚠️ ${username} keluar dari room`;
        statusEl.style.color = '#ff6600';
    }
    const btn = document.getElementById('btn-game-ready') || document.getElementById('btn-ready');
    if (btn && !matchEnded) {
        setTimeout(() => {
            btn.disabled = false;
            btn.innerText = 'READY (0/2)';
            if (statusEl) { statusEl.innerText = 'SIAP...'; statusEl.style.color = ''; }
        }, 3000);
    }
    appendChat('⚠️ SISTEM', `${username} meninggalkan room`, '#ff6600');
});

function sendChat() {
    const input = document.getElementById('chat-input');
    if (input && input.value.trim()) {
        socket.emit('send_chat', input.value.trim());
        input.value = '';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
});

socket.on('receive_chat', ({ username, message }) => {
    appendChat(username, message, username === myName ? '#00ff00' : '#fff');
});

function appendChat(username, message, color = '#fff') {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.style.cssText = `margin:4px 0; color:${color}`;
    div.innerHTML = `<b>${username}:</b> ${message}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

socket.on('room_data', (players) => {
    const listEl = document.getElementById('list-users');
    if (listEl) {
        listEl.innerHTML = players.map(p => `
            <div style="padding:6px 0; border-bottom:1px solid #333; display:flex; justify-content:space-between; border-radius:4px;">
                <span>${p.username === myName ? '👤 ' + p.username + ' (You)' : p.username}</span>
                <span style="color:${p.ready ? '#00ff00' : '#aaa'}">${p.ready ? 'READY ✅' : 'WAITING...'}</span>
            </div>
        `).join('');
    }

    const psGame = document.getElementById('ps-game');
    if (psGame) {
        psGame.innerHTML = players.map(p =>
            `<div>${p.username === myName ? '▶ ' : ''}${p.username}: ${p.ready ? 'READY ✅' : 'WAITING...'}</div>`
        ).join('');
    }

    const rdCount = document.getElementById('rd-count');
    if (rdCount) rdCount.innerText = players.filter(p => p.ready).length;

    const countEl = document.getElementById('player-count');
    if (countEl) {
        const human = players.filter(p => !p.isAI).length;
        countEl.innerText = `${human}/2`;
        countEl.style.color = human >= 2 ? '#00ff00' : '#aaa';
    }
});

function sendReady() {
    if (matchEnded) return;
    socket.emit('set_ready');
    const btn = document.getElementById('btn-ready') || document.getElementById('btn-game-ready');
    if (btn) { btn.disabled = true; btn.innerText = 'WAITING...'; }
}

socket.on('start_game_nav', (info) => {
    if (info && info.maxRounds) MATCH_ROUNDS_CLIENT = info.maxRounds;
    if (isWaiting) {
        window.location.href = 'game.html';
    } else if (isGame) {
        startSequence();
    }
});

// ── UI HELPERS ──────────────────────────────────────────────────────────────
function renderRoundLabel(roundNum) {
    const label = document.getElementById('round-label');
    if (!label) return;
    if (clientSuddenDeath || roundNum > MATCH_ROUNDS_CLIENT) {
        label.innerHTML = `<span style="color:#ffd000;">⚡ SUDDEN DEATH</span> — RONDE <span id="current-round-text" style="color:#fff;">${roundNum}</span>`;
    } else {
        label.innerHTML = `RONDE: <span id="current-round-text" style="color:#fff;">${roundNum}</span>/${MATCH_ROUNDS_CLIENT}`;
    }
}

function renderMatchScore(matchScore) {
    const el = document.getElementById('match-score');
    if (!el || !matchScore) return;
    const oppName = Object.keys(matchScore).find(n => n !== myName);
    const mine = matchScore[myName] != null ? matchScore[myName] : 0;
    const opp  = oppName != null ? matchScore[oppName] : 0;
    el.innerHTML = `<span style="color:#00ff66;">${myName}: ${mine}</span> &nbsp;-&nbsp; <span style="color:#e10600;">${opp} :${oppName || 'Lawan'}</span>`;
}

// ── LIGHTS SEQUENCE ─────────────────────────────────────────────────────────
function startSequence() {
    gameActive = false; lightsOn = false; falseStartDone = false; startTime = null;
    closePopup();

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

// ── REAKSI ──────────────────────────────────────────────────────────────────
document.addEventListener('mousedown',  handleReaction);
document.addEventListener('touchstart', handleReaction, { passive: true });

function handleReaction(e) {
    if (!isGame || matchEnded) return;
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (lightsOn && !falseStartDone && !gameActive) {
        falseStartDone = true;
        lightsOn = false;
        myScores.push(FALSE_START_CLIENT);
        totalRounds++;

        document.getElementById('game-status').innerText = '🚨 FALSE START! LANGSUNG KALAH!';
        document.getElementById('game-status').style.color = '#ff0000';

        document.querySelectorAll('.bulb').forEach(b => {
            b.style.background = 'radial-gradient(circle, #ff6600, #883300)';
            b.style.boxShadow  = '0 0 30px #ff6600';
        });
        setTimeout(() => document.querySelectorAll('.bulb').forEach(b => {
            b.style.background = ''; b.style.boxShadow = ''; b.classList.remove('red');
        }), 800);

        const avg = myScores.reduce((a, b) => a + b, 0) / myScores.length;
        const consistency = myScores.length > 1 ? Math.max(...myScores) - Math.min(...myScores) : 0;

        calculatePerformance(FALSE_START_CLIENT, avg, consistency);
        socket.emit('submit_score', { score: FALSE_START_CLIENT, avg, cons: consistency });
        return;
    }

    if (!gameActive || !startTime) return;

    const react = performance.now() - startTime;
    startTime = null;
    gameActive = false;
    myScores.push(react);
    totalRounds++;

    const avg = myScores.reduce((a, b) => a + b, 0) / myScores.length;
    const consistency = myScores.length > 1 ? Math.max(...myScores) - Math.min(...myScores) : 0;

    document.getElementById('game-status').innerText = `${react.toFixed(0)}ms — Menunggu lawan...`;
    calculatePerformance(react, avg, consistency);
    socket.emit('submit_score', { score: react, avg, cons: consistency });
}

// ── PERFORMANCE ─────────────────────────────────────────────────────────────
function calculatePerformance(lastReact, avg, consistency) {
    let improvement = 'N/A';
    if (myScores.length > 1) {
        const prev = myScores[myScores.length - 2];
        if (prev !== FALSE_START_CLIENT && lastReact !== FALSE_START_CLIENT) {
            const diff = prev - lastReact;
            improvement = diff > 0 ? `+${diff.toFixed(0)}ms Faster` : `${Math.abs(diff).toFixed(0)}ms Slower`;
        }
    }
    let change5 = 'Need 5 rounds...';
    if (myScores.length >= 5) {
        const validScores = myScores.filter(s => s !== FALSE_START_CLIENT);
        if (validScores.length >= 2) {
            const pct = ((validScores[0] - validScores[validScores.length - 1]) / validScores[0]) * 100;
            change5 = `${pct.toFixed(1)}% ${pct > 0 ? 'Improvement' : 'Decline'}`;
        } else {
            change5 = 'Inconclusive';
        }
    }
    const displayReact = lastReact >= FALSE_START_CLIENT ? 'F/S' : `${lastReact.toFixed(0)}ms`;
    const displayAvg = avg >= FALSE_START_CLIENT ? 'F/S' : `${avg.toFixed(0)}ms`;
    const wr = totalRounds > 0 ? ((winCount / totalRounds) * 100).toFixed(0) : 0;

    setText('st-re', displayReact);
    setText('st-wr', `${wr}%`);
    setText('st-av', displayAvg);
    setText('st-cs', `${consistency.toFixed(0)}ms`);
    setText('st-im', improvement);
    setText('st-ch', change5);
    saveToHistory(lastReact, avg, consistency);
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.innerText = val; }

function saveToHistory(score, avg, cons) {
    let h = JSON.parse(localStorage.getItem('f1_history')) || [];
    h.push({ name: myName, score, avg, cons, time: new Date().toLocaleTimeString() });
    localStorage.setItem('f1_history', JSON.stringify(h));
}

// ── POPUP HELPERS ───────────────────────────────────────────────────────────
function closePopup() {
    const popup = document.getElementById('result-popup');
    if (popup) popup.classList.add('hidden');
}

function formatScores(scores) {
    if (!scores || !Object.keys(scores).length) return '';
    return Object.entries(scores)
        .map(([n, ms]) => `${n}: ${ms == null ? '-' : (ms >= FALSE_START_CLIENT ? 'FALSE START' : Math.round(ms) + 'ms')}`)
        .join('  ·  ');
}

// ── ROUND RESULT (server -> client) ────
socket.on('round_result', (data) => {
    if (data.winner === myName) winCount++;
    clientSuddenDeath = !!data.suddenDeath;

    renderMatchScore(data.matchScore);

    const statusEl = document.getElementById('game-status');
    if (statusEl) {
        const won = data.winner === myName;
        statusEl.innerText   = won ? '🏆 RONDE INI MENANG!' : (data.isDraw ? '🤝 RONDE SERI' : `❌ ${data.winner} menang ronde ini`);
        statusEl.style.color = won ? '#00ff66' : (data.isDraw ? '#ffd000' : '#e10600');
    }
    setText('st-wr', totalRounds > 0 ? `${((winCount / totalRounds) * 100).toFixed(0)}%` : '0%');

    if (data.matchOver) {
        matchEnded = true;
        showMatchResult(data);
        lockReadyButton();
    } else {
        showRoundResult(data);
        enableNextRoundButton(data);
    }
});

// Popup hasil per-ronde (auto-close)
function showRoundResult(data) {
    const popup    = document.getElementById('result-popup');
    const title    = document.getElementById('res-title');
    const detail   = document.getElementById('res-detail');
    const finalBox = document.getElementById('final-stats-box');
    const btn      = document.getElementById('btn-popup-action');
    if (!popup || !title || !detail) return;
    if (finalBox) finalBox.classList.add('hidden');

    const myScore   = data.scores ? data.scores[myName] : null;
    const won       = data.winner === myName;
    const scoreLine = formatScores(data.scores);

    if (myScore === FALSE_START_CLIENT && !won && !data.isDraw) {
        title.innerText = '🚨 FALSE START!'; title.style.color = '#ff6600';
        detail.innerText = 'Kamu klik saat lampu masih merah — kalah ronde ini.';
    } else if (data.isDraw) {
        title.innerText = '🤝 DRAW!'; title.style.color = '#ffd000';
        detail.innerText = scoreLine || 'Waktu reaksi sama!';
    } else if (won) {
        title.innerText = '🏆 RONDE WIN!'; title.style.color = '#00ff66';
        detail.innerText = scoreLine || 'Kamu tercepat ronde ini!';
    } else {
        title.innerText = '❌ RONDE LOSE'; title.style.color = '#e10600';
        detail.innerText = scoreLine || `${data.winner} lebih cepat ronde ini.`;
    }
    title.style.fontSize = '50px';

    if (btn) { btn.innerText = 'TUTUP'; btn.onclick = closePopup; }
    popup.classList.remove('hidden');
    clearTimeout(popupTimer);
    popupTimer = setTimeout(closePopup, 3000);
}

// Popup MATCH WINNER (akhir 5 ronde / sudden death) — manual close
function showMatchResult(data) {
    const popup    = document.getElementById('result-popup');
    const title    = document.getElementById('res-title');
    const detail   = document.getElementById('res-detail');
    const finalBox = document.getElementById('final-stats-box');
    const btn      = document.getElementById('btn-popup-action');
    if (!popup || !title || !detail) return;
    clearTimeout(popupTimer);

    const ms      = data.matchScore || {};
    const oppName = Object.keys(ms).find(n => n !== myName);
    const myWins  = ms[myName] != null ? ms[myName] : winCount;
    const oppWins = oppName != null ? ms[oppName] : 0;
    const sd      = data.suddenDeath ? ' (sudden death)' : '';

    if (data.isMatchDraw) {
        title.innerText  = '🤝 MATCH SERI'; title.style.color = '#ffd000';
        detail.innerText = `Skor akhir ${myWins} - ${oppWins}. Tidak ada pemenang.`;
    } else if (data.matchWinner === myName) {
        title.innerText  = '🏆 MATCH MENANG!'; title.style.color = '#00ff66';
        detail.innerText = `Kamu menang ${myWins} - ${oppWins}${sd}! 🎉`;
    } else {
        title.innerText  = '❌ MATCH KALAH'; title.style.color = '#e10600';
        detail.innerText = `${data.matchWinner} menang ${oppWins} - ${myWins}${sd}.`;
    }
    title.style.fontSize = '46px';

    // Rekap 5 ronde
    const valid = myScores.filter(s => s !== FALSE_START_CLIENT);
    const finalAvg  = valid.length ? (valid.reduce((a, b) => a + b, 0) / valid.length) : 0;
    const finalCons = valid.length > 1 ? (Math.max(...valid) - Math.min(...valid)) : 0;
    let pct = 0;
    if (valid.length >= 2) pct = ((valid[0] - valid[valid.length - 1]) / valid[0]) * 100;

    setText('fin-avg', finalAvg ? finalAvg.toFixed(1) + ' ms' : 'N/A (FS)');
    setText('fin-cs',  finalCons ? finalCons.toFixed(0) + ' ms' : '0 ms');
    setText('fin-wr',  totalRounds ? ((winCount / totalRounds) * 100).toFixed(0) + '%' : '0%');
    setText('fin-ch',  pct ? `${pct.toFixed(1)}% ${pct > 0 ? 'Lebih Fokus' : 'Penurunan Fokus'}` : 'Stabil');
    if (finalBox) finalBox.classList.remove('hidden');

    if (btn) { btn.innerText = 'KEMBALI KE LOBBY'; btn.onclick = () => location.href = 'index.html'; }
    popup.classList.remove('hidden');
}

function lockReadyButton() {
    const btn = document.getElementById('btn-game-ready');
    const statusEl = document.getElementById('game-status');
    if (btn) { btn.disabled = true; btn.innerText = 'MATCH SELESAI'; btn.onclick = null; }
    if (statusEl) { statusEl.innerText = 'MATCH SELESAI'; statusEl.style.color = '#e10600'; }
}

function enableNextRoundButton(data) {
    const btn = document.getElementById('btn-game-ready');
    const statusEl = document.getElementById('game-status');
    setTimeout(() => {
        if (matchEnded) return;
        if (btn) {
            btn.disabled = false;
            btn.innerText = (data && data.suddenDeath) ? '⚡ READY (SUDDEN DEATH)' : 'READY RONDE BERIKUTNYA (0/2)';
            btn.onclick = sendReady;
        }
        if (statusEl) {
            statusEl.innerText = (data && data.suddenDeath) ? 'SUDDEN DEATH! SIAP...' : 'SIAP...';
            statusEl.style.color = '';
        }
    }, 2500);
}
