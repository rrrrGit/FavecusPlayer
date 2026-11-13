'use strict';
const fs = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createInflateRaw } = require('node:zlib');
const MAX_BYTES = 1024 ** 4, MAX_FILES = 60000, U32 = 0xffffffff;
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function CRC(bytes, value = 0xffffffff) { for (const b of bytes) value = table[(value ^ b) & 255] ^ (value >>> 8); return value >>> 0; }
const { SafeName } = require('./library-transfer.cjs'); // 許可する名前の規則は、iPhone版と共通
function Read64(buffer, at) { const n = Number(buffer.readBigUInt64LE(at)); if (!Number.isSafeInteger(n) || n > MAX_BYTES) throw new Error('ZIPのサイズが上限を超えています。'); return n; }
function Extra64(values) { if (!values.length) return Buffer.alloc(0); const data = Buffer.alloc(4 + values.length * 8); data.writeUInt16LE(1); data.writeUInt16LE(values.length * 8, 2); values.forEach((v, i) => data.writeBigUInt64LE(BigInt(v), 4 + i * 8)); return data; }
async function WriteAll(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset, position + offset); if (!result.bytesWritten) throw new Error('書き込みに失敗しました。'); offset += result.bytesWritten; }
}
async function WriteZip(destination, items, { forceZip64 = false } = {}) {
  const file = await fs.promises.open(destination, 'wx'), records = [], names = new Set(); let position = 0;
  const put = async bytes => { if (position + bytes.length > MAX_BYTES) throw new Error('ZIPの上限は1TBです。'); await WriteAll(file, bytes, position); position += bytes.length; };
  try {
    for (const item of items) {
      if (!SafeName(item.name) || names.has(item.name) || records.length >= MAX_FILES) throw new Error('ZIP内のファイル名または件数が正しくありません。'); names.add(item.name);
      const expected = item.data ? item.data.length : (await fs.promises.stat(item.file)).size;
      const wide = forceZip64 || expected >= U32, name = Buffer.from(item.name), offset = position, extra = Extra64(wide ? [expected, expected] : []), head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50); head.writeUInt16LE(wide ? 45 : 20, 4); head.writeUInt16LE(0x808, 6); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(extra.length, 28);
      if (wide) { head.writeUInt32LE(U32, 18); head.writeUInt32LE(U32, 22); }
      await put(head); await put(name); await put(extra); let size = 0, crc = 0xffffffff;
      const source = item.data ? Readable.from([item.data]) : fs.createReadStream(item.file);
      for await (const chunk of source) { size += chunk.length; if (size > expected) throw new Error('出力中にファイルの内容が変わりました。再実行してください。'); crc = CRC(chunk, crc); await put(chunk); }
      if (size !== expected) throw new Error('出力中にファイルの内容が変わりました。再実行してください。');
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(wide ? 24 : 16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
      if (wide) { descriptor.writeBigUInt64LE(BigInt(size), 8); descriptor.writeBigUInt64LE(BigInt(size), 16); }
      else { descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); }
      await put(descriptor); records.push({ name, offset, size, crc, wide });
    }
    const start = position;
    for (const r of records) {
      const wideOffset = forceZip64 || r.offset >= U32, extra = Extra64([...(r.wide ? [r.size, r.size] : []), ...(wideOffset ? [r.offset] : [])]);
      const head = Buffer.alloc(46); head.writeUInt32LE(0x02014b50); head.writeUInt16LE(extra.length ? 45 : 20, 4); head.writeUInt16LE(extra.length ? 45 : 20, 6); head.writeUInt16LE(0x808, 8);
      head.writeUInt32LE(r.crc, 16); head.writeUInt32LE(r.wide ? U32 : r.size, 20); head.writeUInt32LE(r.wide ? U32 : r.size, 24); head.writeUInt16LE(r.name.length, 28); head.writeUInt16LE(extra.length, 30); head.writeUInt32LE(wideOffset ? U32 : r.offset, 42);
      await put(head); await put(r.name); await put(extra);
    }
    const directorySize = position - start, wideEnd = forceZip64 || start >= U32 || directorySize >= U32 || records.length >= 65535 || records.some(r => r.wide);
    if (wideEnd) {
      const recordOffset = position, end64 = Buffer.alloc(56); end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(records.length), 24); end64.writeBigUInt64LE(BigInt(records.length), 32); end64.writeBigUInt64LE(BigInt(directorySize), 40); end64.writeBigUInt64LE(BigInt(start), 48); await put(end64);
      const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(recordOffset), 8); locator.writeUInt32LE(1, 16); await put(locator);
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(wideEnd ? 65535 : records.length, 8); end.writeUInt16LE(wideEnd ? 65535 : records.length, 10); end.writeUInt32LE(wideEnd ? U32 : directorySize, 12); end.writeUInt32LE(wideEnd ? U32 : start, 16); await put(end); await file.sync();
  } catch (error) { await file.close(); await fs.promises.rm(destination, { force: true }); throw error; }
  await file.close();
}
class ZipReader {
  async Open(file) {
    this.file = file; this.handle = await fs.promises.open(file, 'r');
    try {
      const stat = await this.handle.stat(); if (!stat.isFile() || stat.size < 22 || stat.size > MAX_BYTES) throw new Error('対応するZIPファイルではありません。');
      const tailStart = Math.max(0, stat.size - 65557), tail = await this.Read(tailStart, Math.min(stat.size, 65557)); let end = tail.length - 22;
      while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
      if (end < 0 || tail.readUInt32LE(end + 4) !== 0) throw new Error('ZIPの一覧を読み取れません。');
      let count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16), boundary = tailStart + end;
      if (count !== tail.readUInt16LE(end + 8)) throw new Error('分割ZIPは対応していません。');
      if (count === 65535 || size === U32 || offset === U32) {
        if (boundary < 20) throw new Error('ZIP64の一覧を読み取れません。');
        const locator = await this.Read(boundary - 20, 20);
        if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new Error('分割ZIPは対応していません。');
        const endOffset = Read64(locator, 8), info = await this.Read(endOffset, 56);
        if (info.readUInt32LE(0) !== 0x06064b50 || Read64(info, 4) < 44 || endOffset + 12 + Read64(info, 4) > boundary - 20 || info.readUInt32LE(16) || info.readUInt32LE(20) || Read64(info, 24) !== Read64(info, 32)) throw new Error('ZIP64が壊れています。');
        count = Read64(info, 32); size = Read64(info, 40); offset = Read64(info, 48); boundary = endOffset;
      }
      if (count > MAX_FILES || size > 16 * 1024 * 1024 || offset + size > boundary) throw new Error('ZIPが大きすぎるか壊れています。');
      const directory = await this.Read(offset, size); this.entries = new Map(); let at = 0, total = 0;
      for (let i = 0; i < count; i++) {
        if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error('ZIPが壊れています。');
        const flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10), crc = directory.readUInt32LE(at + 16);
        let packed = directory.readUInt32LE(at + 20), bytes = directory.readUInt32LE(at + 24), local = directory.readUInt32LE(at + 42);
        const len = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32), disk = directory.readUInt16LE(at + 34), name = directory.toString('utf8', at + 46, at + 46 + len);
        const extraStart = at + 46 + len, next = extraStart + extra + comment;
        if (next > directory.length || disk) throw new Error('ZIPの一覧が正しくありません。');
        if ([packed, bytes, local].includes(U32)) {
          let pos = extraStart, found = false;
          while (pos + 4 <= extraStart + extra) {
            const type = directory.readUInt16LE(pos), length = directory.readUInt16LE(pos + 2), stop = pos + 4 + length; pos += 4;
            if (stop > extraStart + extra) throw new Error('ZIP64の拡張情報が正しくありません。');
            if (type === 1) { for (const field of ['bytes', 'packed', 'local']) if ((field === 'bytes' ? bytes : field === 'packed' ? packed : local) === U32) { if (pos + 8 > stop) throw new Error('ZIP64のサイズが不足しています。'); const n = Read64(directory, pos); pos += 8; if (field === 'bytes') bytes = n; else if (field === 'packed') packed = n; else local = n; } found = true; break; }
            pos = stop;
          }
          if (!found) throw new Error('ZIP64の拡張情報がありません。');
        }
        at = next;
        if (!SafeName(name) || this.entries.has(name) || (flags & ~0x808) || ![0, 8].includes(method) || local + 30 + packed > offset || (total += bytes) > MAX_BYTES) throw new Error('対応しないZIP構造です。');
        const header = await this.Read(local, 30);
        if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method) throw new Error('ZIPのヘッダーが一致しません。');
        const localName = await this.Read(local + 30, header.readUInt16LE(26)), start = local + 30 + localName.length + header.readUInt16LE(28);
        if (localName.toString('utf8') !== name || start + packed > offset || (method === 0 && packed !== bytes)) throw new Error('ZIPの内容が一致しません。');
        this.entries.set(name, { name, start, packed, bytes, crc, method });
      }
      if (at !== directory.length) throw new Error('ZIPの一覧サイズが一致しません。');
      return this;
    } catch (error) { await this.Close(); throw error; }
  }
  async Read(position, size) {
    const buffer = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const { bytesRead } = await this.handle.read(buffer, offset, size - offset, position + offset); if (!bytesRead) throw new Error('ZIPの途中でデータが途切れています。'); offset += bytesRead; } return buffer;
  }
  async Content(name, destination, limit = 32 * 1024 * 1024) {
    const item = this.entries.get(name); if (!item || item.bytes > limit) throw new Error('アーカイブ内のデータが見つからないか大きすぎます。');
    let size = 0, crc = 0xffffffff; const chunks = [];
    const check = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; if (size > item.bytes || size > limit) return done(new Error('展開サイズが一致しません。')); crc = CRC(chunk, crc); done(null, chunk); }, flush(done) { done(size === item.bytes && ((crc ^ 0xffffffff) >>> 0) === item.crc ? null : new Error('ZIPのデータが破損しています。')); } });
    const source = item.packed ? fs.createReadStream(this.file, { fd: this.handle.fd, autoClose: false, start: item.start, end: item.start + item.packed - 1 }) : Readable.from([]);
    const sink = destination ? fs.createWriteStream(destination, { flags: 'wx' }) : new Transform({ transform(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    await pipeline(source, ...(item.method === 8 ? [createInflateRaw()] : []), check, sink);
    return destination || Buffer.concat(chunks);
  }
  async Close() { if (this.handle) { await this.handle.close(); this.handle = null; } }
}
module.exports = { WriteZip, ZipReader };
