import { gridFromAlpha, trim, wrapLines, stackGrids } from './raster';

// Measure text by character count, so wrap widths read as "max characters".
const byChars = (t: string) => t.length;

describe('wrapLines', () => {
  it('breaks a long line onto multiple lines at word boundaries', () => {
    expect(wrapLines(['the quick brown fox'], byChars, 9)).toEqual(['the quick', 'brown fox']);
  });

  it('keeps a word longer than the limit on its own line rather than splitting it', () => {
    expect(wrapLines(['supercalifragilistic'], byChars, 9)).toEqual(['supercalifragilistic']);
  });

  it('wraps each input line independently', () => {
    expect(wrapLines(['aa bb', 'cc dd'], byChars, 5)).toEqual(['aa bb', 'cc dd']);
  });
});

describe('stackGrids', () => {
  it('stacks grids centred with a blank-row gap', () => {
    expect(stackGrids([[[true]], [[true, true, true]]], 1)).toEqual([
      [false, true, false],
      [false, false, false],
      [true, true, true],
    ]);
  });

  it('skips empty grids', () => {
    expect(stackGrids([[[false]], [[true]]], 0)).toEqual([[true]]);
  });
});

/** Builds an RGBA buffer from a boolean grid (alpha 255 where true). */
function rgba(grid: boolean[][]): number[] {
  const out: number[] = [];
  for (const row of grid) {
    for (const on of row) out.push(0, 0, 0, on ? 255 : 0);
  }
  return out;
}

describe('gridFromAlpha', () => {
  it('thresholds the alpha channel into booleans', () => {
    const grid = [
      [true, false],
      [false, true],
    ];
    expect(gridFromAlpha(rgba(grid), 2, 2)).toEqual(grid);
  });
});

describe('trim', () => {
  it('drops empty border rows and columns', () => {
    const padded = [
      [false, false, false, false],
      [false, true, false, false],
      [false, true, true, false],
      [false, false, false, false],
    ];
    expect(trim(padded)).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it('collapses an all-empty grid to a single empty cell', () => {
    expect(
      trim([
        [false, false],
        [false, false],
      ]),
    ).toEqual([[false]]);
  });

  it('leaves an already-tight grid unchanged', () => {
    const tight = [[true, true]];
    expect(trim(tight)).toEqual(tight);
  });
});
