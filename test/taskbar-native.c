#define Entry UnusedHelperEntry
#include "../native/taskbar.c"
#undef Entry
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
H (*LoadLibraryW)(const W*);
H (*GetProcAddress)(H,const char*);
void (*ExitProcess)(U32);
static H fakeTarget=(H)1, fakeParent;
static int haveNotify=1, allowParent=1, allowStyle=1, geometry=1, positioned=0, destroyed=0, created=0, actualDpi=96, trayWidth=1920, trayHeight=48, notifyX=1730, originX=-1920;
static I64 style;
static char output[512];
static TASKRECT actualBounds;
static int coverMode, renderOK=1, rendered, flushed, framesCreated, framesDeleted, dcsDeleted;
static U64 ticks=1000;
static U32 *pixels;
static H captured;
static H Capture(H h){H old=captured;captured=h;return old;}
static int Release(void){captured=0;return 1;}
static int Foreground(H h){assert(h==(H)4);return 1;}
static void ClickBar(int x,int y){I64 point=(I64)(y<<16)|(unsigned short)x;BarProc(bar,0x201,1,point);BarProc(bar,0x202,0,point);}
static H FindTop(const W*a,const W*b){(void)a;(void)b;return fakeTarget;}
static H FindChild(H parent,H after,const W*a,const W*b){(void)after;(void)a;(void)b;assert(parent==fakeTarget);return haveNotify?(H)2:0;}
static int ClientRect(H h,TASKRECT*r){assert(h==fakeTarget);*r=(TASKRECT){0,0,trayWidth,trayHeight};return geometry;}
static int WindowRect(H h,TASKRECT*r){if(h==(H)2)*r=(TASKRECT){originX+notifyX,1000,originX+trayWidth,1000+trayHeight};else{assert(h==(H)3);*r=(TASKRECT){originX+actualBounds.left,1000+actualBounds.top,originX+actualBounds.right,1000+actualBounds.bottom};}return 1;}
static int ToClient(H h,POINT*p){assert(h==fakeTarget);p->x-=originX;p->y-=1000;return 1;}
static H DpiContext(H h){assert(h==fakeTarget);return (H)(I64)-4;}
static H ThreadDpi(H context){assert(context==(H)(I64)-4);return context;}
static U32 Dpi(H h){assert(h==fakeTarget);return actualDpi;}
static H Font(int a,int b,int c,int d,int e,U32 f,U32 g,U32 h,U32 i,U32 j,U32 k,U32 l,U32 m,const W*n){(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i;(void)j;(void)k;(void)l;(void)m;(void)n;return (H)8;}
static int Delete(H h){if(h==(H)12){free(pixels);pixels=0;framesDeleted++;}return 1;}
static H Module(const W*w){(void)w;return (H)7;}
static H Create(U32 ex,const W*klass,const W*title,U32 ws,int x,int y,int w,int h,H parent,H menu,H module,H data){(void)klass;(void)title;(void)x;(void)y;(void)w;(void)h;(void)menu;(void)module;(void)data;assert(ex&0x80);assert(!(ws&0x10000000));assert(parent==0);style=ws;created++;return (H)3;}
static void LastError(U32 value){(void)value;}
static U32 Error(void){return 5;}
static I64 GetStyle(H h,int index){assert(h==(H)3&&index==-16);return style;}
static I64 SetStyle(H h,int index,I64 value){assert(h==(H)3&&index==-16);I64 old=style;if(allowStyle)style=value;return old;}
static H Parent(H child,H parent){assert(child==(H)3&&parent==fakeTarget);assert((style&0x40000000)&&!(style&0x80000000));if(allowParent)fakeParent=parent;return 0;}
static H ParentOf(H h){assert(h==(H)3);return fakeParent;}
static int WindowValid(H h){return h==(H)3||h==fakeTarget;}
static int Position(H h,H z,int x,int y,int w,int height,U32 flags){assert(h==(H)3&&z==0&&fakeParent==fakeTarget);assert(flags&0x10);if(flags&2){x=actualBounds.left;y=actualBounds.top;}if(flags&1){w=actualBounds.right-actualBounds.left;height=actualBounds.bottom-actualBounds.top;}actualBounds=(TASKRECT){x,y,x+w,y+height};positioned++;if(flags&0x40){assert(rendered);style|=0x10000000;}return 1;}
static int Invalidate(H h,const TASKRECT*r,int erase){(void)h;(void)r;(void)erase;return 1;}
static int Update(H h){assert(h==(H)3);return 1;}
static int Write(H h,const void*bytes,U32 n,U32*written,H overlap){(void)h;(void)overlap;assert(n<sizeof(output));memcpy(output,bytes,n);output[n]=0;*written=n;return 1;}
static int Destroy(H h){assert(h==(H)3);destroyed++;return 1;}
static U64 Tick(void){return ticks;}
static int Visible(H h){assert(h==(H)3);return !!(style&0x10000000);}
static H AtPoint(POINT p){assert(p.x>originX+actualBounds.left&&p.x<originX+actualBounds.right);assert(p.y==1000+(actualBounds.top+actualBounds.bottom)/2);return coverMode==1?fakeTarget:coverMode==2?(H)999:(H)3;}
static int ChildOf(H parent,H child){return parent==fakeTarget&&(child==(H)2||child==(H)3);}
static int ClassName(H h,W*out,int capacity){(void)h;const W *name=L"Test_Window";int n=0;while(name[n]&&n<capacity-1){out[n]=name[n];n++;}out[n]=0;return n;}
static H MemoryDC(H h){assert(h==0);return (H)11;}
static H Bitmap(H dc,const TASKBITMAP*info,U32 usage,void**data,H section,U32 offset){assert(dc==(H)11&&usage==0&&section==0&&offset==0);assert(info->size==40&&info->depth==32&&info->planes==1&&info->compression==0);assert(info->width==barWidth&&info->height==-barHeight);assert(!pixels);pixels=calloc(barWidth*barHeight,sizeof(U32));assert(pixels);*data=pixels;framesCreated++;return (H)12;}
static int DeleteMemoryDC(H dc){assert(dc==(H)11);dcsDeleted++;return 1;}
static H Select(H dc,H object){assert(dc==(H)11&&object);return (H)13;}
static H Brush(U32 color){(void)color;flushed=0;return (H)14;}
static H Pen(int s,int width,U32 color){(void)s;(void)width;(void)color;return (H)15;}
static int FillMock(H dc,const TASKRECT*r,H brush){assert(dc==(H)11&&brush);for(int y=r->top;y<r->bottom;y++)for(int x=r->left;x<r->right;x++){assert(x>=0&&x<barWidth&&y>=0&&y<barHeight);pixels[y*barWidth+x]=0x00191c27;}return 1;}
static int Round(H dc,int x,int y,int right,int bottom,int rw,int rh){assert(dc==(H)11&&x>=0&&y>=0&&right<=barWidth&&bottom<=barHeight&&rw==rh);return 1;}
static int Circle(H dc,int x,int y,int right,int bottom){return Round(dc,x,y,right,bottom,0,0);}
static U32 TextColor(H dc,U32 color){assert(dc==(H)11);return color;}
static int Background(H dc,int mode){assert(dc==(H)11&&mode==1);return 1;}
static int DrawText(H dc,const W*t,int n,TASKRECT*r,U32 flags){assert(dc==(H)11&&t&&n==-1&&r->right>r->left&&flags);return 1;}
static int Poly(H dc,const POINT*p,int n){assert(dc==(H)11&&p&&n==3);return 1;}
static int Move(H dc,int x,int y,POINT*old){(void)x;(void)y;assert(dc==(H)11&&old==0);return 1;}
static int LineMock(H dc,int x,int y){(void)x;(void)y;assert(dc==(H)11);return 1;}
static int Flush(void){flushed=1;return 1;}
static int Layered(H window,H dest,const POINT*position,const TASKSIZE*size,H source,const POINT*from,U32 key,const TASKBLEND*blend,U32 flags){assert(window==(H)3&&dest==0&&position==0&&source==(H)11);assert(size->width==barWidth&&size->height==barHeight&&from->x==0&&from->y==0&&key==0&&flags==2);assert(blend->operation==0&&blend->flags==0&&blend->alpha==255&&blend->format==1&&flushed);assert(pixels[0]==0&&pixels[barWidth-1]==0);assert((pixels[(barHeight/2)*barWidth+barWidth/2]>>24)==255);rendered++;return renderOK;}
static unsigned char pipeBytes[2048];
static U32 pipeSize,pipeAt,pipeFragment=37;
static int Peek(H h,H buffer,U32 n,U32*r,U32*available,U32*left){(void)h;(void)buffer;(void)n;(void)r;(void)left;*available=pipeSize-pipeAt;return 1;}
static int Read(H h,void*buffer,U32 n,U32*r,H overlap){(void)h;(void)overlap;if(n>pipeFragment)n=pipeFragment;memcpy(buffer,pipeBytes+pipeAt,n);pipeAt+=n;*r=n;return 1;}
int main(void){
    FindWindowW=FindTop;FindWindowExW=FindChild;GetClientRect=ClientRect;GetWindowRect=WindowRect;ScreenToClient=ToClient;
    GetWindowDpiAwarenessContext=DpiContext;SetThreadDpiAwarenessContext=ThreadDpi;GetDpiForWindow=Dpi;CreateFontW=Font;DeleteObject=Delete;GetModuleHandleW=Module;CreateWindowExW=Create;
    SetLastError=LastError;GetLastError=Error;GetWindowLongPtrW=GetStyle;SetWindowLongPtrW=SetStyle;SetParent=Parent;GetParent=ParentOf;IsWindow=WindowValid;SetWindowPos=Position;InvalidateRect=Invalidate;UpdateWindow=Update;WriteFile=Write;DestroyWindow=Destroy;GetTickCount64=Tick;
    IsWindowVisible=Visible;WindowFromPoint=AtPoint;IsChild=ChildOf;GetClassNameW=ClassName;CreateCompatibleDC=MemoryDC;CreateDIBSection=Bitmap;DeleteDC=DeleteMemoryDC;SelectObject=Select;CreateSolidBrush=Brush;CreatePen=Pen;FillRect=FillMock;RoundRect=Round;Ellipse=Circle;SetTextColor=TextColor;SetBkMode=Background;DrawTextW=DrawText;Polygon=Poly;MoveToEx=Move;LineTo=LineMock;GdiFlush=Flush;UpdateLayeredWindow=Layered;
    state.width=360;assert(AttachOrPosition());assert(created==1&&positioned==2&&rendered==1);assert(fakeParent==fakeTarget);assert(actualBounds.left>=0&&actualBounds.right<notifyX&&actualBounds.top>=0&&actualBounds.bottom<=trayHeight);assert(strstr(output,"attached")&&strstr(output,"\"rendered\":true")&&strstr(output,"\"hitCount\":3")&&strstr(output,"\"x\":-"));
    int oldX=actualBounds.left;notifyX-=100;assert(AttachOrPosition());assert(created==1&&actualBounds.left==oldX-100);
    int right=actualBounds.right;state.width=500;assert(AttachOrPosition());assert(barWidth==500&&actualBounds.right==right&&frameWidth==500&&framesDeleted==1);assert(ButtonAt(ControlsLeft()+ButtonCell()/2,barHeight/2)==1&&ButtonAt(ControlsLeft()+5*ButtonCell()+ButtonCell()/2,barHeight/2)==6);
    state.width=360;actualDpi=144;trayHeight=72;assert(AttachOrPosition());assert(barWidth==540);
    Detach();assert(destroyed==1&&bar==0);allowParent=0;fakeParent=0;positioned=0;assert(!AttachOrPosition());assert(failed&&positioned==0&&strstr(output,"parent-error"));Detach();
    failed=0;haveNotify=0;assert(!AttachOrPosition());assert(strstr(output,"notify-not-found"));
    failed=0;haveNotify=1;allowParent=1;fakeTarget=0;assert(!AttachOrPosition());assert(!failed&&missingSince>0);fakeTarget=(H)9;assert(AttachOrPosition());assert(fakeParent==(H)9&&missingSince==0);
    int oldCreated=created;fakeTarget=(H)10;assert(AttachOrPosition());assert(created==oldCreated+1&&fakeParent==(H)10);Detach();
    failed=0;geometry=0;assert(!AttachOrPosition());assert(failed&&strstr(output,"geometry-error"));geometry=1;
    failed=0;allowStyle=0;positioned=0;assert(!AttachOrPosition());assert(failed&&positioned==0&&strstr(output,"parent-error"));Detach();allowStyle=1;
    failed=0;renderOK=0;assert(!AttachOrPosition());assert(failed&&!Visible(bar)&&strstr(output,"render-error"));Detach();renderOK=1;
    failed=0;coverMode=1;assert(AttachOrPosition());assert(!failed&&hitCount==0&&strstr(output,"waiting-visible"));ticks+=4000;AttachOrPosition();assert(failed&&strstr(output,"occluded"));Detach();
    failed=0;coverMode=2;assert(AttachOrPosition());ticks+=5000;AttachOrPosition();assert(!failed&&coveredSince==0&&strstr(output,"waiting-visible"));coverMode=0;assert(AttachOrPosition());assert(hitCount==3&&strstr(output,"attached"));
    fakeParent=0;AttachOrPosition();assert(failed&&strstr(output,"parent-error"));Detach();
    TASKPACKET p={.magic=0x31425046,.size=1024,.opcode=1,.width=360,.volume=50};assert(ValidPacket(&p));p.title[179]=1;assert(!ValidPacket(&p));p.title[179]=0;p.flags=16;assert(!ValidPacket(&p));
    TASKRECT bounds;assert(TaskbarBounds(1920,48,1700,96,360,0,&bounds));assert(!TaskbarBounds(48,1080,30,96,360,0,&bounds));assert(!TaskbarBounds(800,48,400,96,520,0,&bounds));assert(!TaskbarBounds(1920,48,1400,96,360,1200,&bounds));
    PeekNamedPipe=Peek;ReadFile=Read;failed=0;p.flags=15;p.title[0]=0x523b;p.title[1]=0x4e0b;p.title[2]=0x5bfa;p.title[3]=0xd83c;p.title[4]=0xdfb5;
    memcpy(pipeBytes,&p,1024);pipeSize=1024;ReadState();assert(!hasState&&incomingSize>0&&incomingSize<1024);
    while(pipeAt<pipeSize)ReadState();assert(!failed&&hasState&&incomingSize==0);assert(memcmp(&p,&state,1024)==0);
    // 実際のクリック処理から出力されるコマンドと無効状態を確認する。
    int x=ControlsLeft()+ButtonCell()/2,y=barHeight/2;
    ClickBar(x,y);assert(strstr(output,"previous"));
    state.flags=0;strcpy(output,"unchanged");ClickBar(x,y);assert(strcmp(output,"unchanged")==0);
    for(int px=0;px<ControlsLeft();px++){ClickBar(px,y);assert(strcmp(output,"unchanged")==0);}
    ClickBar(barWidth-1,y);assert(strcmp(output,"unchanged")==0);
    int restoreX=ControlsLeft()+5*ButtonCell()+ButtonCell()/2;
    BarProc(0,0x201,1,(I64)(y<<16)|D(20));BarProc(0,0x202,0,(I64)(y<<16)|restoreX);assert(strcmp(output,"unchanged")==0);
    ClickBar(restoreX,y);assert(strstr(output,"restore"));
    state.flags=15;const char *commands[]={"previous","toggle","next","stop","volume","restore"};
    for(int button=0;button<6;button++){ClickBar(ControlsLeft()+button*ButtonCell()+ButtonCell()/2,y);assert(strstr(output,commands[button]));}
    Volume(137);assert(state.volume==100&&strstr(output,"\"value\":100"));Volume(-10);assert(state.volume==0&&strstr(output,"\"value\":0"));
    SetCapture=Capture;ReleaseCapture=Release;SetForegroundWindow=Foreground;
    for(int scale=96;scale<=192;scale+=48){dpi=scale;assert(VolumeFromX(D(52))==0&&VolumeFromX(D(115))==50&&VolumeFromX(D(178))==100);assert(VolumeFromX(-100)==0&&VolumeFromX(D(300))==100);}
    dpi=96;PopupProc((H)4,0x201,1,(27<<16)|D(115));assert(volumeDragging&&captured==(H)4&&state.volume==50);
    PopupProc((H)4,0x200,1,(27<<16)|D(300));assert(state.volume==100);
    PopupProc((H)4,0x202,0,(27<<16)|(unsigned short)-30);assert(state.volume==0&&!volumeDragging&&!captured);
    PopupProc((H)4,0x100,39,0);assert(state.volume==1);PopupProc((H)4,0x100,35,0);assert(state.volume==100);PopupProc((H)4,0x100,36,0);assert(state.volume==0);
    PopupProc((H)4,0x201,1,(27<<16)|D(115));PopupProc((H)4,0x215,0,0);assert(!volumeDragging&&!captured);
    assert(PrepareFrame());DrawVolumePanel(frameDC);ReleaseFrame();
    p.opcode=2;memcpy(pipeBytes,&p,1024);pipeAt=0;pipeFragment=1024;ReadState();assert(closing&&!failed);
    closing=0;incomingSize=0;p.opcode=1;p.magic=0;memcpy(pipeBytes,&p,1024);pipeAt=0;ReadState();assert(failed&&strstr(output,"protocol-error"));
    assert(framesCreated==framesDeleted&&framesDeleted==dcsDeleted);
    puts("Native taskbar surface/alpha/visibility/occlusion/width/DPI/cleanup/reconnect/protocol checks passed (mock Win32; no Windows rendering test).");return 0;
}
