'use strict';
// 画面（app.js）を、読み込み順に分けたもの：自動リストの設定・再生統計・再生履歴。全体は、classic script として順に読み込む（index.html）。
// 設定の画面（04-settings.js）から開く。規則と保存は main 側（core/auto-list-settings.cjs・play-history.cjs・play-ledger.cjs の Stats）。

const AUTO_LIMIT_CHOICES = [10, 20, 50, 100, 200, 500], AUTO_MIN_CHOICES = [1, 2, 3, 5, 10], AUTO_DAYS_CHOICES = [0, 7, 30, 90, 365];

function AutoListSettings() {
  const lists = [['frequent', 'よく聴く曲'], ['recent', '最近追加した曲'], ['unplayed', '未再生'], ['favorites', 'お気に入り'], ['history', '最近聴いた曲']];
  const options = (choices, current, label) => choices.map(value => `<option value="${value}"${value === current ? ' selected' : ''}>${label(value)}</option>`).join('');
  Run(async () => {
    const epoch = modalEpoch;
    const settings = await api.autoListSettings();
    if (epoch !== modalEpoch) return;
    OpenModal('自動リスト', `<p class="form-note">ホームの「自動リスト」の、曲の数と条件です（このPCだけ。同期しません）。</p>
      ${lists.map(([kind, name]) => `<label class="field">${name}の曲数（上限）<select data-limit="${kind}">${options(AUTO_LIMIT_CHOICES, settings.limits[kind], v => `${v}曲`)}</select></label>`).join('')}
      <label class="field">「よく聴く曲」に入る最低の回数<select id="auto-min">${options(AUTO_MIN_CHOICES, settings.frequentMin, v => `${v}回以上`)}</select></label>
      <label class="field">「最近追加した曲」の期間<select id="auto-days">${options(AUTO_DAYS_CHOICES, settings.recentDays, v => (v === 0 ? '期間を限らない' : `${v}日以内`))}</select></label>
      <div class="form-actions"><button id="auto-reset" class="button secondary" type="button">既定に戻す</button><button id="history-clear" class="button secondary danger" type="button">再生履歴を消す</button></div>`, async () => {
      const limits = {}; for (const select of $('modal-body').querySelectorAll('select[data-limit]')) limits[select.dataset.limit] = Number(select.value);
      await api.autoListSettings({ limits, frequentMin: Number($('auto-min').value), recentDays: Number($('auto-days').value) });
      if (openEpoch === modalEpoch) { Toast('自動リストの設定を保存しました。'); RenderAutoLists?.(); }
    }, '保存する', Settings);
    const openEpoch = modalEpoch;
    $('auto-reset').onclick = () => { for (const select of $('modal-body').querySelectorAll('select[data-limit]')) select.value = { frequent: 50, recent: 50, unplayed: 200, favorites: 200, history: 100 }[select.dataset.limit]; $('auto-min').value = 1; $('auto-days').value = 0; };
    $('history-clear').onclick = () => Run(async () => { if (confirm('再生履歴（「最近聴いた曲」）を消します。再生回数は変わりません。')) { await api.clearHistory(); if (openEpoch === modalEpoch) { Toast('再生履歴を消しました。'); RefreshAutoLists?.(); } } });
  });
}
// 自動リストのカードを、設定の変更のあとに作り直す（ホームを開いているとき）。
function RenderAutoLists() { if (typeof RenderHome === 'function' && !$('home')?.classList.contains('hidden')) RenderHome(); }

function FormatPlayDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  if (s === 0) return '0分';
  if (s < 60) return `${s}秒`;
  const minutes = Math.floor(s / 60), hours = Math.floor(minutes / 60), rem = minutes % 60;
  if (hours === 0) return `${minutes}分`;
  return rem > 0 ? `${hours}時間${rem}分` : `${hours}時間`;
}

