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
 * loopback address: http://127.0.0.1:5200 is fine, a LAN IP is not.
 */
/**
 * Turns a getUserMedia failure into something a player can act on.
 *
 * Every cause below lands in the same catch block and looks identical from the
 * outside, but the fixes are unrelated: one is a browser permission, one means
 * closing another app, and one cannot be fixed on the current page at all.
 */
export function explainCameraError(error: unknown, inApp: boolean): string {
  if (inApp) {
    return (
      'The browser built into a chat app will not open the camera. Tap the ⋯ or share button ' +
      'and choose "Open in browser", then try again.'
    );
  }

  if (!window.isSecureContext) {
    return 'The camera needs a https:// address. Open the hosted site rather than a local one.';
  }

  const name = error instanceof DOMException ? error.name : '';

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return (
        'Camera access was refused. Tap the icon at the left of the address bar, allow the ' +
        'camera for this site, then reload.'
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device. Use "Enter code by hand".';
    case 'NotReadableError':
    case 'AbortError':
      return 'Something else is using the camera. Close other camera apps and try again.';
    default:
      return 'The camera could not be started. Use "Enter code by hand".';
  }
}

export class QrScanner {
  private stream: MediaStream | null = null;
  private frame = 0;
  private detector: BarcodeDetectorLike | null = null;
  private readonly canvas = document.createElement('canvas');

  /**
   * Opens the camera. Kept separate from attaching it so the caller can ask
   * while the user's tap is still the current gesture (browsers are stricter
   * about permission prompts raised later), and so a refusal is known before
   * the camera screen is shown.
   */
  async acquire(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException('getUserMedia unavailable', 'NotFoundError');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    return this.stream;
  }

  async attach(video: HTMLVideoElement, onResult: (value: string) => void): Promise<void> {
    if (!this.stream) throw new DOMException('camera not acquired', 'InvalidStateError');

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
 * Extracts a Spotify track id from whatever the camera read or the player typed.
 * A card's QR is the bare 22-char id, but a pasted `spotify:track:<id>` URI or an
 * `open.spotify.com/track/<id>` link works too. Case is preserved on purpose —
 * Spotify ids are case-sensitive.
 */
export function trackIdFromScan(value: string): string {
  const raw = value.trim();

  const uri = /spotify:track:([A-Za-z0-9]+)/.exec(raw);
  if (uri) return uri[1];

  const url = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(raw);
  if (url) return url[1];

  return raw;
}
