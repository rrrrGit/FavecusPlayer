"""生成済みPEの起動入口とAPI初期化をLinux x64上の模擬Win32関数で検証する。"""
from pathlib import Path
import argparse,json,subprocess,tempfile
ROOT=Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('target',type=Path);p.add_argument('--expect-failure',action='store_true');a=p.parse_args()
files=[a.target] if a.target.is_file() else sorted(a.target.glob('*.exe'))
assert files,'No EXEs to verify'
results=[]
with tempfile.TemporaryDirectory(prefix='favecus-native-test-') as t:
 test=Path(t)/'native-startup'
 subprocess.run(['gcc','-std=c11','-O2',str(ROOT/'test/native-startup.c'),'-o',str(test)],check=True)
 for file in files:
  r=subprocess.run([str(test),str(file.resolve())],capture_output=True,text=True,timeout=10)
  results.append({'file':file.name,'exit':r.returncode,'output':(r.stdout+r.stderr).strip()})
print(json.dumps(results,ensure_ascii=False,indent=2))
assert all(r['exit']!=0 if a.expect_failure else r['exit']==0 for r in results),'Native startup regression'
