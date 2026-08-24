import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { DeckService } from '../../core/deck';
import { SpotifyAuth } from '../../core/spotify-auth';
import { qrSvg } from '../../core/qr';
import type { Card } from '../../core/models';

const PER_PAGE = 12;
const COLUMNS = 3;

interface PrintCard extends Card {
  qr: SafeHtml;
}

interface Sheet {
  side: 'front' | 'back';
  cards: (PrintCard | null)[];
}

@Component({
  selector: 'app-print',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './print.html',
  styleUrl: './print.css',
})
export class PrintSheet {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly auth = inject(SpotifyAuth);

  protected readonly deck = inject(DeckService);

  readonly deckName = this.deck.deckName;
  /** The address the QR codes point back to. */
  readonly appUrl = this.auth.redirectUri;

  /**
   * Front and back sheets, ready for duplex printing.
   *
   * Each back sheet has its rows reversed left-to-right, which is what a
   * long-edge flip does to the paper. Card 1 is top-left on the front and
   * top-right on the back.
   */
  readonly sheets = computed<Sheet[]>(() => {
    const cards = this.deck.cards();
    const out: Sheet[] = [];

    for (let start = 0; start < cards.length; start += PER_PAGE) {
      const chunk = cards.slice(start, start + PER_PAGE).map((card) => this.decorate(card));

      out.push({ side: 'front', cards: chunk });

      /*
       * Each row is padded out to a full width *before* being reversed. A short
       * last row otherwise reverses into the wrong columns: two cards in
       * columns 1-2 would come back as columns 1-2, but the flip puts column 1
       * opposite column 3, so every answer on that row lands on a neighbour.
       */
      const mirrored: (PrintCard | null)[] = [];
      for (let row = 0; row < chunk.length; row += COLUMNS) {
        const line: (PrintCard | null)[] = chunk.slice(row, row + COLUMNS);
        while (line.length < COLUMNS) line.push(null);
        mirrored.push(...line.reverse());
      }

      out.push({ side: 'back', cards: mirrored });
    }

    return out;
  });

  /** Pieces of paper, as opposed to sides — each one is printed front and back. */
  readonly paperCount = computed(() => Math.ceil(this.deck.count() / PER_PAGE));

  /** Which piece of paper a given page index lands on — two pages per sheet. */
  paperNumber(pageIndex: number): number {
    return Math.floor(pageIndex / 2) + 1;
  }

  print(): void {
    window.print();
  }

  private decorate(card: Card): PrintCard {
    const target = `${this.auth.redirectUri}?t=${card.id}`;
    return { ...card, qr: this.sanitizer.bypassSecurityTrustHtml(qrSvg(target)) };
  }
}
