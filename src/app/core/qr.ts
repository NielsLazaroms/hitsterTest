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