function StatsSettings() {
  Run(async () => {
    const epoch = modalEpoch;
    const stats = await api.stats();
    if (epoch !== modalEpoch) return;
    OpenModal('再生統計', '', null, '保存', Settings);
    const body = $('modal-body');
    const summary = Element('p', 'form-note');
    summary.append(Element('span', '', 'この再生回数の記録（同期した他の端末の回数を含みます）の、合計は '), Element('strong', '', String(stats.total)), Element('span', '', ' 回です。'), document.createElement('br'), Element('span', '', 'このPCでの合計再生時間：'), Element('strong', '', FormatPlayDuration(stats.totalSeconds || 0)), Element('span', '', '（バックグラウンド再生を含みます）'));
    body.append(summary);
    const appendBars = (heading, items, valueOf, labelOf) => {
      body.append(Element('h3', 'stat-heading', heading));
      const peak = Math.max(1, ...items.map(valueOf));
      for (const m of items) {
        const val = valueOf(m), row = Element('div', 'stat-row'), bar = Element('span', 'stat-bar'), fill = document.createElement('i');
        fill.style.width = `${Math.max(0, Math.min(100, Math.round((val / peak) * 100)))}%`;
        bar.append(fill);
        row.append(Element('span', 'stat-label', String(m.month || '')), bar, Element('span', 'stat-value', labelOf(val)));
        body.append(row);
      }
    };
    appendBars('月ごとの再生回数（最近12か月）', stats.months, m => m.plays || 0, v => String(v));
    appendBars('月ごとの再生時間（最近12か月）', stats.months, m => m.seconds || 0, v => FormatPlayDuration(v));
    const appendTop = (heading, id, items) => {
      body.append(Element('h3', 'stat-heading', heading));
      const wrap = Element('div'); wrap.id = id;
      if (!items.length) wrap.append(Element('p', 'form-note', 'まだ記録がありません。'));
      else {
        const ol = Element('ol', 'stat-top');
        items.forEach((item, index) => {
          const li = Element('li');
          li.append(Element('span', 'stat-title', `${index + 1}. ${item.title}`), Element('span', 'stat-value', `${item.count}回`));
          ol.append(li);
        });
        wrap.append(ol);
      }
      body.append(wrap);
    };
    appendTop('今月よく聴いた曲', 'stat-month', stats.thisMonthTop);
    appendTop('これまでによく聴いた曲（上位20）', 'stat-all', stats.top);
  });
}

// ライブラリの点検（重複・リンク切れ）。報告だけで、何も自動では消さない。外すのは、選んで「リストから外す」（最近削除へ保管される）。
function AuditSettings() {
  OpenModal('ライブラリの点検', '', null, '保存', Settings);
  const epoch = modalEpoch;
  const paint = async () => {
    const report = await api.audit();
    if (epoch !== modalEpoch || !$('modal').open) return;
    const body = $('modal-body'); body.replaceChildren();
    body.append(Element('p', 'form-note', `${report.checked}曲を点検しました。重複 ${report.duplicates.length}件・リンク切れ ${report.missing.length}件。自動では、何も消しません。`));
    const section = (title, note, items, rowFor) => {
      body.append(Element('h3', 'stat-heading', `${title}（${items.length}）`));
      if (!items.length) { body.append(Element('p', 'form-note', '見つかりませんでした。')); return; }
      body.append(Element('p', 'form-note', note));
      for (const item of items) body.append(rowFor(item));
    };
    const remove = (playlistId, entryId) => Run(async () => { await Action({ type: 'remove', playlistId, entryId }); Toast('リストから外しました（最近削除に、30日間、保管します）。'); await paint(); });
    section('重複', '同じプレイリストに、同じ動画・同じファイルの曲が、2つ以上あります。いらないほうを、外せます。', report.duplicates, item => {
      const box = Element('div', 'audit-group'); box.append(Element('strong', '', `${item.playlistName}：${item.title}`));
      item.entries.forEach((entry, index) => { const row = Element('div', 'trash-row'); row.append(Element('span', 'auto-note', `${index + 1}つ目：${entry.title || '（無題）'}`), Button('このリストから外す', 'button secondary', () => remove(item.playlistId, entry.id))); box.append(row); });
      return box;
    });
    section('リンク切れ', 'ローカルの曲で、メディアのファイルが、このPCにありません。「ファイル追加」で入れ直すか、リストから外せます。', report.missing, item => {
      const row = Element('div', 'trash-row'); const text = Element('div', 'trash-text'); text.append(Element('strong', '', item.title), Element('span', 'auto-note', `${item.playlistName}（${item.fileName}）`));
      row.append(text, Button('このリストから外す', 'button secondary', () => remove(item.playlistId, item.entryId))); return row;
    });
  };
  Run(paint);
}

// 音声の出力デバイス（保存済み・ローカルの曲の再生だけ。Bilibiliのオンライン再生は、既定のデバイス）。デバイスの名前で選ぶ。
function OutputSettings() {
  Run(async () => {
    const epoch = modalEpoch;
    const current = await api.outputGet();
    let names = [];
    try { names = [...new Set((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.label).map(d => d.label))]; } catch { names = []; }
    if (epoch !== modalEpoch) return;
    if (current && !names.includes(current)) names.unshift(current);
    OpenModal('出力デバイス', '<p class="form-note">保存済み・ローカルの曲の再生で使う、音声の出力先です（Bilibiliのオンライン再生は、既定のデバイスのままです）。選んだデバイスが、いまつながっていないときは、既定のデバイスで鳴ります。</p><label class="field">出力先<select id="output-select"></select></label><p class="form-note" id="output-note"></p>', async () => {
      await api.outputSet($('output-select').value); Toast('出力デバイスを保存しました。');
    }, '保存する', Settings);
    const select = $('output-select'); select.append(new Option('既定のデバイス', ''));
    for (const name of names) select.append(new Option(name, name));
    select.value = current || '';
    if (!names.length) $('output-note').textContent = 'デバイスの名前を取得できませんでした。既定のデバイスで鳴ります。';
  });
}
