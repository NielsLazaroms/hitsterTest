import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { DeckService } from '../../core/deck';
import { SpotifyAuth } from '../../core/spotify-auth';
import { qrSvg, qrMatrix } from '../../core/qr';
import {
  DEFAULT_TILE,
  deckMesh,
  plateColumns,
  plateRows,
  plateCapacity,
  splitPlates,
  serializeBinaryStl,
  type TileFaces,
} from '../../core/stl';
import { downloadStl, downloadZip, rasterText } from '../../core/raster';
import { zipStore } from '../../core/zip';
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

  /** Grid a single bed-sized file holds, e.g. "5 × 4". */
  readonly plateGrid = `${plateColumns(DEFAULT_TILE)} × ${plateRows(DEFAULT_TILE)}`;
  /** Most tiles in one file. */
  readonly plateCapacity = plateCapacity(DEFAULT_TILE);
  /** How many files the current deck will produce. */
  readonly fileCount = computed(() => Math.ceil(this.deck.count() / this.plateCapacity) || 0);

  /** Guards the button while a large deck's mesh is being built. */
  readonly building = signal(false);

  print(): void {
    window.print();
  }

  /**
   * Turns every card into an extruded tile — QR and its code raised on top, the
   * answer raised underneath — and downloads the deck split into bed-sized
   * plates, each a grid that fits a 250 × 210 mm bed. A single plate downloads
   * as one STL; several are bundled into one ZIP so the browser is not asked to
   * fire off a stack of downloads.
   *
   * Building is synchronous and can take a moment, so the button is disabled
   * across a paint that lets "Building…" show first.
   */
  async download3d(): Promise<void> {
    if (this.building() || this.deck.count() === 0) return;
    this.building.set(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      // Wrap the back text at the tile's usable width so a long title breaks
      // onto more lines rather than shrinking — every card ends up one size.
      const innerMm = DEFAULT_TILE.tileSize - 2 * DEFAULT_TILE.margin;
      const backWrapPx = Math.floor(innerMm / DEFAULT_TILE.backCell);

      const tiles: TileFaces[] = this.deck.cards().map((card) => ({
        qr: qrMatrix(`${this.auth.redirectUri}?t=${card.id}`),
        code: rasterText([card.id.toUpperCase()], { weight: 700 }),
        back: rasterText([card.artist, String(card.year), card.title], { maxWidth: backWrapPx }),
      }));

      const slug = (this.deckName() || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const plates = splitPlates(tiles, DEFAULT_TILE);

      if (plates.length === 1) {
        downloadStl(serializeBinaryStl(deckMesh(plates[0], DEFAULT_TILE)), `${slug}-3d-tiles.stl`);
        return;
      }

      const entries = plates.map((plate, i) => ({
        name: `${slug}-3d-tiles-${i + 1}of${plates.length}.stl`,
        data: new Uint8Array(serializeBinaryStl(deckMesh(plate, DEFAULT_TILE))),
      }));
      downloadZip(zipStore(entries), `${slug}-3d-tiles.zip`);
    } finally {
      this.building.set(false);
    }
  }

  private decorate(card: Card): PrintCard {
    const target = `${this.auth.redirectUri}?t=${card.id}`;
    return { ...card, qr: this.sanitizer.bypassSecurityTrustHtml(qrSvg(target)) };
  }
}
