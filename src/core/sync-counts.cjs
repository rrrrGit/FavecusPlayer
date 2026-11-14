'use strict';
// 再生回数と「再生回数が少ない曲を優先する」設定の同期（Windows版・iPhone版で共通。端末APIなし）。
// ライブラリの同期（sync-session.cjs）の後に、別の処理として動かす。失敗・テーブル未作成でも、ライブラリの同期には影響しない。
// adapter（端末側）：
//   Read()  → { deviceId, epoch, cursor, rows: [{ epoch, month, key, n }]（送る行。初回は全部、以降は変わった行だけ）, prefs: { weighted: boolean, at: number（ミリ秒。変更していなければ0） } }
//   Apply({ rows, epoch, cursor, prefs })  prefs は { weighted, at } か null（リモートの設定が新しいとき）。端末が保存する
//   Pushed()  送信に成功したあとに呼ぶ（変わった行の印を消す）
// repository：sync-supabase.cjs の PushCounts / PullCounts / GetPrefs / PutPrefs。
async function SyncExtras(adapter, repository) {
  try {
    const local = await adapter.Read();
    const remote = await repository.GetPrefs();
    const epoch = Math.max(local.epoch, remote ? remote.epoch : 0);
    // 設定は、新しい時刻の方が勝つ（同じなら、この端末のまま）
    const remoteWins = !!remote && remote.at > local.prefs.at;
    const prefs = remoteWins ? { weighted: remote.weighted, at: remote.at } : { weighted: local.prefs.weighted, at: local.prefs.at };
    const pulled = await repository.PullCounts(local.cursor, local.deviceId);
    await adapter.Apply({ rows: pulled.rows, epoch, cursor: pulled.cursor, prefs: remoteWins ? prefs : null });
    if (local.rows.length) await repository.PushCounts(local.deviceId, local.rows);
    if (!remote || local.epoch > remote.epoch || (!remoteWins && local.prefs.at > (remote ? remote.at : 0))) await repository.PutPrefs({ epoch, weighted: prefs.weighted, at: prefs.at });
    await adapter.Pushed();
    return { ok: true, pushed: local.rows.length, pulled: pulled.rows.length, epoch };
  } catch (error) {
    return { ok: false, missing: error && error.code === 'missing', error: String(error && error.message || error) };
  }
}
module.exports = { SyncExtras };
