'use strict';
/**
 * ai.js — AI cho chế độ Solo.
 *
 * Cách lai (#7):
 *  1. Heuristic trên server tính các ô ứng viên (lân cận quân đã đánh) và chấm điểm.
 *  2. BẮT BUỘC: nếu thắng được ngay thì đánh; nếu đối thủ sắp thắng thì chỉ cho phép các ô chặn.
 *  3. Gemini chọn 1 ô trong shortlist và viết câu khịa tiếng Việt.
 *  4. Gemini lỗi / sai định dạng / quá thời gian => dùng ô heuristic tốt nhất + câu khịa dựng sẵn.
 */
const { key, other, inBounds, wouldWin } = require('./gameLogic');

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
// Điểm của 1 cửa sổ 5 ô không có quân địch, theo số quân mình trong đó
const WINDOW_SCORE = [0, 1, 10, 100, 2000, 100000];

/** Các ô trống trong bán kính `r` quanh mọi quân đã đánh */
function candidateCells(game, r = 2) {
  const seen = new Set();
  const out = [];
  for (const [x, y] of game.moves) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const cx = x + dx, cy = y + dy;
        const k = key(cx, cy);
        if (seen.has(k)) continue;
        seen.add(k);
        if (inBounds(game, cx, cy) && !game.board.has(k)) out.push([cx, cy]);
      }
    }
  }
  return out;
}

/**
 * Điểm nếu `sym` đặt quân tại (x,y): cộng điểm mọi cửa sổ 5 ô chứa ô đó,
 * không có quân địch và không ra ngoài biên. Cửa sổ trượt xử lý được cả thế "X X _ X".
 */
function windowScore(game, x, y, sym) {
  const opp = other(sym);
  let total = 0;
  for (const [dx, dy] of DIRS) {
    for (let s = -4; s <= 0; s++) {
      let own = 0, bad = false;
      for (let i = 0; i < 5; i++) {
        const cx = x + dx * (s + i), cy = y + dy * (s + i);
        if (cx === x && cy === y) { own++; continue; }
        if (!inBounds(game, cx, cy)) { bad = true; break; }
        const v = game.board.get(key(cx, cy));
        if (v === opp) { bad = true; break; }
        if (v === sym) own++;
      }
      if (!bad) total += WINDOW_SCORE[own];
    }
  }
  return total;
}

function tagFor(atk, def) {
  if (atk >= 2000) return 'tạo chuỗi 4 (rất mạnh)';
  if (def >= 2000) return 'chặn chuỗi 4 của đối thủ';
  if (atk >= 300) return 'tạo chuỗi 3';
  if (def >= 300) return 'chặn chuỗi 3 của đối thủ';
  return 'phát triển thế cờ';
}

/** Xếp hạng các nước đi cho `sym`. Phần tử đầu là tốt nhất. `forced` = nước bắt buộc. */
function rankMoves(game, sym) {
  const opp = other(sym);
  const b = game.bounds;

  if (game.board.size === 0) { // đi đầu: gần tâm
    const cx = Math.floor((b.minX + b.maxX) / 2) + (Math.random() < 0.5 ? 0 : 1);
    const cy = Math.floor((b.minY + b.maxY) / 2) + (Math.random() < 0.5 ? 0 : 1);
    return [{ x: cx, y: cy, score: 1, tag: 'mở màn', forced: false }];
  }

  const cands = candidateCells(game, 2);
  if (!cands.length) { // hiếm: không còn ô lân cận => lấy ô trống bất kỳ
    for (let x = b.minX; x <= b.maxX; x++) {
      for (let y = b.minY; y <= b.maxY; y++) {
        if (!game.board.has(key(x, y))) return [{ x, y, score: 0, tag: 'đi đại', forced: false }];
      }
    }
    return [];
  }

  // 1) thắng ngay (dùng đúng luật chặn 2 đầu của gameLogic)
  for (const [x, y] of cands) {
    if (wouldWin(game, x, y, sym)) return [{ x, y, score: 1e9, tag: 'thắng ngay', forced: true }];
  }

  const scored = cands.map(([x, y]) => {
    const atk = windowScore(game, x, y, sym);
    const def = windowScore(game, x, y, opp);
    return { x, y, atk, def, score: atk + def * 0.9 + Math.random() * 1.5, tag: tagFor(atk, def), forced: false };
  });

  // 2) đối thủ sắp thắng => chỉ được chọn các ô chặn
  const blocks = scored.filter((c) => wouldWin(game, c.x, c.y, opp));
  if (blocks.length) {
    blocks.sort((a, b2) => b2.score - a.score);
    return blocks.map((c) => ({ ...c, tag: 'chặn đối thủ thắng', forced: true }));
  }

  scored.sort((a, b2) => b2.score - a.score);
  return scored;
}

