'use strict';
const assert = require('node:assert/strict');
const G = require('../gameLogic');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

// Đặt quân trực tiếp để dựng thế cờ (bỏ qua lượt)
function put(game, list) { for (const [x, y, s] of list) game.board.set(G.key(x, y), s); }
function row(y, x0, x1, s) { const a = []; for (let x = x0; x <= x1; x++) a.push([x, y, s]); return a; }

console.log('gameLogic');

test('5 ngang thắng', () => {
  const g = G.createGame(); put(g, row(3, 2, 6, 'X'));
  assert.ok(G.checkWinAt(g, 4, 3, 'X'));
});
test('4 quân chưa thắng', () => {
  const g = G.createGame(); put(g, row(3, 2, 5, 'X'));
  assert.equal(G.checkWinAt(g, 4, 3, 'X'), null);
});
test('5 dọc, 2 chéo thắng', () => {
  let g = G.createGame(); put(g, [[1,1,'O'],[1,2,'O'],[1,3,'O'],[1,4,'O'],[1,5,'O']]);
  assert.ok(G.checkWinAt(g, 1, 3, 'O'));
  g = G.createGame(); put(g, [[2,2,'X'],[3,3,'X'],[4,4,'X'],[5,5,'X'],[6,6,'X']]);
  assert.ok(G.checkWinAt(g, 4, 4, 'X'));
  g = G.createGame(); put(g, [[6,2,'X'],[5,3,'X'],[4,4,'X'],[3,5,'X'],[2,6,'X']]);
  assert.ok(G.checkWinAt(g, 4, 4, 'X'));
});
test('chặn cả 2 đầu => chưa thắng', () => {
  const g = G.createGame(); put(g, [...row(3, 2, 6, 'X'), [1,3,'O'], [7,3,'O']]);
  assert.equal(G.checkWinAt(g, 4, 3, 'X'), null);
});
test('chỉ chặn 1 đầu => vẫn thắng', () => {
  const g = G.createGame(); put(g, [...row(3, 2, 6, 'X'), [1,3,'O']]);
  assert.ok(G.checkWinAt(g, 4, 3, 'X'));
});
test('biên bàn cờ KHÔNG tính là chặn (#1)', () => {
  const g = G.createGame(); put(g, row(0, 0, 4, 'X'));       // sát biên trái, đầu phải trống
  assert.ok(G.checkWinAt(g, 2, 0, 'X'));
  const h = G.createGame(); put(h, [...row(0, 5, 9, 'X')]);   // sát biên phải
  assert.ok(G.checkWinAt(h, 7, 0, 'X'));
  const k = G.createGame(); put(k, [...row(0, 0, 4, 'X'), [5,0,'O']]); // 1 đầu biên + 1 đầu địch
  assert.ok(G.checkWinAt(k, 2, 0, 'X'));
});
test('chuỗi 6 thắng; 6 bị chặn 2 đầu thì chưa (#2)', () => {
  let g = G.createGame(); put(g, row(3, 1, 6, 'X'));
  assert.equal(G.checkWinAt(g, 3, 3, 'X').length, 6);
  g = G.createGame(); put(g, [...row(3, 1, 6, 'X'), [0,3,'O'], [7,3,'O']]);
  assert.equal(G.checkWinAt(g, 3, 3, 'X'), null);
});
test('wouldWin không làm đổi bàn cờ', () => {
  const g = G.createGame(); put(g, row(3, 2, 5, 'X'));
  assert.equal(G.wouldWin(g, 6, 3, 'X'), true);
  assert.equal(G.wouldWin(g, 9, 9, 'X'), false);
  assert.equal(g.board.has(G.key(6, 3)), false);
});
test('mở rộng 10→12 sau nước 10, →14 sau nước 20; tọa độ âm hợp lệ', () => {
  const g = G.createGame();
  const size = () => g.bounds.maxX - g.bounds.minX + 1;
  // đi lần lượt từng ô theo hàng: X và O xen kẽ nên không ai đủ 5 liên tiếp
  for (let i = 0; i < 20; i++) {
    const r = G.applyMove(g, i % 10, Math.floor(i / 10), g.turn);
    assert.ok(r.ok && !r.win);
    assert.equal(r.expanded, i === 9 || i === 19);
    if (i === 8) assert.equal(size(), 10);
    if (i === 9) assert.equal(size(), 12);
  }
  assert.equal(size(), 14);
  assert.equal(g.bounds.minX, -2);
  assert.ok(G.applyMove(g, -2, -2, g.turn).ok); // đặt được ở ô tọa độ âm
});
test('nước sai bị từ chối: sai lượt, ô trùng, ngoài biên, sau khi thắng', () => {
  const g = G.createGame();
  assert.equal(G.applyMove(g, 0, 0, 'O').ok, false);         // X đi trước
  assert.equal(G.applyMove(g, 10, 0, 'X').ok, false);        // ngoài biên
  assert.equal(G.applyMove(g, 1.5, 0, 'X').ok, false);       // không nguyên
  assert.ok(G.applyMove(g, 0, 0, 'X').ok);
  assert.equal(G.applyMove(g, 0, 0, 'O').ok, false);         // ô trùng
  const w = G.createGame(); put(w, row(3, 2, 5, 'X')); w.turn = 'X';
  const r = G.applyMove(w, 6, 3, 'X');
  assert.ok(r.ok && r.win && w.winner === 'X' && w.winLine.length === 5);
  assert.equal(G.applyMove(w, 0, 0, 'O').ok, false);         // đã kết thúc
});
test('createGame(starter) đặt lượt đầu', () => {
  assert.equal(G.createGame('O').turn, 'O');
});

console.log(`\n${passed} test đạt.`);
