'use strict';
// 端末共通JSのバンドルを、ECMAScript標準機能だけの環境（JavaScriptCoreの JSContext 相当）で実行して検証する。
// 同じ shared/fixtures/cases.json を、iOSのXCTestでもJSContextで実行する。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Build, MODULES } = require('../scripts/build-shared-bundle.cjs');
const prelude = require('../shared/runtime/prelude.js');

const root = path.resolve(__dirname, '..');
const casesText = fs.readFileSync(path.join(root, 'shared/fixtures/cases.json'), 'utf8');
const cases = JSON.parse(casesText);

function EcmaScriptOnly(native = false) {
  // Node本来のWeb API（URL・atob・structuredClone・Buffer・process・require）を渡さない新しい実行環境。
  const context = vm.createContext(native ? { URL, atob, structuredClone } : {});
  vm.runInContext(Build({ native }), context, { filename: native ? 'favecus-core.native.js' : 'favecus-core.js' });
  return context;
}
function Run(context, expression, value) {
  context.input = value;
  return vm.runInContext(expression, context);
}

test('the bundle runs in an ECMAScript-only context without host APIs', () => {
  const context = vm.createContext({});
  const globals = vm.runInContext('[typeof URL, typeof atob, typeof structuredClone, typeof Buffer, typeof require, typeof process, typeof TextEncoder, typeof setTimeout]', context);
  assert.deepEqual([...globals], Array(8).fill('undefined'), '実行環境にWeb/Node APIが混ざっています');
  vm.runInContext(Build(), context);
  assert.equal(typeof vm.runInContext('FavecusCore.RunCases', context), 'function');
});

test('shared fixtures pass in the ECMAScript-only context using the prelude polyfills', () => {
  const result = JSON.parse(Run(EcmaScriptOnly(), 'FavecusCore.RunCases(input)', casesText));
  assert.equal(result.total, cases.length);
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures, null, 1));
});

test('fixture expectations come from Node native URL behavior (no case depends on the polyfill)', () => {
  const result = JSON.parse(Run(EcmaScriptOnly(true), 'FavecusCore.RunCases(input)', JSON.stringify(cases.filter(testCase => !testCase.divergence))));
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures, null, 1));
  // 既知の相違として記録できるのは、KnownDivergenceの分類に該当する入力だけ。
  for (const testCase of cases.filter(item => item.divergence)) assert.ok(KnownDivergence(testCase.args[0]), `${testCase.name}: 未分類の相違`);
});

test('the bundler rejects non-relative and out-of-allowlist requires', () => {
  assert.ok(Object.keys(MODULES).length >= 12);
  for (const [, file] of Object.entries(MODULES)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g)) assert.ok(match[2].startsWith('.'), `${file}: ${match[2]}`);
  }
  assert.ok(!Object.values(MODULES).some(file => /store\.cjs|main\.cjs|offline-|bilibili-download|playlist-icon\.cjs$/.test(file)));
});

