'use strict';

function ReadJSON(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text;
  try {
    if (typeof TextDecoder === 'function') text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    else {
      text = '';
      if (encoding !== 'utf-8') {
        if (bytes.length % 2) throw new Error('UTF-16');
        for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(encoding === 'utf-16le' ? bytes[i] | bytes[i + 1] << 8 : bytes[i] << 8 | bytes[i + 1]);
        // fatalなTextDecoderと同じく、不正なサロゲートを拒否する。
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('UTF-16'); }
          else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('UTF-16');
        }
      } else for (let i = 0; i < bytes.length;) {
        const b = bytes[i++]; let cp, count, min;
        if (b < 0x80) { text += String.fromCharCode(b); continue; }
        if (b >= 0xc2 && b <= 0xdf) { cp = b & 31; count = 1; min = 0x80; }
        else if (b >= 0xe0 && b <= 0xef) { cp = b & 15; count = 2; min = 0x800; }
        else if (b >= 0xf0 && b <= 0xf4) { cp = b & 7; count = 3; min = 0x10000; }
        else throw new Error('UTF-8');
        for (let n = 0; n < count; n++) { const next = bytes[i++]; if (next === undefined || (next & 0xc0) !== 0x80) throw new Error('UTF-8'); cp = cp << 6 | next & 63; }
        if (cp < min || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) throw new Error('UTF-8');
        text += String.fromCodePoint(cp);
      }
    }
  }
  catch { throw new Error('文字コードを読み取れません。元のJSONをUTF-8で保存し直してください。'); }
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function ExportJSON(value) {
  // ASCIIのUnicode表記なら、移動先の文字コードに左右されず曲名を復元できる。
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/\n/g, '\r\n') + '\r\n';
}

module.exports = { ReadJSON, ExportJSON };
