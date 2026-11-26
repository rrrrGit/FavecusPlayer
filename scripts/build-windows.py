"""Windows用の小さなGUIランチャーと、自己展開セットアップを作る。"""
from pathlib import Path
import argparse, hashlib, json, struct, subprocess, tempfile, zipfile

ROOT = Path(__file__).resolve().parent.parent
ALIGN = lambda n, a=4: (n+a-1)//a*a

def run(*args):
    subprocess.run(args, check=True, cwd=ROOT)

def version_block(key, value=b'', kind=0, children=b'', value_length=None):
    head = b'\0'*6 + (key+'\0').encode('utf-16le')
    block = head + b'\0'*(ALIGN(len(head))-len(head)) + value
    block += b'\0'*(ALIGN(len(block))-len(block)) + children
    length = len(value)//2 if kind == 1 else len(value)
    return struct.pack('<HHH', len(block), length if value_length is None else value_length, kind) + block[6:]

def version_info(version, filename):
    a,b,c=map(int,version.split('.'));ms=a<<16|b;ls=c<<16
    fixed=struct.pack('<13I',0xFEEF04BD,0x10000,ms,ls,ms,ls,0x3f,0,0x40004,1,0,0,0)
    strings={'CompanyName':'Favecus Player','FileDescription':'FavecusPlayer','FileVersion':version,'ProductName':'FavecusPlayer','ProductVersion':version,'OriginalFilename':filename}
    items=b''.join(version_block(k,(v+'\0').encode('utf-16le'),1) for k,v in strings.items())
    info=version_block('StringFileInfo',kind=1,children=version_block('040904b0',kind=1,children=items))
    translation=version_block('VarFileInfo',kind=1,children=version_block('Translation',struct.pack('<HH',0x409,1200)))
    return version_block('VS_VERSION_INFO',fixed,children=info+translation)

def resources(icon, version, filename, payload):
    items={}
    ico=icon.read_bytes();count=struct.unpack_from('<H',ico,4)[0];group=ico[:6]
    for i in range(count):
        e=ico[6+i*16:22+i*16];size,offset=struct.unpack_from('<II',e,8)
        items[(3,i+1,1033)]=ico[offset:offset+size];group+=e[:12]+struct.pack('<H',i+1)
    items[(14,1,1033)]=group
    items[(16,1,1033)]=version_info(version,filename)
    items[(24,1,1033)]=b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="FavecusPlayer.Launcher" type="win32"/><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo><compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application></compatibility></assembly>'''
    if payload: items[(10,101,1033)]=payload.read_bytes()
    tree={}
    for (kind,name,lang),data in items.items():tree.setdefault(kind,{}).setdefault(name,{})[lang]=data
    out=bytearray();data_entries=[]
    def directory(node):
        offset=len(out);keys=sorted(node);out.extend(struct.pack('<IIHHHH',0,0,0,0,0,len(keys))+b'\0'*(len(keys)*8))
        for i,key in enumerate(keys):
            value=node[key]
            if isinstance(value,dict):dest=directory(value)|0x80000000
            else:
                dest=len(out);out.extend(b'\0'*16);data_entries.append((dest,value))
            struct.pack_into('<II',out,offset+16+i*8,key,dest)
        return offset
    directory(tree)
    fixups=[]
    for dest,data in data_entries:
        out.extend(b'\0'*(ALIGN(len(out))-len(out)));offset=len(out);out.extend(data)
        struct.pack_into('<IIII',out,dest,offset,len(data),0,0);fixups.append(dest)
    return out,fixups

def sections(pe):
    offset=struct.unpack_from('<I',pe,0x3c)[0];optional=offset+24
    assert pe[offset:offset+4]==b'PE\0\0' and struct.unpack_from('<H',pe,optional)[0]==0x20b
    table=optional+struct.unpack_from('<H',pe,offset+20)[0];result={}
    for i in range(struct.unpack_from('<H',pe,offset+6)[0]):
        start=table+i*40;name=pe[start:start+8].rstrip(b'\0').decode()
        virtual_size,rva,size,raw=struct.unpack_from('<IIII',pe,start+8);result[name]=(rva,raw,size,virtual_size)
    return optional,result

def symbol_rvas(pe):
    header=struct.unpack_from('<I',pe,0x3c)[0]
    symbols,count=struct.unpack_from('<II',pe,header+12)
    table=header+24+struct.unpack_from('<H',pe,header+20)[0]
    bases=[struct.unpack_from('<I',pe,table+i*40+12)[0] for i in range(struct.unpack_from('<H',pe,header+6)[0])]
    strings=symbols+count*18;result={};i=0
    while i<count:
        at=symbols+i*18;name=pe[at:at+8]
        if name[:4]==bytes(4):
            start=strings+struct.unpack_from('<I',name,4)[0];name=pe[start:pe.index(0,start)]
        else:name=name.split(bytes(1),1)[0]
        value,section=struct.unpack_from('<Ih',pe,at+8)
        if 0<section<=len(bases):result[name.decode('ascii')]=bases[section-1]+value
        i+=1+pe[at+17]
    return result


def build_exe(destination, mode, payload, version, work, source=None, electron_folder=None):
    resource,fixups=resources(ROOT/'build/icon.ico',version,destination.name,payload)
    (work/'resource.bin').write_bytes(resource)
    (work/'imports.s').write_text('''.section .idata,"aw"
