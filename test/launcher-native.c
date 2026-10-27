#define Entry UnusedLauncherEntry
#include "../native/main.c"
#undef Entry
#include <assert.h>
#include <stdio.h>
#include <string.h>
H (*LoadLibraryW)(const W*);
H (*GetProcAddress)(H,const char*);
void (*ExitProcess)(U32);
static int createOK=1,copyOK=1,copies=0,deletes=0;static U32 exitValue=0,errorValue=2;static char logged[300];static W lastCommand[CAP],chosen[CAP];
static int FakeCreate(const W*a,W*b,H c,H d,int e,U32 f,H g,const W*h,STARTUPINFO*i,PROCESSINFO*j){(void)a;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i;Copy(lastCommand,b);j->process=(H)1;j->thread=(H)2;return createOK;}
static int FakeClose(H h){(void)h;return 1;}
static U32 FakeWait(H h,U32 n){(void)h;(void)n;return 0;}
static int FakeExit(H h,U32*c){(void)h;*c=exitValue;return 1;}
static U32 FakeError(void){return errorValue;}
static U32 FakeSystem(W*p,U32 n){(void)n;Copy(p,L"C:\\Windows\\System32");return Len(p);}
static int FakeCopy(const W*a,const W*b,int c){(void)a;(void)b;(void)c;copies++;return copyOK;}
static int FakeDelete(const W*p){(void)p;deletes++;return 1;}
static int FakeMessage(H h,const W*m,const W*t,U32 n){(void)h;(void)m;(void)t;(void)n;return 1;}
static int FakeDirectory(const W*p,H h){(void)p;(void)h;return 1;}
static H FakeFile(const W*a,U32 b,U32 c,H d,U32 e,U32 f,H g){(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;return (H)3;}
static int FakeSize(H h,I64*s){(void)h;*s=0;return 1;}
static int FakeWrite(H h,const void*p,U32 n,U32*w,H o){(void)h;(void)o;assert(n<sizeof(logged));memcpy(logged,p,n);logged[n]=0;*w=n;return 1;}
static H FakeBrowse(BROWSEINFO*b){(void)b;return (H)4;}
static int FakePath(H h,W*p){(void)h;Copy(p,chosen);return 1;}
static void FakeFree(H h){(void)h;}
static int Contains(const W*s,const W*needle){for(int i=0;s[i];i++){int j=0;while(needle[j]&&s[i+j]==needle[j])j++;if(!needle[j])return 1;}return 0;}
int main(void) {
    assert(SafeName(L"app"));assert(SafeName(L"app-0.4.2-1789011606542"));
    assert(!SafeName(L"../app"));assert(!SafeName(L"app/../other"));assert(!SafeName(L"app\\other"));assert(!SafeName(L"app.."));assert(!SafeName(L"application"));assert(!SafeName(L""));
    CreateProcessW=FakeCreate;CloseHandle=FakeClose;WaitForSingleObject=FakeWait;GetExitCodeProcess=FakeExit;GetLastError=FakeError;GetSystemDirectoryW=FakeSystem;CopyFileW=FakeCopy;DeleteFileW=FakeDelete;MessageBoxW=FakeMessage;
    exitValue=0xc0000005;assert(Run(L"player",L"",L"D:\\FavecusPlayer",1)==(I64)0xc0000005);W code[CAP];ErrorCode(code,(I64)exitValue);assert(Equal(code,L"FP-EXIT-C0000005"));
    exitValue=0xffff7003;assert(Run(L"player",L"",L"D:\\FavecusPlayer",1)==(I64)0xffff7003);ErrorCode(code,(I64)exitValue);assert(Equal(code,L"FP-EXIT-FFFF7003"));assert(Len(ExitExplanation(exitValue))>0);assert(Len(ExitExplanation(0xc0000005))==0);
    exitValue=0x80000003;assert(Run(L"player",L"",L"D:\\FavecusPlayer",1)==(I64)0x80000003);ErrorCode(code,(I64)exitValue);assert(Equal(code,L"FP-EXIT-80000003"));assert(Len(ExitExplanation(exitValue))>0);
    createOK=0;assert(Run(L"player",L"",L"D:\\FavecusPlayer",1)==-1);ErrorCode(code,-1);assert(Equal(code,L"FP-LAUNCH-00000002"));createOK=1;
    Copy(root,L"D:\\FavecusPlayer\\runtime\\config");Copy(exePath,L"D:\\FavecusPlayer\\runtime\\config\\Maintenance.exe");ResolveMaintenanceRoot();assert(Equal(root,L"D:\\FavecusPlayer"));
    Copy(exePath,L"C:\\Downloads\\Patch.exe");copyOK=0;StoreMaintenance();assert(copies==1&&deletes==0);copyOK=1;StoreMaintenance();assert(copies==2&&deletes==1);
    SHBrowseForFolderW=FakeBrowse;SHGetPathFromIDListW=FakePath;CoTaskMemFree=FakeFree;Copy(chosen,L"D:\\FavecusPlayer");assert(ChooseFolder(0));assert(Equal(root,chosen));assert(ChooseFolder(1));assert(Equal(root,chosen));
    exitValue=0;assert(HasDesktopShortcut());assert(Contains(lastCommand,L"CommonDesktopDirectory"));assert(Contains(lastCommand,L"previousRoots"));exitValue=1;assert(!HasDesktopShortcut());
    CreateDirectoryW=FakeDirectory;CreateFileW=FakeFile;GetFileSizeEx=FakeSize;WriteFile=FakeWrite;Copy(runId,L"123-456");LogExit(0xc0000005,code);assert(strcmp(logged,"FP-EXIT-C0000005 run=123-456\r\n")==0);assert(Equal(code,L"D:\\FavecusPlayer\\runtime\\logs\\launcher.log"));
    puts("Native launcher destination, repair location, shortcut detection, unsigned exit status and diagnostic code/log checks passed (mock Win32).");return 0;
}
