'use strict';
// 並び順キー（分数インデックス）。2つのキーの間に、常に新しいキーを作れる。比較は普通の文字列比較（localeCompare・Intlは使わない）。
// キーは 0-9A-Za-z の文字列で、末尾は '0' にならない。小数部だけを表す（整数部なし）。
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', BASE = DIGITS.length;
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
const IsKey = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && KEY.test(value);
function Midpoint(a, b) {
  if (b !== null) {
    let n = 0; while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + Midpoint(a.slice(n), b.slice(n));
  }
  const low = a ? DIGITS.indexOf(a[0]) : 0, high = b !== null ? DIGITS.indexOf(b[0]) : BASE;
  if (high - low > 1) return DIGITS[Math.round(.5 * (low + high))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[low] + Midpoint(a.slice(1), null);
}
// a < 結果 < b（a・bは空・nullで端を表す）。a >= b のとき（同時の挿入で同じキーが並ぶ場合）は、aの後ろへ作る。例外を出さない。
function Between(a, b) {
  const low = a || '', high = b || null;
  if (low && !IsKey(low)) throw new Error('並び順キーが正しくありません。');
  if (high !== null && !IsKey(high)) throw new Error('並び順キーが正しくありません。');
  if (high !== null && low >= high) return Midpoint(low, null);
  return Midpoint(low, high);
}
// n個の増加するキー（左右に分けて中央から作るため、長さが増えすぎない）。
function Spread(count, low = '', high = null) {
  if (count <= 0) return [];
  const middle = Math.floor(count / 2), key = Between(low, high);
  return [...Spread(middle, low, key), key, ...Spread(count - middle - 1, key, high)];
}
module.exports = { IsKey, Between, Spread };
