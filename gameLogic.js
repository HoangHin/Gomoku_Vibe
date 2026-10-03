'use strict';
/**
 * gameLogic.js — luật cờ Ca-rô + bàn cờ mở rộng động.
 * Thuần logic, không phụ thuộc server/ws để dễ test.
 *
 * Bàn cờ: Map "x,y" => 'X' | 'O'. Bounds mở rộng ra ngoài nên tọa độ có thể âm.
 */

const START_SIZE = 10;   // bàn khởi đầu 10x10 (tọa độ 0..9)
const EXPAND_EVERY = 10; // cứ 10 nước (tổng hai bên) mở rộng 1 vòng
const WIN_LEN = 5;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]; // ngang, dọc, 2 chéo

const key = (x, y) => x + ',' + y;
const other = (s) => (s === 'X' ? 'O' : 'X');

function createGame(starter = 'X') {
  return {
    board: new Map(),
    moves: [], // [[x, y, 'X'|'O'], ...] theo thứ tự đi
    bounds: { minX: 0, maxX: START_SIZE - 1, minY: 0, maxY: START_SIZE - 1 },
    turn: starter,
    starter,
    winner: null,
    winLine: null, // [[x,y], ...] các ô thắng
  };
}

function inBounds(game, x, y) {
  const b = game.bounds;
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

/**
 * Kiểm tra nước vừa đặt tại (x,y) của `sym` có thắng không.
 * - Chuỗi >= 5 quân liên tiếp đều tính (kể cả 6+).
 * - Luật chặn 2 đầu: chỉ khi CẢ HAI đầu là quân đối phương thì chưa thắng.
 * - Biên bàn cờ KHÔNG tính là chặn (chỉ quân đối phương mới chặn).
 * Trả về mảng ô thắng hoặc null.
 */
function checkWinAt(game, x, y, sym) {
  const b = game.board;
  const opp = other(sym);
  for (const [dx, dy] of DIRS) {
    let fx = x, fy = y;
    while (b.get(key(fx + dx, fy + dy)) === sym) { fx += dx; fy += dy; }
    let bx = x, by = y;
    while (b.get(key(bx - dx, by - dy)) === sym) { bx -= dx; by -= dy; }
    const len = Math.max(Math.abs(fx - bx), Math.abs(fy - by)) + 1;
    if (len < WIN_LEN) continue;
    const blockedF = b.get(key(fx + dx, fy + dy)) === opp;
    const blockedB = b.get(key(bx - dx, by - dy)) === opp;
    if (blockedF && blockedB) continue;
    const line = [];
    for (let i = 0; i < len; i++) line.push([bx + dx * i, by + dy * i]);
    return line;
  }
  return null;
}

/** Thử đặt quân giả định tại (x,y): có thắng ngay không? (không đổi state) */
function wouldWin(game, x, y, sym) {
  if (!inBounds(game, x, y) || game.board.has(key(x, y))) return false;
  game.board.set(key(x, y), sym);
  const line = checkWinAt(game, x, y, sym);
  game.board.delete(key(x, y));
  return !!line;
}

/** Mở rộng 1 vòng ra ngoài: +2 mỗi chiều */
function expand(game) {
  const b = game.bounds;
  b.minX--; b.minY--; b.maxX++; b.maxY++;
}

/**
 * Áp dụng 1 nước đi. Trả về { ok, error?, win?, expanded? }.
 * Server là nguồn sự thật nên mọi kiểm tra đều nằm ở đây.
 */
function applyMove(game, x, y, sym) {
  if (game.winner) return { ok: false, error: 'Ván cờ đã kết thúc' };
  if (sym !== game.turn) return { ok: false, error: 'Chưa tới lượt của bạn' };
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(game, x, y)) {
    return { ok: false, error: 'Nước đi nằm ngoài bàn cờ' };
  }
  if (game.board.has(key(x, y))) return { ok: false, error: 'Ô này đã có quân' };

  game.board.set(key(x, y), sym);
  game.moves.push([x, y, sym]);

  const line = checkWinAt(game, x, y, sym);
  if (line) {
    game.winner = sym;
    game.winLine = line;
    return { ok: true, win: true, expanded: false };
  }

  game.turn = other(sym);
  let expanded = false;
  if (game.moves.length % EXPAND_EVERY === 0) { expand(game); expanded = true; }
  return { ok: true, win: false, expanded };
}

module.exports = {
  START_SIZE, EXPAND_EVERY, WIN_LEN, DIRS,
  key, other, createGame, inBounds, checkWinAt, wouldWin, expand, applyMove,
};
