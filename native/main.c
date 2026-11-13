#include "winapi.h"
#include "config.h"
#define CAP 4096
#define INVALID ((H)(I64)-1)
static H window,statusLabel;
static W root[CAP],temp[CAP],exePath[CAP],logPath[CAP];
static int busy=0;
static U32 runError=0;
static W runId[64];
static int Len(const W *s){int n=0;while(s[n])n++;return n;}
static void Copy(W *to,const W *from){int n=0;while(from[n]&&n<CAP-1){to[n]=from[n];n++;}to[n]=0;}
static void Add(W *to,const W *s){int n=Len(to),i=0;while(s[i]&&n<CAP-1)to[n++]=s[i++];to[n]=0;}
static void Join(W *out,const W *a,const W *b){Copy(out,a);Add(out,L"\\");Add(out,b);}
static void Number(W *out,U64 n){W reverse[32];int count=0;do{reverse[count++]=(W)('0'+n%10);n/=10;}while(n);int i=0;while(count)out[i++]=reverse[--count];out[i]=0;}
static int Equal(const W *a,const W *b){int i=0;while(a[i]&&a[i]==b[i])i++;return a[i]==b[i];}
static int Exists(const W *path){return GetFileAttributesW(path)!=0xffffffff;}
static void Pump(void){MSG m;while(PeekMessageW(&m,0,0,0,1)){TranslateMessage(&m);DispatchMessageW(&m);}}
static void Status(const W *text){if(statusLabel){SetWindowTextW(statusLabel,text);UpdateWindow(window);}Pump();}
static void Error(const W *text){MessageBoxW(window,text,L"Favecus Player",0x10);}
static I64 WindowProc(H h,U32 m,U64 w,I64 l){if(m==0x10){if(busy)MessageBoxW(h,L"処理が終わるまでお待ちください。",L"Favecus Player",0x40);else DestroyWindow(h);return 0;}return DefWindowProcW(h,m,w,l);}
static void MakeWindow(void){WNDCLASS c={0};c.proc=WindowProc;c.instance=GetModuleHandleW(0);c.icon=LoadIconW(c.instance,(const W*)1);c.cursor=LoadCursorW(0,(const W*)32512);c.background=(H)6;c.name=L"FavecusPlayerSetup";RegisterClassW(&c);window=CreateWindowExW(0,c.name,L"Favecus Player セットアップ",0x00c80000,200,200,640,170,0,0,c.instance,0);statusLabel=CreateWindowExW(0,L"STATIC",L"準備しています…",0x50000000,25,28,570,90,window,0,c.instance,0);ShowWindow(window,5);UpdateWindow(window);}
static int ReadText(const W *file,W *out){char data[12000];U32 read=0;H f=CreateFileW(file,0x80000000,7,0,3,0,0);if(f==INVALID)return 0;int ok=ReadFile(f,data,sizeof(data)-1,&read,0);CloseHandle(f);if(!ok)return 0;data[read]=0;int n=MultiByteToWideChar(65001,0,data,(int)read,out,CAP-1);out[n]=0;return 1;}
static void PollLog(void){static U64 previous=0;U64 now=GetTickCount64();if(!logPath[0]||now-previous<300)return;previous=now;W text[CAP];if(ReadText(logPath,text)){W *line=text;for(int i=0;text[i];i++)if(text[i]=='\n'&&text[i+1])line=text+i+1;SetWindowTextW(statusLabel,line);}}
// CREATE_NO_WINDOW suppresses console windows. Do not set SW_HIDE: GUI children must show normally.
static I64 Run(const W *program,const W *args,const W *cwd,int wait){W cmd[CAP];Copy(cmd,L"\"");Add(cmd,program);Add(cmd,L"\" ");Add(cmd,args);STARTUPINFO si={0};PROCESSINFO pi={0};si.cb=sizeof(si);runError=0;if(!CreateProcessW(program,cmd,0,0,0,0x08000000,0,cwd,&si,&pi)){runError=GetLastError();return -1;}CloseHandle(pi.thread);if(!wait){CloseHandle(pi.process);return 0;}while(WaitForSingleObject(pi.process,50)==258){Pump();if(window)PollLog();}U32 code=1;GetExitCodeProcess(pi.process,&code);CloseHandle(pi.process);return (I64)code;}
static void PSQuote(W *out,const W *value){Add(out,L"'");for(int i=0;value[i];i++){W c[2]={value[i],0};Add(out,c);if(value[i]=='\'')Add(out,L"'");}Add(out,L"'");}
static int PowerShell(const W *script){W program[CAP],args[CAP];GetSystemDirectoryW(program,CAP);Add(program,L"\\WindowsPowerShell\\v1.0\\powershell.exe");Copy(args,L"-NoLogo -NoProfile -NonInteractive -Command \"$ErrorActionPreference='Stop'; ");Add(args,script);Add(args,L"\"");return Run(program,args,0,1);}
static int WritePayload(const W *file){H module=GetModuleHandleW(0),res=FindResourceW(module,(const W*)101,(const W*)10);if(!res)return 0;U32 size=SizeofResource(module,res);H data=LockResource(LoadResource(module,res));H f=CreateFileW(file,0x40000000,0,0,1,0,0);if(f==INVALID)return 0;U32 written=0;int ok=WriteFile(f,data,size,&written,0);CloseHandle(f);return ok&&written==size;}
static int ChooseFolder(int patch){W display[CAP];BROWSEINFO bi={0};bi.owner=window;bi.display=display;bi.title=patch?L"更新するFavecus Playerの最上位フォルダーを選択してください":L"FavecusPlayerフォルダー、またはその保存先を選択してください。";bi.flags=0x41;H item=SHBrowseForFolderW(&bi);if(!item)return 0;int ok=SHGetPathFromIDListW(item,root);CoTaskMemFree(item);return ok;}
static int SafeName(const W *name){if(Equal(name,L"app"))return 1;if(Len(name)<5||Len(name)>100)return 0;for(int i=0;name[i];i++)if(!((name[i]>='a'&&name[i]<='z')||(name[i]>='0'&&name[i]<='9')||name[i]=='-'||name[i]=='.'))return 0;for(int i=0;name[i+1];i++)if(name[i]=='.'&&name[i+1]=='.')return 0;return name[0]=='a'&&name[1]=='p'&&name[2]=='p'&&name[3]=='-';}
static int Repair(void){W program[CAP];Join(program,root,L"runtime\\config\\Maintenance.exe");if(!Exists(program))Join(program,root,L"Maintenance.exe");if(Exists(program)){int code=Run(program,L"--repair",root,0);if(code==0)return 0;}Error(L"必要なファイルがありません。配布されたSetup.exeまたはPatch.exeを再実行してください。");return 1;}
static void ResolveMaintenanceRoot(void){W parent[CAP],expected[CAP];Copy(parent,root);for(int n=0;n<2;n++)for(int i=Len(parent)-1;i>=0;i--)if(parent[i]=='\\'){parent[i]=0;break;}Join(expected,parent,L"runtime\\config\\Maintenance.exe");if(Equal(expected,exePath))Copy(root,parent);}
static void StoreMaintenance(void){W file[CAP],legacy[CAP];Join(file,root,L"runtime\\config\\Maintenance.exe");Join(legacy,root,L"Maintenance.exe");if(!Equal(file,exePath)&&!CopyFileW(exePath,file,0)){Error(L"修復用EXEを保存できませんでした。旧ファイルを保持しています。");return;}if(!Equal(legacy,exePath))DeleteFileW(legacy);}
static void ErrorCode(W *out,I64 code){Copy(out,code<0?L"FP-LAUNCH-":L"FP-EXIT-");U32 value=code<0?runError:(U32)code;W hex[9];for(int i=0;i<8;i++)hex[i]=L"0123456789ABCDEF"[(value>>(28-4*i))&15];hex[8]=0;Add(out,hex);}
static const W *ExitExplanation(I64 code){
  if(code==(I64)0x80000003)return L"\n詳細: 実行環境の内部チェックで停止しました。原因はネイティブ記録と同じ記録IDのログで確認できます。";
  if(code==(I64)0xffff7003)return L"\n詳細: クラッシュ記録機構に接続できていない状態で異常終了しました。終了コードだけでは元の原因を特定できません。";
  if(code==(I64)0xffff7001)return L"\n詳細: クラッシュ記録機構の応答がありませんでした。";
  if(code==(I64)0xffff7002)return L"\n詳細: 異常終了時の状態の取得に失敗しました。";
  return L"";
}
static void LogExit(I64 code,W *file){W directory[CAP],message[CAP];Join(directory,root,L"runtime\\logs");CreateDirectoryW(directory,0);Join(file,directory,L"launcher.log");ErrorCode(message,code);Add(message,L" run=");Add(message,runId);Add(message,L"\r\n");char bytes[256];U32 count=0;for(int i=0;message[i]&&count<255;i++)bytes[count++]=(char)message[i];H f=CreateFileW(file,0x84,7,0,4,0,0);if(f==INVALID)return;I64 size=0;GetFileSizeEx(f,&size);if(size>524288){CloseHandle(f);f=CreateFileW(file,0x40000000,7,0,2,0,0);}if(f!=INVALID){U32 written=0;WriteFile(f,bytes,count,&written,0);CloseHandle(f);}}
static int Launch(void){
  W file[CAP],active[CAP],program[CAP],app[CAP],args[CAP];
  H guard=CreateMutexW(0,0,L"Local\\FavecusPlayerSetupRunning");U32 guardError=GetLastError();if(guard)CloseHandle(guard);
  if(guardError==183){Error(L"セットアップ・更新が終わるまでお待ちください。");return 1;}
  const W *required[]={L"runtime\\node\\node.exe",L"runtime\\ffmpeg\\ffmpeg.exe",ELECTRON_FOLDER L"\\FavecusPlayer.exe",ELECTRON_FOLDER L"\\icudtl.dat",ELECTRON_FOLDER L"\\resources.pak",ELECTRON_FOLDER L"\\ffmpeg.dll"};
  for(int i=0;i<6;i++){Join(file,root,required[i]);if(!Exists(file))return Repair();}
  Join(file,root,L"runtime\\config\\active.txt");if(!ReadText(file,active)){Join(file,root,L"active.txt");if(!ReadText(file,active))return Repair();}
  for(int i=0;active[i];i++)if(active[i]=='\r'||active[i]=='\n'){active[i]=0;break;}
  if(!SafeName(active))return Repair();
  Join(program,root,ELECTRON_FOLDER L"\\FavecusPlayer.exe");Join(app,root,active);
  Join(file,app,L"package.json");if(!Exists(file))return Repair();
  Join(file,app,L"src\\main.cjs");if(!Exists(file))return Repair();
  Copy(args,L"\"");Add(args,app);Add(args,L"\"");SetEnvironmentVariableW(L"FAVECUS_INSTALL_ROOT",root);
  W stamp[32];Number(runId,GetCurrentProcessId());Add(runId,L"-");Number(stamp,GetTickCount64());Add(runId,stamp);SetEnvironmentVariableW(L"FAVECUS_RUN_ID",runId);
  H lock=CreateMutexW(0,0,L"Local\\FavecusPlayerRunning");I64 code=Run(program,args,root,1);if(lock)CloseHandle(lock);
  if(code!=0){W message[CAP],tag[CAP],file[CAP];ErrorCode(tag,code);LogExit(code,file);Copy(message,code<0?L"Favecus Playerのプロセスを起動できませんでした。":L"Favecus Playerが異常終了しました。");Add(message,L"\nエラーコード: ");Add(message,tag);Add(message,ExitExplanation(code));Add(message,L"\n記録ID: ");Add(message,runId);Add(message,L"\nログ: ");Add(message,file);Add(message,L"\n再生の詳細: runtime\\logs\\player-diagnostics.jsonl");Add(message,L"\nネイティブ記録: runtime\\logs\\electron.log / crashes");Error(message);}return (int)code;
}
static void Shortcut(void){W program[CAP],script[CAP];Join(program,root,L"FavecusPlayer.exe");Copy(script,L"$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'Favecus Player.lnk')); $s.TargetPath=");PSQuote(script,program);Add(script,L"; $s.WorkingDirectory=");PSQuote(script,root);Add(script,L"; $s.IconLocation=");PSQuote(script,program);Add(script,L"; $s.Save()");if(PowerShell(script)!=0)Error(L"ショートカットを作成できませんでした。アプリはインストール済みです。");}
static int HasDesktopShortcut(void){W script[CAP],program[CAP];Join(program,root,L"FavecusPlayer.exe");Copy(script,L"$w=New-Object -ComObject WScript.Shell; $targets=@(");PSQuote(script,program);Add(script,L"); $m=");Join(program,root,L"runtime\\config\\favecus-player-install.json");PSQuote(script,program);Add(script,L"; if(Test-Path -LiteralPath $m){$j=Get-Content -Raw -LiteralPath $m|ConvertFrom-Json; foreach($r in (@($j.previousRoot)+@($j.previousRoots))){if($r){$targets+=[IO.Path]::Combine($r,'FavecusPlayer.exe');$targets+=[IO.Path]::Combine($r,'FocusPlayer.exe')}}}; $found=$false; $failed=$false; foreach($d in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))){if($d){foreach($f in Get-ChildItem -LiteralPath $d -Filter '*.lnk' -ErrorAction SilentlyContinue){try{$s=$w.CreateShortcut($f.FullName);if($targets -contains $s.TargetPath){$found=$true;if($s.TargetPath -ne $targets[0]){$s.TargetPath=$targets[0];$s.WorkingDirectory=[IO.Path]::GetDirectoryName($targets[0]);$s.IconLocation=$targets[0];try{$s.Save()}catch{$failed=$true}}}}catch{}}}}; if($failed){exit 3}; if($found){exit 0}; exit 1");int result=PowerShell(script);if(result!=0&&result!=1)Error(L"既存ショートカットの確認・更新を完了できませんでした。FavecusPlayer.exeから起動できます。");return result!=1;}
void Entry(void){InitAPI();CoInitializeEx(0,2);GetModuleFileNameW(0,exePath,CAP);Copy(root,exePath);for(int i=Len(root)-1;i>=0;i--)if(root[i]=='\\'){root[i]=0;break;}
  ResolveMaintenanceRoot();
#if MODE == 0
  ExitProcess((U32)Launch());
#else
  MakeWindow();
  H lock=CreateMutexW(0,0,L"Local\\FavecusPlayerRunning");U32 lockError=GetLastError();if(lockError==183){Error(L"Favecus Playerを閉じてからセットアップ・更新を実行してください。×ボタンでは通知領域に残ります。通知領域のアイコンを右クリックして「終了」を選んでください。");if(lock)CloseHandle(lock);ExitProcess(1);}
  H legacyLock=CreateMutexW(0,0,L"Local\\FocusPlayerRunning");U32 legacyError=GetLastError();if(legacyError==183){Error(L"旧版のアプリを閉じてから更新してください。");ExitProcess(1);}
  H legacySetup=CreateMutexW(0,0,L"Local\\FocusPlayerSetupRunning");if(GetLastError()==183){Error(L"旧版のセットアップを終了してください。");ExitProcess(1);}
  H setupLock=CreateMutexW(0,0,L"Local\\FavecusPlayerSetupRunning");U32 setupError=GetLastError();if(setupError==183){Error(L"別のセットアップが実行中です。");ExitProcess(1);}
  int argc=0;W **argv=CommandLineToArgvW(GetCommandLineW(),&argc);W repairPath[CAP];Join(repairPath,root,L"Maintenance.exe");W configRepair[CAP];Join(configRepair,root,L"runtime\\config\\Maintenance.exe");int repair=Equal(exePath,repairPath)||Equal(exePath,configRepair)||(argc==2&&Equal(argv[1],L"--repair"));if(argv)LocalFree(argv);
  if(!repair&&!ChooseFolder(MODE==2))ExitProcess(0);
  busy=1;Status(L"必要なファイルを準備しています…");
  GetTempPathW(CAP,temp);W number[32];Number(number,GetCurrentProcessId());Add(temp,L"FavecusPlayer-Setup-");Add(temp,number);Add(temp,L"-");Number(number,GetTickCount64());Add(temp,number);if(!CreateDirectoryW(temp,0)){Error(L"一時フォルダーを作成できません。");ExitProcess(1);}
  W zip[CAP],payload[CAP],script[CAP],node[CAP],installer[CAP],args[CAP];Join(zip,temp,L"payload.zip");Join(payload,temp,L"payload");Join(logPath,temp,L"progress.log");
  if(!WritePayload(zip)){Error(L"セットアップファイルを展開できませんでした。");ExitProcess(1);}
  Copy(script,L"Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(");PSQuote(script,zip);Add(script,L",");PSQuote(script,payload);Add(script,L")");
  if(PowerShell(script)!=0){Error(L"ファイルの展開に失敗しました。WindowsのPowerShellが利用可能か確認してください。");ExitProcess(1);}
  DeleteFileW(zip);Join(node,payload,L"bootstrap\\node.exe");Join(installer,payload,L"scripts\\install.cjs");
  Copy(args,L"\"");Add(args,installer);Add(args,L"\" \"");Add(args,root);Add(args,L"\" \"");Add(args,payload);Add(args,L"\" \"");Add(args,logPath);Add(args,MODE==2?L"\" patch":L"\" setup");
  if(!repair)Add(args,L" selected");
  Status(L"必要なファイルを取得しています。インターネット接続が必要です。");int code=Run(node,args,payload,1);
  busy=0;if(code!=0){W message[CAP];Copy(message,L"セットアップを完了できませんでした。詳細ログ:\n");Add(message,logPath);Error(message);W notepad[CAP];GetSystemDirectoryW(notepad,CAP);Add(notepad,L"\\notepad.exe");Copy(args,L"\"");Add(args,logPath);Add(args,L"\"");Run(notepad,args,0,0);ExitProcess(1);}
  W installedRoot[CAP],rootFile[CAP];Copy(rootFile,logPath);Add(rootFile,L".root");if(ReadText(rootFile,installedRoot))Copy(root,installedRoot);
  StoreMaintenance();
  W notice[CAP];Copy(rootFile,logPath);Add(rootFile,L".notice");if(ReadText(rootFile,notice))MessageBoxW(window,notice,L"Favecus Player",0x40);
  Status(L"セットアップが完了しました。");
  if(!HasDesktopShortcut()&&MessageBoxW(window,L"デスクトップにショートカットを作成しますか？",L"Favecus Player",0x24)==6)Shortcut();
  int start=MessageBoxW(window,L"Favecus Playerを起動しますか？",L"Favecus Player",0x24)==6;
  // 実行中のNodeは終了済みなので、展開した一時ファイルをまとめて削除できる。
  Copy(script,L"Remove-Item -LiteralPath ");PSQuote(script,temp);Add(script,L" -Recurse -Force");PowerShell(script);
  if(legacyLock)CloseHandle(legacyLock);if(legacySetup)CloseHandle(legacySetup);
  if(lock)CloseHandle(lock);if(setupLock)CloseHandle(setupLock);DestroyWindow(window);window=0;statusLabel=0;
  if(start){W program[CAP];Join(program,root,L"FavecusPlayer.exe");Run(program,L"",root,0);}
  ExitProcess(0);
#endif
}
