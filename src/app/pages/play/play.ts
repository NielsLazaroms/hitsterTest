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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Icon } from '../../core/icon';
import { Nav } from '../../core/nav';
import { Player, STEP_LENGTHS } from '../../core/player';
import { SpotifyApi } from '../../core/spotify-api';
import { isInAppBrowser } from '../../core/environment';
import { DebugPanel } from '../../core/debug-panel';
import { isDebugEnabled, log } from '../../core/debug';
import { QrScanner, trackIdFromScan, explainCameraError } from '../../core/scanner';

type Mode = 'idle' | 'scanning' | 'playing';

@Component({
  selector: 'app-play',
  imports: [RouterLink, FormsModule, Icon, DebugPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './play.html',
  styleUrl: './play.css',
})
export class Play implements OnDestroy {
  private readonly api = inject(SpotifyApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly player = inject(Player);
  protected readonly nav = inject(Nav);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly scanner = new QrScanner();

  readonly mode = signal<Mode>('idle');
  readonly hint = signal('Richt op de code op de voorkant van een kaart.');

  readonly inApp = isInAppBrowser();

  /** Fragment length, tunable straight from the deck. Kept short for the bar;
      the long form lives in Settings, both bound to the same player signal. */
  readonly clipOptions = [
    { value: 0, label: 'Onbeperkt' },
    { value: 15, label: '15 s' },
    { value: 30, label: '30 s' },
    { value: 45, label: '45 s' },
  ];

  /** The step ladder, for the rung display on the playing view. */
  readonly steps = STEP_LENGTHS;

  /** How much of the song the current Hitsnip round plays, e.g. "0,5 s". */
  readonly stepLabel = computed(() => `${this.player.stepLength().toLocaleString('nl-NL')} s`);

  /** The bar names the tape that is in the deck. */
  readonly modeName = computed(() => (this.player.gameMode() === 'steps' ? 'Hitsnip' : 'Klassiek'));

  constructor() {
    // The mode is the route: /play/classic or /play/steps. Anything else goes
    // back to the shelf to pick one.
    const mode = this.route.snapshot.paramMap.get('mode');
    if (mode !== 'classic' && mode !== 'steps') {
      void this.router.navigate(['/play'], { replaceUrl: true });
      return;
    }
    this.player.setGameMode(mode);

    const pending = this.route.snapshot.queryParamMap.get('t');
    log('play', 'open', {
      mode,
      via: pending ? 'query' : 'screen',
      device: this.player.deviceId() || 'last-active',
      clip: this.player.clipLength(),
      inApp: this.inApp,
    });

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

    // One device snapshot per scan screen, never just before a play: an extra
    // request on the play path would delay it and hide the ordering being
    // diagnosed. Fire and forget, and only when the log is on.
    if (isDebugEnabled()) void this.api.devices().catch(() => undefined);

    const element = await this.videoElement();
    if (!element) {
      this.scanner.stop();
      this.mode.set('idle');
      this.hint.set('De cameraweergave ging niet open. Probeer het opnieuw.');
      return;
    }

    try {
      await this.scanner.attach(element, (value) => {
        // The raw read next to the parsed id: a card that encodes something
        // other than a bare track id shows up here and nowhere else.
        log('play', 'scanned', { raw: value, id: trackIdFromScan(value) });
        void this.launch(trackIdFromScan(value));
      });
      log('play', 'attached', {});
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

  // ---------------------------------------------------------- playback --

  private async launch(rawId: string): Promise<void> {
    const id = rawId.trim();
    log('play', 'launch', { id, length: id.length });
    if (!id) return;

    // A scanned card is self-contained: the id is the track. Play it straight
    // away from a URI built from the id — nothing is looked up or stored to
    // start playback.
    this.mode.set('playing');
    await this.player.start({ id, uri: `spotify:track:${id}`, title: '', artist: '', year: 0 });

    if (this.player.error()) {
      log('play', 'launch-error', { why: this.player.error() });
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

  onClipChange(value: string): void {
    this.player.setClipLength(Number(value));
  }

  async togglePause(): Promise<void> {
    if (this.player.status() === 'playing') await this.player.pause();
    else await this.player.resume();
  }

  async nextCard(): Promise<void> {
    this.hint.set('Richt op de code op de voorkant van een kaart.');
    // Open the camera straight away — no extra "Scan a card" tap. Acquire it
    // first so it stays inside this tap gesture, then stop the old song in the
    // background. If the camera can't open, startScan drops to the scan screen.
    log('play', 'nextCard', { phase: 'before-scan' });
    await this.startScan();
    // A card already in frame can be decoded and launched before startScan
    // returns, which puts this clear() — and its pause — after the new play.
    log('play', 'nextCard', { phase: 'before-clear' });
    void this.player.clear();
  }
}
