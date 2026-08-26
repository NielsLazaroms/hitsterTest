import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { DeckService } from '../../core/deck';
import { Icon } from '../../core/icon';
import { qrSvg } from '../../core/qr';

/**
 * Passing a deck between phones. Split out of Settings so the gesture has a page
 * of its own: the current deck is drawn as a cassette, and sharing it fills in
 * the code written on the label.
 */
@Component({
  selector: 'app-share',
  imports: [FormsModule, RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './share.html',
  styleUrl: './share.css',
})
export class Share {
  private readonly route = inject(ActivatedRoute);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly deck = inject(DeckService);

  /** The code written on the label, once known: from sharing or from a scan. */
  readonly shareCode = signal('');
  readonly shareQr = signal<SafeHtml | null>(null);
  readonly sharing = signal(false);
  readonly copied = signal(false);

  /** The code someone types in to pull a deck sent from another phone. */
  readonly codeInput = signal('');
  readonly loadingCode = signal(false);

  readonly message = signal('');
  readonly failed = signal(false);

  constructor() {
    const params = this.route.snapshot.queryParamMap;

    // A QR scanned from another phone lands here as /share?code=xxxx, so pull that
    // deck straight away so scanning is all it takes.
    const code = params.get('code');
    if (code) {
      this.codeInput.set(code);
      void this.loadCode();
    }
  }

  async shareDeck(): Promise<void> {
    this.sharing.set(true);
    this.say('');
    this.shareCode.set('');
    this.shareQr.set(null);
    this.copied.set(false);
    try {
      const code = await this.deck.share();
      this.showCode(code);
      this.say('Copy made. Hand over the code, or let them scan the sticker.');
    } catch (error) {
      this.say(error instanceof Error ? error.message : 'Could not share the deck.', true);
    } finally {
      this.sharing.set(false);
    }
  }

  async loadCode(): Promise<void> {
    const code = this.codeInput().trim();
    if (!code) return;
    this.loadingCode.set(true);
    this.say('');
    try {
      const count = await this.deck.loadShared(code);
      this.showCode(code.toLowerCase());
      this.say(`Loaded ${count} songs. This deck is ready to play.`);
      this.codeInput.set('');
    } catch (error) {
      this.say(error instanceof Error ? error.message : 'Could not load that code.', true);
    } finally {
      this.loadingCode.set(false);
    }
  }

  async copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.shareCode());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard blocked (insecure context, or denied), so the code is on screen
      // to read out, so this is a convenience that can quietly do nothing.
    }
  }

  private showCode(code: string): void {
    this.shareCode.set(code);
    const link = `${location.origin}/share?code=${code}`;
    this.shareQr.set(this.sanitizer.bypassSecurityTrustHtml(qrSvg(link)));
  }

  private say(text: string, failed = false): void {
    this.message.set(text);
    this.failed.set(failed);
  }
}
