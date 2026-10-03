/**
 * theme.js — NƠI BẠN TỰ CUSTOM giao diện. Sửa file này là đổi được hầu hết diện mạo game,
 * không cần đụng vào app.js.
 *
 * Màu dùng bất kỳ giá trị CSS hợp lệ nào (#hex, rgb(), rgba()).
 * Riêng `background` nhận mọi giá trị của thuộc tính CSS `background`
 * (màu, gradient, hoặc ảnh: "url(/anh/nen.jpg) center/cover").
 */
window.THEME = {
  // Nền toàn trang + màu chữ + màu nhấn
  page: {
    background: 'radial-gradient(1100px 650px at 50% -10%, #2b1560 0%, #0d0b21 58%, #07060f 100%)',
    text: '#ece9ff',
    muted: '#a39fd0',
    accent: '#ff3d81',   // nút chính
    accent2: '#26e4ff',  // nút phụ, viền
    panel: 'rgba(23, 20, 58, 0.92)',
  },

  // Bàn cờ
  board: {
    background: 'linear-gradient(145deg, #171340 0%, #0e0c28 100%)',
    gridColor: 'rgba(125, 135, 255, 0.30)', // đường kẻ lưới
    gridWidth: 1,
    borderColor: 'rgba(125, 135, 255, 0.50)',
  },

  // Quân cờ. Muốn dùng ảnh riêng: đặt file vào public/ rồi điền đường dẫn vào `image`
  // (ví dụ '/img/x.png'). Để null thì tự vẽ nét X / O.
  X: { color: '#ff3d81', glow: 'rgba(255, 61, 129, 0.95)', lineWidth: 0.13, image: null },
  O: { color: '#26e4ff', glow: 'rgba(38, 228, 255, 0.95)', lineWidth: 0.13, image: null },

  // Hiệu ứng nước vừa đánh: vòng sóng + lớp sáng nhấp nháy
  lastMove: {
    ripple: 'rgba(255, 209, 102, 0.95)',
    glow: 'rgba(255, 209, 102, 0.95)',
  },

  // Màu của 4 hiệu ứng kết liễu
  fx: {
    laser: '#ff2a6d',
    laserCore: '#ffffff',
    blackHole: '#8a3dff',
    blackHoleRing: '#26e4ff',
    crack: '#ffffff',
    koTop: '#ffe27a',
    koBottom: '#ff3d3d',
    koStroke: '#1a0610',

    // --- 6 hiệu ứng mở rộng (số 5 → 10) ---
    glitch: '#33ff66', glitchRed: '#ff2a55', glitchCyan: '#2affff',      // 5. Glitch / Matrix
    plasma: '#ff5ad8', plasmaCore: '#ffffff', supernova: '#ffd36b',       // 6. Supernova
    ice: '#bfefff', iceDeep: '#5ec8ff', hammer: '#8b95a5', hammerHandle: '#8a5a2b', // 7. Nitrogen + búa
    heat: '#ff3b1d', ember: '#ffb347',                                     // 8. Meltdown
    voidColor: '#7b2cff', chain: '#8a8aa6', loserGray: '#8f8fa3',          // 9. Domain / Dark Void
    bolt: '#9ad1ff', boltCore: '#ffffff', boltSpark: '#7ad7ff',            // 10. Lightning
  },
};
