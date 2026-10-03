# Cờ Ca-rô Vibe

Cờ Ca-rô (Gomoku) realtime. Bàn 10x10, cứ 10 nước thì mở rộng thêm 1 vòng. Có chế độ Solo vs AI (Gemini) và PvP 1v1 bằng mã phòng 4 số.
Không database, mọi phòng nằm trên RAM, chạy ổn trên VPS 1GB.

## Chạy thử

```bash
npm install
cp .env.example .env      # điền GEMINI_API_KEY (bỏ trống vẫn chơi được, AI dùng heuristic + câu khịa dựng sẵn)
npm test                  # 22 test cho luật cờ + AI
npm start                 # http://localhost:3000
```

Cần Node 18 trở lên.

## Cấu trúc

```
server.js      web server + WebSocket, quản lý phòng trên RAM
gameLogic.js   luật cờ: chặn 2 đầu, mở rộng bàn
ai.js          heuristic + Gemini (chọn nước + câu khịa)
public/
  index.html   khung giao diện
  theme.js     TỰ CUSTOM: màu, quân X/O, lưới, màu hiệu ứng
  style.css    giao diện, animation nhấp nháy, rung màn hình
  audio.js     mini player nhạc nền
  app.js       client WebSocket, vẽ canvas, 4 hiệu ứng kết liễu
  music/       đặt bgm.mp3 vào đây
```

## Tự custom

- **Màu, nền, quân cờ, lưới:** sửa `public/theme.js`. Muốn dùng ảnh riêng cho quân, điền đường dẫn vào `X.image` / `O.image`.
- **Nhạc nền:** đặt `public/music/bgm.mp3`, hoặc dán link stream vào `BGM_CONFIG.src` trong `public/audio.js`. Trình duyệt chỉ cho phát nhạc sau lần chạm đầu tiên.
- **Xem thử từng hiệu ứng kết liễu:** thêm `?fx=1` đến `?fx=4` vào địa chỉ (1 Laser, 2 Black Hole, 3 Thanos Snap, 4 K.O). Không có tham số thì chọn ngẫu nhiên.
- **Đổi model Gemini:** sửa `GEMINI_MODEL` trong `.env`.

## Luật đã chốt

- Thắng: từ 5 quân liên tiếp trở lên. Cả 2 đầu bị quân đối phương chặn thì chưa thắng. Biên bàn cờ không tính là chặn.
- Không có hòa, không có đồng hồ lượt.
- Ván sau đổi người đi trước (cả PvE lẫn PvP).
- Mất kết nối: giữ chỗ 30 giây. Quá hạn hoặc bấm Rời phòng giữa ván PvP thì đối thủ được tính thắng và phòng bị hủy. Phòng chờ không ai vào tự hủy sau 10 phút.

## Đưa lên VPS

Chạy nền bằng pm2, giới hạn RAM:

```bash
npm install -g pm2
pm2 start server.js --name caro --node-args="--max-old-space-size=256"
pm2 save && pm2 startup
```

Caddy (tự lo HTTPS và WebSocket):

```
caro.ten-mien-cua-ban.com {
    reverse_proxy localhost:3000
}
```

Nginx cần thêm header nâng cấp cho đường `/ws`:

```
location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
location / { proxy_pass http://127.0.0.1:3000; }
```

Site chạy https thì client tự dùng `wss://`. Kiểm tra server sống: `GET /healthz`.
