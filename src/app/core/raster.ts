/**
 * Browser-only helpers for the 3D export: turning text into the boolean grids
 * that {@link ./stl} extrudes, and handing the finished STL to the user.
 *
 * Text is rasterised rather than turned into real glyph outlines on purpose —
 * a pixel grid rides the exact same extrusion path as the QR modules, so the
 * whole feature needs no font-parsing or polygon-triangulation dependency. The
 * result is a slightly chunky embossed label, which is all a printed tile wants.
 */

/** Lines of text laid onto a boolean grid, `grid[row][col]` true where inked. */
export interface RasterOptions {
  /** Pixels per em; higher is crisper but multiplies the triangle count. */
  pixelsPerLine?: number;
  /** Font family used on the offscreen canvas. */
  font?: string;
  /** Extra weight, e.g. `700` for the loud middle line. */
  weight?: number | string;
}

/**
 * Renders one or more lines centred on a transparent canvas and thresholds the
 * alpha channel into a boolean grid. Empty and blank lines collapse to a 1×1
 * empty grid so callers can hand the result straight to the mesh builder.
 */
export function rasterText(lines: string[], opts: RasterOptions = {}): boolean[][] {
  const px = opts.pixelsPerLine ?? 24;
  const family = opts.font ?? 'Arial, sans-serif';
  const weight = opts.weight ?? 400;
  const text = lines.map((l) => l.trim()).filter(Boolean);
  if (!text.length) return [[false]];

  const pad = Math.round(px * 0.15);
  const lineGap = Math.round(px * 0.3);
  const font = `${weight} ${px}px ${family}`;

  // First pass: measure so the canvas is only as wide as the widest line.
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [[false]];
  probe.font = font;
  const widths = text.map((l) => Math.ceil(probe.measureText(l).width));
  const width = Math.max(1, ...widths) + pad * 2;
  const lineH = Math.round(px * 1.25);
  const height = lineH * text.length + lineGap * (text.length - 1) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [[false]];

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  text.forEach((line, i) => {
    const y = pad + lineH / 2 + i * (lineH + lineGap);
    ctx.fillText(line, width / 2, y);
  });

  const { data } = ctx.getImageData(0, 0, width, height);
  return trim(gridFromAlpha(data, width, height));
}

/**
 * Thresholds a canvas' RGBA buffer into a boolean grid on the alpha channel —
 * pure, so the grid-shaping half of {@link rasterText} is testable without a
 * real canvas (the text rendering itself needs a browser).
 */
export function gridFromAlpha(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const rowArr: boolean[] = [];
    for (let x = 0; x < width; x++) {
      rowArr.push(data[(y * width + x) * 4 + 3] > 128);
    }
    grid.push(rowArr);
  }
  return grid;
}

/** Drops fully-empty border rows and columns so the label fills its box. */
export function trim(grid: boolean[][]): boolean[][] {
  let top = 0,
    bottom = grid.length - 1,
    left = 0,
    right = grid[0].length - 1;
  const rowEmpty = (r: number) => grid[r].every((v) => !v);
  const colEmpty = (c: number) => grid.every((row) => !row[c]);
  while (top < bottom && rowEmpty(top)) top++;
  while (bottom > top && rowEmpty(bottom)) bottom--;
  while (left < right && colEmpty(left)) left++;
  while (right > left && colEmpty(right)) right--;

  const out: boolean[][] = [];
  for (let r = top; r <= bottom; r++) out.push(grid[r].slice(left, right + 1));
  return out.length ? out : [[false]];
}

/** Saves an STL buffer to a file via a throwaway object URL. */
export function downloadStl(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
