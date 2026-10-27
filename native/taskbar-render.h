#pragma once
static H frameDC, frameBitmap, frameOldBitmap;
static U32 *framePixels;
static int frameWidth, frameHeight;
static int ButtonCell(void) { return D(barWidth>=D(420)?34:26); }
static int ControlsLeft(void) { return barWidth-6*ButtonCell()-D(10); }
static void ReleaseFrame(void) {
    if(frameDC&&frameOldBitmap)SelectObject(frameDC,frameOldBitmap);
    if(frameBitmap)DeleteObject(frameBitmap);if(frameDC)DeleteDC(frameDC);
    frameDC=0;frameBitmap=0;frameOldBitmap=0;framePixels=0;frameWidth=0;frameHeight=0;
}
static int PrepareFrame(void) {
    if(frameDC&&frameWidth==barWidth&&frameHeight==barHeight)return 1;
    ReleaseFrame();frameDC=CreateCompatibleDC(0);if(!frameDC)return 0;
    TASKBITMAP info={.size=40,.width=barWidth,.height=-barHeight,.planes=1,.depth=32};
    frameBitmap=CreateDIBSection(frameDC,&info,0,(void**)&framePixels,0,0);
    if(!frameBitmap||!framePixels){ReleaseFrame();return 0;}
    frameOldBitmap=SelectObject(frameDC,frameBitmap);frameWidth=barWidth;frameHeight=barHeight;return 1;
}
static void FilledShape(H dc,int x,int y,int w,int h,int radius,U32 fill,U32 border,int circle) {
    H brush=CreateSolidBrush(fill),pen=CreatePen(0,1,border),oldBrush=SelectObject(dc,brush),oldPen=SelectObject(dc,pen);
    if(circle)Ellipse(dc,x,y,x+w,y+h);else RoundRect(dc,x,y,x+w,y+h,radius*2,radius*2);
    SelectObject(dc,oldBrush);SelectObject(dc,oldPen);DeleteObject(brush);DeleteObject(pen);
}
static void DrawBar(H dc) {
    Fill(dc,0,0,barWidth,barHeight,COLOR(25,28,39));
    FilledShape(dc,0,0,barWidth,barHeight,D(8),COLOR(25,28,39),COLOR(85,80,105),0);
    int iconSize=barHeight-D(8);if(iconSize>D(34))iconSize=D(34);
    if(DrawIconEx)DrawIconEx(dc,D(10),(barHeight-iconSize)/2,LoadIconW(GetModuleHandleW(0),(const W*)1),iconSize,iconSize,0,0,3);
    int controlLeft=ControlsLeft(),textLeft=D(10)+iconSize+D(9),half=barHeight/2,compact=barHeight<D(30);
    TASKRECT title={textLeft,compact?0:D(1),controlLeft-D(6),compact?barHeight:half+1},detail={textLeft,half,controlLeft-D(6),barHeight-D(1)};
    SetBkMode(dc,1);SetTextColor(dc,COLOR(237,240,248));H oldFont=SelectObject(dc,titleFont);
    DrawTextW(dc,state.title[0]?state.title:L"Favecus Player",-1,&title,0x8824);
    if(!compact){SelectObject(dc,detailFont);SetTextColor(dc,COLOR(149,156,181));DrawTextW(dc,state.artist,-1,&detail,0x8824);}SelectObject(dc,oldFont);
    for(int button=1;button<=6;button++) {
        int cell=ButtonCell(),left=controlLeft+(button-1)*cell,cx=left+cell/2,cy=barHeight/2,sz=D(5);
        int diameter=barHeight-D(8);if(diameter>D(32))diameter=D(32);if(sz>diameter/4)sz=diameter/4;
        U32 color=Enabled(button)?COLOR(190,195,216):COLOR(92,97,116);
        if(button==2){FilledShape(dc,cx-diameter/2,cy-diameter/2,diameter,diameter,0,hover==button?COLOR(228,222,255):COLOR(215,206,249),COLOR(215,206,249),1);color=Enabled(button)?COLOR(40,33,54):COLOR(133,126,151);}
        else if(button==hover)FilledShape(dc,left,D(2),cell-1,barHeight-D(4),D(6),COLOR(48,51,69),COLOR(48,51,69),0);
        if(button==1||button==3){int direction=button==1?-1:1;Triangle(dc,cx,cy,sz,direction,color);Fill(dc,cx+direction*(sz+D(2))-D(1),cy-sz,D(2),2*sz,color);}
        else if(button==2){if(state.flags&1)Triangle(dc,cx,cy,sz,1,color);else{Fill(dc,cx-D(4),cy-sz,D(3),2*sz,color);Fill(dc,cx+D(1),cy-sz,D(3),2*sz,color);}}
        else if(button==4)Fill(dc,cx-sz,cy-sz,2*sz,2*sz,color);
        else {
            H pen=CreatePen(0,D(1),color),old=SelectObject(dc,pen);
            if(button==5){
                Line(dc,cx-D(8),cy-D(3),cx-D(4),cy-D(3));Line(dc,cx-D(4),cy-D(3),cx,cy-D(7));Line(dc,cx,cy-D(7),cx,cy+D(7));Line(dc,cx,cy+D(7),cx-D(4),cy+D(3));Line(dc,cx-D(4),cy+D(3),cx-D(8),cy+D(3));Line(dc,cx-D(8),cy+D(3),cx-D(8),cy-D(3));
                if(state.volume){Line(dc,cx+D(4),cy-D(4),cx+D(6),cy-D(2));Line(dc,cx+D(6),cy-D(2),cx+D(6),cy+D(2));Line(dc,cx+D(6),cy+D(2),cx+D(4),cy+D(4));Line(dc,cx+D(7),cy-D(7),cx+D(10),cy-D(3));Line(dc,cx+D(10),cy-D(3),cx+D(10),cy+D(3));Line(dc,cx+D(10),cy+D(3),cx+D(7),cy+D(7));}
                else{Line(dc,cx+D(4),cy-D(4),cx+D(9),cy+D(4));Line(dc,cx+D(9),cy-D(4),cx+D(4),cy+D(4));}
            } else {Line(dc,cx-D(6),cy+D(6),cx+D(6),cy-D(6));Line(dc,cx-D(1),cy-D(6),cx+D(6),cy-D(6));Line(dc,cx+D(6),cy-D(6),cx+D(6),cy+D(1));Line(dc,cx-D(6),cy-D(1),cx-D(6),cy+D(6));Line(dc,cx-D(6),cy+D(6),cx+D(1),cy+D(6));}
            SelectObject(dc,old);DeleteObject(pen);
        }
    }
}
static void FrameAlpha(void) {
    int radius=D(8);if(radius>barHeight/2)radius=barHeight/2;
    for(int y=0;y<barHeight;y++)for(int x=0;x<barWidth;x++){
        int dx=x<radius?radius-1-x:x>=barWidth-radius?x-(barWidth-radius):0;
        int dy=y<radius?radius-1-y:y>=barHeight-radius?y-(barHeight-radius):0;
        U32 *pixel=framePixels+y*barWidth+x;
        // GDIで描いたRGBに不透明度を補い、四隅だけを透明にする。
        *pixel=dx*dx+dy*dy>radius*radius?0:(*pixel|0xff000000u);
    }
}
static int DrawSurface(void) {
    if(!PrepareFrame())return 0;
    DrawBar(frameDC);if(!GdiFlush())return 0;FrameAlpha();POINT source={0,0};TASKSIZE size={barWidth,barHeight};TASKBLEND blend={0,0,255,1};
    if(!UpdateLayeredWindow(bar,0,0,&size,frameDC,&source,0,&blend,2))return 0;
    frameDirty=0;surfaceCount++;return 1;
}
