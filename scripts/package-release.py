"""Create the release deliverables, Discord icon and combined ZIP after verification."""
from pathlib import Path
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def sha(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def copy_verified(source, destination):
    temporary = destination.with_name(destination.name + '.tmp')
    with source.open('rb') as stream, temporary.open('wb', buffering=0) as target:
        while chunk := stream.read(1024 * 1024):
            remaining = memoryview(chunk)
            while remaining:
                written = target.write(remaining)
                if not written:
                    raise OSError('short write made no progress')
                remaining = remaining[written:]
        os.fsync(target.fileno())
    assert temporary.stat().st_size == source.stat().st_size
    assert sha(temporary) == sha(source)
    os.replace(temporary, destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--windows', type=Path, required=True)
    parser.add_argument('--verification', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--profile', choices=('full', 'patch'), default='full')
    parser.add_argument('--platform', choices=('windows-x64',), default='windows-x64')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    source_commit = source_tree = None
    if (ROOT / '.git').exists():
        assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT).strip(), 'Commit the release source before packaging'
        source_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        source_tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()
    pe = json.loads((args.verification / 'pe-verification.json').read_text())
    expected = {'FavecusPlayer.exe', 'FavecusPlayerTaskbar.exe', 'Patch.exe', 'Setup.exe'}
    assert {item['file'] for item in pe} == expected
    for item in pe:
        assert item['version'] == version
        assert item['sha256'] == sha(args.windows / item['file'])
    startup = json.loads((args.verification / 'windows-entry-test.txt').read_text())
    assert {item['file'] for item in startup} == expected
    assert all(item['exit'] == 0 for item in startup)
    test_text = (args.verification / 'node-tests.txt').read_text()
    tests = {key: int(re.search(rf'^ℹ {key} (\d+)$', test_text, re.M)[1]) for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped')}
    assert tests['tests'] > 0 and tests['fail'] == tests['cancelled'] == 0
    syntax = (args.verification / 'syntax.txt').read_text().strip()
    assert re.fullmatch(r'\d+ JavaScript files: syntax OK', syntax)
    audit = json.loads((args.verification / 'ui-resource-audit.json').read_text())
    assert audit['version'] == version and audit['status'] == 'pass'

    outputs = {}
    for kind in (('Patch',) if args.profile == 'patch' else ('Patch', 'Setup')):
        outputs[kind.lower()] = args.output / f'Favecus-Player-{version}-{kind}.exe'
        copy_verified(args.windows / f'{kind}.exe', outputs[kind.lower()])

    html = (ROOT / 'docs/GUIDE.html').read_text()
    sections = []
    for name, anchor in (('TASKBAR', 'taskbar-guide'), ('DISCORD', 'discord-guide')):
        html = html.replace(f'href="{name}.html"', f'href="#{anchor}"')
        page = (ROOT / f'docs/{name}.html').read_text()
        body = re.search(r'<body>(.*)</body>', page, re.S)[1]
        body = re.sub(r'src="([^":]+\.png)"', lambda m: 'src="data:image/png;base64,' + base64.b64encode((ROOT / 'docs' / m[1]).read_bytes()).decode() + '"', body)
        sections.append(f'<hr><section id="{anchor}">{body}</section>')
    html = html.replace("img-src 'self'", "img-src 'self' data:").replace('</body>', ''.join(sections) + '</body>')
    for link in re.findall(r'(?:href|src)="([^"]+)"', html):
        assert link.startswith(('https:', 'http:', '#', 'data:')), link
    outputs['guide'] = args.output / f'Favecus-Player-{version}-Guide.html'
    outputs['guide'].write_text(html, encoding='utf-8')

    excluded = {'node_modules', 'dist', '__pycache__', 'qa', '.git', 'release-validation'}
    files = sorted(p for p in ROOT.rglob('*') if p.is_file() and not excluded.intersection(p.relative_to(ROOT).parts))
    validation = {
        'version': version, 'created': datetime.now(timezone.utc).isoformat(),
        'platform': args.platform, 'profile': args.profile, 'sourceCommit': source_commit, 'sourceTree': source_tree,
        'nodeTests': tests, 'javascriptSyntax': syntax, 'uiResources': audit,
        'sourceFiles': len(files), 'windowsPE': pe, 'windowsEntryMock': startup,
        'nativeMock': (args.verification / 'native-tests.txt').read_text().strip(),
        'windowsRealGUI': 'not tested', 'browserVisualReview': 'See docs/DEVELOPMENT-STATUS.md; packaging does not perform GUI testing',
        'bilibiliDiscordLive': 'not tested',
        'guideStandaloneLinks': 'pass',
        'sourceHashes': {p.relative_to(ROOT).as_posix(): sha(p) for p in files},
    }
    if args.profile == 'full':
        outputs['source'] = args.output / f'Favecus-Player-{version}-source.zip'
        with zipfile.ZipFile(outputs['source'], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for file in files:
                archive.write(file, 'favecus-player/' + file.relative_to(ROOT).as_posix())
            archive.writestr('favecus-player/release-validation/completion.json', json.dumps(validation, ensure_ascii=False, indent=2) + '\n')
            for name in ('node-tests.txt', 'syntax.txt', 'native-tests.txt', 'pe-verification.json', 'windows-entry-test.txt', 'ui-resource-audit.json'):
                archive.write(args.verification / name, 'favecus-player/release-validation/' + name)
        with zipfile.ZipFile(outputs['source']) as archive:
            assert archive.testzip() is None
            for name, value in validation['sourceHashes'].items():
                assert hashlib.sha256(archive.read('favecus-player/' + name)).hexdigest() == value

    if args.profile == 'full':
        outputs['icon'] = args.output / 'favecus_player_music.png'
        copy_verified(ROOT / 'docs/favecus_player_music.png', outputs['icon'])
    changelog = (ROOT / 'docs/CHANGELOG.md').read_text()
    heading = f'# {version}\n'
    assert changelog.startswith(heading), 'Changelog version mismatch'
    changes = changelog.split('\n# ', 1)[0]
    changes = changes.replace('最終Windows Patchの生成・出力はStep12で行います。', '').strip()
    notes = f'''{changes}

対象：{args.platform}
生成元コミット：{source_commit or 'Git情報なし（ソースアーカイブからの生成）'}
生成元ツリー：{source_tree or 'Git情報なし'}

更新方法：アプリを終了し、Patch.exeを更新先の外から実行して、FavecusPlayer.exe・app・runtimeがある最上位フォルダーを選びます。
設定・プレイリスト・DLデータは保持し、旧保存配置の移行は更新後のアプリが管理情報を確認して行います。

検証：Nodeテスト {tests['pass']}/{tests['tests']} 成功、失敗 {tests['fail']}、スキップ {tests['skipped']}。{syntax}
Windows EXEの構造・内包ハッシュ・模擬Win32の起動入口・ネイティブ処理を確認しています。
未確認：Windows実機でのインストール/更新/再生、Bilibili実通信、Discord実表示。
'''
    outputs['notes'] = args.output / f'Favecus-Player-{version}-Release-Notes.txt'
    outputs['notes'].write_text(notes, encoding='utf-8')
    outputs['validation'] = args.output / f'Favecus-Player-{version}-Validation.json'
    outputs['validation'].write_text(json.dumps(validation, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    relative_paths = {kind: ('guide' if kind == 'icon' else kind) + '/' + file.name for kind, file in outputs.items()}
    checksums = args.output / f'Favecus-Player-{version}-SHA256SUMS.txt'
    checksums.write_text(''.join(f'{sha(file)}  {relative_paths[kind]}\n' for kind, file in outputs.items()))
    label = f'FavecusPlayer_v{version}' + ('_Patch' if args.profile == 'patch' else '')
    bundle = args.output / f'{label}.zip'
    prefix = f'{label}/'
    with tempfile.TemporaryDirectory(prefix='favecus-release-') as temporary:
        staged_bundle = Path(temporary) / bundle.name
        with staged_bundle.open('w+b', buffering=0) as stream:
            with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
                for kind, file in outputs.items():
                    archive.write(file, prefix + relative_paths[kind])
                archive.write(checksums, prefix + 'SHA256SUMS.txt')
            os.fsync(stream.fileno())
        copy_verified(staged_bundle, bundle)
    with zipfile.ZipFile(bundle) as archive:
        assert archive.testzip() is None
        for kind, file in outputs.items():
            assert hashlib.sha256(archive.read(prefix + relative_paths[kind])).hexdigest() == sha(file)
    outputs['bundle'] = bundle
    outputs['checksums'] = checksums
    records = [{'kind': kind, 'name': file.name, 'path': str(file.resolve()), 'bytes': file.stat().st_size, 'sha256': sha(file)} for kind, file in outputs.items()]
    result = {'version': version, 'status': 'complete', 'platform': args.platform, 'profile': args.profile, 'sourceCommit': source_commit, 'sourceTree': source_tree, 'nodeTests': tests, 'sourceFiles': len(files), 'outputs': records}
    (args.verification / 'completion.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
