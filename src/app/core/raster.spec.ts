import { gridFromAlpha, trim } from './raster';

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
