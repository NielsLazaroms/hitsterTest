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
import { DeckService } from '../../core/deck';
import { Player } from '../../core/player';
import { QrScanner, cardIdFromScan } from '../../core/scanner';

type Mode = 'idle' | 'scanning' | 'manual' | 'playing';

@Component({
  selector: 'app-play',
  imports: [FormsModule, RouterLink],
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

  readonly cameraAvailable = QrScanner.supported;
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
    this.mode.set('scanning');
    // Wait a frame so the <video> element exists before the camera attaches.
    await Promise.resolve();

    const element = this.video()?.nativeElement;
    if (!element) return;

    try {
      await this.scanner.start(element, (value) => void this.launch(cardIdFromScan(value)));
    } catch {
      this.mode.set('idle');
      this.hint.set(
        this.cameraAvailable
          ? 'Camera blocked. Allow access, or use "Enter code by hand".'
          : 'No camera here. Use "Enter code by hand".',
      );
    }
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
