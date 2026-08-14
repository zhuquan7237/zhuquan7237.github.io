import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { unzipTo } from "./unzip-zip";

function readOctal(buf: Buffer, start: number, length: number): number {
  const raw = buf.subarray(start, start + length).toString("utf8").replace(/\0/g, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function readCString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end >= 0 ? end : length).toString("utf8");
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

/**
 * Extract a gzip-compressed ustar/pax tarball (official Node.js unix dist).
 * Avoids depending on system tar or xz.
 */
export async function extractTarGz(archive: Buffer, dest: string): Promise<string[]> {
  const tar = gunzipSync(archive);
  const written: string[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (isZeroBlock(header)) break;

    const size = readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    const typeflag = String.fromCharCode(header[156] || 0);
    const prefix = readCString(header, 345, 155);
    const headerName = readCString(header, 0, 100);
    const linkname = readCString(header, 157, 100);
    const dataEnd = offset + size;
    const data = tar.subarray(offset, Math.min(dataEnd, tar.length));
    offset = dataEnd + ((512 - (size % 512)) % 512);

    if (typeflag === "L") {
      pendingLongName = data.toString("utf8").replace(/\0/g, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g" || typeflag === "K") continue;

    const rawName = pendingLongName || (prefix ? `${prefix}/${headerName}` : headerName);
    pendingLongName = null;
    const name = rawName.replace(/^\.\//, "");
    if (!name || name.includes("..") || path.isAbsolute(name)) continue;

    const target = path.join(dest, name);
    if (typeflag === "5" || name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    if (typeflag === "2" || typeflag === "1") {
      await symlink(linkname, target).catch(async () => {
        /* Windows or existing path: skip the link; npm-cli.js is a real file. */
      });
      written.push(name);
      continue;
    }
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      await writeFile(target, data, { mode: mode ? mode & 0o777 : 0o644 });
      written.push(name);
    }
  }
  return written;
}

export async function extractNodeArchive(archive: Buffer, dest: string, fileName: string): Promise<string[]> {
  if (fileName.endsWith(".zip")) return await unzipTo(archive, dest);
  if (fileName.endsWith(".tar.gz") || fileName.endsWith(".tgz")) return await extractTarGz(archive, dest);
  throw new Error(`不支持的 Node 压缩包格式：${fileName}`);
}
