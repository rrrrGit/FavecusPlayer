'use strict';
(function (root) {
  const Defaults = Object.freeze({ forward: 'ArrowRight', backward: 'ArrowLeft', volumeUp: 'ArrowUp', volumeDown: 'ArrowDown', toggle: 'Space', next: 'Shift+ArrowRight', previous: 'Shift+ArrowLeft' });
  const Labels = { forward: '10秒進む', backward: '10秒戻る', volumeUp: '音量を2%上げる', volumeDown: '音量を2%下げる', toggle: '再生・一時停止', next: '次の曲', previous: '前の曲' };
  const Code = /^(Arrow(?:Left|Right|Up|Down)|Space|Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-2])|Home|End|PageUp|PageDown|Insert|Enter|Escape|Backspace|Delete|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/;
  function Stroke(event) {
    if (!event || event.isComposing || !Code.test(event.code || '')) return '';
    return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', event.code].filter(Boolean).join('+');
  }
  function Validate(input) {
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('キー設定の形式が正しくありません。');
    const result = { ...Defaults, ...input }, seen = new Set();
    for (const action of Object.keys(Defaults)) {
      const value = result[action];
      if (value === '') continue;
      if (typeof value !== 'string' || !/^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?[^+]+$/.test(value) || !Code.test(value.split('+').at(-1))) throw new Error('対応していないキーです。');
      if (seen.has(value)) throw new Error('同じキーを複数の操作には設定できません。'); seen.add(value);
    }
    return Object.fromEntries(Object.keys(Defaults).map(k => [k, result[k]]));
  }
  function Action(bindings, event) { const stroke = Stroke(event); if (!stroke) return null; const action = Object.keys(Defaults).find(k => (bindings || Defaults)[k] === stroke); return event.repeat && ['toggle', 'next', 'previous'].includes(action) ? null : action || null; }
  function Display(value) { return value ? value.replace(/ArrowRight/g, '→').replace(/ArrowLeft/g, '←').replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓').replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1').replace(/Space/g, 'Space').replace(/\+/g, ' + ') : '未設定'; }
  function Editing(target) { return !!target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="slider"]'); }
  const api = { Defaults, Labels, Stroke, Validate, Action, Display, Editing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FavecusKeys = api;
})(globalThis);
