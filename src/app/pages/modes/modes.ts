import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Icon } from '../../core/icon';
import { Player, STEP_LENGTHS, type GameMode } from '../../core/player';

/**
 * The shelf: pick which tape goes into the deck. Each game mode is a cassette;
 * tapping one opens the deck for that mode at /play/<mode>.
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
  protected readonly player = inject(Player);

  /** What the Hitsnip deck reads at the start of a card. */
  readonly firstStep = `${STEP_LENGTHS[0].toLocaleString('nl-NL')}s`;

  /** The classic tape's counter shows the fragment length it will play to. */
  readonly counter = computed(() => {
    const s = this.player.clipLength();
    if (!s) return '∞';
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  pick(mode: GameMode): void {
    void this.router.navigate(['/play', mode]);
  }
}
