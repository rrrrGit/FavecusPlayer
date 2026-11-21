'use strict';
// 画面（app.js）を、読み込み順に分けたもの：アカウント・設定・同期・各設定の画面。全体は、classic script として順に読み込む（index.html）。
function UpdateAccounts() {
  if ($('browse-bilibili')) { $('browse-bilibili').disabled = !accounts.bilibili?.loggedIn; $('browse-bilibili').title = accounts.bilibili?.loggedIn ? 'アプリ内で動画を検索し、表示中の動画を追加します' : '設定・連携からBilibiliにログインしてください'; }
  if ($('bili-account-state')) $('bili-account-state').textContent = accounts.bilibili?.loggedIn ? `ログイン済み: ${accounts.bilibili.name}` : accounts.bilibili?.error || '未ログイン';
}
function SetIcon(button, name) { button.querySelector('use').setAttribute('href', `icons.svg#${name}`); }
function SyncVolume(volume) {
  if (!state) return;
  state.settings.volume = volume; if (volume > 0) lastVolume = volume;
  const percent = Math.round(volume * 100);
  for (const id of ['transport-volume', 'master-volume']) if ($(id)) $(id).value = percent;
  for (const id of ['transport-volume-value', 'volume-value']) if ($(id)) $(id).textContent = `${percent}%`;
  SetIcon($('mute'), volume === 0 ? 'muted' : 'volume');
  const label = volume === 0 ? 'ミュートを解除' : 'ミュート'; $('mute').title = label; $('mute').setAttribute('aria-label', label); $('mute').setAttribute('aria-pressed', String(volume === 0));
}
function VolumeInput(element) { const volume = Number(element.value) / 100; SyncVolume(volume); Run(() => api.volume(volume)); }
function Settings() {
  OpenModal('設定・連携', `
    <section class="settings-block"><h3>音量</h3>
      <label class="volume-row"><span>音量</span><input id="master-volume" type="range" min="0" max="100" step="1" aria-label="アプリの音量"><output id="volume-value" for="master-volume"></output></label>
      <p class="form-note">変更はすぐに反映・保存されます。下部の音量バー、ミニプレイヤーと共通です。</p>
    </section>
    <section class="settings-block"><h3>bilibiliアカウント</h3>
      <div class="account-row"><p id="bili-account-state" class="status-detail">確認しています…</p><div class="settings-actions"><button id="bili-login" type="button" class="button secondary">ログイン・アカウントを開く</button><button id="bili-favorites" type="button" class="button secondary">保存リストから追加</button></div></div>
      <p class="form-note">公式サイトでログインすると、再生画面と保存リストに同じログイン状態を使用します。</p>
    </section>
    <nav id="settings-sections" class="settings-sections" aria-label="設定項目"></nav>`, null);
  // 新しい設定カテゴリはこの配列の末尾へ追加する。
  for (const [name, open] of [['プレイリストの出力', Transfer], ['使い方', () => api.help()], ['自動消去単語設定', TitleWordsSettings], ['Discordアクティビティ', DiscordSettings], ['ミニプレイヤー、タスクバー', TaskbarSettings], ['再生・表示', PlaybackSettings], ['キーコンフィグ', KeySettings], ['シャッフルの再生回数', ShuffleSettings], ['バージョン更新', ReleaseSettings], ['プレイリストの同期', SyncSettings], ['自動リスト', AutoListSettings], ['ライブラリの点検', AuditSettings], ['再生統計', StatsSettings], ['最近削除', TrashSettings]]) {
    const button = Button(name, 'settings-category', open); button.append(Element('span', '', '›')); $('settings-sections').append(button);
  }
  SyncVolume(state.settings.volume); $('master-volume').oninput = () => VolumeInput($('master-volume'));
  $('bili-login').onclick = () => Run(() => api.login('bilibili'));
  $('bili-favorites').onclick = () => { CloseModal(); Favorites(); };
  UpdateAccounts(); Run(async () => { accounts = await api.accounts(); UpdateAccounts(); });
}
async function SaveSettingsSection(settings, expectedEpoch = modalEpoch) {
  if (expectedEpoch !== modalEpoch) return false;
  if (!$('modal-form').reportValidity()) return false;
  const epoch = modalEpoch;
  await Action({ type: 'settings', settings });
  if (epoch === modalEpoch && $('modal').open) { Settings(); Toast('設定を保存しました。'); }
}
// ---- プレイリストの同期（設定）。接続先・サインイン・有効化。状態はmainからの 'sync' イベントで更新する。
let syncStatus = null;
function SyncLabel(status) {
  if (!status) return '確認しています…';
  const when = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('ja-JP') : '未同期';
  const extra = (status.pending ? `・未送信 ${status.pending}件` : '') + (status.conflicts ? `・保留した変更 ${status.conflicts}件` : '');
  if (status.state === 'blocked') return `同期を停止しています：${status.error}`;
  if (!status.enabled) return `同期：オフ${status.signedIn ? `（サインイン済み：${status.email}）` : ''}`;
  if (status.state === 'syncing') return '同期しています…';
  if (status.state === 'error') return `同期に失敗しました：${status.error}（変更は保持しています。つながると自動で再試行します）${extra}`;
  return `同期：オン・最終 ${when}${extra}`;
}
function PaintSync(status) {
  syncStatus = status;
  if (!$('sync-state') || !$('modal').open) return;
  $('sync-state').textContent = SyncLabel(status);
  const on = !!status?.enabled, ready = !!status?.configured, signed = !!status?.signedIn;
  $('sync-url').disabled = $('sync-key').disabled = $('sync-save').disabled = on;
  $('sync-send').disabled = !ready || !status?.encryption; $('sync-verify').disabled = !ready; $('sync-signout').disabled = !signed || on;
  $('sync-enable').disabled = on || !signed; $('sync-disable').disabled = !on; $('sync-reset').disabled = on; $('sync-now').disabled = !on || status?.state === 'syncing';
  $('sync-encryption').classList.toggle('hidden', !status || status.encryption);
  $('sync-blocked').classList.toggle('hidden', !(status && status.enabled && status.state === 'blocked' && status.canUnblock));
}
function SyncSettings() {
  OpenModal('プレイリストの同期', `
    <p class="form-note">自分のSupabaseプロジェクトを使って、プレイリストの構成と曲の登録情報をWindows版・iPhone版で同期します。曲のファイル・保存したメディア・ログイン情報は同期しません。既定はオフです。</p>
    <p id="sync-state" class="status-detail" role="status" aria-live="polite"></p>
    <p id="sync-encryption" class="status-detail hidden">この環境ではサインイン情報を安全に保存できないため、同期を使えません。</p>
    <section class="settings-block"><h3>1. 接続先</h3>
      <label class="field">Project URL<input id="sync-url" maxlength="100" placeholder="https://xxxx.supabase.co" autocomplete="off" spellcheck="false"></label>
      <label class="field">anon（publishable）キー<input id="sync-key" maxlength="4096" autocomplete="off" spellcheck="false"><small>公開してよいキーだけを入力します。service_role・secretキーは使えません。</small></label>
      <div class="settings-actions"><button id="sync-save" type="button" class="button secondary">接続先を保存</button></div>
    </section>
    <section class="settings-block"><h3>2. サインイン（メールのワンタイムコード）</h3>
      <label class="field">メールアドレス<input id="sync-email" type="email" maxlength="200" autocomplete="email"></label>
      <div class="settings-actions"><button id="sync-send" type="button" class="button secondary">コードを送る</button></div>
      <label class="field">届いたコード<input id="sync-code" inputmode="numeric" maxlength="10" autocomplete="one-time-code"></label>
      <div class="settings-actions"><button id="sync-verify" type="button" class="button secondary">サインイン</button><button id="sync-signout" type="button" class="button secondary">サインアウト</button></div>
    </section>
    <section class="settings-block"><h3>3. 同期</h3>
      <div class="settings-actions"><button id="sync-enable" type="button" class="button primary">同期を有効にする</button><button id="sync-now" type="button" class="button secondary">今すぐ同期</button><button id="sync-disable" type="button" class="button secondary">同期を止める</button><button id="sync-reset" type="button" class="button secondary">接続を初期化</button></div>
      <div id="sync-blocked" class="settings-actions hidden"><button id="sync-restore" type="button" class="button primary">サーバーの内容で復元</button><button id="sync-keep" type="button" class="button secondary">この端末の内容を正とする</button></div>
      <p class="form-note">有効にする前に、現在のlibrary.jsonのバックアップをデータフォルダーへ残します。止めても、プレイリストや同期データは消えません。Supabaseの無料枠は、1週間ほど使われないと一時停止します（ダッシュボードで再開でき、データは残ります）。</p>
    </section>`, null, '保存', Settings);
  const call = (command, message) => Run(async () => { const status = await api.sync(command); PaintSync(status); if (message) Toast(message); });
  $('sync-save').onclick = () => call({ action: 'configure', url: $('sync-url').value, anonKey: $('sync-key').value }, '接続先を保存しました。');
  $('sync-send').onclick = () => call({ action: 'send-code', email: $('sync-email').value }, 'コードをメールで送りました。届いた数字を入力してください。');
  $('sync-verify').onclick = () => call({ action: 'verify', email: $('sync-email').value, code: $('sync-code').value }, 'サインインしました。');
  $('sync-signout').onclick = () => call({ action: 'sign-out' }, 'サインアウトしました。');
  $('sync-enable').onclick = () => call({ action: 'enable' }, '同期を有効にしました。');
  $('sync-disable').onclick = () => call({ action: 'disable' }, '同期を止めました。');
  $('sync-restore').onclick = () => call({ action: 'unblock', mode: 'restore' }, '同期した内容で復元しました。');
  $('sync-keep').onclick = () => { if (confirm('この端末の内容を正として同期します。サーバーと他の端末にある、この端末にない内容は削除されます。よろしいですか？')) call({ action: 'unblock', mode: 'keep' }, '同期しました。'); };
  $('sync-reset').onclick = () => { if (confirm('別のプロジェクト・アカウントへ切り替えるため、同期の紐付けを初期化します。手元のプレイリストは変わりません。よろしいですか？')) call({ action: 'reset' }, '初期化しました。'); };
  $('sync-now').onclick = () => call({ action: 'now' }, '同期しました。');
  Run(async () => { const status = await api.sync({ action: 'status' }); PaintSync(status); $('sync-email').value = status.email || ''; $('sync-url').value = status.url || ''; });
}
function KeySettings() {
  const keys = window.FavecusKeys, draft = { ...keys.Validate(state.settings.keybindings) }, inputs = new Map();
  const save = () => SaveSettingsSection({ keybindings: keys.Validate(draft) });
  OpenModal('キーコンフィグ', '<p class="form-note">欄を選択して使用するキーを押してください。修飾キーとの組み合わせも使えます。Backspace・Deleteで解除します。アプリが前面のときだけ有効で、入力欄・設定画面では再生キーを動作させません。</p><div id="keybinding-fields"></div><button id="keybinding-reset" class="button secondary" type="button">初期設定に戻す</button>', save, '保存して戻る', save);
  const paint = () => { for (const [action, input] of inputs) input.value = keys.Display(draft[action]); };
  for (const [action, title] of Object.entries(keys.Labels)) {
    const label = Element('label', 'keybinding-row', title), input = Element('input'); input.type = 'text'; input.readOnly = true; input.setAttribute('aria-label', title);
    input.onkeydown = event => { event.preventDefault(); event.stopPropagation(); if (event.isComposing) return; const value = keys.Stroke(event); if (!value) return; draft[action] = ['Backspace', 'Delete'].includes(value) ? '' : value; paint(); };
    label.append(input); $('keybinding-fields').append(label); inputs.set(action, input);
  }
  $('keybinding-reset').onclick = () => { Object.assign(draft, keys.Defaults); paint(); }; paint();
}
function TitleWordsSettings() {
  OpenModal('自動消去単語設定', `
    <p class="form-note">登録した語句全体に一致する部分を、曲名から取り除きます。英字の大文字・小文字は区別しません。例えば「ニコカラ」を登録しても「ニ」「コ」など1文字ずつは消しません。</p>
    <label class="field">自動消去する語句<input id="title-word-input" maxlength="80" placeholder="例：ニコカラ、純k投屏（1回に1語句）"><small>括弧は [ と ] のように、左右を1つずつ登録します。括弧の中身は残ります。最大200語句。</small></label>
    <button id="title-word-add" type="button" class="button primary">単語を追加</button>
    <p id="title-word-count" class="status-detail"></p><div id="title-word-list" class="title-word-list"></div>
    <p class="form-note">追加・削除はすぐに保存します。追加した語句は、すべての既存プレイリストにも適用します。語句を削除しても、整理済みの曲名は元には戻りません。すべて削除すると今後の自動消去を止められます。</p>`, null, '保存', Settings);
  const epoch = modalEpoch; let busy = false;
  const render = () => {
    $('title-word-list').replaceChildren();
    const words = state.settings.titleCleanupWords;
    $('title-word-count').textContent = `${words.length} / 200語句を登録中`;
    for (const word of words) {
      const chip = Element('div', 'title-word'); chip.append(Element('span', '', word));
      const remove = Button('×', 'icon-button', () => save(state.settings.titleCleanupWords.filter(value => value !== word)), `${word}を自動消去の対象から外す`);
      remove.disabled = busy; chip.append(remove); $('title-word-list').append(chip);
    }
    $('title-word-add').disabled = busy; $('title-word-input').disabled = busy;
  };
  const save = async words => {
    if (busy) return; busy = true;
    const before = new Map(state.playlists.flatMap(p => p.entries.map(e => [e.id, e.title]))); render();
    try {
      await Action({ type: 'settings', settings: { titleCleanupWords: words } });
      if (epoch !== modalEpoch || !$('modal').open) return;
      $('title-word-input').value = '';
      const changed = state.playlists.flatMap(p => p.entries).filter(e => before.get(e.id) !== e.title).length;
      Toast(`語句を保存しました。${changed ? `既存の曲名${changed}件を整理しました。` : ''}`);
    } finally { busy = false; if (epoch === modalEpoch && $('modal').open) render(); }
  };
  const add = () => {
    const word = $('title-word-input').value.trim();
    if (!word) throw new Error('自動消去する語句を入力してください。');
    if (state.settings.titleCleanupWords.some(value => value.toLowerCase() === word.toLowerCase())) throw new Error('その語句は登録済みです。');
    return save([...state.settings.titleCleanupWords, word]);
  };
  $('title-word-add').onclick = () => Run(add);
  $('title-word-input').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); Run(add); } };
  render();
}
function ReleaseSettings() {
  const save = () => SaveSettingsSection({ releaseDriveURL: $('release-drive-url').value.trim() });
  OpenModal('バージョン更新', '<label class="field">Google Driveの配布先<input id="release-drive-url" placeholder="https://drive.google.com/drive/folders/..."><small>配信元から案内されたフォルダーURLを指定してください。未設定の場合はマイドライブを開きます。</small></label><div class="settings-actions"><button id="release-open" type="button" class="button primary">Google Driveを開く ↗</button></div><p class="form-note">配布先のファイル名でバージョンを確認し、Patchを取得してください。アプリを終了（×ボタンでは通知領域に残るため、通知領域のアイコンを右クリックして「終了」）してから、既存のFavecusPlayerフォルダーへ適用します。</p>', save, '保存して戻る', save);
  $('release-drive-url').value = state.settings.releaseDriveURL || '';
  $('release-open').onclick = () => Run(async () => { await Action({ type: 'settings', settings: { releaseDriveURL: $('release-drive-url').value.trim() } }); await api.openRelease(); });
}
function DiscordSettings() {
  const s = state.settings;
  const save = () => SaveSettingsSection({ discordEnabled: $('discord-enabled').checked, discordClientId: $('discord-id').value.trim(), discordImageKey: $('discord-image-key').value.trim(), hideWhenPaused: $('hide-paused').checked, discordThumbnail: $('discord-thumbnail').checked, discordVideoLink: $('discord-video-link').checked, discordThumbnailSize: $('discord-size').value });
  OpenModal('Discordアクティビティ', `
    <p class="form-note">音楽アクティビティとして、メンバー一覧にも曲名を表示します。</p>
    <label class="check-row"><input id="discord-enabled" type="checkbox">Discordに再生中の内容を表示する</label>
    <label class="field">Application ID<input id="discord-id" inputmode="numeric" maxlength="22" placeholder="Developer PortalのApplication ID"><small>初回のみ、自分のDiscord Applicationを作成してIDを入力します。Bot TokenやClient Secretは使用しません。</small></label>
    <label class="field">Rich Presenceの画像名<input id="discord-image-key" maxlength="64" placeholder="favecus_player_music"><small>Rich Presence → Art Assetsに音楽アイコンを登録し、画像名を一致させます。General InformationのApp Iconとは別の設定です。</small></label>
    <label class="check-row"><input id="discord-thumbnail" type="checkbox">楽曲のサムネイルを表示</label>
    <label class="field">楽曲アイコンのサイズ<select id="discord-size"><option value="small">小：補助画像（アプリアイコンを大きく表示）</option><option value="large">大：メイン画像（アプリアイコンを補助表示）</option></select><small>アプリの登録アイコン自体は変更しません。</small></label>
    <p class="form-note">表示位置と細かな大きさはDiscord側で決まります。四隅の自由指定・任意サイズ・背景全体への設定には対応していません。</p>
    <label class="check-row"><input id="discord-video-link" type="checkbox">楽曲アイコンを押すと動画を開く</label><p class="form-note">楽曲の画像だけに動画リンクを設定します。曲名・アプリアイコンには動画リンクを設定しません。リンクを開く際の確認画面やアプリ名から開くDiscord固有の画面はDiscord側の動作です。</p><label class="check-row"><input id="hide-paused" type="checkbox">一時停止中はアクティビティを非表示</label>
    <p class="form-note">非表示をオフにすると、停止位置 / 総再生時間を文字で表示します。</p>
    <div class="settings-actions"><button type="button" id="portal-button" class="button secondary">Developer Portalを開く ↗</button><button type="button" id="discord-guide-button" class="button secondary">画像の設定手順</button><button type="button" id="discord-image-button" class="button secondary">登録するPNGを表示</button></div><p id="discord-detail" class="status-detail"></p>
    <p class="form-note">左上の「戻る」または「保存して戻る」で保存します。×・閉じるは変更を保存せず閉じます。</p>`, save, '保存して戻る', save);
  $('discord-size').value = s.discordThumbnailSize || 'small';
  const imageOptions = () => { $('discord-size').disabled = !$('discord-thumbnail').checked; $('discord-video-link').disabled = !$('discord-thumbnail').checked; };
  $('discord-thumbnail').onchange = imageOptions;
  $('discord-thumbnail').checked = s.discordThumbnail !== false; $('discord-video-link').checked = s.discordVideoLink !== false; imageOptions();
  $('discord-enabled').checked = s.discordEnabled; $('discord-id').value = s.discordClientId; $('hide-paused').checked = s.hideWhenPaused; $('discord-image-key').value = s.discordImageKey;
  $('portal-button').onclick = () => Run(() => api.discordPortal());
  $('discord-guide-button').onclick = () => Run(() => api.discordGuide());
  $('discord-image-button').onclick = () => Run(() => api.discordImage()); UpdateStatus();
}
function TaskbarSettings() {
  const s = state.settings;
  const save = () => SaveSettingsSection({ taskbarEmbed: $('taskbar-embed').checked, taskbarWidth: Number($('taskbar-width').value), taskbarOffset: Number($('taskbar-offset').value) });
  OpenModal('ミニプレイヤー、タスクバー', `
    <label class="check-row"><input id="taskbar-embed" type="checkbox">タスクバー内部への埋め込みを試す（Windows用）</label>
    <p class="form-note">右上の下向き矢印から、プライマリーモニターの横向きタスクバーへ表示します。試験的な機能です。接続できない場合は従来の小型画面を開きます。</p>
    <label class="field">表示の幅<input id="taskbar-width" type="number" min="260" max="520" step="1" required><small>260〜520。アイコンと重なる場合は小さくします。表示倍率に合わせて拡大されます。</small></label>
    <label class="field">左へ移動する量<input id="taskbar-offset" type="number" min="0" max="1200" step="1" required><small>0で通知領域のすぐ左。保存後、下向き矢印から表示し直すと反映されます。</small></label>
    <p id="taskbar-detail" class="status-detail"></p><div class="settings-actions"><button id="taskbar-guide" type="button" class="button secondary">埋め込みの使い方</button><button id="taskbar-log" type="button" class="button secondary">埋め込みの診断記録を開く</button></div>
    <p class="form-note">左上の「戻る」または「保存して戻る」で保存します。×・閉じるは変更を保存せず閉じます。</p>`, save, '保存して戻る', save);
  $('taskbar-embed').checked = s.taskbarEmbed; $('taskbar-width').value = s.taskbarWidth; $('taskbar-offset').value = s.taskbarOffset;
  $('taskbar-log').onclick = () => Run(() => api.taskbarLog());
  $('taskbar-guide').onclick = () => Run(() => api.taskbarGuide()); UpdateStatus();
}
function ShuffleSettings() {
  const save = () => SaveSettingsSection({ weightedShuffle: $('weighted-shuffle').checked });
  OpenModal('シャッフルの再生回数', '<label class="check-row"><input id="weighted-shuffle" type="checkbox">再生回数が少ない曲を優先する</label><p class="form-note">通常再生も含め、実際に3秒以上再生した回数を曲単位で保存します。同じ動画URL・パートや同じ保存ファイルは、別のリストでも共通の回数です。回数が多い曲ほど後に出やすくなりますが、順序は毎回変わります。</p><button type="button" id="reset-play-counts" class="button secondary">再生回数をリセット</button><p class="form-note">リセットは次にシャッフルを開始すると反映されます。現在の再生予定は変更しません。</p>', save, '保存して戻る', save);
  $('weighted-shuffle').checked = state.settings.weightedShuffle !== false;
  $('reset-play-counts').onclick = () => OpenModal('再生回数をリセット', '<p class="form-note">全楽曲の再生回数を0に戻します。プレイリストや保存ファイルは残ります。</p>', async () => { await api.resetPlayCounts(); ShuffleSettings(); Toast('再生回数をリセットしました。'); }, 'リセットする');
}
function PlaybackSettings() {
  const s = state.settings;
  const save = async () => {
    if (!$('modal-form').reportValidity()) return false;
    const epoch = modalEpoch, settings = { volumeLeveling: $('volume-leveling').checked, autoThumbnailEnabled: $('auto-thumbnail').checked, autoThumbnailMinutes: Number($('auto-thumbnail-minutes').value) };
    UpdateDownloads(await api.preferSaved($('playback-source').value === 'saved'));
    return SaveSettingsSection(settings, epoch);
  };
  OpenModal('再生・表示', `
    <label class="field">再生するデータの優先<select id="playback-source"><option value="saved">保存済みの動画・音声を優先</option><option value="online">オンラインを優先</option></select><small>保存済みを優先すると、対応するファイルがある曲はPCから再生します。変更は次の曲の読み込みから反映します。</small></label>
    <label class="field">プレイリスト欄の幅<input id="sidebar-width" type="range" min="170" max="400" step="1"><output id="sidebar-width-value"></output><small>変更はすぐに反映・保存されます。</small></label>
    <label class="check-row"><input id="volume-leveling" type="checkbox">曲ごとの音量差を自動で揃える（大きい曲を下げます）</label>
    <p class="form-note">保存済みの音声・動画と、ローカルの曲が対象です（オンライン再生は対象外）。初めて再生する曲は、音量を測るため、数秒だけ遅れて反映されます。曲を上げることはしません。</p>
    <label class="check-row"><input id="auto-thumbnail" type="checkbox">アプリを前面で使っていない間は、自動で曲モードにする</label>
    <label class="field">切り替えまでの時間（分）<input id="auto-thumbnail-minutes" type="number" min="1" max="120" step="1" required><small>初期値5分。最小化・タスクバー表示中や、別のアプリを操作している間を数えます。前面に戻すと待ち時間をリセットします。</small></label>
    <p class="form-note">音声と再生位置は保ちます。自動切り替え後は「動画」で戻せます。同じ再生画面を再表示・再描画し、通常はページを再読み込みしません。</p>
    <p class="form-note">左上の「戻る」または「保存して戻る」で保存します。×・閉じるは変更を保存せず閉じます。</p>`, save, '保存して戻る', save);
  $('playback-source').value = downloadInfo.preferSaved === false ? 'online' : 'saved';
  $('volume-leveling').checked = s.volumeLeveling !== false;
  $('sidebar-width').value = s.sidebarWidth; $('sidebar-width-value').textContent = `${s.sidebarWidth}px`;
  $('sidebar-width').oninput = () => { const width = Number($('sidebar-width').value); $('sidebar-width-value').textContent = `${width}px`; document.body.style.setProperty('--sidebar-width', `${width}px`); Run(() => Action({ type: 'settings', settings: { sidebarWidth: width } })); };
  $('auto-thumbnail').checked = s.autoThumbnailEnabled; $('auto-thumbnail-minutes').value = s.autoThumbnailMinutes;
}
function Favorites() {
  const selected = new Map(); let page = 1, request = 0, destinations;
  OpenModal('Bilibiliの保存リストから追加', `<p class="form-note">ログインしたアカウントの「收藏夹」から、追加したい動画を選べます。</p><select id="favorite-folders" aria-label="保存リスト" disabled><option>読み込んでいます…</option></select><p id="favorite-message" class="status-detail"></p><div id="favorite-list" class="favorite-list"></div><div class="favorite-pages"><button id="favorite-prev" type="button" class="button secondary" disabled>前へ</button><span id="favorite-page">1</span><button id="favorite-next" type="button" class="button secondary" disabled>次へ</button></div><div class="settings-actions"><button id="favorite-login" type="button" class="button secondary">ログイン</button><button id="favorite-refresh" type="button" class="button secondary">リストを再取得</button><button id="favorite-official" type="button" class="button secondary">公式の保存リストを開く</button></div>`, async () => {
    if (!selected.size) throw new Error('追加する動画にチェックしてください。');
    await AddSelected({ type: 'add-videos', videos: [...selected].map(([url, title]) => ({ url, title, duration: videoDetails.get(url)?.duration })) }, destinations());
  }, '選択した動画を追加');
  destinations = AddDestinations();
  const videoDetails = new Map();
  const epoch = modalEpoch, active = key => epoch === modalEpoch && request === key && $('modal').open;
  const loadPage = async () => {
    const id = $('favorite-folders').value, key = ++request, requestedPage = page;
    $('favorite-message').textContent = '動画を読み込んでいます…'; $('favorite-prev').disabled = true; $('favorite-next').disabled = true;
    $('favorite-list').replaceChildren();
    try {
      const result = await api.favoriteVideos(id, requestedPage);
      if (!active(key)) return;
      $('favorite-list').replaceChildren(); $('favorite-page').textContent = String(requestedPage);
      for (const video of result.videos) {
        videoDetails.set(video.url, video);
        const label = Element('label', 'favorite-row'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(video.url);
        input.onchange = () => { input.checked ? selected.set(video.url, video.title) : selected.delete(video.url); $('favorite-message').textContent = `${selected.size}本を選択中`; };
        const info = Element('span', '', video.title || video.videoId); info.append(Element('small', '', video.artist)); label.append(input, info); $('favorite-list').append(label);
      }
      $('favorite-message').textContent = result.videos.length ? `${selected.size}本を選択中` : 'このページに追加できる動画はありません。';
      $('favorite-prev').disabled = requestedPage <= 1; $('favorite-next').disabled = !result.hasMore;
    } catch (error) { if (active(key)) { $('favorite-message').textContent = `${error.message} リストを取得できない場合は公式画面から動画URLを追加できます。`; $('favorite-prev').disabled = requestedPage <= 1; } }
  };
  const loadFolders = async () => {
    const key = ++request;
    $('favorite-folders').disabled = true; $('favorite-refresh').disabled = true;
    $('favorite-prev').disabled = true; $('favorite-next').disabled = true; $('favorite-list').replaceChildren();
    try {
      const folders = await api.favoriteFolders(); if (!active(key)) return;
      $('favorite-folders').replaceChildren();
      for (const f of folders) { const option = Element('option', '', `${f.title} (${f.count})`); option.value = f.id; $('favorite-folders').append(option); }
      $('favorite-folders').disabled = !folders.length;
      $('favorite-refresh').disabled = false;
      if (folders.length) { page = 1; await loadPage(); } else $('favorite-message').textContent = '保存リストがありません。';
    } catch (error) { if (active(key)) { $('favorite-message').textContent = error.message; $('favorite-refresh').disabled = false; } }
  };
  $('favorite-folders').onchange = () => { page = 1; void loadPage(); };
  $('favorite-prev').onclick = () => { page--; void loadPage(); }; $('favorite-next').onclick = () => { page++; void loadPage(); };
  $('favorite-login').onclick = () => Run(() => api.login('bilibili'));
  $('favorite-official').onclick = () => Run(() => api.login('bilibili', true));
  $('favorite-refresh').onclick = loadFolders; void loadFolders();
}
