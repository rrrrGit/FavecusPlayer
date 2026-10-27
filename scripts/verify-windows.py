"""PEヘッダー、インポート、アイコン、内包ZIPと全ファイルのハッシュを検証する。"""
from pathlib import Path
import argparse, hashlib, io, json, struct, zipfile
from importlib.util import spec_from_file_location, module_from_spec
spec=spec_from_file_location('builder',Path(__file__).with_name('build-windows.py'));builder=module_from_spec(spec);spec.loader.exec_module(builder)

def verify(file):
    pe=file.read_bytes();optional,sections=builder.sections(pe)
    assert struct.unpack_from('<H',pe,optional+68)[0]==2,'Windows GUI subsystem required'
    assert struct.unpack_from('<H',pe,optional+70)[0]&0x140==0x140,'ASLR and NX required'
    assert struct.unpack_from('<II',pe,optional+112+5*8)[1]>0,'ASLR relocation table required'
    for name,(rva,raw,size,virtual) in sections.items():
        if raw: assert raw+size<=len(pe),(name,'truncated section')
    def offset(rva):
        for _,(base,raw,size,_) in sections.items():
            if base<=rva<base+size:return raw+rva-base
        raise AssertionError(f'Unmapped RVA: {rva}')
    import_rva=struct.unpack_from('<I',pe,optional+120)[0];entry=offset(import_rva)
    table,_,_,dll,iat=struct.unpack_from('<5I',pe,entry)
    assert pe[offset(dll):offset(dll)+13]==b'kernel32.dll\0'
    names=[]
    for i in range(4):
        rva=struct.unpack_from('<Q',pe,offset(table)+i*8)[0]
        assert rva==struct.unpack_from('<Q',pe,offset(iat)+i*8)[0]
        if not rva:break
        start=offset(rva)+2;names.append(pe[start:pe.index(0,start)].decode())
    assert names==['LoadLibraryW','GetProcAddress','ExitProcess']
    symbols=builder.symbol_rvas(pe)
    for i,name in enumerate(names):
        assert symbols[name]==iat+i*8, f'{name}: compiled call slot does not match loader IAT'
    resource_rva=struct.unpack_from('<I',pe,optional+128)[0];resource=offset(resource_rva);leaves={}
    def walk(at,keys=()):
        named,numbered=struct.unpack_from('<HH',pe,resource+at+12);assert named==0
        for i in range(numbered):
            key,dest=struct.unpack_from('<II',pe,resource+at+16+i*8)
            if dest&0x80000000:walk(dest&0x7fffffff,(*keys,key))
            else:
                rva,size,_,_=struct.unpack_from('<4I',pe,resource+dest);start=offset(rva)
                assert start+size<=len(pe);leaves[(*keys,key)]=pe[start:start+size]
    walk(0)
    assert (14,1,1033) in leaves and (16,1,1033) in leaves and (24,1,1033) in leaves
    version_info=leaves[(16,1,1033)];fixed=builder.ALIGN(6+(len('VS_VERSION_INFO')+1)*2)
    assert struct.unpack_from('<I',version_info,fixed)[0]==0xFEEF04BD
    ms,ls=struct.unpack_from('<II',version_info,fixed+8)
    version=f'{ms>>16}.{ms&0xffff}.{ls>>16}'
    payload=leaves.get((10,101,1033));count=0;source_count=0
    if payload:
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            assert z.testzip() is None
            manifest=json.loads(z.read('manifest.json'));assert manifest['version']==version
            assert len(z.namelist())==len(set(z.namelist())), 'Duplicate payload paths'
            assert set(z.namelist())=={'manifest.json',*(item['path'] for item in manifest['files'])}, 'Unexpected payload files'
            for item in manifest['files']:
                data=z.read(item['path']);assert hashlib.sha256(data).hexdigest()==item['sha256'],item['path'];count+=1
                name=item['path']
                source=None
                if name.startswith('app/') and name!='app/build/FavecusPlayerTaskbar.exe': source=builder.ROOT/name[4:]
                elif name.startswith('scripts/'): source=builder.ROOT/name
                elif name=='FavecusPlayer.exe': source=file.parent/name
                if source:
                    assert data==source.read_bytes(), f'Bundled file differs from current source: {name}'
                    source_count+=1
            node=z.read('bootstrap/node.exe')
            assert len(node)==93381448 and hashlib.sha256(node).hexdigest()=='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'
            assert json.loads(z.read('app/package.json'))['version']==version
            helper=z.read('app/build/FavecusPlayerTaskbar.exe')
            assert helper.startswith(b'MZ'),'Missing taskbar helper PE'
            assert helper==(file.parent/'FavecusPlayerTaskbar.exe').read_bytes(),'Bundled helper differs from verified build'
    return {'file':file.name,'bytes':len(pe),'version':version,'payloadFiles':count,'sourceFilesCompared':source_count,'sha256':hashlib.sha256(pe).hexdigest()}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);a=p.parse_args()
    print(json.dumps([verify(file) for file in sorted(a.directory.glob('*.exe'))],ensure_ascii=False,indent=2))
