/*
 * A small, defensive ZIP reader (also used for .xlsx, which is a ZIP). Built on Node's own zlib, so no dependency.
 *
 * It refuses, before unpacking anything:
 *   - more entries than allowed, ZIP64 archives, encrypted entries, compression methods other than stored/deflate;
 *   - entry names that could escape a folder (absolute paths, "..", backslashes, drive letters, NUL) and symlinks;
 *   - a declared unpacked total above the limit, and entries that compress suspiciously well (zip bombs).
 * While unpacking, each entry may never produce more bytes than it declared (the inflater is capped), and its
 * CRC-32 must match — so a lying header cannot get past the limits either.
 */
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipRefused extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** An entry above this size that compresses more than MAX_RATIO times is treated as a bomb. */
const RATIO_FLOOR = 1024 * 1024;
const MAX_RATIO = 200;

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  offset: number;
  external: number;
}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL;
}

function findEnd(buf: Buffer): number {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) if (buf.readUInt32LE(i) === EOCD) return i;
  throw new ZipRefused("The archive is damaged (no end-of-archive record)");
}

/** Is this name safe to use as a path inside a folder? */
export function safeEntryName(name: string): boolean {
  if (!name || name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return !name.split("/").some((part) => part === "..");
}

function centralDirectory(buf: Buffer, limits: ZipLimits): CentralEntry[] {
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  const size = buf.readUInt32LE(end + 12);
  const start = buf.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    throw new ZipRefused("ZIP64 archives are not accepted — split the archive into smaller ones");
  if (count > limits.maxEntries) throw new ZipRefused(`The archive has ${count} entries; at most ${limits.maxEntries}`);
  if (start + size > end) throw new ZipRefused("The archive is damaged (central directory out of range)");
  const entries: CentralEntry[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL)
      throw new ZipRefused("The archive is damaged (bad central directory)");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressed: buf.readUInt32LE(p + 20),
      uncompressed: buf.readUInt32LE(p + 24),
      external: buf.readUInt32LE(p + 38),
      offset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Check the whole archive, then unpack its files (folders are skipped). Throws ZipRefused with a plain reason. */
export function readZip(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  const entries = centralDirectory(buf, limits);
  let total = 0;
  for (const e of entries) {
    if (!safeEntryName(e.name)) throw new ZipRefused(`Unsafe path in archive: "${e.name.replace(/\0/g, "")}"`);
    if (((e.external >>> 16) & 0o170000) === 0o120000) throw new ZipRefused(`Symbolic link in archive: "${e.name}"`);
    if (e.flags & 1) throw new ZipRefused(`Encrypted entry in archive: "${e.name}"`);
    if (e.method !== 0 && e.method !== 8) throw new ZipRefused(`Unsupported compression in archive entry "${e.name}"`);
    total += e.uncompressed;
    if (total > limits.maxUncompressedBytes)
      throw new ZipRefused(`The archive unpacks to more than ${limits.maxUncompressedBytes} bytes`);
    if (e.uncompressed > RATIO_FLOOR && e.uncompressed > e.compressed * MAX_RATIO)
      throw new ZipRefused(`Archive entry "${e.name}" compresses suspiciously well (possible zip bomb)`);
  }
  const out: ZipEntry[] = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOCAL)
      throw new ZipRefused(`The archive is damaged at "${e.name}"`);
    const dataStart = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const raw = buf.subarray(dataStart, dataStart + e.compressed);
    if (raw.length !== e.compressed) throw new ZipRefused(`The archive is truncated at "${e.name}"`);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.uncompressed) });
      } catch {
        throw new ZipRefused(`Archive entry "${e.name}" unpacks to more than it declares, or is damaged`);
      }
    }
    if (data.length !== e.uncompressed || crc32(data) >>> 0 !== e.crc >>> 0)
      throw new ZipRefused(`Archive entry "${e.name}" is damaged (size or checksum does not match)`);
    out.push({ name: e.name, data });
  }
  return out;
}
