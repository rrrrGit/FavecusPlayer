#pragma once
#include <stdint.h>

typedef struct { int left, top, right, bottom; } TASKRECT;
typedef struct {
    uint32_t magic, size, opcode, flags, volume, width, offset, reserved;
    uint16_t title[180], artist[100], padding[216];
} TASKPACKET;
_Static_assert(sizeof(TASKPACKET) == 1024, "Taskbar wire record must be 1024 bytes");

static int ClampInt(int value, int low, int high) { return value < low ? low : value > high ? high : value; }
static int ScaleInt(int value, int dpi) { return (value * dpi + 48) / 96; }
static int ValidPacket(const TASKPACKET *p) {
    return p->magic == 0x31425046 && p->size == sizeof(TASKPACKET) && (p->opcode == 1 || p->opcode == 2)
        && !(p->flags & ~15u) && p->volume <= 100 && p->width >= 260 && p->width <= 520 && p->offset <= 1200
        && p->title[179] == 0 && p->artist[99] == 0;
}
static int TaskbarBounds(int width, int height, int notifyLeft, int dpi, int desired, int offset, TASKRECT *out) {
    if (dpi < 48 || dpi > 768 || width <= height || notifyLeft <= 0 || notifyLeft > width || height < ScaleInt(24, dpi)) return 0;
    int margin = ScaleInt(4, dpi), right = notifyLeft - margin - ScaleInt(ClampInt(offset, 0, 1200), dpi);
    int w = ScaleInt(ClampInt(desired, 260, 520), dpi), h = height - 2 * margin;
    if (h > ScaleInt(44, dpi)) h = ScaleInt(44, dpi);
    if (right - w < ScaleInt(48, dpi)) return 0;
    out->left = right - w; out->right = right; out->top = (height - h) / 2; out->bottom = out->top + h;
    return 1;
}
