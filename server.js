'use strict';
/**
 * server.js — web server + WebSocket trung tâm. Toàn bộ phòng nằm trên RAM (Map), không database.
 *
 * Vòng đời phòng (#4, #5):
 *  - Mất kết nối: chờ GRACE_MS (30s) để kết nối lại, quá hạn mới coi là rời phòng.
 *  - Rời hẳn giữa ván PvP: báo đối thủ "đã rời" + tính họ thắng, rồi hủy phòng.
 *  - Phòng chờ không ai vào: tự hủy sau WAIT_ROOM_MS (10 phút).
 *  - Hủy phòng = xóa khỏi Map, hủy timer, xóa session → giải phóng RAM.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---- Nạp .env (tự viết cho nhẹ, khỏi cần thêm thư viện) ----
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* không có .env thì dùng biến môi trường */ }
})();

const express = require('express');
const { WebSocketServer } = require('ws');
const G = require('./gameLogic');
const AI = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_ROOMS = 300;            // chặn tràn RAM
const GRACE_MS = Number(process.env.GRACE_MS) || 30_000;          // chờ kết nối lại
const WAIT_ROOM_MS = Number(process.env.WAIT_ROOM_MS) || 10 * 60_000; // phòng chờ tối đa
const AI_TIMEOUT_MS = 6_000;      // quá thời gian này Gemini bị bỏ qua
const AI_MIN_DELAY_MS = 600;      // AI không đánh nhanh quá, nhìn cho tự nhiên
const HEARTBEAT_MS = 25_000;

if (!GEMINI_API_KEY) console.warn('[ai] Chưa có GEMINI_API_KEY → AI chỉ dùng heuristic + câu khịa dựng sẵn.');

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);

// ---------------------------------------------------------------- Trạng thái trên RAM
/** @type {Map<string, any>} code|id -> room */
const rooms = new Map();
/** @type {Map<string, {room:any, sym:'X'|'O'}>} token -> chỗ ngồi */
const sessions = new Map();

const rid = (n) => crypto.randomBytes(n).toString('hex');

function newRoom(mode, code) {
  return {
    code, mode,
    phase: mode === 'pvp' ? 'waiting' : 'playing', // waiting | playing | over
    game: G.createGame('X'),
    gameNo: 1,
    players: { X: null, O: null }, // O của PvE là AI => để null
    rematchFrom: null,
    aiBusy: false,
    destroyed: false,
    waitTimer: null,
  };
}

function newPlayer(ws) {
  return { token: rid(16), ws, online: true, graceTimer: null };
}

function genCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0'); // giữ số 0 đầu
    if (!rooms.has(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------- Gửi tin
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function stateFor(room, sym) {
  const g = room.game;
  const oppSym = G.other(sym);
  const opp = room.players[oppSym];
  return {
    type: 'state',
    mode: room.mode,
    code: room.mode === 'pvp' ? room.code : null,
    you: sym,
    phase: room.phase,
    gameNo: room.gameNo,
    moves: g.moves,
    bounds: g.bounds,
    turn: g.turn,
    starter: g.starter,
    winner: g.winner,
    winLine: g.winLine,
    opponent: room.mode === 'pve'
      ? { present: true, online: true }
      : { present: !!opp, online: !!(opp && opp.online) },
    rematch: room.rematchFrom, // 'X' | 'O' | null: bên nào đã gửi lời mời đấu lại
  };
}

function broadcast(room) {
  for (const sym of ['X', 'O']) {
    const p = room.players[sym];
    if (p && p.online) send(p.ws, stateFor(room, sym));
  }
}

// ---------------------------------------------------------------- Hủy phòng (giải phóng RAM)
function destroyRoom(room, notify) {
  if (room.destroyed) return;
  room.destroyed = true;
  clearTimeout(room.waitTimer);
  for (const sym of ['X', 'O']) {
    const p = room.players[sym];
    if (!p) continue;
    clearTimeout(p.graceTimer);
    if (notify && p.online) send(p.ws, notify);
    if (p.ws) p.ws.token = null;
    sessions.delete(p.token);
    room.players[sym] = null;
  }
  room.game = null;
  rooms.delete(room.code);
}

/** Một người rời hẳn (bấm thoát, hoặc mất kết nối quá hạn) */
function playerLeft(room, sym) {
  if (room.destroyed) return;
  const opp = room.players[G.other(sym)];
  if (room.mode === 'pvp' && opp && opp.online) {
    // #5: báo đối thủ, tính họ thắng nếu ván đang diễn ra
    send(opp.ws, { type: 'closed', reason: 'opponent_left', youWin: room.phase === 'playing' });
  }
  destroyRoom(room, null);
}

function leaveCurrent(ws) {
  const s = ws.token && sessions.get(ws.token);
  if (s) playerLeft(s.room, s.sym);
  ws.token = null;
}

// ---------------------------------------------------------------- Tạo / vào phòng
function createRoom(ws, mode) {
  leaveCurrent(ws);
  if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'Server đang đầy, thử lại sau ít phút.' });
  const code = mode === 'pvp' ? genCode() : 'ai-' + rid(4);
  if (!code) return send(ws, { type: 'error', message: 'Không tạo được mã phòng, thử lại.' });

  const room = newRoom(mode, code);
  const p = newPlayer(ws);
  room.players.X = p;
  sessions.set(p.token, { room, sym: 'X' });
  rooms.set(code, room);
  ws.token = p.token;
  if (mode === 'pvp') room.waitTimer = setTimeout(() => destroyRoom(room, { type: 'closed', reason: 'timeout' }), WAIT_ROOM_MS);

  send(ws, { type: 'session', token: p.token, mode, code: mode === 'pvp' ? code : null, you: 'X' });
  broadcast(room);
}

function joinRoom(ws, code) {
  if (typeof code !== 'string' || !/^\d{4}$/.test(code)) {
    return send(ws, { type: 'error', message: 'Mã phòng gồm đúng 4 chữ số.' });
  }
  const room = rooms.get(code);
  if (!room || room.mode !== 'pvp') return send(ws, { type: 'error', message: 'Không tìm thấy phòng ' + code + '.' });
  if (room.phase !== 'waiting' || room.players.O) return send(ws, { type: 'error', message: 'Phòng này đã đủ người.' });
  leaveCurrent(ws);
  if (room.destroyed) return; // phòng vừa bị hủy trong lúc leaveCurrent (hiếm)

  const p = newPlayer(ws);
  room.players.O = p;
  room.phase = 'playing';
  clearTimeout(room.waitTimer);
  sessions.set(p.token, { room, sym: 'O' });
  ws.token = p.token;
  send(ws, { type: 'session', token: p.token, mode: 'pvp', code, you: 'O' });
  broadcast(room);
}

function resume(ws, token) {
  const s = typeof token === 'string' && sessions.get(token);
  if (!s) return send(ws, { type: 'resume_failed' });
  const { room, sym } = s;
  const p = room.players[sym];
  if (!p) return send(ws, { type: 'resume_failed' });
  if (p.ws && p.ws !== ws) { p.ws.token = null; try { p.ws.close(); } catch { /* bỏ qua */ } }
  clearTimeout(p.graceTimer);
  p.ws = ws; p.online = true; ws.token = token;
  send(ws, { type: 'session', token, mode: room.mode, code: room.mode === 'pvp' ? room.code : null, you: sym });
  broadcast(room);
}

// ---------------------------------------------------------------- Nước đi & tái đấu
function handleMove(room, sym, x, y) {
  if (room.phase !== 'playing') return { error: 'Chưa thể đi lúc này.' };
  const res = G.applyMove(room.game, x, y, sym);
  if (!res.ok) return { error: res.error };
  if (res.win) room.phase = 'over';
  broadcast(room);

  if (room.mode === 'pve') {
    const human = room.players.X;
    if (res.win && human) send(human.ws, { type: 'chat', text: AI.loseTaunt() });
    else if (room.phase === 'playing' && room.game.turn === 'O') runAi(room);
  }
  return {};
}

