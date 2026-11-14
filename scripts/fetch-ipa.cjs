'use strict';
// iOSのCIが生成した署名なしIPAを、GoogleドライブのPC同期フォルダー（マイドライブ/FavecusPlayer/ios）へ保存する。
// 実機での検証が必要になるごとに、CIの成功後に実行する。認証情報は扱わない（gh CLIの既存ログインのみ使用）。
//
// 使い方:
//   node scripts/fetch-ipa.cjs                 現在のブランチの最新の成功したiOS buildを取得
//   node scripts/fetch-ipa.cjs --run <ID>      指定したrunを取得
//   node scripts/fetch-ipa.cjs --dir <パス>     保存先を指定（環境変数 FAVECUS_IPA_DIR でも可）
//   node scripts/fetch-ipa.cjs --dry-run       取得せず、保存先とrunだけ表示
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

function Args() {
  const out = { run: '', dir: process.env.FAVECUS_IPA_DIR || '', dryRun: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') out.run = argv[++i] || '';
    else if (argv[i] === '--dir') out.dir = argv[++i] || '';
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  if (out.run && !/^\d+$/.test(out.run)) throw new Error('--run には数値のrun IDを指定してください。');
  return out;
}
const run = (command, ...args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Google Drive for desktop は、仮想ドライブ（G:など）の「マイドライブ」（日本語環境）または「My Drive」に同期する。
function FindDriveRoot() {
  for (const letter of 'GHIJKLMNOPQRSTUVWXYZDEF') {
    for (const name of ['マイドライブ', 'My Drive']) {
      const candidate = `${letter}:\\${name}`;
      try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch { /* 存在しない */ }
    }
  }
  return '';
}
function Destination(options) {
  if (options.dir) return path.resolve(options.dir);
  const root = FindDriveRoot();
  if (!root) throw new Error('Googleドライブの同期フォルダー（マイドライブ）が見つかりません。Google Drive for desktopにサインインして同期を有効にするか、--dir で保存先を指定してください。');
  return path.join(root, 'FavecusPlayer', 'ios');
}

function Main() {
  const options = Args(), dest = Destination(options);
  let id = options.run, sha = '';
  if (id) {
    const info = JSON.parse(run('gh', 'run', 'view', id, '--json', 'headSha,conclusion,workflowName'));
    if (info.workflowName !== 'iOS build' || info.conclusion !== 'success') throw new Error(`run ${id} は成功した「iOS build」ではありません（${info.workflowName} / ${info.conclusion}）。`);
    sha = info.headSha;
  } else {
    const branch = run('git', 'rev-parse', '--abbrev-ref', 'HEAD');
    const list = JSON.parse(run('gh', 'run', 'list', '--workflow', 'ios.yml', '--branch', branch, '--status', 'success', '--limit', '1', '--json', 'databaseId,headSha'));
    if (!list.length) throw new Error(`ブランチ ${branch} に成功したiOS buildがありません。`);
    id = String(list[0].databaseId); sha = list[0].headSha;
  }
  const name = `FavecusPlayer-${sha.slice(0, 7)}-run${id}.ipa`, target = path.join(dest, name);
  console.log(`run: ${id}\ncommit: ${sha}\n保存先: ${target}`);
  try { if (run('git', 'rev-parse', 'HEAD') !== sha) console.log('注意: このrunのコミットは、現在のHEADと異なります。'); } catch { /* gitがない場合は省略 */ }
  if (options.dryRun) return console.log('（--dry-run のため取得しません）');
  if (fs.existsSync(target)) return console.log('同名のIPAが既にあるため、何もしません。');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-ipa-'));
  try {
    run('gh', 'run', 'download', id, '-n', 'ios-outputs', '-D', temp);
    const ipa = path.join(temp, 'FavecusPlayer-unsigned.ipa');
    if (!fs.existsSync(ipa) || fs.statSync(ipa).size < 1024) throw new Error('Artifactに有効なIPAが含まれていません（保持期間14日を過ぎた可能性があります）。');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(ipa, target, fs.constants.COPYFILE_EXCL);
    console.log(`保存しました（${fs.statSync(target).size} バイト）。Googleドライブの同期完了後、iPhoneの「ファイル」アプリから開けます。`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
try { Main(); } catch (error) { console.error(`失敗: ${error.message}`); process.exit(1); }
