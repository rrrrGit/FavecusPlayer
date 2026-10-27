"""Check local UI resources, version consistency and public-source exclusions."""
from pathlib import Path
from html.parser import HTMLParser
import argparse, json, re

ROOT = Path(__file__).resolve().parent.parent

class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids = []; self.refs = []; self.csp = None
    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if 'id' in attrs: self.ids.append(attrs['id'])
        if tag in {'script', 'link', 'img', 'use'}:
            ref = attrs.get('src') or attrs.get('href')
            if ref: self.refs.append(ref)
        if tag == 'meta' and attrs.get('http-equiv', '').lower() == 'content-security-policy': self.csp = attrs.get('content', '')

def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--output', type=Path); args = parser.parse_args()
    pkg = json.loads((ROOT/'package.json').read_text()); version = pkg['version']; lock = json.loads((ROOT/'package-lock.json').read_text())
    assert version == lock['version'] == lock['packages']['']['version']
    assert f'id="version">{version}<' in (ROOT/'src/ui/index.html').read_text()
    pages = []
    for source in sorted((ROOT/'src/ui').glob('*.html')):
        page = Page(); page.feed(source.read_text()); assert len(page.ids) == len(set(page.ids)), source
        assert page.csp and re.search(r"(?:^|;\s*)default-src '(?:none|self)'(?:;|$)", page.csp), source
        assert "script-src 'self'" in page.csp and "base-uri 'none'" in page.csp and 'unsafe-eval' not in page.csp, source
        for ref in page.refs:
            file = ref.split('#')[0]
            if not file: continue
            assert not re.match(r'^[a-z]+:', file), (source, ref)
            assert (source.parent/file).is_file() or (ROOT/'build'/file).is_file(), (source, ref)
        pages.append({'file':source.relative_to(ROOT).as_posix(), 'ids':len(page.ids), 'references':len(page.refs)})
    guide = (ROOT/'docs/GUIDE.html').read_text()
    assert not re.search(r'0\.\d+\.\d+\s*(?:で実装|で追加|から実装|で導入)', guide)
    secret = re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|AIza[A-Za-z0-9_-]{30,}')
    checked = 0
    for source in ROOT.rglob('*'):
        if not source.is_file() or {'dist','node_modules','release-validation','.git','__pycache__'}.intersection(source.relative_to(ROOT).parts): continue
        assert source.suffix.lower() not in {'.dmp','.jsonl','.pem','.p12'} and source.name not in {'.env','Cookies','playlists.json','download-settings.json','play-counts.json'}, source
        if source.suffix.lower() in {'.js','.cjs','.py','.ps1','.c','.h','.md','.html','.json','.txt','.yml','.yaml'}:
            assert not secret.search(source.read_text()), f'secret-shaped content: {source.relative_to(ROOT)}'
        checked += 1
    result = {'version':version,'status':'pass','pages':pages,'guideFeatureVersionPhrases':'absent','publicSourceFilesChecked':checked,'knownCredentialPatterns':'absent','windowsVisualReview':'not tested'}
    text = json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if args.output: args.output.write_text(text)
    print(text, end='')

if __name__ == '__main__': main()
