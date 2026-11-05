'use strict';
const fs = require('node:fs');
const { ValidateIcon } = require('./playlist-icon-data.cjs');
function ReadIcon(file, nativeImage) {
  const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('10MB以下の画像を選択してください。');
  let image = nativeImage.createFromBuffer(fs.readFileSync(file));
  if (image.isEmpty()) throw new Error('この画像形式を読み込めません。PNG・JPEG・WebPを選択してください。');
  image = image.resize({ width: 64, height: 64, quality: 'good' });
  return ValidateIcon(`data:image/png;base64,${image.toPNG().toString('base64')}`);
}
module.exports = { ValidateIcon, ReadIcon };
