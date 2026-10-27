'use strict';
const Messages = {
  'FP-DOWNLOAD-CONNECTION': '配信サーバーとの通信が途中で切れました。時間を置いて再実行してください。',
  'FP-DOWNLOAD-TIMEOUT': '通信が時間内に進みませんでした。接続を確認してください。',
  'FP-DOWNLOAD-INCOMPLETE': '取得したデータが不完全です。保存済みにはしていません。',
  'FP-DOWNLOAD-AUTH': 'ログイン状態を確認してください。',
  'FP-DOWNLOAD-LIMIT': '配信元から利用制限が返されました。時間を置いて再実行してください。',
  'FP-DOWNLOAD-HTTP': '配信元から取得できませんでした。公開範囲とログイン状態を確認してください。',
  'FP-DOWNLOAD-NOSPACE': '保存先の空き容量が不足しています。',
  'FP-DOWNLOAD-PERMISSION': '保存先に書き込めません。アクセス権と使用中のファイルを確認してください。',
  'FP-DOWNLOAD-PATH': '保存先のファイル名・階層を扱えません。保存先を短いパスに変更してください。',
  'FP-DOWNLOAD-FORMAT': '取得したデータの結合・再生時間の確認に失敗しました。',
  'FP-DOWNLOAD-METADATA': '動画情報を取得できませんでした。公開範囲・パート・ログイン状態を確認してください。',
  'FP-DOWNLOAD-COVER': 'サムネイルを保存できませんでした。保存済みの動画・音声は利用できます。',
  'FP-DOWNLOAD-LAYOUT': '保存フォルダーを整理できませんでした。元の保存データを保持しています。',
  'FP-DOWNLOAD-UNKNOWN': '保存を完了できませんでした。エラーコードと記録IDを確認してください。'
};
function DownloadDiagnostic(error, phase = '') {
  const causes = []; for (let e = error; e && causes.length < 4 && !causes.includes(e); e = e.cause) causes.push(e);
  const codes = causes.map(e => String(e.code || e.name || ''));
  const httpStatus = causes.find(e => Number.isInteger(e.httpStatus))?.httpStatus || null;
  const apiCode = causes.find(e => Number.isInteger(e.apiCode))?.apiCode ?? null;
  let code = causes.find(e => Messages[e.downloadCode])?.downloadCode;
  if (!code) {
    if (codes.includes('ENOSPC')) code = 'FP-DOWNLOAD-NOSPACE';
    else if (codes.some(c => ['EACCES', 'EPERM', 'EBUSY', 'EROFS'].includes(c))) code = 'FP-DOWNLOAD-PERMISSION';
    else if (codes.some(c => ['ENAMETOOLONG', 'EINVAL', 'ENOENT'].includes(c))) code = 'FP-DOWNLOAD-PATH';
    else if (httpStatus === 401 || apiCode === -101) code = 'FP-DOWNLOAD-AUTH';
    else if ([412, 429].includes(httpStatus) || [-352, -412, -509].includes(apiCode)) code = 'FP-DOWNLOAD-LIMIT';
    else if (httpStatus) code = 'FP-DOWNLOAD-HTTP';
    else if (codes.some(c => /TIMEOUT|TIMEDOUT|TimeoutError/.test(c))) code = 'FP-DOWNLOAD-TIMEOUT';
    else if (codes.some(c => /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN/.test(c)) || causes.some(e => /^(terminated|fetch failed|other side closed)$/i.test(e.message || ''))) code = 'FP-DOWNLOAD-CONNECTION';
    else code = ({ metadata: 'FP-DOWNLOAD-METADATA', format: 'FP-DOWNLOAD-FORMAT', cover: 'FP-DOWNLOAD-COVER', layout: 'FP-DOWNLOAD-LAYOUT' })[phase] || 'FP-DOWNLOAD-UNKNOWN';
  }
  // 署名付きURL・Cookie・生の例外文を診断ログへ持ち込まない。
  return { code, message: Messages[code], phase, httpStatus, apiCode, nativeCode: codes.find(c => /^[A-Z][A-Z0-9_]{1,50}$/.test(c)) || null };
}
module.exports = { DownloadDiagnostic, Messages };
