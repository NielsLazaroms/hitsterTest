/**
 * Browser-only helpers for the 3D export: turning text into the boolean grids
 * that {@link ./stl} extrudes, and handing the finished STL to the user.
 *
 * Text is rasterised rather than turned into real glyph outlines on purpose:
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
  /**
   * Wrap width in pixels. Given, a long line breaks onto more lines instead of
   * widening the canvas, which, once the caller extrudes at a fixed cell size,
   * keeps the text the same physical size whatever the title's length.
   */
  maxWidth?: number;
  /** Cap the wrapped text at this many lines, truncating the last with an ellipsis. */
  maxLines?: number;
}

/**
 * Greedily wraps each line to `maxWidth`, measuring with the supplied callback.
 * Pure and canvas-free so the wrapping (the half that decides how big the text
 * ends up) can be unit-tested. A single word wider than the limit is left on
 * its own line rather than split mid-word.
 */
export function wrapLines(
  lines: string[],
  measure: (text: string) => number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let current = '';
    for (const word of line.split(/\s+/).filter(Boolean)) {
      const trial = current ? `${current} ${word}` : word;
      if (current && measure(trial) > maxWidth) {
        out.push(current);
        current = word;
      } else {
        current = trial;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * Keeps at most `maxLines` lines, ending a truncated block with an ellipsis and
 * dropping trailing words from the last line so it still fits `maxWidth`.
 */
export function clampLines(
  lines: string[],
  maxLines: number | undefined,
  measure: (text: string) => number,
  maxWidth?: number,
): string[] {
  if (!maxLines || lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  if (maxWidth) {
    const words = last.split(' ');
    while (words.length > 1 && measure(`${words.join(' ')}…`) > maxWidth) words.pop();
    last = words.join(' ');
  }
  kept[maxLines - 1] = `${last}…`;
  return kept;
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
  const input = lines.map((l) => l.trim()).filter(Boolean);
  if (!input.length) return [[false]];

  const pad = Math.round(px * 0.15);
  const lineGap = Math.round(px * 0.3);
  const font = `${weight} ${px}px ${family}`;

  // First pass: measure, and wrap long lines so the canvas never grows past the
  // requested width, which is what keeps every card's text one physical size.
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [[false]];
  probe.font = font;
  const measure = (t: string) => probe.measureText(t).width;
  const wrapped = opts.maxWidth ? wrapLines(input, measure, opts.maxWidth) : input;
  const text = clampLines(wrapped, opts.maxLines, measure, opts.maxWidth);
  if (!text.length) return [[false]];

  const widths = text.map((l) => Math.ceil(measure(l)));
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
 * Thresholds a canvas' RGBA buffer into a boolean grid on the alpha channel:
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

/**
 * Stacks grids vertically, centred, with `gap` blank rows between them. Because
 * each grid was rasterised at its own font size but they share one cell size
 * when extruded, this is how the back gets a small artist, a big year, and a
 * small title in a single feature. Empty grids are skipped.
 */
export function stackGrids(grids: boolean[][][], gap = 0): boolean[][] {
  const real = grids.filter((g) => g.length && g.some((row) => row.some(Boolean)));
  if (!real.length) return [[false]];

  const width = Math.max(...real.map((g) => g[0].length));
  const out: boolean[][] = [];
  real.forEach((grid, i) => {
    if (i > 0) for (let k = 0; k < gap; k++) out.push(new Array(width).fill(false));
    const offset = Math.floor((width - grid[0].length) / 2);
    for (const row of grid) {
      const line: boolean[] = new Array(width).fill(false);
      for (let c = 0; c < row.length; c++) line[offset + c] = row[c];
      out.push(line);
    }
  });
  return out;
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

/** Saves any bytes to a file via a throwaway object URL. */
function save(data: BlobPart, filename: string, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Downloads a single STL buffer. */
export function downloadStl(buffer: ArrayBuffer, filename: string): void {
  save(buffer, filename, 'model/stl');
}

/** Downloads a ZIP archive of bundled files. */
export function downloadZip(data: Uint8Array<ArrayBuffer>, filename: string): void {
  save(data, filename, 'application/zip');
}
