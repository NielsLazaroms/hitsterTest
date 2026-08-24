import jsQR from 'jsqr';

interface BarcodeHit {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<BarcodeHit[]>;
}

type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

/**
 * Reads QR codes from the rear camera.
 *
 * Uses the browser's own BarcodeDetector where it exists (Android Chrome) and
 * falls back to decoding canvas frames with jsQR everywhere else (iOS Safari).
 *
 * getUserMedia only works in a secure context, which means https:// or the
 * loopback address — http://127.0.0.1:5200 is fine, a LAN IP is not.
 */
export class QrScanner {
  private stream: MediaStream | null = null;
  private frame = 0;
  private detector: BarcodeDetectorLike | null = null;
  private readonly canvas = document.createElement('canvas');

  static get supported(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(video: HTMLVideoElement, onResult: (value: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    video.srcObject = this.stream;
    await video.play();

    const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (Ctor) {
      try {
        this.detector = new Ctor({ formats: ['qr_code'] });
      } catch {
        this.detector = null;
      }
    }

    const context = this.canvas.getContext('2d', { willReadFrequently: true });

    const tick = async (): Promise<void> => {
      if (!this.stream) return;

      const value = this.detector
        ? await this.detectNative(video)
        : this.detectFallback(video, context);

      if (value) {
        this.stop();
        onResult(value);
        return;
      }

      this.frame = requestAnimationFrame(() => void tick());
    };

    void tick();
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.frame = 0;
  }

  private async detectNative(video: HTMLVideoElement): Promise<string | null> {
    try {
      const hits = await this.detector!.detect(video);
      return hits.length ? hits[0].rawValue : null;
    } catch {
      return null;
    }
  }

  private detectFallback(
    video: HTMLVideoElement,
    context: CanvasRenderingContext2D | null,
  ): string | null {
    if (!context || !video.videoWidth) return null;

    this.canvas.width = video.videoWidth;
    this.canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0);

    const image = context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const hit = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
    return hit ? hit.data : null;
  }
}

/**
 * Pulls the card id out of whatever the camera read. Cards encode
 * `<app>/?t=a3f9`, but a hand-typed bare id works too.
 */
export function cardIdFromScan(value: string): string {
  try {
    const url = new URL(value, document.baseURI);
    const fromQuery = url.searchParams.get('t');
    if (fromQuery) return fromQuery.toLowerCase();
    const last = url.pathname.split('/').filter(Boolean).pop();
    return (last ?? '').toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}
