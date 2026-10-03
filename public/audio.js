/**
 * audio.js — Mini player nhạc nền hỗ trợ Menu chọn bài.
 */
(function () {
  'use strict';

  const PLAYLIST = [
    { src: 'music/track1.mp3', label: 'Ai Ngoài Anh' },
    { src: 'music/track2.mp3', label: 'Giờ Thì' },
    { src: 'music/track3.mp3', label: 'Legends Never Die' },
    { src: 'music/track4.mp3', label: 'Để Mị Nói Cho Mà Nghe' }
  ];
  
  const DEFAULT_VOLUME = 0.35;
  let currentIndex = 0;

  const btn = document.getElementById('bgmToggle');
  const vol = document.getElementById('bgmVol');
  const select = document.getElementById('bgmSelect'); // Bắt ID của menu thả xuống

  // Đổ dữ liệu danh sách bài hát vào menu thả xuống
  PLAYLIST.forEach((track, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = track.label;
    // Đổi màu nền của lựa chọn để dễ nhìn trên trình duyệt
    option.style.background = '#1a1a2e'; 
    option.style.color = '#fff';
    select.appendChild(option);
  });

  const audio = new Audio();
  audio.src = PLAYLIST[currentIndex].src;
  audio.loop = false;
  audio.preload = 'none';
  audio.volume = DEFAULT_VOLUME;
  vol.value = String(DEFAULT_VOLUME);

  let wantPlay = true;
  let broken = false;

  function render() {
    const playing = !audio.paused && !broken;
    btn.textContent = playing ? '❚❚' : '♪';
    btn.classList.toggle('off', !playing);
    select.value = currentIndex; // Cập nhật menu về đúng bài đang phát
  }

  function tryPlay() {
    if (broken) return;
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});
  }

  audio.addEventListener('play', render);
  audio.addEventListener('pause', render);
  audio.addEventListener('error', () => { broken = true; render(); });

  // Tự động chuyển bài khi kết thúc
  audio.addEventListener('ended', () => {
    currentIndex++;
    if (currentIndex >= PLAYLIST.length) currentIndex = 0;
    audio.src = PLAYLIST[currentIndex].src;
    broken = false; 
    if (wantPlay) tryPlay();
    render();
  });

  // Bắt sự kiện khi người dùng tự chọn bài hát từ menu
  select.addEventListener('change', (e) => {
    currentIndex = Number(e.target.value);
    audio.src = PLAYLIST[currentIndex].src;
    broken = false;
    wantPlay = true; // Chọn bài xong tự động phát luôn
    tryPlay();
    render();
  });

  // Xử lý phát nhạc lần đầu
  function onFirstInteraction(e) {
    window.removeEventListener('pointerdown', onFirstInteraction, true);
    window.removeEventListener('keydown', onFirstInteraction, true);
    if (e && e.target && e.target.closest && e.target.closest('#bgm')) return;
    if (wantPlay) tryPlay();
  }
  window.addEventListener('pointerdown', onFirstInteraction, true);
  window.addEventListener('keydown', onFirstInteraction, true);

  btn.addEventListener('click', () => {
    wantPlay = audio.paused;
    if (wantPlay) tryPlay(); else audio.pause();
    render();
  });
  
  vol.addEventListener('input', () => { audio.volume = Number(vol.value); });

  render();
})();