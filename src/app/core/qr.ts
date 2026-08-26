import qrcode from 'qrcode-generator';

/**
 * A scalable SVG for the given payload.
 *
 * Error correction level M keeps the symbol small enough that a 34 mm printed
 * square stays well above the size a phone camera needs.
 */
export function qrSvg(payload: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

/**
 * The QR as a boolean module grid, `matrix[row][col]` true where the cell is
 * dark. Row 0 is the top of the symbol in image space (Y down).
 *
 * Error correction level H is used here rather than M: a same-material 3D
 * print relies on shadow and a filament colour-change for contrast, which is
 * marginal, and the extra redundancy of H tolerates that far better than the
 * flat printed version needs to.
 */
export function qrMatrix(payload: string): boolean[][] {
  const qr = qrcode(0, 'H');
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
