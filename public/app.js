/**
 * app.js — Client: WebSocket, vẽ bàn cờ (canvas), tái đấu, 4 hiệu ứng kết liễu.
 *
 * Giao thức khớp với server.js:
 *   gửi:  create_pve | create_pvp | join{code} | resume{token} | leave | move{x,y}
 *         rematch_request | rematch_accept
 *   nhận: session{token,mode,code,you} | state{...} | chat{text} | closed{reason,youWin}
 *         error{message} | resume_failed
 *
 * Mục lục: [1] tiện ích  [2] kết nối  [3] trạng thái & giao diện  [4] vẽ bàn cờ
 *          [5] nước vừa đánh  [6] engine hiệu ứng  [7] 10 hiệu ứng kết liễu  [8] khởi động
 */
(() => {
  'use strict';

  // ============================================================ [1] Tiện ích
  const T = window.THEME;
  const TAU = Math.PI * 2;
  const $ = (id) => document.getElementById(id);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const other = (s) => (s === 'X' ? 'O' : 'X');
  const keyOf = (x, y) => x + ',' + y;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const el = {
    app: $('app'), menu: $('screenMenu'), game: $('screenGame'),
    btnPve: $('btnPve'), btnPvp: $('btnPvp'), joinForm: $('joinForm'), codeInput: $('codeInput'), btnJoin: $('btnJoin'),
    connInfo: $('connInfo'),
    roomLabel: $('roomLabel'), youChip: $('youChip'), btnLeave: $('btnLeave'), status: $('statusPill'),
    tauntRow: $('tauntRow'), taunt: $('taunt'),
    stage: $('stage'), boardWrap: $('boardWrap'), board: $('board'), glow: $('glow'), overlay: $('overlay'),
    waitBox: $('waitBox'), waitCode: $('waitCode'),
    result: $('result'), resultTitle: $('resultTitle'), resultSub: $('resultSub'), btnRematch: $('btnRematch'), btnMenu: $('btnMenu'),
    modal: $('modal'), modalTitle: $('modalTitle'), modalText: $('modalText'), modalBtn: $('modalBtn'),
    toast: $('toast'), fx: $('fx'),
  };

  // Nạp theme.js vào biến CSS
  function applyTheme() {
    const r = document.documentElement.style;
    r.setProperty('--page-bg', T.page.background);
    r.setProperty('--text', T.page.text);
    r.setProperty('--muted', T.page.muted);
    r.setProperty('--accent', T.page.accent);
    r.setProperty('--accent2', T.page.accent2);
    r.setProperty('--panel', T.page.panel);
    r.setProperty('--board-border', T.board.borderColor);
    r.setProperty('--x', T.X.color);
    r.setProperty('--o', T.O.color);
    r.setProperty('--pulse', T.lastMove.glow);
    r.setProperty('--ripple', T.lastMove.ripple);
    el.boardWrap.style.background = T.board.background;
  }

  // Ảnh quân cờ riêng (nếu theme.js có khai báo)
  const IMG = { X: null, O: null };
  for (const s of ['X', 'O']) {
    if (T[s].image) {
      const im = new Image();
      im.onload = () => drawBoard();
      im.src = T[s].image;
      IMG[s] = im;
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  // ============================================================ [2] Kết nối
  const S = {
    ws: null, open: false, retry: 0, retryTimer: 0,
    token: sessionStorage.getItem('caro.token') || null,

    inRoom: false, closed: false,        // closed: phòng đã bị server đóng (đối thủ rời...)
    mode: null, code: null, you: null, phase: null, gameNo: 0,
    moves: [], bounds: null, turn: null, starter: null, winner: null, winLine: null,
    opp: { present: false, online: false }, rematch: null,

    cells: new Map(),   // "x,y" -> 'X'|'O' (client tự dựng từ moves)
    hidden: new Set(),  // quân bị phá hủy bởi hiệu ứng, không vẽ nữa
    marks: new Set(),   // ô có vệt cháy (Lightning) còn lưu lại tới hết ván
    last: null,
    fxRunning: false,
  };

  function send(obj) {
    if (S.ws && S.open) { S.ws.send(JSON.stringify(obj)); return true; }
    toast('Chưa kết nối tới máy chủ, thử lại sau giây lát.');
    return false;
  }

  function connect() {
    clearTimeout(S.retryTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(proto + '://' + location.host + '/ws');
    S.ws = ws;
    ws.onopen = () => {
      S.open = true; S.retry = 0; setConn(true);
      if (S.token) ws.send(JSON.stringify({ type: 'resume', token: S.token })); // vào lại phòng cũ
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m.type === 'string') onMessage(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.open = false; setConn(false);
      S.retryTimer = setTimeout(connect, Math.min(4000, 500 * Math.pow(2, S.retry++)));
    };
    ws.onerror = () => { /* onclose sẽ xử lý */ };
  }

  function setConn(open) {
    for (const b of [el.btnPve, el.btnPvp, el.btnJoin, el.codeInput]) b.disabled = !open;
    el.connInfo.textContent = open ? 'Đã kết nối.' : 'Mất kết nối, đang kết nối lại…';
    el.connInfo.className = 'conn ' + (open ? 'ok' : 'bad');
    if (S.inRoom) updateUI();
  }

  function clearSession() {
    S.token = null;
    sessionStorage.removeItem('caro.token');
  }

  function onMessage(m) {
    switch (m.type) {
      case 'session':
        S.token = m.token;
        sessionStorage.setItem('caro.token', m.token);
        break;
      case 'state': onState(m); break;
      case 'chat': showTaunt(m.text); break;
      case 'closed': onClosed(m); break;
      case 'error': toast(m.message || 'Có lỗi xảy ra.'); break;
      case 'resume_failed':
        clearSession();
        if (S.inRoom && !S.closed) {
          showModal('Phòng đã đóng', 'Bạn mất kết nối quá lâu nên phòng không còn nữa.');
        }
        break;
    }
  }

  // ============================================================ [3] Trạng thái & giao diện
  function showScreen(name) {
    el.menu.hidden = name !== 'menu';
    el.game.hidden = name !== 'game';
  }

  function resetRoomState() {
    S.inRoom = false; S.closed = false; S.mode = null; S.code = null; S.you = null; S.phase = null; S.gameNo = 0;
    S.moves = []; S.bounds = null; S.turn = null; S.starter = null; S.winner = null; S.winLine = null;
    S.opp = { present: false, online: false }; S.rematch = null;
    S.cells.clear(); S.hidden.clear(); S.marks.clear(); S.last = null; S.fxRunning = false;
  }

  function onState(m) {
    const newGame = !S.inRoom || m.gameNo !== S.gameNo;
    S.inRoom = true; S.closed = false;
    S.mode = m.mode; S.code = m.code; S.you = m.you; S.phase = m.phase; S.gameNo = m.gameNo;
    S.turn = m.turn; S.starter = m.starter; S.winner = m.winner; S.winLine = m.winLine;
    S.opp = m.opponent; S.rematch = m.rematch; S.bounds = m.bounds;

    if (newGame) {
      fxClear();
      S.fxRunning = false;
      S.hidden.clear(); S.marks.clear(); S.cells.clear(); S.moves = [];
      el.result.hidden = true;
      el.taunt.hidden = true; el.taunt.textContent = '';
    }

    const fresh = m.moves.slice(S.moves.length);   // các nước mới kể từ lần trước
    for (const [x, y, s] of fresh) S.cells.set(keyOf(x, y), s);
    S.moves = m.moves;
    S.last = m.moves.length ? m.moves[m.moves.length - 1] : null;
    const animate = !newGame && fresh.length > 0;

    showScreen('game');
    layout();
    drawBoard();
    placeGlow();
    if (animate && S.last) ripple(S.last[0], S.last[1]);

    if (S.phase === 'over' && S.winner) {
      if (animate) startFinish();
      else if (!S.fxRunning) showResult();      // vào lại phòng / cập nhật lời mời: không chạy lại hiệu ứng
    } else if (!S.fxRunning) {
      el.result.hidden = true;
    }
    updateUI();
  }

  function showTaunt(text) {
    if (!text) return;
    el.taunt.textContent = text;
    el.taunt.hidden = false;
    // chạy lại animation "pop" cho mỗi câu mới
    el.taunt.style.animation = 'none'; void el.taunt.offsetWidth; el.taunt.style.animation = '';
  }

  function updateUI() {
    if (!S.inRoom) return;
    const pve = S.mode === 'pve';
    el.roomLabel.textContent = pve ? 'Chơi với máy' : 'Phòng ' + S.code;
    el.youChip.textContent = 'Bạn là ' + S.you;
    el.youChip.className = 'chip ' + S.you.toLowerCase();
    el.tauntRow.hidden = !pve;
    el.waitBox.hidden = !(S.mode === 'pvp' && S.phase === 'waiting');
    el.waitCode.textContent = S.code || '';

    let text = '', cls = 'status';
    if (!S.open) { text = 'Mất kết nối, đang nối lại…'; cls += ' warn'; }
    else if (S.phase === 'waiting') text = 'Chờ đối thủ vào phòng…';
    else if (S.phase === 'over') {
      text = 'Ván đã kết thúc';
    } else if (S.mode === 'pvp' && !S.opp.online) {
      text = 'Đối thủ mất kết nối, đang chờ họ quay lại (tối đa 30 giây)…'; cls += ' warn';
    } else if (S.turn === S.you) {
      text = S.moves.length === 0 ? 'Bạn đi trước, chọn một ô' : 'Đến lượt bạn';
      cls += ' mine';
    } else {
      text = pve ? 'Máy đang nghĩ…' : (S.moves.length === 0 ? 'Đối thủ đi trước' : 'Đến lượt đối thủ');
    }
    el.status.textContent = text;
    el.status.className = cls;
  }

  function showResult() {
    S.fxRunning = false;
    const win = S.winner === S.you;
    const pve = S.mode === 'pve';
    el.resultTitle.textContent = win ? 'Bạn thắng!' : 'Bạn thua!';
    const nextFirst = other(S.starter) === S.you ? 'Ván sau bạn đi trước.' : (pve ? 'Ván sau máy đi trước.' : 'Ván sau đối thủ đi trước.');
    let sub = nextFirst;
    const b = el.btnRematch;
    if (S.rematch && S.rematch !== S.you) { sub = 'Đối thủ muốn đấu lại với bạn.'; b.textContent = 'Chấp nhận'; b.disabled = false; }
    else if (S.rematch === S.you) { sub = 'Đã gửi lời mời, chờ đối thủ chấp nhận…'; b.textContent = 'Đã gửi lời mời'; b.disabled = true; }
    else { b.textContent = 'Đấu lại'; b.disabled = false; }
    el.resultSub.textContent = sub;
    el.result.hidden = false;
    updateUI();
  }

  function onClosed(m) {
    fxClear(); S.fxRunning = false;
    el.result.hidden = true;
    S.closed = true;
    clearSession();
    if (m.reason === 'opponent_left') {
      showModal('Đối thủ đã rời phòng', m.youWin ? 'Ván này tính bạn thắng.' : 'Phòng đã đóng.');
    } else {
      showModal('Phòng đã đóng', 'Không có ai vào phòng trong 10 phút nên phòng tự đóng.');
    }
  }

  function showModal(title, text) {
    el.modalTitle.textContent = title;
    el.modalText.textContent = text;
    el.modal.hidden = false;
    el.modalBtn.focus();
  }

  function goMenu(notify) {
    if (notify && S.open) send({ type: 'leave' });
    clearSession();
    fxClear();
    el.modal.hidden = true; el.result.hidden = true; el.taunt.hidden = true;
    resetRoomState();
    showScreen('menu');
  }

  function onLeaveClick() {
    const risky = S.inRoom && !S.closed && S.mode === 'pvp' && S.phase === 'playing';
    if (risky && !window.confirm('Rời phòng giữa ván sẽ tính bạn thua. Bạn vẫn muốn rời?')) return;
    goMenu(true);
  }

  // ---------- Sự kiện giao diện ----------
  el.btnPve.addEventListener('click', () => send({ type: 'create_pve' }));
  el.btnPvp.addEventListener('click', () => send({ type: 'create_pvp' }));
  el.codeInput.addEventListener('input', () => { el.codeInput.value = el.codeInput.value.replace(/\D/g, '').slice(0, 4); });
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.codeInput.value;
    if (!/^\d{4}$/.test(code)) return toast('Mã phòng gồm đúng 4 chữ số.');
    send({ type: 'join', code });
  });
  el.btnLeave.addEventListener('click', onLeaveClick);
  el.btnMenu.addEventListener('click', () => goMenu(true));
  el.modalBtn.addEventListener('click', () => goMenu(false));
  el.btnRematch.addEventListener('click', () => {
    if (S.rematch && S.rematch !== S.you) send({ type: 'rematch_accept' });
    else if (!S.rematch) send({ type: 'rematch_request' });
  });
  el.board.addEventListener('pointerdown', onBoardTap);
  document.addEventListener('visibilitychange', () => {
    // Quay lại tab / mở khóa màn hình: nối lại ngay thay vì chờ đếm lùi
    if (!document.hidden && !S.open) connect();
  });

  function onBoardTap(e) {
    if (!L || S.phase !== 'playing' || S.turn !== S.you || S.fxRunning) return;
    const r = el.board.getBoundingClientRect();
    const k = L.size / r.width;
    const gx = Math.floor(((e.clientX - r.left) * k) / L.cell) + L.minX;
    const gy = Math.floor(((e.clientY - r.top) * k) / L.cell) + L.minY;
    if (S.cells.has(keyOf(gx, gy))) return;
    send({ type: 'move', x: gx, y: gy });
  }

  // ============================================================ [4] Vẽ bàn cờ
  let L = null;     // layout: { cols, cell, size, minX, minY }
  let dpr = 1;
  const bctx = el.board.getContext('2d');

  function layout() {
    if (!S.bounds || el.game.hidden) return;
    const b = S.bounds;
    const cols = b.maxX - b.minX + 1;
    // Co giãn: ô cờ nhỏ lại khi bàn mở rộng để bàn luôn vừa khung
    const avail = Math.min(el.stage.clientWidth, el.stage.clientHeight) - 14;
    const cell = Math.max(6, Math.floor(avail / cols));
    const size = cell * cols;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.boardWrap.style.width = size + 'px';
    el.boardWrap.style.height = size + 'px';
    el.board.width = Math.round(size * dpr);
    el.board.height = Math.round(size * dpr);
    el.board.style.width = size + 'px';
    el.board.style.height = size + 'px';
    L = { cols, cell, size, minX: b.minX, minY: b.minY };
  }

  const cellCenter = (gx, gy) => ({ x: (gx - L.minX + 0.5) * L.cell, y: (gy - L.minY + 0.5) * L.cell });

  /** Vẽ 1 quân (X hoặc O) — dùng cho cả bàn cờ lẫn hiệu ứng. */
  function drawPiece(c, sym, cx, cy, size, o) {
    o = o || {};
    const t = T[sym], img = IMG[sym];
    c.save();
    c.translate(cx, cy);
    if (o.rot) c.rotate(o.rot);
    if (o.scale !== undefined) c.scale(o.scale, o.scale);
    if (o.alpha !== undefined) c.globalAlpha = o.alpha;
    if (img && img.complete && img.naturalWidth) {
      const s = size * 0.8;
      c.drawImage(img, -s / 2, -s / 2, s, s);
    } else {
      c.lineCap = 'round';
      c.strokeStyle = o.color || t.color;
      c.lineWidth = Math.max(2, size * t.lineWidth);
      if (o.glow !== false) { c.shadowColor = o.glowColor || t.glow; c.shadowBlur = size * 0.35; }
      c.beginPath();
      if (sym === 'X') {
        const h = size * 0.27;
        c.moveTo(-h, -h); c.lineTo(h, h); c.moveTo(h, -h); c.lineTo(-h, h);
      } else {
        c.arc(0, 0, size * 0.29, 0, TAU);
      }
      c.stroke();
    }
    c.restore();
  }

  function drawBoard() {
    if (!L) return;
    const c = bctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, L.size, L.size);
    c.strokeStyle = T.board.gridColor;
    c.lineWidth = T.board.gridWidth;
    c.beginPath();
    for (let i = 1; i < L.cols; i++) {
      const p = i * L.cell;
      c.moveTo(p, 0); c.lineTo(p, L.size);
      c.moveTo(0, p); c.lineTo(L.size, p);
    }
    c.stroke();
    for (const k of S.marks) {
      const i = k.indexOf(',');
      const gx = Number(k.slice(0, i)), gy = Number(k.slice(i + 1));
      const p = cellCenter(gx, gy);
      drawScorch(c, p.x, p.y, L.cell, 1, gx, gy);
    }
    for (const [k, s] of S.cells) {
      if (S.hidden.has(k)) continue;
      const i = k.indexOf(',');
      const p = cellCenter(Number(k.slice(0, i)), Number(k.slice(i + 1)));
      drawPiece(c, s, p.x, p.y, L.cell);
    }
  }

  // ============================================================ [5] Nước vừa đánh
  /** Lớp sáng mờ nhấp nháy tại nước vừa đánh, giữ cho tới nước kế tiếp. */
  function placeGlow() {
    if (!L || !S.last || S.phase !== 'playing') { el.glow.hidden = true; return; }
    const p = cellCenter(S.last[0], S.last[1]);
    const g = el.glow;
    g.style.left = (p.x - L.cell / 2) + 'px';
    g.style.top = (p.y - L.cell / 2) + 'px';
    g.style.width = L.cell + 'px';
    g.style.height = L.cell + 'px';
    g.hidden = false;
  }

  /** Vòng sóng tròn tỏa ra từ tâm ô vừa đặt quân. */
  function ripple(gx, gy) {
    if (!L) return;
    const p = cellCenter(gx, gy);
    const d = document.createElement('div');
    d.className = 'ripple';
    d.style.left = (p.x - L.cell / 2) + 'px';
    d.style.top = (p.y - L.cell / 2) + 'px';
    d.style.width = L.cell + 'px';
    d.style.height = L.cell + 'px';
    el.overlay.appendChild(d);
    const kill = () => d.remove();
    d.addEventListener('animationend', kill);
    setTimeout(kill, 1200);   // phòng khi tab ẩn làm animation không bắn sự kiện
  }

  if (window.ResizeObserver) {
    new ResizeObserver(() => { layout(); drawBoard(); placeGlow(); }).observe(el.stage);
  }
  window.addEventListener('resize', () => { layout(); drawBoard(); placeGlow(); });

  // ============================================================ [6] Engine hiệu ứng (canvas phủ toàn màn hình)
  const fctx = el.fx.getContext('2d');
  let fw = 0, fh = 0, fdpr = 1;
  const MAX_PARTS = 1600;
  const FX = { eff: null, parts: [], t: 0, last: 0, raf: 0, flash: 0, flashRate: 2.6, slowUntil: 0, onDone: null, safety: 0 };

  function resizeFx() {
    fdpr = Math.min(window.devicePixelRatio || 1, 2);
    fw = window.innerWidth; fh = window.innerHeight;
    el.fx.width = Math.round(fw * fdpr); el.fx.height = Math.round(fh * fdpr);
  }

  let shakeTimer = 0;
  /** Rung màn hình: ms = thời lượng, amp = biên độ (px). */
  function shake(ms, amp) {
    const a = el.app;
    a.classList.remove('shake'); void a.offsetWidth;
    a.style.setProperty('--amp', amp);
    a.style.setProperty('--shake-dur', ms + 'ms');
    a.classList.add('shake');
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => a.classList.remove('shake'), ms + 40);
  }

  /** Sinh 1 hạt. p: {x,y,vx,vy,g,drag,turb,life,size,color,round} hoặc {orbit,cx,cy,ang,rad,vr,w,...} */
  function spawn(p) {
    if (FX.parts.length >= MAX_PARTS) return;
    p.max = p.life;
    FX.parts.push(p);
  }

  function stepParts(dt) {
    const a = FX.parts;
    let w = 0;
    for (let i = 0; i < a.length; i++) {
      const p = a[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.orbit) {
        p.ang += p.w * dt; p.rad -= p.vr * dt;
        if (p.rad <= 2) continue;
        p.x = p.cx + Math.cos(p.ang) * p.rad; p.y = p.cy + Math.sin(p.ang) * p.rad;
      } else {
        if (p.spin) p.rot = (p.rot || 0) + p.spin * dt;
        if (p.grow) p.size += p.grow * dt;
        if (p.turb) { p.vx += (Math.random() - 0.5) * p.turb * dt; p.vy += (Math.random() - 0.5) * p.turb * dt; }
        if (p.g) p.vy += p.g * dt;
        if (p.drag) { const k = Math.pow(p.drag, dt * 60); p.vx *= k; p.vy *= k; }
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      a[w++] = p;
    }
    a.length = w;
  }

  function drawParts(c) {
    let fontSize = 0;
    for (const p of FX.parts) {
      c.globalAlpha = clamp(p.life / p.max, 0, 1) * (p.a === undefined ? 1 : p.a);
      c.fillStyle = p.color;
      if (p.char) {                     // ký tự (mưa số)
        if (fontSize !== p.size) { c.font = 'bold ' + p.size + 'px "Courier New", monospace'; fontSize = p.size; }
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(p.char, p.x, p.y);
      } else if (p.poly) {              // mảnh vỡ đa giác
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot || 0);
        c.beginPath();
        for (let i = 0; i < p.poly.length; i++) { if (i) c.lineTo(p.poly[i][0], p.poly[i][1]); else c.moveTo(p.poly[i][0], p.poly[i][1]); }
        c.closePath(); c.fill();
        if (p.edge) { c.strokeStyle = p.edge; c.lineWidth = 1.2; c.stroke(); }
        c.restore();
      } else if (p.drop) {              // giọt chất lỏng, dãn dài theo tốc độ rơi
        c.beginPath(); c.ellipse(p.x, p.y, p.size / 2, (p.size / 2) * (1 + clamp(p.vy / 250, 0, 2.2)), 0, 0, TAU); c.fill();
      } else if (p.round) { c.beginPath(); c.arc(p.x, p.y, p.size / 2, 0, TAU); c.fill(); }
      else c.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);   // hạt "pixel"
    }
    c.globalAlpha = 1;
  }

  function fxStart(eff, onDone) {
    fxClear();
    resizeFx();
    FX.eff = eff; FX.parts = []; FX.t = 0; FX.flash = 0; FX.flashRate = 2.6; FX.slowUntil = 0; FX.onDone = onDone;
    FX.last = performance.now();
    if (eff.init) eff.init();
    FX.raf = requestAnimationFrame(fxLoop);
    // Chốt an toàn: tab bị ẩn thì rAF dừng, vẫn phải hiện bảng kết quả
    FX.safety = setTimeout(fxFinish, (eff.duration + 3) * 1000);
  }

  function fxLoop(now) {
    const e = FX.eff;
    if (!e) return;
    const real = Math.min(0.05, (now - FX.last) / 1000);
    FX.last = now;
    const dt = real * (now < FX.slowUntil ? 0.25 : 1);   // slow-motion
    FX.t += dt;
    if (e.update) e.update(dt, FX.t);
    stepParts(dt);
    fctx.setTransform(fdpr, 0, 0, fdpr, 0, 0);
    fctx.clearRect(0, 0, fw, fh);
    e.draw(fctx, FX.t);
    drawParts(fctx);
    if (FX.flash > 0) {
      fctx.fillStyle = 'rgba(255,255,255,' + Math.min(1, FX.flash) + ')';
      fctx.fillRect(0, 0, fw, fh);
      FX.flash = Math.max(0, FX.flash - real * FX.flashRate);
    }
    if (FX.t >= e.duration) return fxFinish();
    FX.raf = requestAnimationFrame(fxLoop);
  }

  function fxFinish() {
    const done = FX.onDone;
    fxClear();
    if (done) done();
  }

  /** Dừng hiệu ứng và dọn sạch canvas (dùng khi hết hiệu ứng, sang ván mới, rời phòng). */
  function fxClear() {
    cancelAnimationFrame(FX.raf);
    clearTimeout(FX.safety);
    const e = FX.eff;
    if (e && e.cleanup) { try { e.cleanup(); } catch (err) { /* bỏ qua */ } }   // trả lại filter CSS...
    FX.eff = null; FX.parts = []; FX.onDone = null; FX.flash = 0;
    clearTimeout(shakeTimer);
    el.app.classList.remove('shake');
    if (fw) { fctx.setTransform(1, 0, 0, 1, 0, 0); fctx.clearRect(0, 0, el.fx.width, el.fx.height); }
  }

  // ============================================================ [7] 4 hiệu ứng kết liễu
  /** Gom thông tin cần cho hiệu ứng: vị trí ô trên màn hình, quân thua, ô thắng. */
  function makeInfo() {
    const rect = el.board.getBoundingClientRect();
    const Lc = Object.assign({}, L);
    const at = (gx, gy) => ({ x: rect.left + (gx - Lc.minX + 0.5) * Lc.cell, y: rect.top + (gy - Lc.minY + 0.5) * Lc.cell });
    const loser = other(S.winner);
    const losers = [];
    for (const [k, s] of S.cells) {
      if (s !== loser) continue;
      const i = k.indexOf(',');
      losers.push([Number(k.slice(0, i)), Number(k.slice(i + 1))]);
    }
    return { rect, cell: Lc.cell, at, winner: S.winner, loser, losers, winCells: S.winLine || [] };
  }

  function hideLosers(info) {
    for (const [x, y] of info.losers) S.hidden.add(keyOf(x, y));
    drawBoard();
  }

  /** Quân vỡ thành hạt pixel */
  function shatter(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, TAU), sp = rnd(80, 460);
      spawn({
        x: x + rnd(-8, 8), y: y + rnd(-8, 8), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120,
        g: 1100, drag: 0.99, life: rnd(0.7, 1.6), size: rnd(2, 5) | 0 || 2,
        color: Math.random() < 0.2 ? '#ffffff' : color,
      });
    }
  }

  // ---- 1. Laser Slash & Shatter ----
  function effLaser(info) {
    const pts = info.winCells.map((c) => info.at(c[0], c[1]));
    const a = pts[0], b = pts[pts.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const ext = info.cell * 1.4;
    const A = { x: a.x - ux * ext, y: a.y - uy * ext };
    const B = { x: b.x + ux * ext, y: b.y + uy * ext };
    const SWEEP = 0.45;
    const per = clamp(Math.floor(900 / Math.max(1, info.losers.length)), 8, 36);
    let fired = false;
    return {
      duration: 2.3, destroys: true,
      update(dt, t) {
        if (t < SWEEP) {   // tia lửa theo đầu laser
          const p = t / SWEEP, hx = A.x + (B.x - A.x) * p, hy = A.y + (B.y - A.y) * p;
          for (let i = 0; i < 4; i++) {
            spawn({ x: hx, y: hy, vx: rnd(-160, 160), vy: rnd(-160, 160), g: 300, life: rnd(0.2, 0.5), size: rnd(2, 4) | 0 || 2, color: i % 2 ? '#fff' : T.fx.laser });
          }
        }
        if (!fired && t >= SWEEP) {   // laser chém tới nơi: rung màn hình + quân thua vỡ vụn
          fired = true;
          shake(650, 10);
          FX.flash = 0.85;
          const col = T[info.loser].color;
          for (const [x, y] of info.losers) { const p = info.at(x, y); shatter(p.x, p.y, per, col); }
          hideLosers(info);
        }
      },
      draw(c, t) {
        const fade = t < 0.9 ? 1 : Math.max(0, 1 - (t - 0.9) / 0.5);
        if (fade <= 0) return;
        const p = Math.min(1, t / SWEEP);
        const hx = A.x + (B.x - A.x) * p, hy = A.y + (B.y - A.y) * p;
        const w = info.cell * (0.34 + 0.05 * Math.sin(t * 60));
        c.save();
        c.globalAlpha = fade; c.lineCap = 'round';
        c.shadowColor = T.fx.laser; c.shadowBlur = 28; c.strokeStyle = T.fx.laser; c.lineWidth = w;
        c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(hx, hy); c.stroke();
        c.shadowBlur = 0; c.strokeStyle = T.fx.laserCore; c.lineWidth = w * 0.4;
        c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(hx, hy); c.stroke();
        c.restore();
      },
    };
  }

  // ---- 2. Black Hole ----
  function effBlackHole(info) {
    const r = info.rect;
    let cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (info.losers.length) {
      cx = 0; cy = 0;
      for (const [x, y] of info.losers) { const p = info.at(x, y); cx += p.x; cy += p.y; }
      cx /= info.losers.length; cy /= info.losers.length;
    }
    const R = Math.max(info.cell * 2, r.width * 0.13);
    const TRAVEL = 1.1, CLOSE = 2.5, DUR = 3.1;
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y);
      const dx = p.x - cx, dy = p.y - cy, rad = Math.hypot(dx, dy);
      return { rad, ang: Math.atan2(dy, dx), delay: 0.45 + Math.min(0.7, (rad / r.width) * 1.2) + Math.random() * 0.2 };
    });
    const colors = [T.fx.blackHole, T.fx.blackHoleRing, '#ffffff'];
    return {
      duration: DUR, destroys: true,
      init() { hideLosers(info); shake(2200, 2); },   // quân được vẽ lại bằng sprite bên dưới
      update(dt, t) {
        if (t < CLOSE - 0.2) {   // hạt xoáy quanh hố đen
          for (let i = 0; i < 2; i++) {
            spawn({ orbit: true, cx, cy, ang: rnd(0, TAU), rad: R * rnd(1.6, 3.2), vr: rnd(60, 140), w: rnd(2, 4), life: 2, size: rnd(1.5, 3), color: colors[(Math.random() * 3) | 0], round: true });
          }
        }
      },
      draw(c, t) {
        const h = t < 0.7 ? easeOutCubic(t / 0.7) : (t > CLOSE ? Math.max(0, 1 - (t - CLOSE) / (DUR - CLOSE)) : 1);
        const rr = R * h;
        if (rr > 1) {
          const g = c.createRadialGradient(cx, cy, rr * 0.6, cx, cy, rr * 2.4);
          g.addColorStop(0, 'rgba(138,61,255,0.55)'); g.addColorStop(1, 'rgba(138,61,255,0)');
          c.fillStyle = g; c.beginPath(); c.arc(cx, cy, rr * 2.4, 0, TAU); c.fill();
          c.lineWidth = 2;
          for (let i = 0; i < 4; i++) {   // vành xoáy quay
            const a0 = t * (2.5 - i * 0.5) + i;
            c.strokeStyle = i % 2 ? T.fx.blackHoleRing : T.fx.blackHole; c.globalAlpha = 0.8;
            c.beginPath(); c.arc(cx, cy, rr * (1.15 + i * 0.22), a0, a0 + 1.7); c.stroke();
          }
          c.globalAlpha = 1;
        }
        // quân thua bị hút xoáy vào tâm
        for (const s of sprites) {
          const u = clamp((t - s.delay) / TRAVEL, 0, 1);
          if (u >= 1) continue;
          const e = u * u;
          const rad = s.rad * (1 - e), ang = s.ang + e * 6.5;
          drawPiece(c, info.loser, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, info.cell,
            { scale: 1 - 0.9 * e, rot: e * 9, alpha: 1 - Math.max(0, (u - 0.85) / 0.15), glow: false });
        }
        if (rr > 1) {
          c.fillStyle = '#000'; c.beginPath(); c.arc(cx, cy, rr, 0, TAU); c.fill();
          c.strokeStyle = T.fx.blackHoleRing; c.lineWidth = 2; c.stroke();
        }
        if (t > CLOSE) {   // sóng xung kích khi hố đen đóng lại
          const q = (t - CLOSE) / (DUR - CLOSE);
          c.strokeStyle = T.fx.blackHole; c.globalAlpha = 1 - q; c.lineWidth = 4;
          c.beginPath(); c.arc(cx, cy, R * (1 + q * 2.2), 0, TAU); c.stroke(); c.globalAlpha = 1;
        }
      },
    };
  }

  // ---- 3. Thanos Snap ----
  function buildCracks(cx, cy) {
    const out = [];
    const maxR = Math.hypot(fw, fh);
    function grow(x, y, ang, len, depth) {
      const pts = [[x, y]];
      let total = 0, px = x, py = y, a = ang;
      while (total < len) {
        const seg = rnd(24, 60);
        a += rnd(-0.38, 0.38);
        px += Math.cos(a) * seg; py += Math.sin(a) * seg;
        pts.push([px, py]); total += seg;
        if (depth < 2 && Math.random() < 0.22) grow(px, py, a + rnd(0.5, 1.1) * (Math.random() < 0.5 ? -1 : 1), len * rnd(0.25, 0.45), depth + 1);
      }
      out.push({ pts, total });
    }
    const N = 10;
    for (let i = 0; i < N; i++) grow(cx, cy, (i * TAU) / N + rnd(-0.2, 0.2), maxR * rnd(0.35, 0.7), 0);
    return out;
  }

  function drawCracks(c, cracks, p, alpha) {
    c.save();
    c.lineJoin = 'round'; c.lineCap = 'round'; c.globalAlpha = alpha;
    for (const pass of [{ w: 5, col: 'rgba(0,0,0,0.55)' }, { w: 2, col: T.fx.crack }]) {
      c.lineWidth = pass.w; c.strokeStyle = pass.col;
      c.beginPath();
      for (const k of cracks) {
        let rem = k.total * p;
        c.moveTo(k.pts[0][0], k.pts[0][1]);
        for (let i = 1; i < k.pts.length && rem > 0; i++) {
          const [x0, y0] = k.pts[i - 1], [x1, y1] = k.pts[i];
          const sl = Math.hypot(x1 - x0, y1 - y0);
          if (rem >= sl) { c.lineTo(x1, y1); rem -= sl; }
          else { const f = rem / sl; c.lineTo(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f); rem = 0; }
        }
      }
      c.stroke();
    }
    c.restore();
  }

  function effSnap(info) {
    const r = info.rect;
    const per = clamp(Math.floor(1100 / Math.max(1, info.losers.length)), 10, 34);
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y);
      // sóng tro bụi quét từ trái sang phải
      return { x: p.x, y: p.y, delay: 0.55 + ((p.x - r.left) / r.width) * 1.0 + Math.random() * 0.15, done: false };
    });
    const col = T[info.loser].color;
    const dust = [col, '#d8d4ff', '#6b6890'];
    let cracks = null, snapped = false;
    return {
      duration: 3.5, destroys: true,
      init() { hideLosers(info); },
      update(dt, t) {
        if (!snapped && t >= 0.15) {   // "bụp" — màn hình nứt
          snapped = true;
          cracks = buildCracks(r.left + r.width * rnd(0.35, 0.65), r.top + r.height * rnd(0.35, 0.65));
          shake(600, 9); FX.flash = 0.75;
        }
        for (const s of sprites) {
          if (s.done || t < s.delay) continue;
          s.done = true;
          for (let i = 0; i < per; i++) {
            spawn({
              x: s.x + rnd(-info.cell * 0.3, info.cell * 0.3), y: s.y + rnd(-info.cell * 0.3, info.cell * 0.3),
              vx: rnd(30, 170), vy: rnd(-140, -20), turb: 260, drag: 0.985,
              life: rnd(0.9, 1.7), size: rnd(1.5, 3.2), color: dust[(Math.random() * 3) | 0],
            });
          }
        }
      },
      draw(c, t) {
        for (const s of sprites) {   // quân mờ dần rồi tan
          if (t >= s.delay + 0.4) continue;
          let x = s.x, y = s.y, al = 1;
          if (t > s.delay) { const q = (t - s.delay) / 0.4; al = 1 - q; x += q * 14; y -= q * 10; }
          else if (t > s.delay - 0.25) { x += rnd(-1.5, 1.5); y += rnd(-1.5, 1.5); }
          drawPiece(c, info.loser, x, y, info.cell, { alpha: al, glow: false });
        }
        if (cracks) {
          const p = clamp((t - 0.15) / 0.7, 0, 1);
          const alpha = t > 3.0 ? Math.max(0, 1 - (t - 3.0) / 0.5) : 1;
          drawCracks(c, cracks, p, alpha);
        }
      },
    };
  }

  // ---- 4. Arcade K.O Slam ----
  function koText(c, txt, x, y, size, alpha) {
    if (alpha <= 0) return;
    c.save();
    c.globalAlpha = alpha;
    c.font = '900 ' + size + 'px Impact, "Arial Black", "Segoe UI Black", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.lineWidth = size * 0.12; c.strokeStyle = T.fx.koStroke;
    c.strokeText(txt, x, y);
    const g = c.createLinearGradient(0, y - size / 2, 0, y + size / 2);
    g.addColorStop(0, T.fx.koTop); g.addColorStop(1, T.fx.koBottom);
    c.fillStyle = g; c.shadowColor = T.fx.koBottom; c.shadowBlur = size * 0.25;
    c.fillText(txt, x, y);
    c.restore();
  }

  function effKO() {
    const cx = fw / 2, cy = fh * 0.42;
    const fs = Math.min(fw * 0.28, 250);
    const HIT1 = 0.26, HIT2 = 1.25, DUR = 3.0;
    let h1 = false, h2 = false;
    const debris = (n, sp) => {
      for (let i = 0; i < n; i++) {
        const a = rnd(0, TAU), v = rnd(sp * 0.3, sp);
        spawn({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 600, drag: 0.992, life: rnd(0.6, 1.2), size: rnd(3, 7) | 0 || 3, color: ['#ffe27a', '#ff3d3d', '#ffffff'][(Math.random() * 3) | 0] });
      }
    };
    return {
      duration: DUR, destroys: false,
      update(dt, t) {
        if (!h1 && t >= HIT1) {   // đập xuống: rung mạnh + slow-motion 0.5 giây
          h1 = true; shake(800, 16); FX.flash = 0.9; FX.slowUntil = performance.now() + 500; debris(70, 700);
        }
        if (!h2 && t >= HIT2) { h2 = true; shake(500, 9); FX.flash = 0.45; debris(40, 450); }
      },
      draw(c, t) {
        const out = t > 2.5 ? Math.max(0, 1 - (t - 2.5) / 0.5) : 1;
        c.fillStyle = 'rgba(5,2,12,' + (Math.min(0.55, t * 2.2) * out) + ')';
        c.fillRect(0, 0, fw, fh);
        // K.O! lao từ rất to xuống rồi nảy nhẹ
        const p = Math.min(1, t / HIT1);
        const sc = t < HIT1 ? 5 - 4 * p * p : 1 + (t < 0.5 ? 0.12 * Math.sin(((t - HIT1) / 0.24) * Math.PI) : 0);
        koText(c, 'K.O!', cx, cy, fs * sc, Math.min(1, t / 0.12) * out);
        if (t >= HIT1) {   // sóng xung kích
          const q = (t - HIT1) / 0.7;
          if (q < 1) {
            c.save(); c.strokeStyle = T.fx.koTop; c.lineWidth = 8 * (1 - q); c.globalAlpha = 1 - q;
            c.beginPath(); c.arc(cx, cy, q * fw * 0.5, 0, TAU); c.stroke(); c.restore();
          }
        }
        if (t >= 1.1) {   // FATALITY đập tiếp
          const q = Math.min(1, (t - 1.1) / 0.15);
          koText(c, 'FATALITY', cx, cy + fs * 0.78, fs * 0.34 * (3 - 2 * q * q), out * Math.min(1, q * 2));
        }
      },
    };
  }

  // ======================================================================
  //  6 HIỆU ỨNG KẾT LIỄU MỞ RỘNG (số 5 → 10)
  //  Màu có thể đổi trong theme.js (mục fx); thiếu khóa nào thì dùng giá trị mặc định dưới đây.
  // ======================================================================
  const FXC = Object.assign({
    glitch: '#33ff66', glitchRed: '#ff2a55', glitchCyan: '#2affff',
    plasma: '#ff5ad8', plasmaCore: '#ffffff', supernova: '#ffd36b',
    ice: '#bfefff', iceDeep: '#5ec8ff', hammer: '#8b95a5', hammerHandle: '#8a5a2b',
    heat: '#ff3b1d', ember: '#ffb347',
    voidColor: '#7b2cff', chain: '#8a8aa6', loserGray: '#8f8fa3',
    bolt: '#9ad1ff', boltCore: '#ffffff', boltSpark: '#7ad7ff',
  }, T.fx);

  const pickOne = (arr) => arr[(Math.random() * arr.length) | 0];
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInCubic = (t) => t * t * t;
  const avgPoint = (pts, fallback) => {
    if (!pts.length) return fallback;
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  };
  const polyline = (c, pts) => {
    c.beginPath();
    for (let i = 0; i < pts.length; i++) { if (i) c.lineTo(pts[i][0], pts[i][1]); else c.moveTo(pts[i][0], pts[i][1]); }
    c.stroke();
  };
  /** Khoảng cách từ điểm p tới đoạn thẳng a-b */
  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  /** Vệt cháy đen mờ trên mặt ô (hình dạng cố định theo tọa độ ô để vẽ lại không bị đổi). */
  function drawScorch(c, px, py, cell, alpha, gx, gy) {
    let s = (((gx * 374761393) ^ (gy * 668265263)) >>> 0) || 1;
    const rr = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    c.save();
    c.translate(px, py);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, cell * 0.55);
    g.addColorStop(0, 'rgba(0,0,0,' + 0.6 * alpha + ')');
    g.addColorStop(0.6, 'rgba(8,4,10,' + 0.35 * alpha + ')');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, cell * 0.55, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(0,0,0,' + 0.45 * alpha + ')';
    c.lineWidth = Math.max(1, cell * 0.05); c.lineCap = 'round';
    for (let i = 0; i < 7; i++) {   // tia cháy lan ra từ tâm
      const a = rr() * TAU, a2 = a + (rr() - 0.5) * 0.6;
      const l1 = cell * (0.2 + rr() * 0.15), l2 = cell * (0.4 + rr() * 0.15);
      c.beginPath();
      c.moveTo(Math.cos(a) * l1, Math.sin(a) * l1);
      c.lineTo(Math.cos(a2) * l2, Math.sin(a2) * l2);
      c.stroke();
    }
    c.restore();
  }

  // ---------------------------------------------------------------- 5. Glitch / Matrix Deletion
  function makeScanPattern() {
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 4;
    const x = cv.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.55)';
    x.fillRect(0, 0, 4, 2);
    return fctx.createPattern(cv, 'repeat');
  }

  function effGlitch(info) {
    const GREEN = FXC.glitch;
    const scan = makeScanPattern();
    const fs = clamp(info.cell * 0.5, 11, 20);
    const DUR = 3.3;
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y);
      return { x: p.x, y: p.y, delay: 0.55 + Math.random() * 0.9, rainUntil: 0, started: false };
    });
    return {
      duration: DUR, destroys: true,
      init() { hideLosers(info); },
      update(dt, t) {
        // Chromatic aberration (tách màu RGB) cực nhẹ trên bàn cờ trong 0.3s đầu
        if (t < 0.3) {
          const k = 1 - t / 0.3, d = (2 + rnd(0, 1.5)) * k;
          el.board.style.filter = 'drop-shadow(' + (-d) + 'px 0 0 rgba(255,0,70,.8)) drop-shadow(' + d + 'px 0 0 rgba(0,255,255,.8))';
        } else if (el.board.style.filter) el.board.style.filter = '';
        for (const s of sprites) {
          if (!s.started && t >= s.delay) { s.started = true; s.rainUntil = t + rnd(0.5, 0.9); }
          if (s.started && t < s.rainUntil && Math.random() < 0.8) {   // mưa số rơi thẳng xuống
            spawn({
              x: s.x + rnd(-info.cell * 0.4, info.cell * 0.4), y: s.y + rnd(-info.cell * 0.4, info.cell * 0.2),
              vx: 0, vy: rnd(200, 520), life: rnd(0.7, 1.4), size: fs,
              color: Math.random() < 0.15 ? '#eafff0' : GREEN, char: Math.random() < 0.5 ? '0' : '1',
            });
          }
        }
      },
      draw(c, t) {
        const fade = t > DUR - 0.5 ? Math.max(0, (DUR - t) / 0.5) : 1;
        // quân thua méo mó, tách màu, nháy trước khi hóa thành mã
        for (const s of sprites) {
          if (s.started && t >= s.delay + 0.2) continue;
          const amt = clamp(t / s.delay, 0, 1);
          const al = s.started ? 1 - (t - s.delay) / 0.2 : 1;
          const j = Math.random() < amt * 0.7 ? rnd(-1, 1) * info.cell * 0.25 * amt : 0;
          c.save();
          c.globalCompositeOperation = 'lighter';
          drawPiece(c, info.loser, s.x - j - 2, s.y, info.cell, { alpha: al * 0.7, glow: false, color: FXC.glitchRed });
          drawPiece(c, info.loser, s.x + j + 2, s.y, info.cell, { alpha: al * 0.7, glow: false, color: FXC.glitchCyan });
          c.restore();
          drawPiece(c, info.loser, s.x + j * 0.5, s.y, info.cell, { alpha: al, glow: false });
        }
        // nháy overlay
        if (Math.random() < 0.25) { c.fillStyle = 'rgba(40,255,120,' + rnd(0.03, 0.09) * fade + ')'; c.fillRect(0, 0, fw, fh); }
        // scanline (chạy chậm xuống)
        c.save();
        c.globalAlpha = 0.22 * fade; c.fillStyle = scan;
        c.translate(0, (t * 30) % 4);
        c.fillRect(0, -4, fw, fh + 4);
        c.restore();
        // dải sáng quét dọc màn hình
        const by = (((t * 0.9) % 1.2) - 0.1) * fh;
        const g = c.createLinearGradient(0, by - 60, 0, by + 60);
        g.addColorStop(0, 'rgba(60,255,140,0)'); g.addColorStop(0.5, 'rgba(60,255,140,' + 0.1 * fade + ')'); g.addColorStop(1, 'rgba(60,255,140,0)');
        c.fillStyle = g; c.fillRect(0, by - 60, fw, 120);
        // thỉnh thoảng xé hình ngang
        if (t < 2.4 && Math.random() < 0.12) { c.fillStyle = 'rgba(0,255,160,0.12)'; c.fillRect(0, rnd(0, fh), fw, rnd(2, 12)); }
      },
      cleanup() { el.board.style.filter = ''; },
    };
  }

  // ---------------------------------------------------------------- 6. Supernova Burst
  function effSupernova(info) {
    const P = info.winCells.map((c) => info.at(c[0], c[1]));
    const a = P[0], b = P[P.length - 1];
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const LINK = 0.9, SQUEEZE = 1.1, BURST = 1.8, DUR = 3.6;
    const maxR = Math.hypot(fw, fh);
    const dx = b.x - a.x, dy = b.y - a.y, LEN = Math.hypot(dx, dy) || 1, nx = -dy / LEN, ny = dx / LEN;
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y);
      let ux = p.x - cx, uy = p.y - cy, d = Math.hypot(ux, uy);
      if (d < 1) { ux = 1; uy = 0; d = 1; }
      return { x: p.x, y: p.y, ox: p.x, oy: p.y, ux: ux / d, uy: uy / d, d, vx: 0, vy: 0, rot: 0, spin: rnd(-9, 9), gone: false };
    });
    const rings = [];
    let burst = false;
    const smoke = (x, y) => spawn({ x, y, vx: rnd(-20, 20), vy: rnd(-20, 20), life: rnd(0.5, 1), size: rnd(5, 10), grow: 25, color: 'rgb(200,200,220)', round: true, a: 0.25 });
    return {
      duration: DUR, destroys: true,
      init() { hideLosers(info); },
      update(dt, t) {
        if (t > 0.5 && t < BURST) {   // hạt năng lượng dồn về tâm
          const n = 1 + Math.floor((t - 0.5) * 5);
          for (let i = 0; i < n; i++) {
            const ang = rnd(0, TAU), R = rnd(90, 300), v = R / rnd(0.35, 0.6);
            spawn({ x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R, vx: -Math.cos(ang) * v, vy: -Math.sin(ang) * v, life: R / v, size: rnd(2, 4), color: pickOne([FXC.plasma, FXC.plasmaCore, FXC.supernova]), round: true });
          }
        }
        if (!burst && t >= BURST) {   // BÙNG NỔ
          burst = true;
          shake(1000, 15); FX.flash = 1; FX.flashRate = 1.6;
          rings.push({ t0: t, w: 14 }, { t0: t + 0.12, w: 8 });
          for (const s of sprites) {
            const sp = 700 + 900 * Math.min(1, 160 / (s.d + 80)) + rnd(0, 250);   // gần tâm bị thổi mạnh hơn
            s.vx = s.ux * sp; s.vy = s.uy * sp;
          }
          for (let i = 0; i < 140; i++) {
            const ang = rnd(0, TAU), v = rnd(150, 900);
            spawn({ x: cx, y: cy, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, drag: 0.96, life: rnd(0.5, 1.3), size: rnd(2, 5), color: pickOne([FXC.plasmaCore, FXC.supernova, FXC.plasma]), round: true });
          }
        }
        if (burst) {
          for (const s of sprites) {   // quân bị thổi bay ra mép màn hình, để lại vệt khói
            if (s.gone) continue;
            s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.spin * dt;
            if (s.x < -80 || s.x > fw + 80 || s.y < -80 || s.y > fh + 80) { s.gone = true; continue; }
            smoke(s.x, s.y); smoke(s.x, s.y);
          }
        }
      },
      draw(c, t) {
        const q = easeInCubic(clamp((t - SQUEEZE) / (BURST - SQUEEZE), 0, 1));
        const fade = t < BURST ? 1 : Math.max(0, 1 - (t - BURST) / 0.25);
        c.save();
        c.globalCompositeOperation = 'lighter';
        if (fade > 0) {
          // luồng plasma nối các ô thắng
          const link = clamp(t / LINK, 0, 1);
          const ex = lerp(a.x, b.x, link), ey = lerp(a.y, b.y, link);
          const squeeze = 1 - q * 0.6;
          for (let k = 0; k < 3; k++) {
            c.beginPath();
            const segs = 36;
            for (let i = 0; i <= segs; i++) {
              const s = i / segs;
              const amp = info.cell * 0.28 * Math.sin(Math.PI * s) * squeeze * (k === 0 ? 0.4 : 1);
              const off = Math.sin(s * 14 + t * 14 + k * 2.1) * amp;
              const px = lerp(a.x, ex, s) + nx * off, py = lerp(a.y, ey, s) + ny * off;
              if (i) c.lineTo(px, py); else c.moveTo(px, py);
            }
            c.strokeStyle = k === 0 ? FXC.plasmaCore : (k === 1 ? FXC.plasma : FXC.supernova);
            c.lineWidth = k === 0 ? 3 : 5; c.globalAlpha = fade * (k === 0 ? 1 : 0.55);
            c.shadowColor = FXC.plasma; c.shadowBlur = 18;
            c.stroke();
          }
          c.shadowBlur = 0;
          // các ô thắng dồn năng lượng về tâm
          P.forEach((p, i) => {
            if (link * (P.length - 1) < i - 0.5) return;
            const px = lerp(p.x, cx, q), py = lerp(p.y, cy, q);
            const r = info.cell * (0.45 + 0.2 * Math.sin(t * 12 + i));
            const g = c.createRadialGradient(px, py, 0, px, py, r);
            g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.4, FXC.plasma); g.addColorStop(1, 'rgba(255,90,216,0)');
            c.globalAlpha = fade * 0.9; c.fillStyle = g;
            c.beginPath(); c.arc(px, py, r, 0, TAU); c.fill();
          });
          // tâm sáng cực đại
          if (t > SQUEEZE) {
            const r = info.cell * (0.3 + 3.2 * q * q);
            const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
            g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, FXC.supernova); g.addColorStop(1, 'rgba(255,211,107,0)');
            c.globalAlpha = fade; c.fillStyle = g;
            c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.fill();
          }
        }
        // shockwave hình tròn dạt ra viền canvas
        for (const r of rings) {
          const age = t - r.t0;
          if (age < 0) continue;
          const rad = age * 1700;
          if (rad > maxR) continue;
          c.globalAlpha = clamp(1 - rad / maxR, 0, 1);
          c.lineWidth = r.w * (1 - rad / maxR) + 1;
          c.strokeStyle = FXC.supernova; c.shadowColor = FXC.plasma; c.shadowBlur = 22;
          c.beginPath(); c.arc(cx, cy, rad, 0, TAU); c.stroke();
        }
        c.restore();
        // quân đối thủ rung lên rồi bị thổi bay
        for (const s of sprites) {
          if (s.gone) continue;
          const sh = burst ? 0 : q * 3;
          drawPiece(c, info.loser, s.x + rnd(-sh, sh), s.y + rnd(-sh, sh), info.cell, { rot: s.rot, glow: false });
        }
      },
    };
  }

  // ---------------------------------------------------------------- 7. Liquid Nitrogen & Hammer Smash
  function drawHammer(c, x, y, hs, rot, alpha) {
    c.save();
    c.globalAlpha = alpha;
    c.translate(x, y);
    c.rotate(rot);
    const hw = hs * 0.16, hl = hs * 1.9, bw = hs, bh = hs * 0.52;
    c.lineWidth = 3; c.strokeStyle = '#140a04';
    let g = c.createLinearGradient(-hw / 2, 0, hw / 2, 0);   // cán búa
    g.addColorStop(0, '#5d3a1a'); g.addColorStop(0.5, FXC.hammerHandle); g.addColorStop(1, '#4a2d14');
    c.fillStyle = g;
    c.beginPath(); c.rect(-hw / 2, -bh - hl, hw, hl); c.fill(); c.stroke();
    g = c.createLinearGradient(0, -bh, 0, 0);                // đầu búa, mặt đập ở y = 0
    g.addColorStop(0, '#d3dbe6'); g.addColorStop(0.45, FXC.hammer); g.addColorStop(1, '#4b5361');
    c.fillStyle = g;
    c.beginPath(); c.rect(-bw / 2, -bh, bw, bh); c.fill(); c.stroke();
    c.fillStyle = '#39414d';
    c.fillRect(-bw / 2 - hs * 0.06, -bh, hs * 0.06, bh); c.fillRect(bw / 2, -bh, hs * 0.06, bh);
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.fillRect(-bw / 2 + 4, -bh + 4, bw - 8, 5);
    c.restore();
  }

  function effIce(info) {
    const r = info.rect;
    const hs = clamp(r.width * 0.3, 80, 200);
    const HIT = 1.3, SWING = 0.35, DUR = 3.0;
    const C = avgPoint(info.losers.map(([x, y]) => info.at(x, y)), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const hx = C.x, hy = C.y + info.cell * 0.5;
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y), d = Math.hypot(p.x - C.x, p.y - C.y);
      return {
        x: p.x, y: p.y, d, broke: false,
        freeze: 0.1 + ((p.x - r.left) / r.width) * 0.7,              // sương quét từ trái sang phải
        breakAt: HIT + Math.min(0.3, (d / Math.max(1, r.width)) * 0.4), // sóng chấn động lan từ điểm đập
        ice: [rnd(0.14, 0.3), rnd(0.16, 0.34), rnd(0.12, 0.28)],
      };
    });
    const fog = Array.from({ length: 16 }, () => ({ y: r.top + Math.random() * r.height, x0: r.left - rnd(60, 200), sp: rnd(0.9, 1.4), rad: rnd(70, 150), a: rnd(0.18, 0.35) }));
    const palette = ['#e8fbff', '#9fe3ff', '#5ec8ff', '#ffffff'];
    let hit = false, h2 = false, h3 = false;
    return {
      duration: DUR, destroys: true,
      init() { hideLosers(info); },
      update(dt, t) {
        if (t < 1.4) spawn({ x: r.left + Math.random() * r.width, y: r.top + Math.random() * r.height, vx: rnd(-10, 10), vy: rnd(8, 30), life: rnd(0.8, 1.5), size: rnd(1.5, 3), color: '#e8fbff', round: true, a: 0.7 });
        if (!hit && t >= HIT) {   // búa đập: rung chấn dồn dập
          hit = true; shake(900, 16); FX.flash = 0.55; FX.flashRate = 4;
          for (let i = 0; i < 40; i++) { const a = rnd(0, TAU), v = rnd(100, 500); spawn({ x: hx, y: hy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80, drag: 0.95, g: 400, life: rnd(0.4, 0.9), size: rnd(2, 4), color: '#ffffff', round: true }); }
        }
        if (!h2 && t >= HIT + 0.18) { h2 = true; shake(500, 11); }
        if (!h3 && t >= HIT + 0.34) { h3 = true; shake(400, 7); }
        for (const s of sprites) {
          if (s.broke || t < s.breakAt) continue;
          s.broke = true;   // băng vỡ thành mảnh tam giác/đa giác
          const base = Math.atan2(s.y - C.y, s.x - C.x);
          for (let i = 0; i < 11; i++) {
            const n = Math.random() < 0.6 ? 3 : 4, rad = info.cell * rnd(0.12, 0.3), poly = [];
            const a0 = rnd(0, TAU);
            for (let k = 0; k < n; k++) { const a = a0 + (k / n) * TAU + rnd(-0.4, 0.4), rr = rad * rnd(0.6, 1.1); poly.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
            const a = base + rnd(-0.9, 0.9), v = rnd(200, 750);
            spawn({ x: s.x, y: s.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, g: 1000, drag: 0.995, rot: rnd(0, TAU), spin: rnd(-12, 12), life: rnd(1, 1.8), poly, color: pickOne(palette), edge: '#ffffff' });
          }
        }
      },
      draw(c, t) {
        // làn sương lạnh tràn qua bàn cờ
        const fogA = Math.min(1, t / 0.3) * (t > 1.9 ? Math.max(0, 1 - (t - 1.9) / 0.8) : 1);
        if (fogA > 0) {
          for (const f of fog) {
            const px = f.x0 + t * f.sp * r.width * 0.9;
            if (px - f.rad > r.left + r.width + 100) continue;
            const g = c.createRadialGradient(px, f.y, 0, px, f.y, f.rad);
            g.addColorStop(0, 'rgba(205,238,255,' + f.a * fogA + ')'); g.addColorStop(1, 'rgba(205,238,255,0)');
            c.fillStyle = g; c.beginPath(); c.arc(px, f.y, f.rad, 0, TAU); c.fill();
          }
        }
        // quân đối thủ đóng băng: xanh băng tuyết + vành sương giá + băng nhũ
        for (const s of sprites) {
          if (s.broke) continue;
          const k = clamp((t - s.freeze) / 0.35, 0, 1);
          drawPiece(c, info.loser, s.x, s.y, info.cell, { alpha: 1 - k * 0.6, glow: false });
          if (k > 0) {
            drawPiece(c, info.loser, s.x, s.y, info.cell, { alpha: k, glow: false, color: FXC.ice });
            c.strokeStyle = 'rgba(220,245,255,' + 0.7 * k + ')'; c.lineWidth = 2;
            c.beginPath(); c.arc(s.x, s.y, info.cell * 0.42, 0, TAU); c.stroke();
            c.fillStyle = 'rgba(205,240,255,' + 0.9 * k + ')'; c.strokeStyle = 'rgba(255,255,255,' + k + ')'; c.lineWidth = 1;
            for (let i = 0; i < 3; i++) {
              const ix = s.x + (i - 1) * info.cell * 0.2, iy = s.y + info.cell * 0.22, w = info.cell * 0.06, l = s.ice[i] * info.cell * k;
              c.beginPath(); c.moveTo(ix - w, iy); c.lineTo(ix + w, iy); c.lineTo(ix, iy + l); c.closePath(); c.fill(); c.stroke();
            }
          }
        }
        // chiếc búa tạ vector giáng từ trên xuống
        if (t >= HIT - SWING && t < HIT + 0.9) {
          const e = easeInCubic(clamp((t - (HIT - SWING)) / SWING, 0, 1));
          let y = lerp(hy - fh * 0.9, hy, e), rot = lerp(-0.45, 0, e), al = 1;
          if (t > HIT + 0.35) { const q = clamp((t - HIT - 0.35) / 0.5, 0, 1); y = hy - q * fh * 0.5; rot = q * 0.2; al = 1 - q; }
          drawHammer(c, hx, y, hs, rot, al);
        }
        if (t >= HIT) {   // vòng xung kích tại điểm đập
          const age = t - HIT, rad = age * 900;
          if (age < 0.6) { c.save(); c.strokeStyle = '#ffffff'; c.globalAlpha = 1 - age / 0.6; c.lineWidth = 6 * (1 - age / 0.6) + 1; c.beginPath(); c.arc(hx, hy, rad, 0, TAU); c.stroke(); c.restore(); }
        }
      },
    };
  }

  // ---------------------------------------------------------------- 8. Nuclear Meltdown / Acid Burn
  function effMelt(info) {
    const r = info.rect;
    const P = info.winCells.map((c) => info.at(c[0], c[1]));
    const a = P[0], b = P[P.length - 1];
    const HEAT = 0.8, DUR = 3.8, PMAX = 26;
    const glowOK = info.losers.length <= 60;   // nhiều quân quá thì bỏ glow cho nhẹ máy
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y), d = distToSegment(p, a, b);
      const heatAt = 0.45 + Math.min(1.1, (d / (r.width * 0.5)) * 1.1) + Math.random() * 0.15;   // nhiệt lan từ vệt thắng
      return { x: p.x, y: p.y, heatAt, meltAt: heatAt + 0.9, nextDrip: 0 };
    });
    let puddle = 0;
    const smoke = (x, y) => spawn({ x, y, vx: rnd(-14, 14), vy: -rnd(35, 80), life: rnd(1, 1.9), size: rnd(5, 9), grow: 16, color: 'rgb(205,205,215)', round: true, a: 0.22 });
    return {
      duration: DUR, destroys: true,
      init() { hideLosers(info); },
      update(dt, t) {
        for (const s of sprites) {
          if (t > s.heatAt + 0.4 && Math.random() < dt * 2.5) smoke(s.x + rnd(-6, 6), s.y);
          const m = (t - s.meltAt) / 1.3;
          if (m > 0 && m < 1) {   // chảy xệ: nhỏ giọt từ đáy quân
            s.nextDrip -= dt;
            if (s.nextDrip <= 0) {
              s.nextDrip = rnd(0.08, 0.22);
              spawn({ x: s.x + rnd(-0.3, 0.3) * info.cell, y: s.y + info.cell * 0.3, vx: rnd(-8, 8), vy: rnd(20, 80), g: 800, life: 4, size: rnd(3, 6), color: pickOne([FXC.heat, FXC.ember, '#ffd24a']), drop: true });
            }
          }
        }
        for (const p of FX.parts) {   // giọt chạm đáy màn hình thì dồn thành vũng
          if (p.drop && p.y >= fh - puddle - 2) {
            p.life = 0; puddle = Math.min(PMAX, puddle + 0.5);
            spawn({ x: p.x, y: fh - puddle - 2, vx: rnd(-40, 40), vy: -rnd(40, 120), g: 600, life: 0.4, size: 2, color: FXC.ember, round: true });
          }
        }
        if (puddle > 2 && Math.random() < dt * 20) smoke(r.left + Math.random() * r.width, fh - puddle - 2);
      },
      draw(c, t) {
        // vệt thắng kích hoạt phản ứng nhiệt
        const hp = clamp(t / HEAT, 0, 1);
        const beamA = t < 2.6 ? 1 : Math.max(0, 1 - (t - 2.6) / 0.6);
        if (beamA > 0) {
          const ex = lerp(a.x, b.x, hp), ey = lerp(a.y, b.y, hp), pulse = 0.75 + 0.25 * Math.sin(t * 18);
          c.save();
          c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
          c.shadowColor = FXC.heat; c.shadowBlur = 26; c.globalAlpha = beamA * 0.8;
          c.strokeStyle = FXC.heat; c.lineWidth = info.cell * 0.5 * pulse;
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(ex, ey); c.stroke();
          c.shadowBlur = 0; c.strokeStyle = FXC.ember; c.lineWidth = info.cell * 0.2;
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(ex, ey); c.stroke();
          c.strokeStyle = '#ffffff'; c.lineWidth = info.cell * 0.07;
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(ex, ey); c.stroke();
          c.restore();
        }
        // quân đối thủ: đỏ rực như than hồng rồi chảy xệ xuống
        for (const s of sprites) {
          const k = clamp((t - s.heatAt) / 0.8, 0, 1), m = clamp((t - s.meltAt) / 1.3, 0, 1);
          if (m >= 1) continue;
          const alpha = 1 - m * m * m, by = s.y + info.cell * 0.5;
          c.save();
          c.translate(s.x, by); c.scale(1 + 0.35 * m, 1 - 0.88 * m); c.translate(-s.x, -by);
          drawPiece(c, info.loser, s.x, s.y, info.cell, { alpha: alpha * (1 - k), glow: false });
          if (k > 0) {
            drawPiece(c, info.loser, s.x, s.y, info.cell, { alpha: alpha * k, color: k < 0.55 ? FXC.heat : FXC.ember, glowColor: FXC.heat, glow: glowOK });
            if (k > 0.5) {   // lõi than hồng
              const cr = info.cell * 0.2 * k;
              const g = c.createRadialGradient(s.x, s.y, 0, s.x, s.y, cr);
              g.addColorStop(0, 'rgba(255,240,170,' + 0.85 * alpha + ')'); g.addColorStop(1, 'rgba(255,120,30,0)');
              c.fillStyle = g; c.beginPath(); c.arc(s.x, s.y, cr, 0, TAU); c.fill();
            }
          }
          c.restore();
        }
        // vũng chất lỏng nóng ở đáy màn hình
        if (puddle > 0.5) {
          const pa = t > DUR - 0.5 ? Math.max(0, (DUR - t) / 0.5) : 1, h = puddle + 3;
          const g = c.createLinearGradient(0, fh - h, 0, fh);
          g.addColorStop(0, 'rgba(255,120,30,0)'); g.addColorStop(0.3, FXC.ember); g.addColorStop(1, FXC.heat);
          c.save(); c.globalAlpha = pa; c.fillStyle = g;
          c.beginPath(); c.moveTo(0, fh);
          for (let x = 0; x <= fw; x += 12) c.lineTo(x, fh - h + Math.sin(x * 0.05 + t * 3) * 2);
          c.lineTo(fw, fh); c.closePath(); c.fill(); c.restore();
        }
      },
    };
  }

  // ---------------------------------------------------------------- 9. Domain Expansion / Dark Void
  function effDomain(info) {
    const cell = info.cell;
    const IN = 1.2, OUT = 0.45, DUR = 4.0;
    const win = info.winCells.map((c) => info.at(c[0], c[1]));
    const wc = T[info.winner].color;
    const C = avgPoint(win, { x: fw / 2, y: fh / 2 });
    const span = win.length > 1 ? Math.hypot(win[win.length - 1].x - win[0].x, win[win.length - 1].y - win[0].y) : 0;
    const R1 = Math.max(span / 2 + cell * 1.4, cell * 3);
    const sprites = info.losers.map(([x, y]) => {
      const p = info.at(x, y);
      return {
        x: p.x, y: p.y, delay: 1.1 + Math.random() * 0.9,
        tent: [0, 1, 2].map((i) => ({ ang: rnd(0, TAU), ph: rnd(0, TAU), chain: i % 2 === 1 })),   // xúc tu và xích
      };
    });
    let lastFilter = '';
    const strength = (t) => clamp(t / IN, 0, 1) * (t > DUR - OUT ? Math.max(0, (DUR - t) / OUT) : 1);
    return {
      duration: DUR, destroys: true,
      init() { hideLosers(info); },
      update(dt, t) {
        // bộ lọc xám tối cho cả trang; canvas hiệu ứng nằm ngoài #app nên quân thắng giữ nguyên màu
        const p = strength(t);
        const f = t < 0.14 ? 'invert(1) hue-rotate(180deg)' : 'grayscale(' + p.toFixed(2) + ') brightness(' + (1 - 0.6 * p).toFixed(2) + ') contrast(' + (1 + 0.25 * p).toFixed(2) + ')';
        if (f !== lastFilter) { el.app.style.filter = f; lastFilter = f; }
      },
      draw(c, t) {
        const p = strength(t), gp = clamp(t / IN, 0, 1);
        // vignette tối
        const vg = c.createRadialGradient(C.x, C.y, Math.min(fw, fh) * 0.1, C.x, C.y, Math.hypot(fw, fh) * 0.6);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(6,0,14,' + 0.85 * p + ')');
        c.fillStyle = vg; c.fillRect(0, 0, fw, fh);
        // vòng ấn lãnh địa quay quanh hàng thắng
        c.save();
        c.translate(C.x, C.y);
        c.globalAlpha = 0.55 * p; c.strokeStyle = wc; c.lineWidth = 2; c.shadowColor = wc; c.shadowBlur = 14;
        c.beginPath(); c.arc(0, 0, R1, 0, TAU); c.stroke();
        c.setLineDash([cell * 0.6, cell * 0.4]);
        c.rotate(t * 0.5); c.beginPath(); c.arc(0, 0, R1 * 1.1, 0, TAU); c.stroke();
        c.rotate(-t * 1.1); c.beginPath(); c.arc(0, 0, R1 * 0.82, 0, TAU); c.stroke();
        c.restore();

        // quân thua bị xích / xúc tu bóng tối kéo chìm xuống bề mặt
        for (const s of sprites) {
          const u = clamp((t - s.delay - 0.5) / 0.9, 0, 1);
          if (u >= 1 && t > s.delay + 1.7) continue;
          const pg = easeOutCubic(clamp((t - s.delay) / 0.4, 0, 1)) * (u >= 1 ? Math.max(0, 1 - (t - (s.delay + 1.4)) / 0.3) : 1);
          if (pg > 0) {   // hố tối dưới quân
            c.beginPath(); c.ellipse(s.x, s.y + cell * 0.18, cell * 0.58 * pg, cell * 0.3 * pg, 0, 0, TAU);
            c.fillStyle = '#05020a'; c.fill();
            c.strokeStyle = FXC.voidColor; c.globalAlpha = 0.8; c.lineWidth = 2; c.stroke(); c.globalAlpha = 1;
          }
          if (u < 1) {
            const by = s.y + cell * 0.3;
            c.save();
            c.translate(s.x, by); c.scale(1 - 0.35 * u, 1 - 0.9 * u); c.translate(-s.x, -by);
            drawPiece(c, info.loser, s.x, s.y, cell, { alpha: (1 - gp) * (1 - u * u), glow: false });
            drawPiece(c, info.loser, s.x, s.y, cell, { alpha: gp * (1 - u * u), glow: false, color: FXC.loserGray });
            c.restore();
          }
          const vis = easeOutCubic(clamp((t - s.delay) / 0.5, 0, 1)) * (1 - clamp((u - 0.3) / 0.7, 0, 1));
          if (vis > 0.01) {
            c.save();
            c.lineCap = 'round'; c.lineJoin = 'round';
            for (const tn of s.tent) {
              const pts = [];
              const n = 12, last = Math.max(1, Math.round(n * vis));
              for (let i = 0; i <= last; i++) {
                const k = i / n;
                pts.push([
                  s.x + Math.cos(tn.ang) * cell * 0.55 * (1 - k * 0.6) + Math.sin(k * 6 + t * 5 + tn.ph) * cell * 0.18 * k,
                  s.y + cell * 0.2 - k * cell * 1.1 * (1 - u * 0.6),
                ]);
              }
              if (tn.chain) {   // xích: nét đứt dày giống các mắt xích
                c.setLineDash([cell * 0.14, cell * 0.08]); c.lineWidth = cell * 0.14; c.strokeStyle = FXC.chain;
                polyline(c, pts);
                c.setLineDash([]);
              } else {          // xúc tu: lõi đen, viền tím
                c.lineWidth = cell * 0.2; c.strokeStyle = FXC.voidColor; c.globalAlpha = 0.6; polyline(c, pts);
                c.lineWidth = cell * 0.13; c.strokeStyle = '#12081f'; c.globalAlpha = 1; polyline(c, pts);
              }
            }
            c.restore();
          }
        }
        // hàng quân thắng giữ nguyên neon rực lửa
        for (const w of win) {
          const hr = cell * 1.2;
          const g = c.createRadialGradient(w.x, w.y, 0, w.x, w.y, hr);
          g.addColorStop(0, wc); g.addColorStop(1, 'rgba(0,0,0,0)');
          c.save(); c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.35 * p * (0.8 + 0.2 * Math.sin(t * 8)); c.fillStyle = g;
          c.beginPath(); c.arc(w.x, w.y, hr, 0, TAU); c.fill(); c.restore();
          drawPiece(c, info.winner, w.x, w.y, cell, { alpha: p });
        }
      },
      cleanup() { el.app.style.filter = ''; },
    };
  }

  // ---------------------------------------------------------------- 10. Lightning Judgement
  function makeBolt(x0, y0, x1, y1, cell) {
    const pts = [[x0, y0]];
    const n = 12 + ((Math.random() * 5) | 0);
    for (let i = 1; i < n; i++) {   // zig-zag, càng gần mục tiêu càng gọn
      const s = i / n, jit = cell * 1.1 * (1 - s * 0.7);
      pts.push([lerp(x0, x1, s) + rnd(-jit, jit), lerp(y0, y1, s)]);
    }
    pts.push([x1, y1]);
    const branches = [];
    for (let k = 0; k < 2; k++) {
      const i = 3 + ((Math.random() * Math.max(1, pts.length - 6)) | 0), dir = Math.random() < 0.5 ? -1 : 1;
      let px = pts[i][0], py = pts[i][1];
      const bp = [[px, py]];
      for (let j = 0; j < 4; j++) { px += dir * rnd(10, 34); py += rnd(14, 40); bp.push([px, py]); }
      branches.push(bp);
    }
    const arcs = [];   // tia điện nhỏ tóe ra tại điểm chạm
    for (let k = 0; k < 5; k++) {
      let px = x1, py = y1, a = rnd(0, TAU);
      const ap = [[px, py]];
      for (let j = 0; j < 3; j++) { a += rnd(-0.7, 0.7); px += Math.cos(a) * cell * 0.4; py += Math.sin(a) * cell * 0.4; ap.push([px, py]); }
      arcs.push(ap);
    }
    return { pts, branches, arcs };
  }

  function effLightning(info) {
    const cell = info.cell;
    const N = info.losers.length;
    const START = 0.35, TICK = 0.12;
    const perTick = Math.max(1, Math.ceil(N / 15));
    const ticks = Math.max(1, Math.ceil(N / perTick));
    const DUR = START + ticks * TICK + 0.9;
    const sprites = info.losers.map(([x, y]) => { const p = info.at(x, y); return { x: p.x, y: p.y, gx: x, gy: y, dead: false }; });
    const queue = sprites.slice().sort(() => Math.random() - 0.5);   // đánh ngẫu nhiên, liên tiếp
    const bolts = [], scorches = [];
    let nextTick = 0, qi = 0;
    function strike(s, t) {
      s.dead = true;
      bolts.push(Object.assign(makeBolt(s.x + rnd(-cell * 2, cell * 2), -10, s.x, s.y, cell), { born: t, life: 0.22 }));
      scorches.push({ x: s.x, y: s.y, gx: s.gx, gy: s.gy, born: t });
      for (let i = 0; i < 28; i++) {   // quân nổ tung thành tia lửa điện plasma
        const a = rnd(0, TAU), v = rnd(120, 620);
        spawn({ x: s.x, y: s.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 0.93, life: rnd(0.3, 0.8), size: rnd(2, 4), color: pickOne([FXC.boltCore, FXC.boltSpark, '#b58cff']), round: true });
      }
    }
    return {
      duration: DUR, destroys: true, marks: info.losers,
      init() { hideLosers(info); FX.flash = 1; FX.flashRate = 30; },   // chớp trắng 1-2 khung hình
      update(dt, t) {
        while (nextTick < ticks && t >= START + nextTick * TICK) {
          for (let j = 0; j < perTick && qi < queue.length; j++) strike(queue[qi++], t);
          nextTick++;
          shake(180, 5); FX.flash = Math.max(FX.flash, 0.3); FX.flashRate = 6;
        }
      },
      draw(c, t) {
        const mood = Math.min(1, t / 0.4) * (t > DUR - 0.5 ? Math.max(0, (DUR - t) / 0.5) : 1);
        c.fillStyle = 'rgba(5,8,25,' + 0.35 * mood + ')'; c.fillRect(0, 0, fw, fh);
        for (const sc of scorches) drawScorch(c, sc.x, sc.y, cell, clamp((t - sc.born) / 0.15, 0, 1), sc.gx, sc.gy);
        for (const s of sprites) if (!s.dead) drawPiece(c, info.loser, s.x, s.y, cell, { glow: false });
        c.save();
        c.lineJoin = 'round'; c.lineCap = 'round';
        for (const b of bolts) {
          const age = t - b.born;
          if (age > b.life) continue;
          const al = (1 - age / b.life) * (Math.random() < 0.75 ? 1 : 0.35);
          c.globalAlpha = al; c.shadowColor = FXC.bolt; c.shadowBlur = 24;
          c.strokeStyle = FXC.bolt; c.lineWidth = 6; polyline(c, b.pts);
          c.lineWidth = 3; for (const bp of b.branches) polyline(c, bp);
          c.shadowBlur = 0; c.strokeStyle = FXC.boltCore; c.lineWidth = 2.4; polyline(c, b.pts);
          if (age < 0.15) { c.lineWidth = 2; for (const ap of b.arcs) polyline(c, ap); }
        }
        c.restore();
      },
    };
  }

  const EFFECTS = [effLaser, effBlackHole, effSnap, effKO, effGlitch, effSupernova, effIce, effMelt, effDomain, effLightning];

  /** Chọn ngẫu nhiên 1 trong 10 hiệu ứng khi có người thắng. */
  function startFinish() {
    S.fxRunning = true;
    el.glow.hidden = true;
    el.result.hidden = true;
    updateUI();
    let eff;
    try {
      const info = makeInfo();
      const forced = Number(new URLSearchParams(location.search).get('fx'));   // chỉ để thử: ?fx=1..10
      const pick = forced >= 1 && forced <= EFFECTS.length ? forced - 1 : Math.floor(Math.random() * EFFECTS.length);
      eff = EFFECTS[pick](info);
      fxStart(eff, () => {
        if (eff.marks) { for (const [x, y] of eff.marks) S.marks.add(keyOf(x, y)); }   // vệt cháy ở lại trên bàn cờ
        if (eff.destroys) hideLosers(info);
        showResult();
      });
    } catch (err) {
      console.error('Lỗi hiệu ứng:', err);
      fxClear();
      showResult();
    }
  }

  // ============================================================ [8] Khởi động
  applyTheme();
  resizeFx();
  window.addEventListener('resize', resizeFx);
  connect();
})();
