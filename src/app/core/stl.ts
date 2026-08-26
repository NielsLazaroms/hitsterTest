/**
 * Turns boolean pixel grids (a QR matrix, a strip of rasterised text) into a
 * binary STL of extruded tiles, ready for a slicer.
 *
 * The whole file is deliberately free of any browser or framework dependency:
 * it takes grids in and gives triangle data out, so the geometry — and above
 * all the mirroring, which is the part that silently breaks — can be pinned by
 * a unit test. Rasterising text to a grid and triggering the download are the
 * browser's job and live elsewhere.
 *
 * Every raised feature is emitted as its own fully closed box rather than as
 * one stitched surface with holes. The result is a set of overlapping closed
 * solids, not a single manifold shell — a slicer unions them without complaint,
 * but a strict mesh-repair tool will note the internal faces. Boxes are sunk
 * slightly into the base so the union is clean; a coincident face would instead
 * show up as an artefact. Adjacent lit cells in a row are merged into a single
 * box first, which keeps the triangle count down on a full deck.
 */

/** A square tile: QR + code raised on top, the answer raised underneath. */
export interface TileFaces {
  /** QR module grid, `qr[row][col]` true where dark. Row 0 is the top. */
  qr: boolean[][];
  /** Rasterised card code, shown under the QR on the top face. */
  code: boolean[][];
  /** Rasterised answer (artist / year / title), raised on the bottom face. */
  back: boolean[][];
}

export interface TileOptions {
  /** Side of the square tile, mm. */
  tileSize: number;
  /** Solid core between the two relief faces, mm. */
  baseThickness: number;
  /** How far raised features stand out from the base, mm. */
  relief: number;
  /** How far each feature sinks into the base so solids union cleanly, mm. */
  sink: number;
  /** Flat quiet-zone border around the QR, in QR modules. */
  quiet: number;
  /** Structural border kept clear at the tile edge, mm. */
  margin: number;
  /** Gap between tiles when laid out in a grid, mm. */
  gap: number;
  /** Usable bed width; the grid wraps to a new row past it, mm. */
  bedWidth: number;
  /** Usable bed depth; the deck splits into a new file past it, mm. */
  bedDepth: number;
  /**
   * Physical size of one back-text raster pixel, mm. Fixing this — rather than
   * scaling each card's block to fill its space — is what keeps the answer the
   * same size on every tile; a long title just wraps onto more lines.
   */
  backCell: number;
}

export const DEFAULT_TILE: TileOptions = {
  tileSize: 40,
  baseThickness: 1.6,
  relief: 0.6,
  sink: 0.2,
  // Two modules rather than the textbook four: the flat base margin around the
  // block is the same colour as the tile, so it already reads as quiet zone.
  // That lets the QR itself grow without starving the scanner of a border.
  quiet: 2,
  margin: 1.5,
  gap: 4,
  bedWidth: 250,
  bedDepth: 210,
  // 0.12 mm × the raster's ~30 px line height ≈ a 3.6 mm line — legible and the
  // same on every card. rasterText renders back text at 24 px, so this is the
  // conversion from those pixels to millimetres.
  backCell: 0.12,
};

/**
 * A growable store of triangles, each held as 12 floats: normal, then the
 * three vertices. Kept as one Float32Array so a full-deck mesh never becomes a
 * forest of tiny objects.
 */
export class TriangleSink {
  private data = new Float32Array(4096 * 12);
  /** Number of triangles written so far. */
  count = 0;

