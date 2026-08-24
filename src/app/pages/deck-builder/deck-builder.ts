import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DeckService } from '../../core/deck';
import { Diagnostics } from '../../core/diagnostics';
import type { Card, DraftCard } from '../../core/models';

@Component({
  selector: 'app-deck-builder',
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './deck-builder.html',
  styleUrl: './deck-builder.css',
})
export class DeckBuilder {
  private readonly deck = inject(DeckService);
  private readonly diagnostics = inject(Diagnostics);
  private readonly router = inject(Router);

  readonly playlistUrl = signal('');
  readonly drafts = signal<DraftCard[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly report = signal('');
  readonly diagnosing = signal(false);

  readonly suspectCount = computed(() => this.drafts().filter((d) => d.suspect).length);
  readonly ready = computed(() => this.drafts().filter((d) => d.year !== null).length);

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');

    try {
      const drafts = await this.deck.fromPlaylist(this.playlistUrl());
      if (drafts.length === 0) throw new Error('No playable tracks found in that playlist.');
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
    void this.router.navigate(['/settings']);
  }
}
