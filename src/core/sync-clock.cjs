'use strict';
// 同期用のHLC（ハイブリッド論理時計）。端末の壁時計を信頼せず、受信した時刻より後の時刻を必ず作る。
// 文字列は固定幅（壁時計12桁・カウンター4桁の16進数＋端末ID）で、通常の文字列比較がそのまま順序になる。
// 純粋な処理：現在時刻（ミリ秒）とdeviceIdは呼び出し側が渡す。Date・乱数・端末APIには依存しない。
const MAX_WALL = 0xFFFFFFFFFFFF, MAX_COUNTER = 0xFFFF;
const DEVICE = /^[A-Za-z0-9_.-]{1,64}$/;
const FORMAT = /^([0-9a-f]{12})-([0-9a-f]{4})-([A-Za-z0-9_.-]{1,64})$/;
const Hex = (value, width) => value.toString(16).padStart(width, '0');
function Format(wall, counter, deviceId) {
  if (!Number.isSafeInteger(wall) || wall < 0 || wall > MAX_WALL || !Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER || !DEVICE.test(deviceId)) throw new Error('時計の値が正しくありません。');
  return `${Hex(wall, 12)}-${Hex(counter, 4)}-${deviceId}`;
}
function Parse(hlc) {
  const match = FORMAT.exec(String(hlc));
  if (!match) throw new Error('時計の形式が正しくありません。');
  return { wall: parseInt(match[1], 16), counter: parseInt(match[2], 16), deviceId: match[3] };
}
const IsHlc = value => typeof value === 'string' && FORMAT.test(value);
// 既存データから変換した初期値の時刻。実際の編集は必ずこれより後になる。同じライブラリを別々の端末で変換しても同じ値になる。
const GENESIS = '000000000000-0000-0';
// ローカルの編集：直前の時刻より必ず後の時刻を返す。
function Tick(last, now, deviceId) {
  const previous = last ? Parse(last) : { wall: 0, counter: 0 };
  const wall = Math.max(previous.wall, Math.floor(now));
  if (wall === previous.wall) return previous.counter >= MAX_COUNTER ? Format(wall + 1, 0, deviceId) : Format(wall, previous.counter + 1, deviceId);
  return Format(wall, 0, deviceId);
}
// 受信：自分の時計を、受け取った時刻より進めておく（相手の時計が進んでいても、その後の自分の編集が勝てる）。
function Observe(last, remote, now, deviceId) {
  const own = last ? Parse(last) : { wall: 0, counter: 0 }, other = Parse(remote), current = Math.floor(now);
  const wall = Math.max(own.wall, other.wall, current);
  let counter = 0;
  if (wall === own.wall && wall === other.wall) counter = Math.max(own.counter, other.counter);
  else if (wall === own.wall) counter = own.counter;
  else if (wall === other.wall) counter = other.counter;
  else return last || Format(wall, 0, deviceId);
  return Format(wall, counter, deviceId);
}
const Wall = hlc => Parse(hlc).wall;
module.exports = { GENESIS, IsHlc, Format, Parse, Tick, Observe, Wall, DEVICE };
