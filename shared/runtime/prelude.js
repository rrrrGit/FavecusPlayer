'use strict';
// JavaScriptCore（JSContext）にはWeb APIのURL・atob・structuredCloneがない。
// 共通処理が使う範囲だけをECMAScript標準機能で実装し、NodeでもiOSでも同じ実装を使う。
// 共通モジュールへはラッパー関数の引数として渡し、グローバルには依存しない。
//
// 対象：http/httpsの絶対URL（WHATWG URL Standardの特殊スキームの解析）。
// 既知の相違（Nodeが受理し、ここでは例外 'Invalid URL' にする）：http/https以外のスキーム、相対URL、IPv6ホスト、
// 非ASCIIのホスト名（IDNA変換。全角のwww．bilibili．comのようにNodeが許可ホストへ正規化する入力も含む）、
// IPv4として解釈される数値ホスト。Windows版が受理して登録する全角等のURLを、iOS版は拒否する（逆はない）。
// 拒否側に倒れるだけで、受理したURLの正規化結果（MediaKeyの根拠）はNodeと必ず一致する。
// 「NodeとここでURL解析の結果が異なる」状態は許容しない。差分は test/shared-runtime.test.cjs で検証する。
(function () {
  const DEFAULT_PORT = { 'http:': '80', 'https:': '443' };
  const FAIL = () => new TypeError('Invalid URL');
  const HEX = '0123456789ABCDEF';

  function CodePoints(text) {
    const result = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { result.push(0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00)); i++; continue; }
      }
      result.push(c >= 0xD800 && c <= 0xDFFF ? 0xFFFD : c);
    }
    return result;
  }
  function Utf8(cp) {
    if (cp < 0x80) return [cp];
    if (cp < 0x800) return [0xC0 | (cp >> 6), 0x80 | (cp & 63)];
    if (cp < 0x10000) return [0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
    return [0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  }
  const Pct = byte => '%' + HEX[byte >> 4] + HEX[byte & 15];
  // WHATWGのpercent-encode: shouldEncode(codePoint)がtrueの文字（と非ASCII）をUTF-8でパーセント符号化する。
  function Encode(text, shouldEncode) {
    if (/^[\x00-\x7F]*$/.test(text)) { let clean = true; for (let i = 0; i < text.length; i++) if (shouldEncode(text.charCodeAt(i))) { clean = false; break; } if (clean) return text; }
    let out = '';
    for (const cp of CodePoints(text)) {
      if (cp < 0x80 && !shouldEncode(cp)) out += String.fromCharCode(cp);
      else for (const byte of Utf8(cp)) out += Pct(byte);
    }
    return out;
  }
  const C0 = cp => cp <= 0x1F || cp > 0x7E;
  const FRAGMENT = cp => C0(cp) || cp === 0x20 || cp === 0x22 || cp === 0x3C || cp === 0x3E || cp === 0x60;
  const QUERY = cp => C0(cp) || cp === 0x20 || cp === 0x22 || cp === 0x23 || cp === 0x3C || cp === 0x3E;
  const SPECIAL_QUERY = cp => QUERY(cp) || cp === 0x27;
  const PATH = cp => QUERY(cp) || cp === 0x3F || cp === 0x5E || cp === 0x60 || cp === 0x7B || cp === 0x7D;
  const USERINFO = cp => PATH(cp) || cp === 0x2F || cp === 0x3A || cp === 0x3B || cp === 0x3D || cp === 0x40 || (cp >= 0x5B && cp <= 0x5D) || cp === 0x7C;
  const FORM = cp => !((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || cp === 0x2A || cp === 0x2D || cp === 0x2E || cp === 0x5F);

  function DecodeBytes(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; continue; }
      const c = text.charCodeAt(i), pair = c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xDC00 && text.charCodeAt(i + 1) <= 0xDFFF;
      for (const byte of Utf8(CodePoints(pair ? text.slice(i, i + 2) : text[i])[0])) bytes.push(byte);
      if (pair) i++;
    }
    return bytes;
  }
  // UTF-8の寛容な復号（不正なバイト列はU+FFFD）。
  function FromUtf8(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      let need = 0, cp = 0, min = 0;
      if (b < 0x80) { out += String.fromCharCode(b); i++; continue; }
      if (b >= 0xC2 && b <= 0xDF) { need = 1; cp = b & 0x1F; min = 0x80; }
      else if (b >= 0xE0 && b <= 0xEF) { need = 2; cp = b & 0x0F; min = 0x800; }
      else if (b >= 0xF0 && b <= 0xF4) { need = 3; cp = b & 0x07; min = 0x10000; }
      else { out += '�'; i++; continue; }
      let j = 1;
      for (; j <= need; j++) {
        const next = bytes[i + j];
        if (next === undefined || (next & 0xC0) !== 0x80) break;
        cp = (cp << 6) | (next & 63);
      }
      if (j <= need || cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { out += '�'; i += Math.max(1, j); continue; }
      out += String.fromCodePoint(cp); i += need + 1;
    }
    return out;
  }
  const PercentDecode = text => /^[\x00-\x7F]*$/.test(text) && text.indexOf('%') < 0 ? text : FromUtf8(DecodeBytes(text));

  function ParseQuery(query) {
    const list = [];
    for (const part of query.split('&')) {
      if (!part) continue;
      const at = part.indexOf('='), name = at < 0 ? part : part.slice(0, at), value = at < 0 ? '' : part.slice(at + 1);
      list.push([PercentDecode(name.replace(/\+/g, ' ')), PercentDecode(value.replace(/\+/g, ' '))]);
    }
    return list;
  }
  const SerializeQuery = list => list.map(([name, value]) => `${Encode(name, FORM).replace(/%20/g, '+')}=${Encode(value, FORM).replace(/%20/g, '+')}`).join('&');

  class URLSearchParams {
    constructor(list, owner) { this._list = list; this._owner = owner; }
    get(name) { const hit = this._list.find(pair => pair[0] === String(name)); return hit ? hit[1] : null; }
    has(name) { return this._list.some(pair => pair[0] === String(name)); }
    set(name, value) {
      name = String(name); value = String(value);
      let found = false; const next = [];
      for (const pair of this._list) {
        if (pair[0] !== name) next.push(pair);
        else if (!found) { found = true; next.push([name, value]); }
      }
      if (!found) next.push([name, value]);
      this._list = next; this._update();
    }
    toString() { return SerializeQuery(this._list); }
    _update() { if (this._owner) this._owner._query = this._list.length ? SerializeQuery(this._list) : null; }
  }

  function ResolvePath(raw) {
    const segments = raw.replace(/\\/g, '/').split('/'), out = [];
    segments.shift(); // 先頭の空要素（先頭の/）
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i], lower = segment.toLowerCase(), last = i === segments.length - 1;
      if (lower === '..' || lower === '.%2e' || lower === '%2e.' || lower === '%2e%2e') { if (out.length) out.pop(); if (last) out.push(''); }
      else if (lower === '.' || lower === '%2e') { if (last) out.push(''); }
      else out.push(Encode(segment, PATH));
    }
    return '/' + out.join('/');
  }
  function ParseHost(raw) {
    const decoded = PercentDecode(raw);
    if (!decoded || /[^\x00-\x7F]/.test(decoded)) throw FAIL();
    const host = decoded.toLowerCase();
    if (/[\x00-\x20#%/:<>?@[\\\]^|\x7F]/.test(host)) throw FAIL();
    const labels = host.split('.'); if (labels[labels.length - 1] === '' && labels.length > 1) labels.pop();
    if (/^([0-9]+|0[xX][0-9A-Fa-f]*)$/.test(labels[labels.length - 1])) throw FAIL(); // IPv4として解釈される形は未対応
    return host;
  }

  class URL {
    constructor(input) {
      let text = String(input).replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
      const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(text);
      if (!scheme) throw FAIL();
      const protocol = scheme[1].toLowerCase() + ':';
      if (!DEFAULT_PORT[protocol]) throw FAIL();
      text = text.slice(scheme[0].length).replace(/^[/\\]*/, '');
      const cut = text.search(/[/\\?#]/), authority = cut < 0 ? text : text.slice(0, cut);
      let rest = cut < 0 ? '' : text.slice(cut), hash = null;
      const hashAt = rest.indexOf('#');
      if (hashAt >= 0) { hash = rest.slice(hashAt + 1); rest = rest.slice(0, hashAt); }
      const queryAt = rest.indexOf('?');
      const query = queryAt >= 0 ? rest.slice(queryAt + 1) : null, path = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
      let username = '', password = '', hostPort = authority;
      const at = authority.lastIndexOf('@');
      if (at >= 0) {
        const info = authority.slice(0, at), colon = info.indexOf(':');
        username = Encode(colon < 0 ? info : info.slice(0, colon), USERINFO); password = colon < 0 ? '' : Encode(info.slice(colon + 1), USERINFO);
        hostPort = authority.slice(at + 1);
      }
      if (hostPort.startsWith('[')) throw FAIL();
      const colon = hostPort.lastIndexOf(':');
      let port = '';
      if (colon >= 0) {
        const digits = hostPort.slice(colon + 1);
        hostPort = hostPort.slice(0, colon);
        if (digits) {
          if (!/^[0-9]+$/.test(digits) || Number(digits) > 65535) throw FAIL();
          port = String(Number(digits));
          if (port === DEFAULT_PORT[protocol]) port = '';
        }
      }
      this._protocol = protocol; this._username = username; this._password = password; this._port = port;
      this._hostname = ParseHost(hostPort); this._pathname = ResolvePath(path || '/');
      this._query = query === null ? null : Encode(query, SPECIAL_QUERY);
      this._hash = hash === null ? null : Encode(hash, FRAGMENT); // 空のフラグメント（末尾の#）はhrefに残る
      this._params = new URLSearchParams(this._query ? ParseQuery(this._query) : [], this);
    }
    get protocol() { return this._protocol; }
    get username() { return this._username; }
    get password() { return this._password; }
    get port() { return this._port; }
    get hostname() { return this._hostname; }
    get host() { return this._hostname + (this._port ? ':' + this._port : ''); }
    get pathname() { return this._pathname; }
    get search() { return this._query ? '?' + this._query : ''; }
    get hash() { return this._hash ? '#' + this._hash : ''; }
    get searchParams() { return this._params; }
    get href() {
      const info = this._username || this._password ? this._username + (this._password ? ':' + this._password : '') + '@' : '';
      return `${this._protocol}//${info}${this.host}${this._pathname}${this._query === null ? '' : '?' + this._query}${this._hash === null ? '' : '#' + this._hash}`;
    }
    toString() { return this.href; }
  }

  // WHATWG forgiving-base64。
  function atob(input) {
    let data = String(input).replace(/[\t\n\f\r ]/g, '');
    if (data.length % 4 === 0) data = data.replace(/==?$/, '');
    if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) throw new Error('InvalidCharacterError');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '', bits = 0, value = 0;
    for (const char of data) {
      value = (value << 6) | alphabet.indexOf(char); bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((value >> bits) & 255); value &= (1 << bits) - 1; }
    }
    return out;
  }

  // 検証済みのプレイリスト（JSON値のみ）の複製に限定する。Date・Map・undefined値の保持は対象外。
  const structuredClone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  module.exports = { URL, URLSearchParams, atob, structuredClone };
})();
