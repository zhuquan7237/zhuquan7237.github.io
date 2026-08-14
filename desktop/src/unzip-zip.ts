import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readEntries(archive: Buffer): ZipEntry[] {
  if (archive.length < 22) throw new Error("zip archive is too small");
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0 && i >= archive.length - 22 - 0xffff; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip end-of-central-directory not found");
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("invalid zip central directory");
    const method = archive.readUInt16LE(offset + 10);
    const compact = archive.readUInt32LE(offset + 20);
    const nameLen = archive.readUInt16LE(offset + 28);
    const extraLen = archive.readUInt16LE(offset + 30);
    const commentLen = archive.readUInt16LE(offset + 32);
    const localOff = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (name.includes("..") || path.isAbsolute(name)) continue;
    if (archive.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`invalid zip local header: ${name}`);
    const localNameLen = archive.readUInt16LE(localOff + 26);
    const localExtraLen = archive.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const compressed = archive.subarray(dataStart, dataStart + compact);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!data) throw new Error(`unsupported zip method ${method} for ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

/** Extract a standard ZIP (store / deflate) without depending on unzip(1). */
export async function unzipTo(archive: Buffer, dest: string): Promise<string[]> {
  const entries = readEntries(archive);
  for (const entry of entries) {
    const target = path.join(dest, entry.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  return entries.map((entry) => entry.name);
}
