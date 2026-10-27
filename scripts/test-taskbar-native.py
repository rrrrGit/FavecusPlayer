"""実装本体に模擬Win32 APIを接続し、親子関係・配置・失敗・通信を検証する。Windows実機テストではない。"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='favecus-taskbar-test-') as temporary:
    for name in ['taskbar-native', 'launcher-native']:
        binary = Path(temporary) / name
        subprocess.run(['gcc', '-std=c11', '-O0', '-fshort-wchar', '-ffunction-sections', '-fdata-sections',
                        '-Wl,--gc-sections', str(ROOT / f'test/{name}.c'), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True, timeout=10)