// ---------- Câu khịa dựng sẵn (fallback khi không có / lỗi Gemini) ----------
const LOCAL = {
  win: ['Hết cờ rồi bạn ơi! 😎', 'Ván này AI xin nhận nhé 🏆', 'Đủ năm quân rồi, cảm ơn đã tiếp sức!'],
  block: ['Định đi đường đó hả? Không cửa đâu 😏', 'Chặn cái rụp, tiếc quá nha!', 'Ê ê, lối này đóng cửa rồi nhé 🚧'],
  attack: ['Ba quân rồi nè, run chưa? 😈', 'Thế cờ đang đẹp à nha', 'Cứ đi tiếp đi, AI đang nghiền ngẫm 🍿'],
  other: ['Từ từ nghĩ đi, AI đợi được 🍵', 'Nước này nhìn hiền mà sâu lắm đó', 'Đi đại thôi mà... hên thế nào đó 😌', 'Bạn có chắc không đó?'],
};
const LOSE_LINES = ['Hên thôi! Ván sau tính 😤', 'Ơ... AI lỡ tay thôi nha', 'Công nhận bạn cũng được đấy 👏', 'Đòi tái đấu liền cho coi 🔥'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function localTaunt(move) {
  if (move.tag === 'thắng ngay') return pick(LOCAL.win);
  if (move.tag === 'chặn đối thủ thắng' || move.tag.startsWith('chặn')) return pick(LOCAL.block);
  if (move.tag.startsWith('tạo')) return pick(LOCAL.attack);
  return pick(LOCAL.other);
}
const loseTaunt = () => pick(LOSE_LINES);

// ---------- Gemini ----------
const SYSTEM_PROMPT =
  'Bạn là AI chơi cờ ca-rô tên "Bot Gáy", tính cách hài hước, thích khịa bạn chơi kiểu bạn bè trêu nhau. ' +
  'Quy tắc câu khịa: tiếng Việt, đúng 1 câu, tối đa 70 ký tự, có thể kèm 1 emoji; không chửi thề, ' +
  'không xúc phạm cá nhân, ngoại hình, vùng miền hay giới tính; phải liên quan đến nước đi bạn chọn ' +
  '(chặn đường, tạo thế, sắp thắng...). Khi chọn ô: ưu tiên ô có điểm cao nhất, ' +
  'chỉ chọn ô khác khi điểm gần bằng nhau.';

async function askGemini(game, sym, shortlist, { apiKey, model, timeoutMs, signal }) {
  const opp = other(sym);
  const last = game.moves.length ? game.moves[game.moves.length - 1] : null;
  const forced = shortlist.length === 1 && shortlist[0].forced;
  const lines = shortlist.map((c, i) => `${i}: (${c.x},${c.y}) — điểm ${Math.round(c.score)} — ${c.tag}`).join('\n');
  const text =
    `Ván cờ ca-rô: bạn cầm quân ${sym}, người chơi cầm quân ${opp}. Đã đi ${game.moves.length} nước. ` +
    (last ? `Nước vừa rồi của người chơi: (${last[0]},${last[1]}).\n` : 'Bạn đi trước.\n') +
    (forced ? 'Chỉ có 1 nước hợp lý (bắt buộc):\n' : 'Chọn 1 ô trong danh sách:\n') + lines +
    '\nTrả về JSON: {"choice": số thứ tự ô, "taunt": câu khịa}';

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: 256,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { choice: { type: 'INTEGER' }, taunt: { type: 'STRING' } },
        required: ['choice', 'taunt'],
      },
      thinkingConfig: { thinkingBudget: 0 }, // tắt "suy nghĩ" cho nhanh
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
    const data = await res.json();
    const raw = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const choice = Number.isInteger(parsed.choice) && parsed.choice >= 0 && parsed.choice < shortlist.length ? parsed.choice : 0;
    const taunt = typeof parsed.taunt === 'string' ? parsed.taunt.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return { choice, taunt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chọn nước đi cho AI. Luôn trả về nước hợp lệ: { x, y, taunt, source }.
 * source: 'gemini' | 'heuristic'
 */
async function chooseMove(game, sym, { apiKey, model = 'gemini-2.5-flash', timeoutMs = 6000, log = () => {} } = {}) {
  const ranked = rankMoves(game, sym);
  if (!ranked.length) return null;
  const best = ranked[0];
  let chosen = best, taunt = '', source = 'heuristic';

  if (apiKey) {
    try {
      const shortlist = best.forced
        ? ranked.slice(0, best.tag === 'thắng ngay' ? 1 : 4)
        : ranked.filter((c) => c.score >= best.score * 0.35).slice(0, 5);
      const r = await askGemini(game, sym, shortlist, { apiKey, model, timeoutMs });
      chosen = shortlist[r.choice];
      taunt = r.taunt;
      source = 'gemini';
    } catch (e) {
      log('Gemini lỗi, dùng heuristic: ' + (e.name === 'AbortError' ? 'quá thời gian' : e.message));
      chosen = best;
    }
  }
  return { x: chosen.x, y: chosen.y, taunt: taunt || localTaunt(chosen), source };
}

module.exports = { chooseMove, rankMoves, candidateCells, windowScore, loseTaunt };
