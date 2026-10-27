param([Parameter(Mandatory=$true)][string]$Target, [Parameter(Mandatory=$true)][string]$Donor)
$ErrorActionPreference = 'Stop'
# アイコンとバージョン情報だけを移す。コード・マニフェスト・他のリソースは保持する。
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FavecusRuntimeBranding {
    [return: MarshalAs(UnmanagedType.Bool)]
    private delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
    [return: MarshalAs(UnmanagedType.Bool)]
    private delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, NameCallback callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr LockResource(IntPtr resource);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    private static extern IntPtr BeginUpdateResourceW(string file, [MarshalAs(UnmanagedType.Bool)] bool deleteExisting);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndUpdateResourceW(IntPtr update, [MarshalAs(UnmanagedType.Bool)] bool discard);
    private sealed class Item {
        internal int Type, Id;
        internal string Name;
        internal ushort Language;
        internal byte[] Data;
    }
    private static Win32Exception Failure() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    private static List<Item> Read(string file, bool bytes) {
        IntPtr module = LoadLibraryExW(file, IntPtr.Zero, 2); // LOAD_LIBRARY_AS_DATAFILE
        if (module == IntPtr.Zero) throw Failure();
        var result = new List<Item>();
        try {
            foreach (int type in new int[] { 3, 14, 16 }) {
                Exception failure = null;
                NameCallback names = delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
                    try {
                        long value = n.ToInt64();
                        int id = value >= 0 && value <= 65535 ? (int)value : -1;
                        string name = id < 0 ? Marshal.PtrToStringUni(n) : null;
                        LanguageCallback languages = delegate(IntPtr lm, IntPtr lt, IntPtr ln, ushort language, IntPtr lp) {
                            try {
                                var item = new Item { Type=type, Id=id, Name=name, Language=language };
                                if (bytes) {
                                    IntPtr resource = FindResourceExW(lm, lt, ln, language);
                                    if (resource == IntPtr.Zero) throw Failure();
                                    uint size = SizeofResource(lm, resource);
                                    if (size == 0 || size > 4 * 1024 * 1024) throw new InvalidOperationException("Invalid resource size.");
                                    IntPtr loaded = LoadResource(lm, resource);
                                    if (loaded == IntPtr.Zero) throw Failure();
                                    IntPtr data = LockResource(loaded);
                                    if (data == IntPtr.Zero) throw Failure();
                                    item.Data = new byte[size]; Marshal.Copy(data, item.Data, 0, (int)size);
                                }
                                result.Add(item); return true;
                            } catch (Exception error) { failure = error; return false; }
                        };
                        bool ok = EnumResourceLanguagesW(m, t, n, languages, IntPtr.Zero);
                        GC.KeepAlive(languages);
                        if (!ok) { if (failure != null) throw failure; throw Failure(); }
                        return true;
                    } catch (Exception error) { failure = error; return false; }
                };
                bool enumerated = EnumResourceNamesW(module, new IntPtr(type), names, IntPtr.Zero);
                int nativeError = Marshal.GetLastWin32Error(); GC.KeepAlive(names);
                if (failure != null) throw failure;
                if (!enumerated && nativeError != 1812 && nativeError != 1813) throw new Win32Exception(nativeError);
            }
        } finally { FreeLibrary(module); }
        return result;
    }
    private static void Write(IntPtr update, Item item, bool remove) {
        IntPtr name = item.Id >= 0 ? new IntPtr(item.Id) : Marshal.StringToHGlobalUni(item.Name);
        try {
            if (!UpdateResourceW(update, new IntPtr(item.Type), name, item.Language, remove ? null : item.Data, remove ? 0 : (uint)item.Data.Length)) throw Failure();
        } finally { if (item.Id < 0) Marshal.FreeHGlobal(name); }
    }
    public static void Copy(string donor, string target) {
        var incoming = Read(donor, true);
        foreach (int type in new int[] {3, 14, 16}) if (!incoming.Exists(item => item.Type == type)) throw new InvalidOperationException("Missing application resource.");
        var existing = Read(target, false); // モジュールを解放してから更新を開始する。
        IntPtr update = BeginUpdateResourceW(target, false);
        if (update == IntPtr.Zero) throw Failure();
        try {
            foreach (var item in existing) Write(update, item, true);
            foreach (var item in incoming) Write(update, item, false);
            bool saved = EndUpdateResourceW(update, false); update = IntPtr.Zero;
            if (!saved) throw Failure();
        } finally { if (update != IntPtr.Zero) EndUpdateResourceW(update, true); }
    }
}
'@
[FavecusRuntimeBranding]::Copy($Donor, $Target)
$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($Target)
if ($info.FileDescription -ne 'FavecusPlayer' -or $info.ProductName -ne 'FavecusPlayer') { throw 'アプリ名の確認に失敗しました。' }
