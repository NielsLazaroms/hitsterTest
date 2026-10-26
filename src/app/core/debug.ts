import { signal, type Signal } from '@angular/core';
import { read, write } from './storage';

/**
 * A log the phone can read back, because the phone is where these bugs live.
 *
 * Playback faults only reproduce on a handset talking to a Connect device, and
 * that is exactly where there is no console to open. So every line goes into a
 * ring buffer the Play screen can show and copy, and is mirrored to
 * console.debug for the rarer session that does have an inspector attached.
 *
 * Off by default, switched with `?debug=1`, and remembered from then on: the
 * flag has to outlive the redirects Launch and Play make to strip their own
 * query parameters, so a check that only reads the current URL would miss it.
 */

/** Lines kept before the oldest is dropped: enough for a scan and a round. */
const LIMIT = 300;

export interface LogLine {
  /** Milliseconds since the page loaded, so orderings read at a glance. */
  at: number;
  scope: string;
  event: string;
  detail: string;
}

/**
 * Held as a plain boolean as well as a signal, so a caller can skip building
 * expensive arguments: `log` discards them when the flag is off, but it cannot
 * stop them being computed, so anything costly is guarded with
 * `isDebugEnabled()` at the call site.
 */
let enabled = read<boolean>('debug', false);
let counter = 0;

const lines = signal<LogLine[]>([]);

/** The buffer, for the on-screen panel. */
export const debugLines: Signal<readonly LogLine[]> = lines.asReadonly();

/** Mirrors `enabled` so templates can react to the switch. */
export const debugOn = signal(enabled);

/**
 * A number that ties a request's "sent" line to its "done" line. Without it
 * two commands in flight at once are impossible to tell apart, which is the
 * whole point of the log: a pause that overtakes a play looks perfectly
 * ordinary until the pairs are matched up.
 */
export function nextSeq(): number {
  return ++counter;
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function setDebugEnabled(on: boolean): void {
  enabled = on;
  debugOn.set(on);
  write('debug', on);
}

/** Reads `?debug=1` (or `0`) once at boot and remembers the answer. */
export function initDebug(search: string = location.search): void {
  const flag = new URLSearchParams(search).get('debug');
  if (flag === null) return;
  setDebugEnabled(flag !== '0' && flag !== 'false');
}

/**
 * Records one event. `detail` is flattened to `key=value` pairs rather than
 * JSON so a copied log stays readable in a chat message.
 */
export function log(scope: string, event: string, detail: Record<string, unknown> = {}): void {
  if (!enabled) return;

  const line: LogLine = {
    at: Math.round(performance.now()),
    scope,
    event,
    detail: format(detail),
  };

  lines.update((all) => (all.length < LIMIT ? [...all, line] : [...all.slice(1), line]));
  console.debug(`[${line.at}] ${scope} ${event}`, detail);
}

export function clearLog(): void {
  lines.set([]);
}

/** The buffer as one block of text, for the copy button. */
export function logText(): string {
  return lines()
    .map((line) => `${String(line.at).padStart(7)} ${line.scope} ${line.event} ${line.detail}`.trimEnd())
    .join('\n');
}

function format(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${render(value)}`)
    .join(' ');
}

function render(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '-';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'string') return value === '' ? "''" : value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
