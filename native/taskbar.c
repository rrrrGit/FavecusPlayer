#include "taskbar-api.h"
#define INVALID ((H)(I64)-1)
#define COLOR(r,g,b) ((U32)((r)|((g)<<8)|((b)<<16)))
API(int,DrawIconEx,(H,int,int,H,int,int,U32,H,U32));

static H bar, taskbar, popup, inputPipe, outputPipe, parentProcess, titleFont, detailFont;
static TASKPACKET state={.magic=0x31425046,.size=1024,.opcode=1,.flags=1,.volume=100,.width=500};
static int dpi=96, barWidth, barHeight, hover=0, previousVolume=100, closing=0, failed=0, hasState=0;
static U64 outsideSince=0, missingSince=0;
static int volumeDragging=0,pressedButton=0;
static TASKRECT lastBounds;
static int ButtonCell(void);
static int ControlsLeft(void);
static int frameDirty=1;
static int readyReported=0,hitCount=0,surfaceCount=0;
static H lastHit;
static U64 coveredSince=0;
static unsigned char incoming[1024];
static U32 incomingSize=0;
static int Length(const W *s) { int n=0; while(s[n])n++; return n; }
static int Equal(const W *a,const W *b) { int i=0; while(a[i]&&b[i]&&a[i]==b[i])i++; return a[i]==b[i]; }
static int TextLength(const char *s) { int n=0; while(s[n])n++; return n; }
static void Append(char *out,const char *s) { int at=TextLength(out); for(int i=0;s[i]&&at<500;i++)out[at++]=s[i];out[at]=0; }
static void Number(char *out,U64 value) { char number[24];int n=0;do{number[n++]=(char)('0'+value%10);value/=10;}while(value);while(n){char s[2]={number[--n],0};Append(out,s);} }
static void Emit(const char *line) { U32 written=0; if(!WriteFile(outputPipe,line,(U32)TextLength(line),&written,0))closing=1; }
static void Status(const char *code,U32 error) {
    char message[512]="{\"event\":\"status\",\"code\":\"";Append(message,code);Append(message,"\",\"win32\":");Number(message,error);
    Append(message,",\"width\":");Number(message,barWidth);Append(message,",\"height\":");Number(message,barHeight);Append(message,",\"dpi\":");Number(message,dpi);
    Append(message,",\"parent\":");Number(message,(U64)taskbar);
    Append(message,",\"rendered\":");Append(message,surfaceCount?"true":"false");
    Append(message,",\"visible\":");Append(message,bar&&IsWindowVisible(bar)?"true":"false");
    Append(message,",\"hitCount\":");Number(message,hitCount);Append(message,",\"hitWindow\":");Number(message,(U64)lastHit);
    TASKRECT actual={0};if(bar)GetWindowRect(bar,&actual);
    Append(message,",\"x\":");if(actual.left<0){Append(message,"-");Number(message,(U64)-(I64)actual.left);}else Number(message,actual.left);
    Append(message,",\"y\":");if(actual.top<0){Append(message,"-");Number(message,(U64)-(I64)actual.top);}else Number(message,actual.top);
    Append(message,",\"renderer\":\"layered\",\"hitClass\":\"");
    W klass[80]={0};if(lastHit)GetClassNameW(lastHit,klass,80);
    for(int i=0;klass[i];i++){char c=(klass[i]>='a'&&klass[i]<='z')||(klass[i]>='A'&&klass[i]<='Z')||(klass[i]>='0'&&klass[i]<='9')||klass[i]=='.'||klass[i]=='_'||klass[i]=='-'?(char)klass[i]:'_';char one[2]={c,0};Append(message,one);}
    Append(message,"\"}\n");Emit(message);
}
static void Command(const char *command) { char message[512]="{\"event\":\"command\",\"command\":\"";Append(message,command);Append(message,"\"}\n");Emit(message); }
static int D(int n) { return ScaleInt(n,dpi); }
static void HideVolume(void) { if(volumeDragging){volumeDragging=0;ReleaseCapture();}if(popup)ShowWindow(popup,0);outsideSince=0; }
static void Volume(int value) {
    state.volume=(U32)ClampInt(value,0,100);if(state.volume)previousVolume=(int)state.volume;
    if(popup)InvalidateRect(popup,0,0);
    char message[512]="{\"event\":\"volume\",\"value\":";Number(message,state.volume);Append(message,"}\n");Emit(message);
    frameDirty=1;
}
static int ButtonAt(int x,int y) {
    int left=ControlsLeft(),cell=ButtonCell();
    if(y<0||y>=barHeight||x<left||x>=left+6*cell)return 0;
    return (x-left)/cell+1;
}
static int Enabled(int button) {
    if(button==1||button==3)return (state.flags&8)!=0;
    if(button==2)return (state.flags&2)!=0;
    if(button==4)return (state.flags&4)!=0;
    return 1;
}
static void Fill(H dc,int x,int y,int w,int h,U32 color) {
    TASKRECT r={x,y,x+w,y+h};H brush=CreateSolidBrush(color);FillRect(dc,&r,brush);DeleteObject(brush);
}
static void Triangle(H dc,int x,int y,int size,int direction,U32 color) {
    POINT p[3]={{x+direction*size,y},{x-direction*size,y-size},{x-direction*size,y+size}};
    H brush=CreateSolidBrush(color),pen=CreatePen(0,1,color),oldBrush=SelectObject(dc,brush),oldPen=SelectObject(dc,pen);
    Polygon(dc,p,3);SelectObject(dc,oldBrush);SelectObject(dc,oldPen);DeleteObject(brush);DeleteObject(pen);
}
static void Line(H dc,int x1,int y1,int x2,int y2) { MoveToEx(dc,x1,y1,0);LineTo(dc,x2,y2); }
#include "taskbar-render.h"
#include "volume-panel.h"
static I64 PopupProc(H h,U32 message,U64 w,I64 l) {
    if(message==0xf){PAINTINFO paint;H dc=BeginPaint(h,&paint);DrawVolumePanel(dc);EndPaint(h,&paint);return 0;}
    if(message==0x14)return 1;
    if(message==0x201){int x=(short)(l&0xffff),y=(short)((l>>16)&0xffff);if(x>=D(44)&&x<=D(187)&&y>=D(10)&&y<=D(45)){SetForegroundWindow(h);volumeDragging=1;SetCapture(h);Volume(VolumeFromX(x));}return 0;}
    if(message==0x200){if(volumeDragging&&(w&1))Volume(VolumeFromX((short)(l&0xffff)));return 0;}
    if(message==0x202){if(volumeDragging){Volume(VolumeFromX((short)(l&0xffff)));volumeDragging=0;ReleaseCapture();}return 0;}
    if(message==0x215||message==0x1f){if(volumeDragging){volumeDragging=0;ReleaseCapture();}return 0;}
    if(message==0x100){int value=KeyboardVolume((int)w,(int)state.volume);if(value>=0){Volume(value);return 0;}}
    if(message==0x20a){int delta=(short)((w>>16)&0xffff);if(delta)Volume((int)state.volume+(delta>0?5:-5));return 0;}
    if(message==0x10||(message==0x100&&w==27)){HideVolume();return 0;}
    if(message==0x6&&(w&0xffff)==0){HideVolume();return 0;}
    return DefWindowProcW(h,message,w,l);
}
static void OpenVolume(void) {
    if(popup&&IsWindowVisible(popup))return;
    if(!popup){
        popup=CreateWindowExW(0x88,L"FavecusPlayerTaskbarVolume",L"Favecus Player 音量",0x80000000,0,0,D(235),D(55),0,0,GetModuleHandleW(0),0);
        if(!popup)return;
    }
    TASKRECT r;if(!GetWindowRect(bar,&r))return;
    MONITORINFO monitor={.size=sizeof(MONITORINFO)};if(!GetMonitorInfoW(MonitorFromWindow(bar,2),&monitor))return;
    int w=D(235),h=D(55),x=ClampInt(r.right-w,monitor.monitor.left,monitor.monitor.right-w),y=r.top-h-D(4);
    if(y<monitor.monitor.top)y=r.bottom+D(4);
    y=ClampInt(y,monitor.monitor.top,monitor.monitor.bottom-h);
    SetWindowPos(popup,(H)(I64)-1,x,y,w,h,0x10);ShowWindow(popup,4);InvalidateRect(popup,0,0);outsideSince=0;
}
static void MenuAt(int x,int y) {
    H menu=CreatePopupMenu();if(!menu)return;
    AppendMenuW(menu,0,1,L"通常画面へ戻る");AppendMenuW(menu,0,2,L"埋め込みを解除して小型画面へ");AppendMenuW(menu,0x800,0,0);
    AppendMenuW(menu,Enabled(1)?0:1,3,L"前の曲");AppendMenuW(menu,Enabled(2)?0:1,4,(state.flags&1)?L"再生":L"一時停止");AppendMenuW(menu,Enabled(3)?0:1,5,L"次の曲");AppendMenuW(menu,Enabled(4)?0:1,6,L"停止");
    AppendMenuW(menu,0,7,L"音量を調整");SetForegroundWindow(bar);
    int selected=TrackPopupMenu(menu,0x182,x,y,0,bar,0);DestroyMenu(menu);
    if(selected==1)Command("restore");else if(selected==2)Command("floating");else if(selected==3)Command("previous");else if(selected==4)Command("toggle");else if(selected==5)Command("next");else if(selected==6)Command("stop");else if(selected==7)OpenVolume();
}
static I64 BarProc(H h,U32 message,U64 w,I64 l) {
    if(message==0xf){PAINTINFO paint;BeginPaint(h,&paint);EndPaint(h,&paint);frameDirty=1;return 0;}
    if(message==0x14)return 1;
    if(message==0x21)return 3;
    if(message==0x10){Command("restore");return 0;}
    if(message==0x2){if(h==bar)bar=0;return 0;}
    if(message==0x200){int button=ButtonAt((short)(l&0xffff),(short)((l>>16)&0xffff));if(button!=hover){hover=button;frameDirty=1;}if(button==5)OpenVolume();return 0;}
    if(message==0x201){pressedButton=ButtonAt((short)(l&0xffff),(short)((l>>16)&0xffff));return 0;}
    if(message==0x202){int b=ButtonAt((short)(l&0xffff),(short)((l>>16)&0xffff)),pressed=pressedButton;pressedButton=0;if(!b||b!=pressed||!Enabled(b))return 0;if(b==1)Command("previous");else if(b==2)Command("toggle");else if(b==3)Command("next");else if(b==4)Command("stop");else if(b==5)Volume(state.volume?0:previousVolume);else if(b==6)Command("restore");return 0;}
    if(message==0x205){POINT p;if(GetCursorPos(&p))MenuAt(p.x,p.y);return 0;}
    if(message==0x7b){POINT p;if(GetCursorPos(&p))MenuAt(p.x,p.y);return 0;}
    if(message==0x20a){int delta=(short)((w>>16)&0xffff);if(delta)Volume((int)state.volume+(delta>0?5:-5));return 0;}
    return DefWindowProcW(h,message,w,l);
}
static void Fonts(void) {
    if(titleFont)DeleteObject(titleFont);if(detailFont)DeleteObject(detailFont);
    titleFont=CreateFontW(-D(12),0,0,0,400,0,0,0,1,0,0,4,0,L"Yu Gothic UI");
    detailFont=CreateFontW(-D(10),0,0,0,400,0,0,0,1,0,0,4,0,L"Yu Gothic UI");
}
static void Detach(void) {
    HideVolume();if(popup)DestroyWindow(popup);popup=0;pressedButton=0;ReleaseFrame();readyReported=0;coveredSince=0;
    H old=bar;bar=0;if(old&&IsWindow(old))DestroyWindow(old);taskbar=0;surfaceCount=0;hitCount=0;lastHit=0;
}
static int CheckPresentation(void) {
    TASKRECT actual;hitCount=0;lastHit=0;
    if(!bar)return 0;
    if(GetParent(bar)!=taskbar){Status("parent-error",0);failed=1;return 0;}
    if(!IsWindowVisible(bar))return 0;
    if(!GetWindowRect(bar,&actual)){Status("geometry-error",GetLastError());failed=1;return 0;}
    if(actual.right-actual.left!=barWidth||actual.bottom-actual.top!=barHeight){Status("geometry-error",0);failed=1;return 0;}
    int positions[3]={actual.left+D(16),(actual.left+actual.right)/2,actual.right-D(16)},taskbarCover=0;
    for(int i=0;i<3;i++){
        POINT point={positions[i],(actual.top+actual.bottom)/2};H hit=WindowFromPoint(point);
        if(hit==bar||IsChild(bar,hit))hitCount++;
        else{lastHit=hit;if(hit==taskbar||IsChild(taskbar,hit))taskbarCover=1;}
    }
    if(hitCount==3){coveredSince=0;return 1;}
    if(taskbarCover){if(!coveredSince)coveredSince=GetTickCount64();else if(GetTickCount64()-coveredSince>3000){Status("occluded",0);failed=1;}}
    else coveredSince=0;
    return 0;
}
static int AttachOrPosition(void) {
    H target=FindWindowW(L"Shell_TrayWnd",0);
    if(!target){if(!missingSince){missingSince=GetTickCount64();readyReported=0;Status("waiting-taskbar",0);}return 0;}
    H context=GetWindowDpiAwarenessContext(target);if(!context||!SetThreadDpiAwarenessContext(context)){Status("dpi-error",GetLastError());failed=1;return 0;}
    TASKRECT client,notifyRect;if(!GetClientRect(target,&client)){Status("geometry-error",GetLastError());failed=1;return 0;}
    H notify=FindWindowExW(target,0,L"TrayNotifyWnd",0);
    if(!notify||!GetWindowRect(notify,&notifyRect)){Status("notify-not-found",GetLastError());failed=1;return 0;}
    POINT left={notifyRect.left,notifyRect.top};if(!ScreenToClient(target,&left)){Status("geometry-error",GetLastError());failed=1;return 0;}
    int newDpi=(int)GetDpiForWindow(target);TASKRECT bounds;
    if(!TaskbarBounds(client.right,client.bottom,left.x,newDpi,(int)state.width,(int)state.offset,&bounds)){Status("no-space",0);failed=1;return 0;}
    int newBar=!bar||!IsWindow(bar)||taskbar!=target;
    if(newBar){
        Detach();taskbar=target;dpi=newDpi;Fonts();
        bar=CreateWindowExW(0x08080080,L"FavecusPlayerTaskbar",L"Favecus Player タスクバー",0x80000000,0,0,1,1,0,0,GetModuleHandleW(0),0);
        if(!bar){Status("create-error",GetLastError());failed=1;return 0;}
        // 親子関係の変更は小型ヘルパーだけに限定し、ElectronのDPI設定に影響させない。
        SetLastError(0);SetWindowLongPtrW(bar,-16,(GetWindowLongPtrW(bar,-16)&~(I64)0x80000000)|(I64)0x40000000);
        I64 style=GetWindowLongPtrW(bar,-16);if(!(style&0x40000000)||(style&0x80000000)){Status("parent-error",GetLastError());failed=1;return 0;}
        SetLastError(0);SetParent(bar,taskbar);U32 parentError=GetLastError();
        if(GetParent(bar)!=taskbar){Status("parent-error",parentError);failed=1;return 0;}
    }
    if(GetParent(bar)!=taskbar){Status("parent-error",0);failed=1;return 0;}
    if(dpi!=newDpi){HideVolume();dpi=newDpi;Fonts();if(popup){DestroyWindow(popup);popup=0;}}
    int changed=newBar||bounds.left!=lastBounds.left||bounds.top!=lastBounds.top||bounds.right!=lastBounds.right||bounds.bottom!=lastBounds.bottom;
    if(changed){
        barWidth=bounds.right-bounds.left;barHeight=bounds.bottom-bounds.top;
        if(!SetWindowPos(bar,0,bounds.left,bounds.top,barWidth,barHeight,0x30)){Status("position-error",GetLastError());failed=1;return 0;}
        lastBounds=bounds;frameDirty=1;
    }
    if(frameDirty&&!DrawSurface()){Status("render-error",GetLastError());failed=1;return 0;}
    // 親の描画や子ウィンドウの作り直し後も、タスクバー内の重なり順を戻す。
    if(!SetWindowPos(bar,0,0,0,0,0,0x53)){Status("position-error",GetLastError());failed=1;return 0;}
    if(CheckPresentation()){if(changed||readyReported!=1)Status("attached",0);readyReported=1;}
    else if(!failed){if(readyReported!=-1)Status("waiting-visible",0);readyReported=-1;}
    missingSince=0;return 1;
}
static void ReadState(void) {
    for(int count=0;count<8;count++){
        U32 available=0,read=0;if(!PeekNamedPipe(inputPipe,0,0,0,&available,0)){closing=1;return;}if(!available)return;
        U32 size=1024-incomingSize;if(size>available)size=available;
        if(!ReadFile(inputPipe,incoming+incomingSize,size,&read,0)||!read){closing=1;return;}incomingSize+=read;
        if(incomingSize==1024){
            const TASKPACKET *packet=(const TASKPACKET*)incoming;
            if(!ValidPacket(packet)){Status("protocol-error",0);failed=1;return;}
            if(packet->opcode==2){closing=1;return;}
            int layoutChanged=packet->width!=state.width||packet->offset!=state.offset;
            unsigned char *destination=(unsigned char*)&state;for(U32 i=0;i<1024;i++)destination[i]=incoming[i];incomingSize=0;hasState=1;
            if(state.volume)previousVolume=(int)state.volume;
            if(popup)InvalidateRect(popup,0,0);
            frameDirty=1;
            if(layoutChanged)lastBounds.right=0;
        }
    }
}
static void PopupHover(void) {
    if(!bar||!popup||!IsWindowVisible(popup)||volumeDragging)return;
    POINT cursor;TASKRECT p,b;if(!GetCursorPos(&cursor)||!GetWindowRect(popup,&p)||!GetWindowRect(bar,&b))return;
    int inside=cursor.x>=p.left&&cursor.x<p.right&&cursor.y>=p.top&&cursor.y<p.bottom;
    int volumeLeft=b.left+ControlsLeft()+4*ButtonCell(),volumeRight=volumeLeft+ButtonCell();
    if(inside||(cursor.x>=volumeLeft-D(5)&&cursor.x<volumeRight+D(5)&&cursor.y>=b.top-D(10)&&cursor.y<b.bottom)){outsideSince=0;return;}
    if(!outsideSince)outsideSince=GetTickCount64();else if(GetTickCount64()-outsideSince>400)HideVolume();
}
void Entry(void) {
    InitAPI();CoInitializeEx(0,2);
    if(!InitTaskbarAPI())ExitProcess(31);
    H u=LoadLibraryW(L"user32.dll");BIND(u,DrawIconEx);
    inputPipe=GetStdHandle((U32)-10);outputPipe=GetStdHandle((U32)-11);
    if(!inputPipe||inputPipe==INVALID||!outputPipe||outputPipe==INVALID)ExitProcess(32);
    int argc=0;W **argv=CommandLineToArgvW(GetCommandLineW(),&argc);U32 pid=0;
    if(argc==3&&Equal(argv[1],L"--parent-pid")){for(int i=0;argv[2][i];i++){if(argv[2][i]<'0'||argv[2][i]>'9'||pid>429496729u||(pid==429496729u&&argv[2][i]>'5')){pid=0;break;}pid=pid*10+argv[2][i]-'0';}}
    if(argv)LocalFree(argv);if(!pid)ExitProcess(33);
    parentProcess=OpenProcess(0x100000,0,pid);if(!parentProcess){Status("parent-process-error",GetLastError());ExitProcess(34);}
    WNDCLASS c={0};c.proc=BarProc;c.instance=GetModuleHandleW(0);c.cursor=LoadCursorW(0,(const W*)32512);c.name=L"FavecusPlayerTaskbar";
    if(!RegisterClassW(&c))ExitProcess(35);c.proc=PopupProc;c.name=L"FavecusPlayerTaskbarVolume";c.background=(H)16;
    if(!RegisterClassW(&c))ExitProcess(36);InitCommonControls();
    U64 started=GetTickCount64(),lastCheck=0;
    while(!closing&&!failed&&WaitForSingleObject(parentProcess,0)==258){
        ReadState();MSG m;while(PeekMessageW(&m,0,0,0,1)){if(m.message==0x12){closing=1;break;}TranslateMessage(&m);DispatchMessageW(&m);}
        if(closing||failed)break;
        U64 now=GetTickCount64();
        if(hasState&&now-lastCheck>=500){lastCheck=now;AttachOrPosition();}
        if((!hasState&&now-started>5000)||(missingSince&&now-missingSince>15000)){Status("timeout",0);failed=1;}
        if(bar&&frameDirty&&!DrawSurface()){Status("render-error",GetLastError());failed=1;}
        PopupHover();Sleep(20);
    }
    Detach();if(titleFont)DeleteObject(titleFont);if(detailFont)DeleteObject(detailFont);CloseHandle(parentProcess);ExitProcess(failed?1:0);
}