.global Imports
Imports:
.space 64
.global LoadLibraryW,GetProcAddress,ExitProcess
LoadLibraryW: .quad 0
GetProcAddress: .quad 0
ExitProcess: .quad 0
.space 512
.section .data,"aw"
.quad Entry
''')
    (work/'resource.s').write_text('.section .rsrc,"a"\n.incbin "'+(work/'resource.bin').as_posix()+'"\n')
    flags=['-mabi=ms','-mno-red-zone','-fshort-wchar','-fpie','-ffreestanding','-fno-builtin','-fno-ident','-fno-stack-protector','-fno-asynchronous-unwind-tables','-fno-unwind-tables','-O2','-Wall','-Wextra','-Wno-unused-function','-Wno-unused-variable','-Wno-misleading-indentation']
    defines=[f'-DMODE={mode}']
    if electron_folder:defines.append(f'-DELECTRON_FOLDER=L"{electron_folder}"')
    run('gcc','-c',*flags,*defines,str(source or ROOT/'native/main.c'),'-o',str(work/'main.o'))
    for name in ['imports','resource']:run('gcc','-c',str(work/f'{name}.s'),'-o',str(work/f'{name}.o'))
    run('ld','-mi386pep','--subsystem','windows','--major-subsystem-version','6','--minor-subsystem-version','0','--image-base','0x140000000','--entry','Entry','--dynamicbase','--nxcompat','--stack','8388608,1048576',str(work/'main.o'),str(work/'imports.o'),str(work/'resource.o'),'-o',str(destination))
    pe=bytearray(destination.read_bytes());optional,sec=sections(pe);base_rva,base_raw,_,_=sec['.idata']
    # リンカーが追加する領域を考慮し、実際のシンボル位置へ書き込む。
    symbols=symbol_rvas(pe);rva=symbols['Imports'];raw=base_raw+rva-base_rva
    for i,name in enumerate(['LoadLibraryW','GetProcAddress','ExitProcess']):
        assert symbols[name]==rva+64+i*8, f'Unexpected import slot: {name}'
    dll=128;lookup=96;names=[160,180,200]
    struct.pack_into('<IIIII',pe,raw,rva+lookup,0,0,rva+dll,rva+64)
    pe[raw+dll:raw+dll+13]=b'kernel32.dll\0'
    for i,(name,at) in enumerate(zip(['LoadLibraryW','GetProcAddress','ExitProcess'],names)):
        value=b'\0\0'+name.encode()+b'\0';pe[raw+at:raw+at+len(value)]=value
        struct.pack_into('<Q',pe,raw+64+i*8,rva+at);struct.pack_into('<Q',pe,raw+lookup+i*8,rva+at)
    struct.pack_into('<II',pe,optional+112+8,rva,40)
    struct.pack_into('<II',pe,optional+112+12*8,rva+64,32)
    res_rva,res_raw,res_size,_=sec['.rsrc']
    for pos in fixups:struct.pack_into('<I',pe,res_raw+pos,struct.unpack_from('<I',pe,res_raw+pos)[0]+res_rva)
    struct.pack_into('<II',pe,optional+112+2*8,res_rva,res_size)
    struct.pack_into('<I',pe,optional+64,0)
    destination.write_bytes(pe)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--node',type=Path,required=True);parser.add_argument('--node-license',type=Path,required=True);parser.add_argument('--output',type=Path,default=ROOT/'dist/windows');args=parser.parse_args()
    node=args.node.read_bytes()
    if not node.startswith(b'MZ') or len(node)!=93381448 or hashlib.sha256(node).hexdigest()!='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5':raise ValueError('添付MSIから展開したNode.js v24.20.0 x64を指定してください')
    pkg=json.loads((ROOT/'package.json').read_text());version=pkg['version'];electron=json.loads((ROOT/'scripts/runtime-downloads.json').read_text())['electron']['version']
    electron_folder=f'runtime\\\\electron-{electron}'
    args.output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='favecus-windows-build-') as temporary:
        work=Path(temporary);launcher=args.output/'FavecusPlayer.exe';build_exe(launcher,0,None,version,work,electron_folder=electron_folder)
        taskbar=args.output/'FavecusPlayerTaskbar.exe';build_exe(taskbar,0,None,version,work,ROOT/'native/taskbar.c')
        records={}
        for folder in ['src','docs','build']:
            for p in sorted((ROOT/folder).rglob('*')):
                if p.is_file():records['app/'+p.relative_to(ROOT).as_posix()]=p
        for file in ['package.json','LICENSE']:records['app/'+file]=ROOT/file
        for file in ['install.cjs','install-core.cjs','brand-runtime.cjs','brand-runtime.ps1','runtime-downloads.json']:records['scripts/'+file]=ROOT/'scripts'/file
        records['FavecusPlayer.exe']=launcher;records['bootstrap/node.exe']=args.node;records['bootstrap/NODE-LICENSE.txt']=args.node_license
        records['app/build/FavecusPlayerTaskbar.exe']=taskbar
        manifest={'product':'favecus-player','version':version,'files':[{'path':name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()} for name,file in records.items()]}
        archive=work/'payload.zip'
        with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=7) as z:
            for name,file in records.items():z.write(file,name)
            z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
        build_exe(args.output/'Setup.exe',1,archive,version,work,electron_folder=electron_folder)
        build_exe(args.output/'Patch.exe',2,archive,version,work,electron_folder=electron_folder)
    checksums={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in args.output.glob('*.exe')}
    (args.output/'SHA256SUMS.txt').write_text('\n'.join(f'{value}  {name}' for name,value in checksums.items())+'\n')
    print(json.dumps({'version':version,'files':[{ 'file':str(p),'bytes':p.stat().st_size } for p in args.output.iterdir()]},ensure_ascii=False))
if __name__=='__main__':main()