async function runAi(room) {
  if (room.aiBusy || room.destroyed) return;
  room.aiBusy = true;
  const gameNo = room.gameNo;
  const t0 = Date.now();
  let move = null;
  try {
    move = await AI.chooseMove(room.game, 'O', {
      apiKey: GEMINI_API_KEY, model: GEMINI_MODEL, timeoutMs: AI_TIMEOUT_MS,
      log: (m) => console.warn('[ai]', m),
    });
  } catch (e) {
    console.error('[ai] lỗi bất ngờ:', e);
  }
  const wait = AI_MIN_DELAY_MS - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  room.aiBusy = false;

  // phòng đã hủy / đã sang ván mới trong lúc chờ => bỏ kết quả
  if (room.destroyed || room.gameNo !== gameNo || room.phase !== 'playing' || room.game.turn !== 'O' || !move) return;
  const res = G.applyMove(room.game, move.x, move.y, 'O');
  if (!res.ok) return console.error('[ai] nước không hợp lệ', move);
  if (res.win) room.phase = 'over';
  broadcast(room);
  const human = room.players.X;
  if (human && human.online) send(human.ws, { type: 'chat', text: move.taunt });
}

function startNewGame(room) {
  const nextStarter = G.other(room.game.starter); // #6: đổi lượt đi trước
  room.game = G.createGame(nextStarter);
  room.gameNo++;
  room.phase = 'playing';
  room.rematchFrom = null;
  broadcast(room);
  if (room.mode === 'pve' && room.game.turn === 'O') runAi(room);
}

function handleRematch(room, sym, accept) {
  if (room.phase !== 'over') return;
  if (room.mode === 'pve') return startNewGame(room);
  if (!room.players[G.other(sym)]) return;
  if (room.rematchFrom && room.rematchFrom !== sym) return startNewGame(room); // 2 bên cùng muốn / chấp nhận
  if (accept) return; // chưa có lời mời nào để chấp nhận
  room.rematchFrom = sym;
  broadcast(room);
}

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.token = null;
  ws.rate = { t: Date.now(), n: 0 };
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* lỗi socket đã kèm sự kiện close */ });

  ws.on('message', (data) => {
    const now = Date.now();
    if (now - ws.rate.t > 1000) { ws.rate.t = now; ws.rate.n = 0; }
    if (++ws.rate.n > 20) return ws.close(1008, 'Gửi quá nhanh');

    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    try {
      const s = ws.token && sessions.get(ws.token);
      switch (m.type) {
        case 'create_pve': return createRoom(ws, 'pve');
        case 'create_pvp': return createRoom(ws, 'pvp');
        case 'join': return joinRoom(ws, m.code);
        case 'resume': return resume(ws, m.token);
        case 'leave': return leaveCurrent(ws);
        case 'move': {
          if (!s) return;
          const r = handleMove(s.room, s.sym, m.x, m.y);
          if (r.error) send(ws, { type: 'error', message: r.error });
          return;
        }
        case 'rematch_request': return s && handleRematch(s.room, s.sym, false);
        case 'rematch_accept': return s && handleRematch(s.room, s.sym, true);
        default: return;
      }
    } catch (e) {
      console.error('Lỗi xử lý message:', e);
    }
  });

  ws.on('close', () => {
    const s = ws.token && sessions.get(ws.token);
    if (!s) return;
    const { room, sym } = s;
    const p = room.players[sym];
    if (!p || p.ws !== ws) return; // đã được thay bằng kết nối mới
    p.online = false;
    p.ws = null;
    broadcast(room); // cho đối thủ biết "mất kết nối"
    clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => playerLeft(room, sym), GRACE_MS);
  });
});

// Phát hiện kết nối chết (điện thoại tắt màn hình, rớt mạng...) nhanh hơn
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* bỏ qua */ }
  }
}, HEARTBEAT_MS);

// ---------------------------------------------------------------- Khởi động & tắt êm
server.listen(PORT, () => console.log(`Ca-rô Vibe chạy tại http://localhost:${PORT}`));

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server khởi động lại');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { rooms, sessions }; // phục vụ test
