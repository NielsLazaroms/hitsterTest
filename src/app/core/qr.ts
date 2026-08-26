import qrcode from 'qrcode-generator';

/**
 * A scalable SVG for the given payload.
 *
 * Pinned to version 3 at error-correction level H: a 22-character Spotify track
 * id fits v3-H (24-byte capacity) and always lands on the same 29×29 grid, so
 * the printed module size is predictable (≈1.757 mm on a 50.9 mm symbol). H's
 * redundancy tolerates the wear a printed card takes. The quiet zone comes from
 * the card's own padding, so none is baked in here.
 */
export function qrSvg(payload: string): string {
  const qr = qrcode(3, 'H');
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

/**
 * The QR as a boolean module grid, `matrix[row][col]` true where the cell is
 * dark. Row 0 is the top of the symbol in image space (Y down).
 *
 * Pinned to version 3 at level H, the same symbol the printed card uses: a
 * same-material 3D print relies on shadow and a filament colour-change for
 * contrast, which is marginal, and H's redundancy tolerates that.
 */
export function qrMatrix(payload: string): boolean[][] {
  const qr = qrcode(3, 'H');
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < n; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < n; col++) line.push(qr.isDark(row, col));
    matrix.push(line);
  }
  return matrix;
}
