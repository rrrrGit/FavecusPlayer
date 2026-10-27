"""Create the release deliverables, Discord icon and combined ZIP after verification."""
from pathlib import Path
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
import re
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
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    version = json.loads((ROOT / 'package.json').read_text())['version']
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
    for kind in ('Patch', 'Setup'):
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
        'nodeTests': tests, 'javascriptSyntax': syntax, 'uiResources': audit,
        'sourceFiles': len(files), 'windowsPE': pe, 'windowsEntryMock': startup,
        'nativeMock': (args.verification / 'native-tests.txt').read_text().strip(),
        'windowsRealGUI': 'not tested', 'browserVisualReview': 'not tested',
        'bilibiliDiscordLive': 'not tested',
        'guideStandaloneLinks': 'pass',
        'sourceHashes': {p.relative_to(ROOT).as_posix(): sha(p) for p in files},
    }
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

    outputs['icon'] = args.output / 'favecus_player_music.png'
    copy_verified(ROOT / 'docs/favecus_player_music.png', outputs['icon'])
    relative_paths = {kind: ('guide' if kind == 'icon' else kind) + '/' + file.name for kind, file in outputs.items()}
    checksums = args.output / f'Favecus-Player-{version}-SHA256SUMS.txt'
    checksums.write_text(''.join(f'{sha(file)}  {relative_paths[kind]}\n' for kind, file in outputs.items()))
    bundle = args.output / f'FavecusPlayer_v{version}.zip'
    prefix = f'FavecusPlayer_v{version}/'
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
    records = [{'kind': kind, 'name': file.name, 'path': str(file.resolve()), 'bytes': file.stat().st_size, 'sha256': sha(file)} for kind, file in outputs.items()]
    result = {'version': version, 'status': 'complete', 'nodeTests': tests, 'sourceFiles': len(files), 'outputs': records}
    (args.verification / 'completion.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
