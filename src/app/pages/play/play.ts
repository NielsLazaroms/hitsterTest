import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Icon } from '../../core/icon';
import { Player } from '../../core/player';
import { SpotifyApi } from '../../core/spotify-api';
import { isInAppBrowser } from '../../core/environment';
import { QrScanner, trackIdFromScan, explainCameraError } from '../../core/scanner';

type Mode = 'idle' | 'scanning' | 'manual' | 'playing';

@Component({
  selector: 'app-play',
  imports: [FormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './play.html',
  styleUrl: './play.css',
})
export class Play implements OnDestroy {
  private readonly api = inject(SpotifyApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly player = inject(Player);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly scanner = new QrScanner();

  readonly mode = signal<Mode>('idle');
  readonly hint = signal('Point at the code on the front of a card.');
  readonly manualCode = signal('');

  readonly inApp = isInAppBrowser();
  readonly card = computed(() => this.player.card());

  constructor() {
    const pending = this.route.snapshot.queryParamMap.get('t');
    if (pending) {
      void this.router.navigate([], { replaceUrl: true, queryParams: {} });
      void this.launch(pending);
    }
  }

  ngOnDestroy(): void {
    this.scanner.stop();
  }

  // ------------------------------------------------------------ scanning --

  async startScan(): Promise<void> {
    if (this.mode() === 'scanning') return;

    try {
      // Ask for the camera first: the permission prompt then belongs to the
      // tap that opened it, and a refusal never leaves a dead camera screen.
      await this.scanner.acquire();
    } catch (error) {
      // Fall back to the scan screen (never leave the caller's screen, e.g. the
      // playing view when this was reached from "Next card").
      this.mode.set('idle');
      this.hint.set(explainCameraError(error, this.inApp));
      return;
    }

    this.mode.set('scanning');

    const element = await this.videoElement();
    if (!element) {
      this.scanner.stop();
      this.mode.set('idle');
      this.hint.set('The camera view did not open. Try again, or use "Enter code by hand".');
      return;
    }

    try {
      await this.scanner.attach(element, (value) => void this.launch(trackIdFromScan(value)));
    } catch (error) {
      this.scanner.stop();
      this.mode.set('idle');
      this.hint.set(explainCameraError(error, this.inApp));
    }
  }

  /**
   * The <video> only exists once Angular has rendered the scanning branch, and
   * that happens on a later task than the signal write. Awaiting a resolved
   * promise is not enough: it runs before change detection, so the element is
   * still missing and the scan used to abort without saying anything.
   */
  private async videoElement(): Promise<HTMLVideoElement | null> {
    // setTimeout rather than requestAnimationFrame: frames stop being served
    // to a hidden or throttled page, and waiting on one that never arrives
    // hangs the scan with nothing on screen to explain it.
    for (let attempt = 0; attempt < 60; attempt++) {
      const element = this.video()?.nativeElement;
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return null;
  }

  cancelScan(): void {
    this.scanner.stop();
    this.mode.set('idle');
  }

  // ------------------------------------------------------------- manual --

  openManual(): void {
    this.manualCode.set('');
    this.mode.set('manual');
  }

  async submitManual(): Promise<void> {
    await this.launch(trackIdFromScan(this.manualCode()));
  }

  // ---------------------------------------------------------- playback --

  private async launch(rawId: string): Promise<void> {
    const id = rawId.trim();
    if (!id) return;

    // A scanned card is self-contained: the id is the track. Play it straight
    // away from a URI built from the id — nothing is looked up or stored to
    // start playback.
    this.mode.set('playing');
    await this.player.start({ id, uri: `spotify:track:${id}`, title: '', artist: '', year: 0 });

    if (this.player.error()) {
      this.mode.set('idle');
      this.hint.set(this.player.error());
      return;
    }

    // Look up the track length so the tape counter stops when the song ends.
    try {
      this.player.setDuration(id, await this.api.trackLengthMs(id));
    } catch {
      /* no length — the clock just runs to the clip limit or a manual stop */
    }
  }

  async togglePause(): Promise<void> {
    if (this.player.status() === 'playing') await this.player.pause();
    else await this.player.resume();
  }

  async nextCard(): Promise<void> {
    this.hint.set('Point at the code on the front of a card.');
    // Open the camera straight away — no extra "Scan a card" tap. Acquire it
    // first so it stays inside this tap gesture, then stop the old song in the
    // background. If the camera can't open, startScan drops to the scan screen.
    await this.startScan();
    void this.player.clear();
  }

  /** Returns to the scan screen without opening the camera (manual-entry back). */
  toIdle(): void {
    this.hint.set('Point at the code on the front of a card.');
    this.mode.set('idle');
  }
}
