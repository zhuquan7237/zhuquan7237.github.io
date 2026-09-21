import { describe, expect, it } from "vitest";
import { crc32, createZip, dosDateTime } from "./zip-write";

/** Reads a ZIP back with the container format only, so the writer is verified. */
function readZip(buffer: Buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; crc: number; size: number; offset: number; data: Buffer }> = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    expect(buffer.readUInt32LE(offset)).toBe(0x04034b50);
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const localExtraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLength + localExtraLength;
    entries.push({ name, crc, size, offset, data: buffer.subarray(start, start + size) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, centralSize, centralOffset, eocd };
}

describe("crc32", () => {
  it("matches the published check value", () => {
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("", "utf8"))).toBe(0);
  });
});

describe("createZip", () => {
  const now = new Date(2026, 8, 21, 10, 46, 12);

  it("writes a store-method archive that reads back byte for byte", () => {
    const files = [
      { name: "system-info.txt", data: "desktop 0.3.0\nengine dsh 0.1.5-rc.2\n" },
      { name: "logs/app.log", data: "[2026-09-21 10:46:12] boot\n".repeat(50) },
      { name: "json/running.json", data: Buffer.from('{"ok":true}', "utf8") },
    ];
    const zip = createZip(files, now);
    const read = readZip(zip);

    expect(read.entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    expect(read.centralOffset + read.centralSize).toBe(read.eocd);
    for (const [index, entry] of read.entries.entries()) {
      const source = Buffer.from(files[index].data);
      expect(entry.data.equals(source)).toBe(true);
      expect(entry.crc).toBe(crc32(source));
      expect(entry.size).toBe(source.length);
    }
  });

  it("normalizes separators and strips a leading slash", () => {
    const zip = createZip([{ name: "\\logs\\app.log", data: "x" }], now);
    expect(readZip(zip).entries[0].name).toBe("logs/app.log");
  });

  it("survives an empty archive", () => {
    const read = readZip(createZip([], now));
    expect(read.entries).toEqual([]);
    expect(read.eocd).toBe(0);
  });

  it("encodes a DOS timestamp the platform can transform back", () => {
    const stamp = dosDateTime(now);
    const year = ((stamp.date >> 9) & 0x7f) + 1980;
    const month = (stamp.date >> 5) & 0x0f;
    const day = stamp.date & 0x1f;
    const hour = (stamp.time >> 11) & 0x1f;
    const minute = (stamp.time >> 5) & 0x3f;
    expect([year, month, day, hour, minute]).toEqual([2026, 9, 21, 10, 46]);
  });
});