  push(
    nx: number,
    ny: number,
    nz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    if ((this.count + 1) * 12 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.count * 12;
    const d = this.data;
    d[o] = nx;
    d[o + 1] = ny;
    d[o + 2] = nz;
    d[o + 3] = ax;
    d[o + 4] = ay;
    d[o + 5] = az;
    d[o + 6] = bx;
    d[o + 7] = by;
    d[o + 8] = bz;
    d[o + 9] = cx;
    d[o + 10] = cy;
    d[o + 11] = cz;
    this.count++;
  }

  /** The written triangles as a tight view, 12 floats each. */
  view(): Float32Array {
    return this.data.subarray(0, this.count * 12);
  }
}

type Vec = readonly [number, number, number];

/** Two triangles for a quad, winding a,b,c,d, normal taken from the winding. */
function quad(sink: TriangleSink, a: Vec, b: Vec, c: Vec, d: Vec): void {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  sink.push(nx, ny, nz, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  sink.push(nx, ny, nz, a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}

/**
 * A closed axis-aligned box, all six faces wound counter-clockwise as seen from
 * outside so every normal points away from the box.
 */
export function box(
  sink: TriangleSink,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): void {
  const p000: Vec = [x0, y0, z0],
    p100: Vec = [x1, y0, z0];
  const p110: Vec = [x1, y1, z0],
    p010: Vec = [x0, y1, z0];
  const p001: Vec = [x0, y0, z1],
    p101: Vec = [x1, y0, z1];
  const p111: Vec = [x1, y1, z1],
    p011: Vec = [x0, y1, z1];

  quad(sink, p100, p110, p111, p101); // +X
  quad(sink, p000, p001, p011, p010); // -X
  quad(sink, p010, p011, p111, p110); // +Y
  quad(sink, p000, p100, p101, p001); // -Y
  quad(sink, p001, p101, p111, p011); // +Z
  quad(sink, p000, p010, p110, p100); // -Z
}

/**
 * Extrudes the lit cells of a grid into raised boxes.
 *
 * The grid is image space: column grows rightward, row grows *downward*. On the
 * build plate Y grows upward, so row is mapped to −Y — get that backwards and
 * the top-face view comes out mirrored (a QR that will not scan, text that
 * reads in reverse). `flipX` additionally mirrors the columns, which is what
 * the bottom face needs so the answer reads correctly once the tile is turned
 * over about its vertical edge — the same book-style flip the paper deck uses.
 */
export function extrude(
  sink: TriangleSink,
  grid: boolean[][],
  originX: number,
  topY: number,
  cell: number,
  z0: number,
  z1: number,
  flipX: boolean,
  rightX: number,
): void {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const y1 = topY - r * cell;
    const y0 = topY - (r + 1) * cell;
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < row.length && row[end + 1]) end++;
      let fx0: number, fx1: number;
      if (flipX) {
        fx0 = rightX - (end + 1) * cell;
        fx1 = rightX - c * cell;
      } else {
        fx0 = originX + c * cell;
        fx1 = originX + (end + 1) * cell;
      }
      box(sink, fx0, y0, z0, fx1, y1, z1);
      c = end + 1;
    }
  }
}

/**
 * Centres a grid inside a box (given by its bottom-left corner and size) with a
 * uniform cell size that preserves the grid's aspect ratio, then extrudes it.
 */
function placeFeature(
  sink: TriangleSink,
  grid: boolean[][],
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  z0: number,
  z1: number,
  flipX: boolean,
  maxCell?: number,
): void {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  if (!rows || !cols) return;

  // Fill the box by default; with maxCell, hold a fixed physical size instead
  // and only shrink if the grid would otherwise overflow the box.
  let cell = Math.min(boxW / cols, boxH / rows);
  if (maxCell !== undefined) cell = Math.min(cell, maxCell);
  const w = cols * cell,
    h = rows * cell;
  const left = boxX + (boxW - w) / 2;
  const top = boxY + (boxH + h) / 2; // top edge Y of the centred grid
  extrude(sink, grid, left, top, cell, z0, z1, flipX, left + w);
}

/**
 * One tile at the given grid offset: a solid base, the QR and code raised on
 * top within a quiet-zone border, and the answer raised on the underside.
 */
