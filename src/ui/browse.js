'use strict';
const api = window.favecusBrowse, $ = id => document.getElementById(id);
let state = null, pending = false;
const Run = async action => { try { return await action(); } catch (error) { $('browse-message').textContent = error.message; } };
function Render(value) {
  state = value; $('browse-title').textContent = value.title; $('browse-title').title = value.url;
  $('browse-add').disabled = !value.canAdd || pending; $('browse-add').textContent = value.busy ? '動画を確認しています…' : 'この動画をプレイリストに追加';
  $('browse-back').disabled = !value.canBack; $('browse-forward').disabled = !value.canForward;
  $('browse-maximize').textContent = value.maximized ? '❐' : '□'; $('browse-maximize').setAttribute('aria-label', value.maximized ? '元のサイズに戻す' : '最大化');
  $('browse-sound').textContent = `試聴音声 ${value.muted ? 'オフ' : 'オン'}`; $('browse-sound').setAttribute('aria-pressed', String(!value.muted));
  $('browse-message').textContent = value.message || (!value.loggedIn ? 'ログインが必要です。設定・連携からBilibiliにログインしてください。' : value.video ? `追加対象：${value.video.videoId} · パート ${value.video.part}　｜　追加先は次の画面で選べます。` : '投稿動画を開くと、右上から追加できます。検索画面の音声は初期オフです。');
}
for (const command of ['back', 'forward', 'home', 'reload', 'minimize', 'maximize', 'close', 'sound']) $(`browse-${command}`).onclick = () => Run(() => api.command(command));
$('browse-search').addEventListener('submit', event => { event.preventDefault(); Run(() => api.command('search', $('browse-keyword').value)); });
$('browse-add').onclick = () => Run(async () => { if (pending) return; pending = true; if (state) Render(state); try { await api.add(); } finally { pending = false; if (state) { state.busy = false; Render(state); } } });
api.onState(Render); Run(async () => Render(await api.state()));
