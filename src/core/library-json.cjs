'use strict';

function ReadJSON(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('文字コードを読み取れません。元のJSONをUTF-8で保存し直してください。'); }
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function ExportJSON(value) {
  // ASCIIのUnicode表記なら、移動先の文字コードに左右されず曲名を復元できる。
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/\n/g, '\r\n') + '\r\n';
}

module.exports = { ReadJSON, ExportJSON };
