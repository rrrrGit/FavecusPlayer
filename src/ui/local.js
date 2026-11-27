'use strict';
const params = new URL(location.href).searchParams;
const name = params.get('media');
const video = document.getElementById('local-video'), offline = params.get('offline');
const playback = params.get('playback');
if (/^[a-f0-9]{64}\.(mp4|m4a)$/.test(offline || '') && /^[a-f0-9-]{36}$/.test(playback || '')) video.src = `favecus://offline/${offline}?playback=${playback}`;
if (/^[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(name || '')) video.src = `favecus://media/${name}`;
video.addEventListener('error', () => { document.getElementById('local-error').textContent = '再生できません。ファイルの有無と形式を確認してください。MP4はH.264/AAC、WebMはVP8/VP9/Opusが目安です。'; });

// ---- オリジナルの操作（ブラウザー標準のコントロールの代わり）。音量は下部の再生バーが担当する（preloadが全体の音量を管理するため、ここでは触れない）。
const $ = id => document.getElementById(id);
const controls = $('local-controls'), toggle = $('local-toggle'), seek = $('local-seek'), time = $('local-time');
const bridge = window.favecusPlayer; // preloadが、この画面にだけ公開する（拡大・画質の要求）
const format = seconds => { seconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0; return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
let scrubbing = false, idleTimer = null;
function Paint() {
  document.body.classList.toggle('is-paused', video.paused);
  const duration = video.duration > 0 ? video.duration : 0;
  time.textContent = `${format(video.currentTime)} / ${format(duration)}`;
  if (!scrubbing) seek.value = duration ? String(Math.round(video.currentTime / duration * 1000)) : '0';
  seek.disabled = !duration;
}
function Wake() {
  document.body.classList.add('is-active'); document.body.classList.remove('is-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && $('local-quality-menu').hidden) { document.body.classList.remove('is-active'); document.body.classList.add('is-idle'); } }, 2600);
}
const PlayPause = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
for (const button of controls.querySelectorAll('button')) button.addEventListener('mousedown', event => event.preventDefault()); // ボタンにフォーカスを残さない（Spaceなどが二重に働くのを防ぐ）
toggle.addEventListener('click', PlayPause);
video.addEventListener('click', PlayPause);
video.addEventListener('dblclick', () => bridge?.fullscreen());
$('local-fullscreen').addEventListener('click', () => bridge?.fullscreen());
video.addEventListener('play', Wake); // キーボードや再生バーからの再生でも操作部品を隠すタイマーを動かす
for (const event of ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'ended', 'seeked']) video.addEventListener(event, Paint);
video.addEventListener('loadedmetadata', () => { controls.hidden = false; Paint(); Wake(); });
seek.addEventListener('input', () => { scrubbing = true; if (video.duration > 0) { video.currentTime = Number(seek.value) / 1000 * video.duration; Paint(); } });
seek.addEventListener('change', () => { scrubbing = false; seek.blur(); });
for (const event of ['pointerup', 'pointercancel', 'blur']) seek.addEventListener(event, () => { if (scrubbing) { scrubbing = false; Paint(); } });
for (const event of ['mousemove', 'pointerdown', 'touchstart']) document.addEventListener(event, Wake, { passive: true });
document.addEventListener('mouseleave', () => { if (!video.paused && $('local-quality-menu').hidden) { document.body.classList.remove('is-active'); document.body.classList.add('is-idle'); } });

// ---- 画質：保存済みの動画だけ。表示は保存済みの画質で、切り替えは「別の画質で保存し直す」（既存の保存画面）から行う。
const kind = params.get('kind'), height = params.get('height');
if (offline && kind === 'video' && /^\d{1,4}$/.test(height || '') && bridge) {
  const box = $('local-quality-box'), button = $('local-quality'), menu = $('local-quality-menu');
  button.textContent = `${Number(height)}p`; $('local-quality-info').textContent = `保存済みの画質：${Number(height)}p（動画）`; box.hidden = false;
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', event => { event.stopPropagation(); menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); });
  $('local-quality-change').addEventListener('click', () => { close(); bridge.changeQuality(); });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !box.contains(event.target)) close(); });
  window.addEventListener('resize', close); // 拡大・解除でmainがEscを先に処理したときも、メニューを残さない
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { close(); event.stopPropagation(); } }, true);
}
Paint();
