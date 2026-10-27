#pragma once
static int VolumeFromX(int x) {
    int left=D(52),width=D(126);
    return ClampInt(((x-left)*100+width/2)/width,0,100);
}
static int KeyboardVolume(int key,int value) {
    if(key==37||key==40)return ClampInt(value-1,0,100);
    if(key==38||key==39)return ClampInt(value+1,0,100);
    if(key==33)return ClampInt(value+10,0,100);
    if(key==34)return ClampInt(value-10,0,100);
    if(key==36)return 0;if(key==35)return 100;return -1;
}
static void DrawVolumePanel(H dc) {
    int width=D(235),height=D(55),left=D(52),length=D(126),cy=height/2;
    Fill(dc,0,0,width,height,COLOR(36,39,55));
    FilledShape(dc,0,0,width,height,D(9),COLOR(36,39,55),COLOR(87,82,105),0);
    SetBkMode(dc,1);SetTextColor(dc,COLOR(237,240,248));H oldFont=SelectObject(dc,titleFont);
    TASKRECT label={D(12),0,D(43),height},value={D(187),0,D(226),height};
    DrawTextW(dc,L"音量",-1,&label,0x24);
    char digits[512]="";Number(digits,state.volume);W text[5]={0};int at=0;
    while(digits[at]&&at<3){text[at]=digits[at];at++;}text[at]='%';
    DrawTextW(dc,text,-1,&value,0x26);SelectObject(dc,oldFont);
    FilledShape(dc,left,cy-D(2),length,D(4),D(2),COLOR(80,84,107),COLOR(80,84,107),0);
    int position=(length*(int)state.volume+50)/100;
    if(position)FilledShape(dc,left,cy-D(2),position,D(4),D(2),COLOR(177,162,255),COLOR(177,162,255),0);
    FilledShape(dc,left+position-D(6),cy-D(6),D(12),D(12),0,COLOR(215,206,249),COLOR(215,206,249),1);
}
