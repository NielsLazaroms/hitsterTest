import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Icon } from '../../core/icon';
import { STEP_LENGTHS, type GameMode } from '../../core/player';

/**
 * The shelf: pick which mode goes into the deck. Tapping a card opens the deck
 * for that mode at /play/<mode>.
 */
@Component({
  selector: 'app-modes',
  imports: [RouterLink, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './modes.html',
  styleUrl: './modes.css',
})
export class Modes {
  private readonly router = inject(Router);

  /** The round ladder, drawn as a staircase on the Hitsnip card. */
  readonly steps = STEP_LENGTHS;

  pick(mode: GameMode): void {
    void this.router.navigate(['/play', mode]);
  }
}
