import { zipStore, type ZipEntry } from './zip';

/** Minimal reader: walks the local file headers of a STORE-only archive. */
function unzip(bytes: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; data: Uint8Array; crc: number }[] = [];
  let p = 0;
  while (p + 4 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const crc = dv.getUint32(p + 14, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameStart = p + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    out.push({ name, data: bytes.subarray(dataStart, dataStart + size), crc });
    p = dataStart + size;
  }
  return out;
}

describe('zipStore', () => {
  const entries: ZipEntry[] = [
    { name: 'a.txt', data: new TextEncoder().encode('hello') },
    { name: 'b.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
  ];

  it('starts with the local file header signature', () => {
    const zip = zipStore(entries);
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
  });

  it('round-trips every entry name and payload', () => {
    const back = unzip(zipStore(entries));
    expect(back.map((e) => e.name)).toEqual(['a.txt', 'b.bin']);
    expect(Array.from(back[0].data)).toEqual(Array.from(entries[0].data));
    expect(Array.from(back[1].data)).toEqual(Array.from(entries[1].data));
  });

  it('writes the standard CRC-32 of the payload', () => {
    // CRC32("hello") is a fixed, widely-published value.
    expect(unzip(zipStore(entries))[0].crc).toBe(0x3610a686);
  });

  it('records the entry count in the end-of-central-directory record', () => {
    const zip = zipStore(entries);
    const dv = new DataView(zip.buffer);
    const eocd = zip.length - 22; // no archive comment
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
  });
});
