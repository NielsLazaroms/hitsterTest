import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideX } from '@lucide/angular';
import { DeckService } from '../../core/deck';
import { Diagnostics } from '../../core/diagnostics';
import type { Card, DraftCard } from '../../core/models';

@Component({
  selector: 'app-deck-builder',
  imports: [FormsModule, RouterLink, LucideCheck, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './deck-builder.html',
  styleUrl: './deck-builder.css',
})
export class DeckBuilder {
  protected readonly deck = inject(DeckService);
  private readonly diagnostics = inject(Diagnostics);

  readonly playlistUrl = signal('');
  readonly drafts = signal<DraftCard[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly report = signal('');
  readonly diagnosing = signal(false);
  /** True once the deck is saved, so we show the "what next" step in place. */
  readonly saved = signal(false);

  readonly suspectCount = computed(() => this.drafts().filter((d) => d.suspect).length);
  readonly ready = computed(() => this.drafts().filter((d) => d.year !== null).length);

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');

    try {
      const drafts = await this.deck.fromPlaylist(this.playlistUrl());
      if (drafts.length === 0) {
        this.error.set('No playable tracks found in that playlist.');
        return;
      }
      this.drafts.set(drafts);
      this.notice.set(`${drafts.length} tracks loaded. ${this.suspectCount()} need a second look.`);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not read that playlist.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Asks Spotify the same questions one at a time, to place the blame. */
  async diagnose(): Promise<void> {
    this.diagnosing.set(true);
    this.report.set('');
    try {
      this.report.set(await this.diagnostics.run(this.playlistUrl()));
    } catch (error) {
      this.report.set(error instanceof Error ? error.message : 'The check itself failed.');
    } finally {
      this.diagnosing.set(false);
    }
  }

  updateYear(id: string, raw: string): void {
    const year = Number.parseInt(raw, 10);
    this.drafts.update((list) =>
      list.map((draft) =>
        draft.id === id ? { ...draft, year: Number.isFinite(year) ? year : null } : draft,
      ),
    );
  }

  remove(id: string): void {
    this.drafts.update((list) => list.filter((draft) => draft.id !== id));
  }

  save(): void {
    const cards: Card[] = this.drafts()
      .filter((draft): draft is DraftCard & { year: number } => draft.year !== null)
      .map(({ id, uri, title, artist, year }) => ({ id, uri, title, artist, year }));

    this.deck.save(cards);
    // Stay put and offer the next step rather than forcing a share. Making a
    // shared copy uploads the deck to the server, so it should be a choice, not
    // a side effect of saving.
    this.saved.set(true);
  }

  /** Back to the table from the saved step, to tweak a year or drop a card. */
  edit(): void {
    this.saved.set(false);
  }
}
