'use strict';
const assert = require('node:assert/strict');
const G = require('../gameLogic');
const AI = require('../ai');

let passed = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { passed++; console.log('  ok  ' + name); }); }
// Dựng thế cờ: list [x,y,sym] theo thứ tự (cả moves lẫn board)
function setup(list, turn) {
  const g = G.createGame();
  for (const [x, y, s] of list) { g.board.set(G.key(x, y), s); g.moves.push([x, y, s]); }
  g.turn = turn;
  return g;
}

(async () => {
  console.log('ai');
  await test('thắng ngay khi có thể (bỏ qua việc chặn)', () => {
    const g = setup([[2,3,'O'],[3,3,'O'],[4,3,'O'],[5,3,'O'],[2,5,'X'],[3,5,'X'],[4,5,'X'],[5,5,'X']], 'O');
    const r = AI.rankMoves(g, 'O');
    assert.equal(r.length, 1);
    assert.equal(r[0].tag, 'thắng ngay');
    assert.ok([[1,3],[6,3]].some(([x, y]) => x === r[0].x && y === r[0].y));
  });
  await test('bắt buộc chặn khi đối thủ sắp thắng', () => {
    const g = setup([[2,5,'X'],[3,5,'X'],[4,5,'X'],[5,5,'X'],[0,0,'O'],[9,9,'O']], 'O');
    const r = AI.rankMoves(g, 'O');
    assert.ok(r.every((c) => c.forced));
    assert.ok([[1,5],[6,5]].some(([x, y]) => x === r[0].x && y === r[0].y));
  });
  await test('thế X X _ X X: AI chặn đúng ô giữa', () => {
    const g = setup([[1,4,'X'],[2,4,'X'],[4,4,'X'],[5,4,'X'],[8,8,'O'],[0,9,'O']], 'O');
    const r = AI.rankMoves(g, 'O');
    assert.deepEqual([r[0].x, r[0].y], [3, 4]);
  });
  await test('luật chặn 2 đầu: đã bị chặn kín thì không phải đe dọa', () => {
    // 4 quân X có O ở cả 2 đầu → thêm 1 quân nữa vẫn không thắng, AI không bị ép
    const g = setup([[1,4,'O'],[2,4,'X'],[3,4,'X'],[4,4,'X'],[5,4,'X'],[6,4,'O'],[8,8,'O']], 'O');
    const r = AI.rankMoves(g, 'O');
    assert.equal(r.some((c) => c.forced), false);
  });
  await test('ván trống: đi gần tâm', () => {
    const r = AI.rankMoves(G.createGame('O'), 'O');
    assert.ok(r[0].x >= 4 && r[0].x <= 5 && r[0].y >= 4 && r[0].y <= 5);
  });
  await test('chooseMove không có API key vẫn trả nước hợp lệ + câu khịa', async () => {
    const g = setup([[4,4,'X']], 'O');
    const m = await AI.chooseMove(g, 'O', {});
    assert.ok(G.inBounds(g, m.x, m.y) && !g.board.has(G.key(m.x, m.y)));
    assert.equal(m.source, 'heuristic');
    assert.ok(m.taunt.length > 0);
  });
  await test('Gemini lỗi mạng => fallback heuristic', async () => {
    const g = setup([[4,4,'X']], 'O');
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('mạng chết'); };
    const m = await AI.chooseMove(g, 'O', { apiKey: 'fake', timeoutMs: 500 });
    global.fetch = realFetch;
    assert.equal(m.source, 'heuristic');
  });
  await test('Gemini trả JSON hợp lệ => dùng lựa chọn + câu khịa của Gemini', async () => {
    const g = setup([[4,4,'X'],[5,5,'X']], 'O');
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"choice":1,"taunt":"Hello khịa"}' }] } }] }) });
    const m = await AI.chooseMove(g, 'O', { apiKey: 'fake' });
    global.fetch = realFetch;
    assert.equal(m.source, 'gemini');
    assert.equal(m.taunt, 'Hello khịa');
  });
  await test('Gemini trả choice sai phạm vi => về ô 0, không văng lỗi', async () => {
    const g = setup([[4,4,'X']], 'O');
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"choice":99,"taunt":"ok"}' }] } }] }) });
    const m = await AI.chooseMove(g, 'O', { apiKey: 'fake' });
    global.fetch = realFetch;
    assert.ok(G.inBounds(g, m.x, m.y));
  });
  await test('Gemini treo quá giờ => fallback', async () => {
    const g = setup([[4,4,'X']], 'O');
    const realFetch = global.fetch;
    global.fetch = (url, opt) => new Promise((_, rej) => opt.signal.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' }))));
    const t0 = Date.now();
    const m = await AI.chooseMove(g, 'O', { apiKey: 'fake', timeoutMs: 300 });
    global.fetch = realFetch;
    assert.equal(m.source, 'heuristic');
    assert.ok(Date.now() - t0 < 1500);
  });
  await test('AI tự đấu với AI: ván kết thúc hợp lệ, không văng lỗi', async () => {
    const g = G.createGame();
    let guard = 0;
    while (!g.winner && guard++ < 400) {
      const m = await AI.chooseMove(g, g.turn, {});
      const r = G.applyMove(g, m.x, m.y, g.turn);
      assert.ok(r.ok, 'nước AI phải hợp lệ: ' + JSON.stringify(m));
    }
    assert.ok(g.winner, 'phải có người thắng trong 400 nước');
  });
  console.log(`\n${passed} test đạt.`);
})().catch((e) => { console.error(e); process.exit(1); });
