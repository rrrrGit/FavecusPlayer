'use strict';
// 自動リストの設定（v0.7.4）：件数と条件。この端末内だけに保存し、同期しない。PC版・iPhone版で同じ選択肢（共通JS）。
// 既定は、これまでの動き（よく聴く50・最近追加50・未再生200・お気に入り200・最近聴いた100、条件なし）。

const LIMIT_CHOICES = Object.freeze([10, 20, 50, 100, 200, 500]);
const DEFAULT = Object.freeze({ limits: Object.freeze({ frequent: 50, recent: 50, unplayed: 200, favorites: 200, history: 100 }), frequentMin: 1, recentDays: 0 });
const FREQUENT_MIN_CHOICES = Object.freeze([1, 2, 3, 5, 10]);
const RECENT_DAYS_CHOICES = Object.freeze([0, 7, 30, 90, 365]); // 0＝期間を限らない

const nearest = (choices, value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? choices.reduce((best, c) => (Math.abs(c - number) < Math.abs(best - number) ? c : best), choices[0]) : fallback;
};
// 知らない値・足りない項目は、既定にする。選択肢のうち、いちばん近い値に丸める。
function Normalize(input) {
  const raw = input && typeof input === 'object' ? input : {}, limits = {};
  for (const kind of Object.keys(DEFAULT.limits)) limits[kind] = nearest(LIMIT_CHOICES, raw.limits?.[kind], DEFAULT.limits[kind]);
  return { limits, frequentMin: nearest(FREQUENT_MIN_CHOICES, raw.frequentMin, DEFAULT.frequentMin), recentDays: nearest(RECENT_DAYS_CHOICES, raw.recentDays, DEFAULT.recentDays) };
}
const IsDefault = settings => JSON.stringify(Normalize(settings)) === JSON.stringify(Normalize({}));

module.exports = { LIMIT_CHOICES, FREQUENT_MIN_CHOICES, RECENT_DAYS_CHOICES, DEFAULT, Normalize, IsDefault };
