'use strict';
const { ipcRenderer, contextBridge } = require('electron');
// ローカル再生画面（アプリ自身のページ）にだけ、拡大・画質のボタン用の最小のAPIを公開する。Bilibiliなど外部ページには公開しない。
if (typeof location !== 'undefined' && /^favecus:\/\/app\/local\.html(?:\?|$)/.test(location.href)) {
  contextBridge.exposeInMainWorld('favecusPlayer', Object.freeze({ fullscreen: () => ipcRenderer.send('media:fullscreen'), changeQuality: () => ipcRenderer.send('media:quality') }));
}
let currentMedia = null, endReported = false, lastSend = 0, masterVolume = null;
let lastHealth = '';
const knownMedia = new WeakSet();
let startPending = typeof process !== 'undefined' && process.argv.includes('--favecus-start-at-zero');
let startUntil = null;
const initializedMedia = new WeakSet();
let qualityPending = typeof process !== 'undefined' && process.argv.includes('--favecus-quality-360p'), qualityUntil = 0;
const officialPlayer = typeof process !== 'undefined' && process.argv.includes('--favecus-official-player');
let pendingRestore = null;
function FitOfficialPlayer() {
  if (!officialPlayer) return;
  const player = document.querySelector('#bilibili-player') || document.querySelector('#bilibiliPlayer') || document.querySelector('.bpx-player-container');
  if (!player || document.getElementById('favecus-player-fit')) return;
  player.classList.add('favecus-official-root');
  const style = document.createElement('style'); style.id = 'favecus-player-fit';
  style.textContent = 'html,body{margin:0!important;overflow:hidden!important;background:#000!important}.favecus-official-root{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;min-width:0!important;max-width:none!important;max-height:none!important;z-index:9990!important}.favecus-official-root .bpx-player-container,.favecus-official-root .bilibili-player-video-wrap{width:100%!important;height:100%!important}';
  document.head.append(style);
}
function RestorePlayback(element) {
  if (!pendingRestore || !element || element.readyState < 1 || !(element.duration > 0)) return;
  const value = pendingRestore; pendingRestore = null; startPending = false;
  try { element.currentTime = Math.max(0, Math.min(value.position || 0, element.duration - .05)); if (value.paused) element.pause(); else element.play().catch(() => ipcRenderer.send('media:error', '再開するには再生ボタンまたはスペースを押してください。')); } catch { pendingRestore = value; }
}
function DefaultQuality() {
  if (!qualityPending || !/^https:\/\/(?:www|player)\.bilibili\.com\/(?:video\/|player\.html)/.test(location.href)) return;
  if (Date.now() > qualityUntil) { qualityPending = false; return; }
  const items = document.querySelectorAll('.bpx-player-ctrl-quality-menu-item, .bilibili-player-video-quality-menu li, .bilibili-player-video-quality-list li');
  const target = [...items].find(item => /(?:^|\D)360\s*p/i.test(item.textContent || '') || item.getAttribute('data-value') === '16' || item.getAttribute('data-quality') === '16');
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
  qualityPending = false;
  if (!target.classList.contains('active') && !target.classList.contains('bpx-state-active') && target.getAttribute('aria-selected') !== 'true') target.click();
}
function StartAtZero(element) {
  if (!startPending || !element || element.readyState < 1) return;
  if (startUntil === null && !element.paused && element.readyState >= 2) startUntil = Date.now() + 1500;
  if (startUntil !== null && Date.now() >= startUntil) { startPending = false; return; }
  if (!initializedMedia.has(element)) {
    try { element.currentTime = 0; initializedMedia.add(element); } catch { return; }
  }
  // 初回の自動再生直後にサイトが履歴位置へ戻す場合も、短い初期化期間だけ補正する。
  const expected = startUntil === null ? 0 : Math.max(0, (Date.now() - (startUntil - 1500)) / 1000);
  if (element.currentTime > expected + .75) { try { element.currentTime = 0; } catch {} }
}
function FindMedia() {
  const elements = [...document.querySelectorAll('video, audio')];
  return elements.find(e => !e.paused && e.readyState >= 1) || elements.find(e => e.duration > 0) || elements[0];
}
let masterSink = null;
// 出力デバイス（保存済み・ローカルの再生画面だけ）：名前（label）で選ぶ。名前が合うデバイスがなければ、既定。変えられなくても、再生は続ける。
async function ApplySink() {
  if (masterSink === null || location.protocol !== 'favecus:') return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const id = masterSink && devices.find(d => d.label === masterSink)?.deviceId || 'default';
    for (const e of document.querySelectorAll('video, audio')) if (typeof e.setSinkId === 'function' && e.sinkId !== id) await e.setSinkId(id);
  } catch { /* 出力先を変えられない：既定のまま */ }
}
let masterRate = null;
// 再生速度：読み込みのたびに、サイトが速度を戻しても、アプリで選んだ速度に合わせ直す。
function ApplyRate() {
  if (masterRate === null) return;
  for (const e of document.querySelectorAll('video, audio')) if (Math.abs(e.playbackRate - masterRate) > .001) e.playbackRate = masterRate;
}
function ApplyVolume() {
  if (masterVolume === null) return;
  for (const e of document.querySelectorAll('video, audio')) {
    if (Math.abs(e.volume - masterVolume) > .001) e.volume = masterVolume;
    if (e.muted !== (masterVolume === 0)) e.muted = masterVolume === 0;
    knownMedia.add(e);
  }
}
function Text(selector) { return document.querySelector(selector)?.textContent?.trim() || ''; }
function Report(force = false) {
  const element = FindMedia();
  RestorePlayback(element);
  const health = { url: location.href, ready: !!element && element.readyState >= 2 && Number.isFinite(element.duration) && element.duration > 0 && !element.error, errorCode: Number(element?.error?.code) || 0, position: Number(element?.currentTime) || 0, paused: element?.paused ?? true, ended: element?.ended === true };
  const healthKey = JSON.stringify(health);
  if (healthKey !== lastHealth) { lastHealth = healthKey; ipcRenderer.send('media:health', health); }
  if (element !== currentMedia) { currentMedia = element; endReported = false; }
  if (!element) return;
  StartAtZero(element);
  if (!knownMedia.has(element)) ApplyVolume();
  if (!force && Date.now() - lastSend < 450) return; // 再生位置は約0.5秒ごとに送る（以前は約2秒ごとで、再生バーの位置が遅れて更新されていた）
  lastSend = Date.now();
  let title = Text('.bpx-player-video-info-title') || Text('h1.video-title') || document.querySelector('meta[property="og:title"]')?.content || '';
  const artist = Text('.up-name');
  if (!title && location.protocol !== 'favecus:') title = document.title.replace(/\s*[-_|]\s*(哔哩哔哩.*|bilibili.*)$/i, '');
  if (/^(bilibili|哔哩哔哩|播放器|Favecus Player)/i.test(title) && title.length < 35) title = '';
  const ended = element.ended && !endReported;
  if (!element.ended) endReported = false;
  if (ended) endReported = true;
  ipcRenderer.send('media:state', { title, artist,
    position: Number.isFinite(element.currentTime) ? element.currentTime : 0,
    duration: Number.isFinite(element.duration) ? element.duration : 0,
    playbackRate: element.playbackRate, paused: element.paused, ended, url: location.href });
}
let initTimer = null;
function NeedsInitTick() {
  return startPending || !!pendingRestore || qualityPending || (officialPlayer && !document.getElementById('favecus-player-fit'));
}
function EnsureInitTimer() {
  if (initTimer || !NeedsInitTick()) return;
  let ticks = 0;
  initTimer = setInterval(() => {
    const media = FindMedia();
    if (startPending) StartAtZero(media);
    RestorePlayback(media);
    DefaultQuality();
    FitOfficialPlayer();
    if (!NeedsInitTick() || ++ticks >= 600) { if (typeof clearInterval === 'function') clearInterval(initTimer); initTimer = null; }
  }, 100);
}
window.addEventListener('DOMContentLoaded', () => {
  qualityUntil = Date.now() + 20000; DefaultQuality(); FitOfficialPlayer();
  for (const event of ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'loadedmetadata', 'canplay', 'ratechange']) document.addEventListener(event, e => {
    if (startPending && e.type === 'playing' && startUntil === null) startUntil = Date.now() + 1500;
    if (e.type === 'loadedmetadata' || e.type === 'play' || e.type === 'playing') { ApplyRate(); void ApplySink(); } // 再生速度：サイトが戻しても、選んだ速度に合わせ直す
    Report(true);
  }, true);
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, e => { if (startUntil !== null) startPending = false;
    if (e.isTrusted && e.target?.closest?.('.bpx-player-ctrl-quality, .bilibili-player-video-btn-quality')) qualityPending = false; }, true);
  EnsureInitTimer();
  document.addEventListener('volumechange', ApplyVolume, true);
  // 再生中の位置の更新。timeupdate（約4回/秒）を0.45秒に間引いて送る。イベントが来ない場合に備えた2秒ごとの報告も残す。
  document.addEventListener('timeupdate', () => { if (Date.now() - lastSend >= 450) Report(); }, true); // 間引き前の計算を避ける
  setInterval(() => Report(), 2000);
});
ipcRenderer.on('media:command', (_event, command) => {
  if (typeof command === 'string') command = { type: command };
  if (!command || typeof command !== 'object') return;
  if (command.type === 'restore' && Number.isFinite(command.position)) { startPending = false; pendingRestore = { position: command.position, paused: command.paused === true }; RestorePlayback(FindMedia()); EnsureInitTimer(); return; }
  if (command.type === 'refresh-display') { Report(true); return; }
  if (command.type === 'sink') {
    if (typeof command.label === 'string') { masterSink = command.label.slice(0, 200); void ApplySink(); }
    return;
  }
  if (command.type === 'rate') {
    if (Number.isFinite(command.value)) { masterRate = Math.max(0.25, Math.min(4, command.value)); ApplyRate(); }
    return;
  }
  if (command.type === 'volume') {
    if (Number.isFinite(command.value)) { masterVolume = Math.max(0, Math.min(1, command.value)); ApplyVolume(); }
    return;
  }
  const element = FindMedia();
  if (!element) { if (command.type !== 'pause') ipcRenderer.send('media:error', '再生画面を読み込み中です。画面内の再生ボタンを押してください。'); return; }
  if (command.type === 'pause') element.pause();
  else if (command.type === 'toggle') {
    if (element.paused) element.play().catch(() => ipcRenderer.send('media:error', '再生画面内の再生ボタンを押してください。'));
    else element.pause();
  } else if (['seek', 'seek-relative'].includes(command.type) && Number.isFinite(command.value) && Number.isFinite(element.duration) && element.duration > 0) {
    startPending = false;
    const target = command.type === 'seek' ? command.value : element.currentTime + command.value;
    element.currentTime = Math.max(0, Math.min(target, element.duration));
    Report(true);
  }
});

let shortcutSettings = { enabled: false, bindings: {} };
ipcRenderer.on('media:shortcuts', (_event, value) => { shortcutSettings = value || { enabled: false, bindings: {} }; });
window.addEventListener('keydown', event => {
  if (!event.isTrusted || event.isComposing || !shortcutSettings.enabled || event.target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="slider"]')) return;
  const stroke = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code].filter(Boolean).join('+');
  const action = Object.keys(shortcutSettings.bindings || {}).find(key => shortcutSettings.bindings[key] === stroke);
  if (!action) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.repeat && ['toggle', 'next', 'previous'].includes(action)) return;
  ipcRenderer.send('media:shortcut', { code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat });
}, true);
