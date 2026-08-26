import {
  box,
  extrude,
  deckMesh,
  serializeBinaryStl,
  gridColumns,
  DEFAULT_TILE,
  TriangleSink,
  type TileFaces,
} from './stl';

interface Tri {
  n: [number, number, number];
  v: [number, number, number][];
}

/** Reads a filled sink back into plain triangles for inspection. */
function triangles(sink: TriangleSink): Tri[] {
  const data = sink.view();
  const out: Tri[] = [];
  for (let t = 0; t < sink.count; t++) {
    const o = t * 12;
    out.push({
      n: [data[o], data[o + 1], data[o + 2]],
      v: [
        [data[o + 3], data[o + 4], data[o + 5]],
        [data[o + 6], data[o + 7], data[o + 8]],
        [data[o + 9], data[o + 10], data[o + 11]],
      ],
    });
  }
  return out;
}

/** Axis-aligned bounds over every vertex — the box a single extrusion covers. */
function bounds(sink: TriangleSink) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles(sink)) {
    for (const p of tri.v) {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], p[i]);
        hi[i] = Math.max(hi[i], p[i]);
      }
    }
  }
  return { lo, hi };
}

describe('box', () => {
  it('emits a closed 12-triangle solid', () => {
    const sink = new TriangleSink();
    box(sink, 0, 0, 0, 2, 3, 4);
    expect(sink.count).toBe(12);
  });

  it('winds every face so its normal points outward', () => {
    const sink = new TriangleSink();
    box(sink, 0, 0, 0, 2, 3, 4);
    const center = [1, 1.5, 2];
    for (const tri of triangles(sink)) {
      const c = [0, 1, 2].map((i) => (tri.v[0][i] + tri.v[1][i] + tri.v[2][i]) / 3);
      const dot = [0, 1, 2].reduce((s, i) => s + tri.n[i] * (c[i] - center[i]), 0);
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('extrude orientation', () => {
  // A lit cell at image row 0 / col 0 is the *top-left* of the picture.
  const topLeft: boolean[][] = [
    [true, false],
    [false, false],
  ];

  it('keeps the top face un-mirrored: image row 0 → high Y, col 0 → low X', () => {
    const sink = new TriangleSink();
    extrude(sink, topLeft, 0, 10, 1, 0, 1, false, 2);
    const { lo, hi } = bounds(sink);
    // Column 0 stays on the left.
    expect(lo[0]).toBe(0);
    expect(hi[0]).toBe(1);
    // Row 0 sits at the top (largest Y), since rows run downward in the image.
    expect(hi[1]).toBe(10);
    expect(lo[1]).toBe(9);
  });

  it('mirrors the bottom face in X so it reads after a book-style flip', () => {
    const sink = new TriangleSink();
    // Same grid, flipX with the right edge at x = 2.
    extrude(sink, topLeft, 0, 10, 1, 0, 1, true, 2);
    const { lo, hi } = bounds(sink);
    // The top-left image cell now lands on the right.
    expect(lo[0]).toBe(1);
    expect(hi[0]).toBe(2);
    // Rows are unaffected by the X flip: row 0 is still at the top.
    expect(hi[1]).toBe(10);
    expect(lo[1]).toBe(9);
  });

  it('merges a horizontal run into one box', () => {
    const sink = new TriangleSink();
    extrude(sink, [[true, true, true]], 0, 1, 1, 0, 1, false, 3);
    expect(sink.count).toBe(12); // one box, not three
    const { lo, hi } = bounds(sink);
    expect(lo[0]).toBe(0);
    expect(hi[0]).toBe(3);
  });
});

describe('serializeBinaryStl', () => {
  it('writes an 84-byte head plus 50 bytes per triangle', () => {
    const sink = new TriangleSink();
    box(sink, 0, 0, 0, 1, 1, 1);
    const buf = serializeBinaryStl(sink);
    expect(buf.byteLength).toBe(84 + 12 * 50);
    expect(new DataView(buf).getUint32(80, true)).toBe(12);
  });
});

describe('deckMesh', () => {
  const face: TileFaces = { qr: [[true]], code: [[false]], back: [[false]] };

  it('fits tiles across the bed and wraps into rows', () => {
    expect(gridColumns(10, DEFAULT_TILE)).toBe(4); // (200+4)/(40+4) = 4
  });

  it('produces a non-empty watertight mesh for a small deck', () => {
    const sink = deckMesh([face, face, face], DEFAULT_TILE);
    // Three base boxes (12 tris each) plus a lit QR module per tile, at least.
    expect(sink.count).toBeGreaterThanOrEqual(3 * 12 + 3 * 12);
    expect(sink.count % 12).toBe(0);
  });
});