export function tileMesh(
  sink: TriangleSink,
  faces: TileFaces,
  opts: TileOptions,
  offsetX = 0,
  offsetY = 0,
): void {
  const { tileSize: S, baseThickness, relief, sink: overlap, quiet, margin } = opts;

  // Z bands: bottom relief sits below the base, top relief above it.
  const baseBottom = relief;
  const baseTop = relief + baseThickness;
  const topZ1 = baseTop + relief;
  const topZ0 = baseTop - overlap;
  const botZ0 = 0;
  const botZ1 = baseBottom + overlap;

  // Solid core.
  box(sink, offsetX, offsetY, baseBottom, offsetX + S, offsetY + S, baseTop);

  const inner = S - 2 * margin;

  // Top face: QR block anchored to the top, a slim code strip below it. The
  // code is only a manual-entry fallback, so it is kept small to hand the QR as
  // much of the tile as possible.
  const codeStrip = Math.min(2.5, inner * 0.09);
  const gapToCode = 0.8;
  const qrBlock = Math.min(inner, inner - codeStrip - gapToCode);
  const qrBlockLeft = offsetX + (S - qrBlock) / 2;
  const qrBlockTop = offsetY + S - margin;

  // Inset the QR by its quiet zone; the untouched base around it is that flat
  // border, which the scanner needs.
  const modules = faces.qr.length;
  const cellBlock = qrBlock / (modules + 2 * quiet);
  const qrInset = quiet * cellBlock;
  placeFeature(
    sink,
    faces.qr,
    qrBlockLeft + qrInset,
    qrBlockTop - qrBlock + qrInset,
    modules * cellBlock,
    modules * cellBlock,
    topZ0,
    topZ1,
    false,
  );

  const codeTop = qrBlockTop - qrBlock - gapToCode;
  placeFeature(
    sink,
    faces.code,
    offsetX + margin,
    codeTop - codeStrip,
    inner,
    codeStrip,
    topZ0,
    topZ1,
    false,
  );

  // Bottom face: the answer, mirrored so it reads after a book-style flip, and
  // held to a fixed text size so it matches across every card in the deck.
  placeFeature(
    sink,
    faces.back,
    offsetX + margin,
    offsetY + margin,
    inner,
    inner,
    botZ0,
    botZ1,
    true,
    opts.backCell,
  );
}

/** How many tiles fit along a bed dimension of the given length. */
function bedFit(length: number, opts: TileOptions): number {
  const pitch = opts.tileSize + opts.gap;
  return Math.max(1, Math.floor((length + opts.gap) / pitch));
}

/** Tile columns per plate — how many fit across the bed. */
export function plateColumns(opts: TileOptions): number {
  return bedFit(opts.bedWidth, opts);
}

/** Tile rows per plate — how many fit down the bed. */
export function plateRows(opts: TileOptions): number {
  return bedFit(opts.bedDepth, opts);
}

/** Tiles that fit on one bed, and so land in one STL file. */
export function plateCapacity(opts: TileOptions): number {
  return plateColumns(opts) * plateRows(opts);
}

/**
 * Splits a deck into bed-sized plates, in order, so each becomes its own file.
 * The last plate holds the remainder.
 */
export function splitPlates(tiles: TileFaces[], opts: TileOptions): TileFaces[][] {
  const per = plateCapacity(opts);
  const plates: TileFaces[][] = [];
  for (let i = 0; i < tiles.length; i += per) plates.push(tiles.slice(i, i + per));
  return plates;
}

/**
 * Lays one plate of tiles out in a grid and returns the filled triangle sink.
 * Expects at most {@link plateCapacity} tiles; the caller splits first.
 */
export function deckMesh(tiles: TileFaces[], opts: TileOptions): TriangleSink {
  const sink = new TriangleSink();
  const cols = Math.min(tiles.length || 1, plateColumns(opts));
  const rows = Math.ceil(tiles.length / cols);
  const pitch = opts.tileSize + opts.gap;

  tiles.forEach((faces, i) => {
    const gx = i % cols;
    const gy = Math.floor(i / cols);
    // Top-left tile is the first card, so rows count down from the top.
    tileMesh(sink, faces, opts, gx * pitch, (rows - 1 - gy) * pitch);
  });

  return sink;
}

/** Packs a filled sink into a binary STL buffer (84-byte head, 50 bytes/tri). */
export function serializeBinaryStl(sink: TriangleSink): ArrayBuffer {
  const count = sink.count;
  const tris = sink.view();
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, count, true);

  let o = 84;
  for (let t = 0; t < count; t++) {
    const b = t * 12;
    for (let k = 0; k < 12; k++) {
      dv.setFloat32(o, tris[b + k], true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
