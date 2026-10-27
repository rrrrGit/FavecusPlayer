#pragma once
#include "winapi.h"
#include "taskbar-model.h"
typedef struct { H dc; int erase; TASKRECT rect; int restore, update; unsigned char reserved[32]; } PAINTINFO;
typedef struct { U32 size; TASKRECT monitor, work; U32 flags; } MONITORINFO;
_Static_assert(sizeof(PAINTINFO)==72, "Windows PAINTSTRUCT layout");
_Static_assert(sizeof(MONITORINFO)==40, "Windows MONITORINFO layout");
typedef struct { int width, height; } TASKSIZE;
typedef struct { unsigned char operation, flags, alpha, format; } TASKBLEND;
typedef struct {
    U32 size; int width, height; unsigned short planes, depth;
    U32 compression, imageSize; int xppm, yppm; U32 used, important, colors;
} TASKBITMAP;
_Static_assert(sizeof(TASKBITMAP)==44, "Windows BITMAPINFO layout");
API(H,GetStdHandle,(U32));
API(int,PeekNamedPipe,(H,H,U32,U32*,U32*,U32*));
API(void,Sleep,(U32));
API(H,OpenProcess,(U32,int,U32));
API(void,SetLastError,(U32));
API(H,FindWindowW,(const W*,const W*));
API(H,FindWindowExW,(H,H,const W*,const W*));
API(int,IsWindow,(H));
API(int,IsWindowVisible,(H));
API(H,SetParent,(H,H));
API(H,GetParent,(H));
API(I64,GetWindowLongPtrW,(H,int));
API(I64,SetWindowLongPtrW,(H,int,I64));
API(int,GetWindowRect,(H,TASKRECT*));
API(int,GetClientRect,(H,TASKRECT*));
API(int,ScreenToClient,(H,POINT*));
API(int,SetWindowPos,(H,H,int,int,int,int,U32));
API(H,GetWindowDpiAwarenessContext,(H));
API(H,SetThreadDpiAwarenessContext,(H));
API(U32,GetDpiForWindow,(H));
API(H,BeginPaint,(H,PAINTINFO*));
API(int,EndPaint,(H,const PAINTINFO*));
API(int,FillRect,(H,const TASKRECT*,H));
API(int,DrawTextW,(H,const W*,int,TASKRECT*,U32));
API(int,InvalidateRect,(H,const TASKRECT*,int));
API(int,GetCursorPos,(POINT*));
API(H,MonitorFromWindow,(H,U32));
API(int,GetMonitorInfoW,(H,MONITORINFO*));
API(I64,SendMessageW,(H,U32,U64,I64));
API(H,CreatePopupMenu,(void));
API(int,AppendMenuW,(H,U32,U64,const W*));
API(int,TrackPopupMenu,(H,U32,int,int,int,H,const TASKRECT*));
API(int,DestroyMenu,(H));
API(int,SetForegroundWindow,(H));
API(H,SetCapture,(H));
API(int,ReleaseCapture,(void));
API(H,WindowFromPoint,(POINT));
API(int,IsChild,(H,H));
API(int,GetClassNameW,(H,W*,int));
API(int,UpdateLayeredWindow,(H,H,const POINT*,const TASKSIZE*,H,const POINT*,U32,const TASKBLEND*,U32));
API(H,CreateCompatibleDC,(H));
API(H,CreateDIBSection,(H,const TASKBITMAP*,U32,void**,H,U32));
API(int,DeleteDC,(H));
API(int,RoundRect,(H,int,int,int,int,int,int));
API(int,Ellipse,(H,int,int,int,int));
API(int,GdiFlush,(void));
API(H,CreateSolidBrush,(U32));
API(H,CreateFontW,(int,int,int,int,int,U32,U32,U32,U32,U32,U32,U32,U32,const W*));
API(H,SelectObject,(H,H));
API(int,DeleteObject,(H));
API(U32,SetTextColor,(H,U32));
API(int,SetBkMode,(H,int));
API(int,Polygon,(H,const POINT*,int));
API(H,CreatePen,(int,int,U32));
API(int,MoveToEx,(H,int,int,POINT*));
API(int,LineTo,(H,int,int));
API(void,InitCommonControls,(void));

#define REQUIRED(lib,name) do { BIND(lib,name); if (!name) return 0; } while (0)
static int InitTaskbarAPI(void) {
    H k=LoadLibraryW(L"kernel32.dll"), u=LoadLibraryW(L"user32.dll"), g=LoadLibraryW(L"gdi32.dll"), c=LoadLibraryW(L"comctl32.dll");
    if (!k || !u || !g || !c) return 0;
    REQUIRED(k,GetStdHandle); REQUIRED(k,PeekNamedPipe); REQUIRED(k,Sleep); REQUIRED(k,OpenProcess); REQUIRED(k,SetLastError);
    REQUIRED(u,FindWindowW); REQUIRED(u,FindWindowExW); REQUIRED(u,IsWindow); REQUIRED(u,IsWindowVisible); REQUIRED(u,SetParent); REQUIRED(u,GetParent);
    REQUIRED(u,GetWindowLongPtrW); REQUIRED(u,SetWindowLongPtrW); REQUIRED(u,GetWindowRect); REQUIRED(u,GetClientRect); REQUIRED(u,ScreenToClient); REQUIRED(u,SetWindowPos);
    REQUIRED(u,GetWindowDpiAwarenessContext); REQUIRED(u,SetThreadDpiAwarenessContext); REQUIRED(u,GetDpiForWindow);
    REQUIRED(u,BeginPaint); REQUIRED(u,EndPaint); REQUIRED(u,FillRect); REQUIRED(u,DrawTextW); REQUIRED(u,InvalidateRect); REQUIRED(u,GetCursorPos);
    REQUIRED(u,MonitorFromWindow); REQUIRED(u,GetMonitorInfoW); REQUIRED(u,SendMessageW); REQUIRED(u,CreatePopupMenu); REQUIRED(u,AppendMenuW); REQUIRED(u,TrackPopupMenu); REQUIRED(u,DestroyMenu); REQUIRED(u,SetForegroundWindow);
    REQUIRED(u,WindowFromPoint); REQUIRED(u,IsChild); REQUIRED(u,GetClassNameW); REQUIRED(u,UpdateLayeredWindow); REQUIRED(u,SetCapture); REQUIRED(u,ReleaseCapture);
    REQUIRED(g,CreateCompatibleDC); REQUIRED(g,CreateDIBSection); REQUIRED(g,DeleteDC); REQUIRED(g,RoundRect); REQUIRED(g,Ellipse);
    REQUIRED(g,GdiFlush);
    REQUIRED(g,CreateSolidBrush); REQUIRED(g,CreateFontW); REQUIRED(g,SelectObject); REQUIRED(g,DeleteObject); REQUIRED(g,SetTextColor); REQUIRED(g,SetBkMode); REQUIRED(g,Polygon); REQUIRED(g,CreatePen); REQUIRED(g,MoveToEx); REQUIRED(g,LineTo);
    REQUIRED(c,InitCommonControls); return 1;
}
