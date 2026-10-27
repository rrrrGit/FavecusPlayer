"""添付MSIのCABからNode本体だけを展開する。MSIの実行・インストールは行わない。"""
from pathlib import Path
import argparse, ctypes, ctypes.util, hashlib, struct, zipfile
NODE_SHA='5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'
def u32(data,at=0):return struct.unpack_from('<I',data,at)[0]
def cabinet_from_msi(data):
    if data[:8]!=bytes.fromhex('D0CF11E0A1B11AE1'):raise ValueError('MSIではありません')
    size=1<<struct.unpack_from('<H',data,30)[0]
    def sector(n):return data[(n+1)*size:(n+2)*size]
    ids=list(struct.unpack_from('<109I',data,76));n=u32(data,68)
    for _ in range(u32(data,72)):
        block=struct.unpack('<'+'I'*(size//4),sector(n));ids+=block[:-1];n=block[-1]
    fat=[]
    for n in [x for x in ids if x<0xfffffffa][:u32(data,44)]:fat+=struct.unpack('<'+'I'*(size//4),sector(n))
    def chain(n):
        chunks=[];seen=set()
        while n<0xfffffffa:
            if n in seen:raise ValueError('壊れたMSIです')
            seen.add(n);chunks.append(sector(n));n=fat[n]
        return b''.join(chunks)
    directory=chain(u32(data,48))
    for at in range(0,len(directory),128):
        entry=directory[at:at+128];length=struct.unpack_from('<Q',entry,120)[0]
        if entry[66]!=2 or length<4096:continue
        stream=chain(u32(entry,116))[:length]
        if stream.startswith(b'MSCF'):return stream
    raise ValueError('CABが見つかりません')
def node_cabinet(cab):
    position=u32(cab,16);entries=[];selected=None
    for _ in range(struct.unpack_from('<H',cab,28)[0]):
        start=position;size,offset,folder=struct.unpack_from('<IIH',cab,position);position=cab.index(b'\0',position+16)+1
        entry=bytearray(cab[start:position]);entries.append((folder,offset,size,entry))
        if entry[16:-1]==b'node.exe':selected=folder
    if selected is None:raise ValueError('Node本体が見つかりません')
    # MSIの重複ファイル参照を除き、libarchiveで読める単一フォルダーのCABにする。
    seen=set();files=[]
    for folder,offset,size,entry in sorted(entries,key=lambda e:e[1]):
        if folder==selected and (offset,size) not in seen:
            seen.add((offset,size));struct.pack_into('<H',entry,8,0);files.append(entry)
    start,blocks,codec=struct.unpack_from('<IHH',cab,36+8*selected);end=start
    for _ in range(blocks):end+=8+struct.unpack_from('<H',cab,end+4)[0]
    header=bytearray(cab[:36]);struct.pack_into('<I',header,16,44);struct.pack_into('<HH',header,26,1,len(files));struct.pack_into('<H',header,34,0)
    table=b''.join(files);result=header+struct.pack('<IHH',44+len(table),blocks,codec)+table+cab[start:end]
    struct.pack_into('<I',result,8,len(result));return bytes(result)
def extract(cab):
    library=ctypes.util.find_library('archive')
    if not library:raise RuntimeError('libarchiveが必要です')
    lib=ctypes.CDLL(library);lib.archive_read_new.restype=ctypes.c_void_p
    for name in ['archive_read_support_filter_all','archive_read_support_format_all','archive_read_free','archive_read_data_skip']:getattr(lib,name).argtypes=[ctypes.c_void_p]
    lib.archive_read_open_memory.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t]
    lib.archive_read_next_header.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p)]
    lib.archive_entry_pathname.argtypes=[ctypes.c_void_p];lib.archive_entry_pathname.restype=ctypes.c_char_p
    lib.archive_entry_size.argtypes=[ctypes.c_void_p];lib.archive_entry_size.restype=ctypes.c_int64
    lib.archive_read_data.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t];lib.archive_read_data.restype=ctypes.c_ssize_t
    a=lib.archive_read_new();lib.archive_read_support_filter_all(a);lib.archive_read_support_format_all(a);buffer=ctypes.create_string_buffer(cab)
    try:
        if lib.archive_read_open_memory(a,buffer,len(cab))!=0:raise ValueError('CABを開けません')
        entry=ctypes.c_void_p()
        while lib.archive_read_next_header(a,ctypes.byref(entry))==0:
            if lib.archive_entry_pathname(entry)!=b'node.exe':lib.archive_read_data_skip(a);continue
            expected=lib.archive_entry_size(entry);chunks=[]
            while True:
                part=ctypes.create_string_buffer(1024*1024);count=lib.archive_read_data(a,part,len(part))
                if count<0:raise ValueError('CABの展開に失敗しました')
                if not count:break
                chunks.append(part.raw[:count])
            result=b''.join(chunks)
            if len(result)!=expected or hashlib.sha256(result).hexdigest()!=NODE_SHA:raise ValueError('Node本体が一致しません')
            return result
    finally:lib.archive_read_free(a)
    raise ValueError('Node本体を展開できませんでした')
def main():
    parser=argparse.ArgumentParser();parser.add_argument('input',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
    if args.input.suffix.lower()=='.zip':
        with zipfile.ZipFile(args.input) as archive:
            matches=[n for n in archive.namelist() if n.endswith('node-v24.20.0-x64.msi')]
            if len(matches)!=1:raise ValueError('対応するMSIを1つ指定してください')
            data=archive.read(matches[0])
    else:data=args.input.read_bytes()
    result=extract(node_cabinet(cabinet_from_msi(data)));args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('wb',buffering=0) as target:
        view=memoryview(result)
        while view:
            count=target.write(view[:1024*1024])
            if not count:raise OSError('ファイルを書き込めません')
            view=view[count:]
    assert args.output.stat().st_size==len(result)
    print(f'{args.output}: {len(result)} bytes, SHA256 {NODE_SHA}')
if __name__=='__main__':main()
