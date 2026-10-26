import { ChangeDetectionStrategy, Component, effect, signal } from '@angular/core';
import { clearLog, debugLines, debugOn, logText, setDebugEnabled } from './debug';

/**
 * The debug log, on the screen that produced it.
 *
 * Deliberately an overlay rather than part of the Play layout: it has to be
 * readable while a round is running without moving the transport or covering
 * the reticle, and it has to disappear completely when the flag is off.
 *
 * Starts collapsed to a single tap target. A log is only useful once it is out
 * of the phone, so copying is the primary action.
 */
@Component({
  selector: 'app-debug-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (debugOn()) {
      <div class="dbg" [class.open]="open()">
        <div class="dbghead">
          <button type="button" (click)="open.set(!open())">
            {{ open() ? '▾' : '▸' }} Logboek ({{ lines().length }})
          </button>
          @if (open()) {
            <button type="button" (click)="copy()">{{ copied() ? 'Gekopieerd' : 'Kopiëren' }}</button>
            <button type="button" (click)="wipe()">Wissen</button>
            <button type="button" (click)="off()">Uit</button>
          }
        </div>

        @if (open()) {
          <pre class="dbgbody">@for (line of lines(); track $index) {<span class="dbgline">{{ line.at }} {{ line.scope }} {{ line.event }} {{ line.detail }}</span>
}</pre>
        }
      </div>
    }
  `,
  styles: `
    .dbg {
      position: fixed;
      inset: auto 0 0 0;
      z-index: 50;
      font-family: ui-monospace, 'JetBrains Mono', monospace;
      font-size: 10px;
      line-height: 1.45;
      color: #d7faf4;
      background: rgba(10, 18, 20, 0.94);
      border-top: 1px solid rgba(120, 220, 210, 0.35);
      padding-bottom: env(safe-area-inset-bottom);
    }

    .dbghead {
      display: flex;
      gap: 4px;
      padding: 4px;
    }

    .dbghead button {
      flex: 0 0 auto;
      font: inherit;
      color: inherit;
      padding: 4px 8px;
      border: 1px solid rgba(120, 220, 210, 0.35);
      border-radius: 5px;
      background: transparent;
    }

    .dbghead button:first-child {
      flex: 1 1 auto;
      text-align: left;
    }

    /* Capped rather than sized to the content: the log grows all round and an
       overlay that creeps up the screen hides the thing being debugged. */
    .dbgbody {
      max-height: 38vh;
      overflow: auto;
      margin: 0;
      padding: 0 8px 8px;
      white-space: pre-wrap;
      word-break: break-word;
      -webkit-overflow-scrolling: touch;
    }

    .dbgline {
      display: block;
    }
  `,
})
export class DebugPanel {
  protected readonly debugOn = debugOn;
  protected readonly lines = debugLines;
  protected readonly open = signal(false);
  protected readonly copied = signal(false);

  constructor() {
    // The overlay is fixed to the bottom of the viewport, so it would sit on
    // top of whatever the screen puts there. Rather than knowing about any one
    // page's layout, it reserves its own height through a variable `.page`
    // already honours, and gives the space back the moment it is switched off.
    effect(() => {
      const pad = !debugOn() ? '0px' : this.open() ? 'calc(40px + 38vh)' : '40px';
      document.documentElement.style.setProperty('--debug-pad', pad);
    });
  }

  protected async copy(): Promise<void> {
    const text = logText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access is refused in plenty of mobile contexts, and a log
      // that cannot leave the phone is worthless. Fall back to a selection the
      // player can copy with the usual long-press.
      fallbackCopy(text);
    }
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  protected wipe(): void {
    clearLog();
  }

  protected off(): void {
    setDebugEnabled(false);
  }
}

function fallbackCopy(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    /* nothing left to try; the text stays selected for a manual copy */
  }
  document.body.removeChild(area);
}
