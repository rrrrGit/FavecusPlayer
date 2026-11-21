'use strict';
// ローカル(Windows非特権・ffmpeg/python3なし)で実行できないテストを、理由つきでスキップするための判定。
// CI(環境変数 CI)では、スキップせず、必須として実行する。
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

function CanSymlink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favecus-sym-'));
  try { fs.writeFileSync(path.join(dir, 'a'), 'x'); fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b')); return true; }
  catch { return false; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const symlink = CanSymlink();
const python3 = spawnSync('python3', ['-c', '1'], { stdio: 'ignore' }).status === 0;
const ffmpeg = fs.existsSync('/usr/bin/ffmpeg');
const ci = Boolean(process.env.CI);

// 使い方: test(name, Skip(Needs.symlink), async t => {...})。条件を満たすか、CIなら、skip は false。
const Needs = {
  symlink: !symlink && !ci ? 'このPCでは、シンボリックリンクを作れません（管理者権限か開発者モードが必要）。CIでは実行します' : false,
  python3: !python3 && !ci ? 'python3 がありません。CIでは実行します' : false,
  ffmpeg: !ffmpeg && !ci ? '/usr/bin/ffmpeg がありません。CIでは実行します' : false
};
module.exports = { Needs, Skip: reason => ({ skip: reason }) };
