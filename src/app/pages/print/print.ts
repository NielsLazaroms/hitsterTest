import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { DeckService } from '../../core/deck';
import { SpotifyAuth } from '../../core/spotify-auth';
import { qrSvg, qrMatrix } from '../../core/qr';
import {
  DEFAULT_TILE,
  deckMesh,
  gridColumns,
  serializeBinaryStl,
  type TileFaces,
} from '../../core/stl';
import { downloadStl, rasterText } from '../../core/raster';
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

  /** How many tiles fit across the 3D print bed, for the on-screen note. */
  readonly tileColumns = computed(() => gridColumns(this.deck.count(), DEFAULT_TILE));

  /** Guards the button while a large deck's mesh is being built. */
  readonly building = signal(false);

  print(): void {
    window.print();
  }

  /**
   * Builds one STL of every card as an extruded tile — QR and its code raised
   * on top, the answer raised underneath — and downloads it. The work is
   * synchronous and can take a moment on a big deck, so the button is disabled
   * across a paint that lets "Building…" show first.
   */
  async download3d(): Promise<void> {
    if (this.building() || this.deck.count() === 0) return;
    this.building.set(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      const tiles: TileFaces[] = this.deck.cards().map((card) => ({
        qr: qrMatrix(`${this.auth.redirectUri}?t=${card.id}`),
        code: rasterText([card.id.toUpperCase()], { weight: 700 }),
        back: rasterText([card.artist, String(card.year), card.title]),
      }));

      const buffer = serializeBinaryStl(deckMesh(tiles, DEFAULT_TILE));
      const slug = (this.deckName() || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      downloadStl(buffer, `${slug}-3d-tiles.stl`);
    } finally {
      this.building.set(false);
    }
  }

  private decorate(card: Card): PrintCard {
    const target = `${this.auth.redirectUri}?t=${card.id}`;
    return { ...card, qr: this.sanitizer.bypassSecurityTrustHtml(qrSvg(target)) };
  }
}
