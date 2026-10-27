'use strict';
function DriveURL(value) {
  const text = String(value || '').trim() || 'https://drive.google.com/drive/u/0/my-drive';
  let url; try { url = new URL(text); } catch { throw new Error('Google DriveのURLを入力してください。'); }
  if (text.length > 2048 || url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port) throw new Error('HTTPSのGoogle Drive URLを入力してください。');
  return url.href;
}
function Repository(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('https://')) {
    const url = new URL(text);
    if (url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) throw new Error('GitHubのリポジトリURLを入力してください。');
    text = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\/releases(?:\/latest)?$/, '');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(text) || ['.', '..'].includes(text.split('/')[1])) throw new Error('配信先は「所有者/リポジトリ名」またはGitHubのURLで指定してください。');
  return text;
}
function ReleaseURL(repository) { const repo = Repository(repository); if (!repo) throw new Error('GitHubの配信先が未設定です。'); return `https://github.com/${repo}/releases/latest`; }
function Version(value) { const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || ''); return match ? match.slice(1).map(Number) : null; }
async function CheckRelease(repository, current, fetcher = fetch) {
  const repo = Repository(repository), url = ReleaseURL(repo);
  const response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, { redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FavecusPlayer' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status === 404 ? '公開リリースが見つかりません。配信先と公開状態を確認してください。' : response.status === 403 || response.status === 429 ? 'GitHubの取得制限です。時間を置いて再確認してください。' : `更新情報を取得できません（HTTP ${response.status}）。`);
  const release = await response.json(), latest = Version(release.tag_name), installed = Version(current);
  if (release.draft || release.prerelease || !latest || !installed) throw new Error('安定版のバージョン情報を読み取れません。リリースページを確認してください。');
  const difference = latest.map((n, i) => n - installed[i]).find(n => n !== 0) || 0;
  return { current, latest: latest.join('.'), available: difference > 0, url };
}
module.exports = { Repository, ReleaseURL, CheckRelease, DriveURL };
