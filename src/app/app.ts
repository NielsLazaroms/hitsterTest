import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Theme } from './core/theme';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  constructor() {
    // Resolve the theme service on boot so the saved preference is applied and
    // kept in sync from the start, not only once Settings is opened. Nothing
    // needs to hold the reference — it is a root singleton with a live effect.
    inject(Theme);
  }
}
