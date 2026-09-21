/**
 * Minimal ZIP writer (STORE method, no compression).
 *
 * The diagnostics bundle has to be a zip that Windows Explorer, macOS Finder and
 * `unzip` all open, and the desktop package only depends on js-yaml. Adding a
 * compression library for one feature would also add native/ESM risk to every
 * platform build, so the container is written by hand: local file headers, a
 * central directory, an end-of-central-directory record, and CRC-32 per entry.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = -1;
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, POSIX separators, no leading slash. */
  name: string;
  data: Buffer | string;
}

interface Prepared {
  name: Buffer;
  data: Buffer;
  crc: number;
  offset: number;
}

/** MS-DOS date/time, which is what the ZIP header stores. */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Directories are implied by entry names; callers pass files only. The archive
 * is always written with a UTC timestamp and stored (method 0), so it can be
 * reproduced byte for byte in tests.
 */
export function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const stamp = dosDateTime(now);
  const locals: Buffer[] = [];
  const prepared: Prepared[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/").replace(/^\/+/, ""), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    prepared.push({ name, data, crc, offset });
    locals.push(header, name, data);
    offset += header.length + name.length + data.length;
  }

  const central: Buffer[] = [];
  for (const item of prepared) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(item.crc, 16);
    record.writeUInt32LE(item.data.length, 20);
    record.writeUInt32LE(item.data.length, 24);
    record.writeUInt16LE(item.name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(item.offset, 42);
    central.push(record, item.name);
  }

  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, ...central, end]);
}
