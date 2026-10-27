'use strict';
const fs = require('node:fs');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function ValidateIcon(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 180000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('プレイリスト画像の形式が正しくありません。');
  const bytes = Buffer.from(value.slice(22), 'base64');
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(16) > 128 || bytes.readUInt32BE(20) > 128) throw new Error('プレイリスト画像のサイズが正しくありません。');
  return value;
}
function ReadIcon(file, nativeImage) {
  const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('10MB以下の画像を選択してください。');
  let image = nativeImage.createFromBuffer(fs.readFileSync(file));
  if (image.isEmpty()) throw new Error('この画像形式を読み込めません。PNG・JPEG・WebPを選択してください。');
  image = image.resize({ width: 64, height: 64, quality: 'good' });
  return ValidateIcon(`data:image/png;base64,${image.toPNG().toString('base64')}`);
}
module.exports = { ValidateIcon, ReadIcon };
