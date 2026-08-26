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
import {
  LucidePause,
  LucidePlay,
  LucideScanLine,
  LucideSettings,
  LucideShare2,
  LucideSkipBack,
  LucideSkipForward,
} from '@lucide/angular';
import { DeckService } from '../../core/deck';
import { Player } from '../../core/player';
import { isInAppBrowser } from '../../core/environment';
import { QrScanner, cardIdFromScan, explainCameraError } from '../../core/scanner';

type Mode = 'idle' | 'scanning' | 'manual' | 'playing';

@Component({
  selector: 'app-play',
  imports: [
    FormsModule,
    RouterLink,
    LucidePause,
    LucidePlay,
    LucideScanLine,
    LucideSettings,
    LucideShare2,
    LucideSkipBack,
    LucideSkipForward,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './play.html',
  styleUrl: './play.css',
})
export class Play implements OnDestroy {
  private readonly deck = inject(DeckService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly player = inject(Player);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly scanner = new QrScanner();

  readonly mode = signal<Mode>('idle');
  readonly hint = signal('Point at the code on the front of a card.');
  readonly manualCode = signal('');
  readonly revealed = signal(false);

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
      await this.scanner.attach(element, (value) => void this.launch(cardIdFromScan(value)));
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
    await this.launch(this.manualCode());
  }

  // ---------------------------------------------------------- playback --

  private async launch(rawId: string): Promise<void> {
    const card = this.deck.find(rawId);
    if (!card) {
      this.mode.set('idle');
      this.hint.set(
        this.deck.count() === 0
          ? 'No deck yet. Build one in Settings first.'
          : `Card "${rawId}" is not in this deck.`,
      );
      return;
    }

    this.revealed.set(false);
    this.mode.set('playing');
    await this.player.start(card);

    if (this.player.error()) {
      this.mode.set('idle');
      this.hint.set(this.player.error());
    }
  }

  async togglePause(): Promise<void> {
    if (this.player.status() === 'playing') await this.player.pause();
    else await this.player.resume();
  }

  async nextCard(): Promise<void> {
    await this.player.clear();
    this.revealed.set(false);
    this.hint.set('Point at the code on the front of a card.');
    this.mode.set('idle');
  }
}
