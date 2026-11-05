'use strict';
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
function ValidateIcon(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 180000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('プレイリスト画像の形式が正しくありません。');
  let bytes;
  try { bytes = Uint8Array.from(atob(value.slice(22)), c => c.charCodeAt(0)); }
  catch { throw new Error('プレイリスト画像の形式が正しくありません。'); }
  if (bytes.length < 24 || !PNG.every((value, i) => bytes[i] === value) || new DataView(bytes.buffer).getUint32(16) > 128 || new DataView(bytes.buffer).getUint32(20) > 128) throw new Error('プレイリスト画像のサイズが正しくありません。');
  return value;
}
module.exports = { ValidateIcon };
