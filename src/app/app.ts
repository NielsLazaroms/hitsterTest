import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { initDebug } from './core/debug';
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
    // Read ?debug=1 before the router runs: Launch and Play both strip their
    // own query parameters, so a check made any later never sees the flag.
    initDebug();

    // Resolve the theme service on boot so the saved preference is applied and
    // kept in sync from the start, not only once Settings is opened. Nothing
    // needs to hold the reference; it is a root singleton with a live effect.
    inject(Theme);
  }
}