// ---- URLのpolyfillとNode本来のURLとの差分 ----
const FIELDS = ['protocol', 'username', 'password', 'port', 'hostname', 'pathname', 'search', 'hash', 'href'];
const NAMES = ['p', 'a', 'b', 'bvid', 'aid', 'q', 'x', 'cid'];
function Seen(Url, input) {
  try { const url = new Url(input); return { ...Object.fromEntries(FIELDS.map(key => [key, url[key]])), params: NAMES.map(name => url.searchParams.get(name)), has: NAMES.map(name => url.searchParams.has(name)) }; }
  catch { return null; }
}
// 許容する既知の相違（この実装が例外にし、Nodeは受理する）。結果が一致しないURLは許容しない。
function KnownDivergence(input) {
  const text = String(input).replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
  const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(text);
  if (!scheme || !/^https?$/i.test(scheme[1])) return 'scheme-or-relative';
  const authority = text.slice(scheme[0].length).replace(/^[/\\]*/, '').split(/[/\\?#]/)[0], host = authority.slice(authority.lastIndexOf('@') + 1);
  if (host.startsWith('[')) return 'ipv6';
  let name = host.replace(/:[^:]*$/, '');
  try { name = decodeURIComponent(name); } catch {}
  if (/[^\x00-\x7F]/.test(name)) return 'non-ascii-host';
  const labels = name.split('.'); if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop();
  if (/^([0-9]+|0[xX][0-9A-Fa-f]*)$/.test(labels[labels.length - 1])) return 'ipv4-numeric-host';
  return null;
}
function Compare(input, divergences) {
  const native = Seen(globalThis.URL, input), poly = Seen(prelude.URL, input);
  if (native === null) { assert.equal(poly, null, `Nodeが拒否する入力をpolyfillが受理: ${JSON.stringify(input)}`); return; }
  if (poly === null) { const kind = KnownDivergence(input); assert.ok(kind, `未分類の相違（polyfillだけが拒否）: ${JSON.stringify(input)}`); divergences.set(kind, (divergences.get(kind) || 0) + 1); return; }
  assert.deepEqual(poly, native, `URLの解析結果が異なる: ${JSON.stringify(input)}`);
}
function Random(seed) { let state = seed >>> 0; return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296; }

test('URL polyfill matches Node URL for the fixture inputs and a deterministic fuzz corpus', () => {
  const divergences = new Map(), inputs = new Set();
  for (const testCase of cases) for (const arg of testCase.args || []) {
    if (typeof arg === 'string') { inputs.add(arg); for (const match of arg.match(/https?:\/\/[^\s<>"'【】]+/gi) || []) inputs.add(match); }
    else if (arg && typeof arg === 'object' && typeof arg.url === 'string') inputs.add(arg.url);
  }
  const schemes = ['https://', 'http://', 'HTTPS://', 'https:\\\\', 'https:/', 'https:///', 'ftp://', '//', 'https:', ' https://', 'https://\t'];
  const infos = ['', 'a@', 'a:b@', '@', ':@', 'a%40b@'];
  const hosts = ['www.bilibili.com', 'WWW.BILIBILI.COM', 'm.bilibili.com', 'bilibili.com.', 'a.b', '127.1', '0x7f.0.0.1', '1.2.3.4', 'example.com', 'xn--abc.com', 'ｗｗｗ.bilibili.com', 'www.%62ilibili.com', '[::1]', '', 'a b', 'a_b.com', 'www.bilibili.com%2f', 'a.b.', 'A.B.C', 'www.bilibili.com.:443', 'a%00b'];
  const ports = ['', ':443', ':80', ':8080', ':0443', ':65536', ':abc', ':', ':00', ':443:'];
  const paths = ['', '/', '/video/BV1xx411c7mD', '/video/../x', '/a/./b/', '/%2e%2e/x', '//x', '/a b', '/日本', '/a\\b', '/%zz', '/a%2Fb', '/%41', '/..', '/.', '/a/..', '/a/%2E', '/a/.%2e/b', '/?x', '/a"b<c>d`e{f}g^h|i', '/%7e~', '/a;b=c,d'];
  const queries = ['', '?', '?p=2', '?p=2&p=3', '?a=b c', '?a=%E3%81%82&b=+', '?x=%ZZ', '?q=\'"<>', '?p', '?=1', '?&&', '?p=%32&aid=17&cid=9', '?a=%F0%9F%98%80', '?a=%C3', '?a=a+b%20c', '?b=1#x', '?q=日本'];
  const hashes = ['', '#x', '#a b', '#', '#日本', '#`a'];
  for (const scheme of schemes) for (const host of hosts.slice(0, 4)) for (const path of paths.slice(0, 6)) inputs.add(scheme + host + path);
  const next = Random(20261113), pick = list => list[Math.floor(next() * list.length)];
  for (let i = 0; i < 40000; i++) inputs.add(pick(schemes) + pick(infos) + pick(hosts) + pick(ports) + pick(paths) + pick(queries) + pick(hashes));
  for (const input of inputs) Compare(input, divergences);
  assert.ok(inputs.size > 30000);
  // 想定外の分類が増えていないことを記録する（件数は固定せず、分類名の集合だけを確認）。
  for (const kind of divergences.keys()) assert.ok(['scheme-or-relative', 'ipv6', 'non-ascii-host', 'ipv4-numeric-host'].includes(kind), kind);
});

test('URL polyfill serializes searchParams.set the same way as Node URL', () => {
  const inputs = ['https://player.bilibili.com/player.html', 'https://player.bilibili.com/player.html?x=1&bvid=old&bvid=older#h', 'https://a.b/?q=a b&c=日本'];
  const values = ['BV1xx411c7mD', 'a b', '日本語', "it's*-._~!()", '', '50%', '&=?+/'];
  for (const input of inputs) for (const name of ['bvid', 'p', 'q', 'n ame', '日本']) for (const value of values) {
    const native = new URL(input), poly = new prelude.URL(input);
    native.searchParams.set(name, value); poly.searchParams.set(name, value);
    native.searchParams.set('autoplay', '1'); poly.searchParams.set('autoplay', '1');
    assert.equal(poly.href, native.href, `${input} ${name}=${value}`);
    assert.equal(poly.search, native.search);
  }
});

test('atob polyfill matches the WHATWG forgiving-base64 decoder', () => {
  const next = Random(7), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/= \n\t.-_';
  const samples = ['', 'QQ==', 'QQ=', 'QQ', 'QUI=', 'QUJD', 'QUJD=', 'QUJD==', 'A', 'AA', 'AAA', 'AAAA', 'AAA==', 'AA==', 'A===', ' QU JD ', 'QU\nJD', '=', '==', '===', '====', 'QUJD ', 'QUJD!', 'QUJD-_'];
  for (let i = 0; i < 20000; i++) { let text = ''; for (let n = Math.floor(next() * 9); n > 0; n--) text += alphabet[Math.floor(next() * alphabet.length)]; samples.push(text); }
  for (const sample of samples) {
    let native, poly;
    try { native = globalThis.atob(sample); } catch { native = null; }
    try { poly = prelude.atob(sample); } catch { poly = null; }
    assert.equal(poly, native, JSON.stringify(sample));
  }
});

test('structuredClone polyfill clones validated JSON data without sharing references', () => {
  const source = { a: [1, { b: 'x' }], c: null, d: 'é' };
  const copy = prelude.structuredClone(source);
  assert.deepEqual(copy, source); assert.notEqual(copy.a, source.a); assert.equal(prelude.structuredClone(undefined), undefined);
});

test('benchmark dataset of 999 lists and about 10000 entries validates in the ECMAScript-only context', () => {
  const result = JSON.parse(Run(EcmaScriptOnly(), 'FavecusCore.Bench(input)', '{}'));
  assert.equal(result.lists, 999); assert.equal(result.validatedLists, 999); assert.equal(result.entries, 9990); assert.ok(result.searchTotal > 0);
  for (const key of ['validateMs', 'shareMs', 'searchIndexMs', 'searchPageMs', 'importMs']) assert.ok(result[key] < 60000, `${key}: ${result[key]}ms`);
});
