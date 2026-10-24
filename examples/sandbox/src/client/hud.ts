import type { ClientState, FrameContext } from '@conduit/game/client';
import type { DisconnectInfo } from '@conduit/net-client';
import { type RegionId, stringCompare } from '@conduit/world';
import type { SandboxInput } from '../shared/input.ts';

/** The HUD's DOM ids (PLAN.md "Sandbox content spec"; `#hud-bytes` and `#hud-joins` from M4). */
export const HUD_IDS = {
  tick: 'hud-tick',
  rtt: 'hud-rtt',
  entities: 'hud-entities',
  regions: 'hud-regions',
  bytes: 'hud-bytes',
  joins: 'hud-joins',
  state: 'hud-state',
  flash: 'hud-flash',
} as const;

/** How long `#hud-flash` stays lit after a horn, in ms. */
export const FLASH_MS = 800;

/** `#hud-bytes` is refreshed at most this often, in seconds of frame time. */
export const BYTES_REFRESH_S = 0.25;

/** Frame bytes per second each way, as `NetClient.stats()` reports them (docs/net.md B.3). */
export interface ByteRates {
  bytesInPerSec: number;
  bytesOutPerSec: number;
}

/** Where `#hud-bytes` reads its rates: the client's `NetClient`. */
export interface ByteRateSource {
  stats(): ByteRates;
}

/** `in 6.6 KB/s, out 3.7 KB/s` (1 KB = 1000 bytes). */
export function formatByteRates(rates: ByteRates): string {
  const kb = (bytes: number) => (bytes / 1000).toFixed(1);
  return `in ${kb(rates.bytesInPerSec)} KB/s, out ${kb(rates.bytesOutPerSec)} KB/s`;
}

function required(doc: Document, id: string): HTMLElement {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`sandbox HUD: #${id} is missing from index.html`);
  return el;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** `FrameContext.regions`: what `RegionClient` holds and the last `RegionSet`. */
export type FrameRegions = FrameContext<SandboxInput>['regions'];

/** The regions of `FrameRegions` by what the HUD shows them as, each sorted. */
export interface RegionSummary {
  /** Loaded and in the last RegionSet (active or prefetch). */
  loaded: RegionId[];
  /** Still loading their asset group and in the last RegionSet. */
  loading: RegionId[];
  /** Held but no longer in the RegionSet: released after `REGION_RELEASE_GRACE_MS` (docs/net.md B.8). */
  releasing: RegionId[];
}

/** Splits the held regions by whether the last RegionSet still lists them (`#hud-regions`). */
export function summarizeRegions(regions: FrameRegions): RegionSummary {
  const listed = new Set([...regions.wanted, ...regions.prefetch]);
  const releasing = [...regions.loaded, ...regions.loading].filter((id) => !listed.has(id));
  return {
    loaded: regions.loaded.filter((id) => listed.has(id)),
    loading: regions.loading.filter((id) => listed.has(id)),
    releasing: releasing.sort(stringCompare),
  };
}

/**
 * Text fields over the canvas: render tick, RTT, visible replica entities, regions, bytes per second
 * each way, the session's join counter and the connection state. `#hud-regions` counts the loaded,
 * loading and releasing regions on its first line and lists their ids below (`data-loaded`,
 * `data-loading`, `data-releasing` and `data-wanted` carry the counts). `#hud-bytes` shows
 * `NetClient.stats()`'s rolling rates every `BYTES_REFRESH_S` (`data-in` and `data-out` in bytes per
 * second). `#hud-state` is the `GameClient` state (`reconnecting` while a lost connection is retried);
 * a rejection (e.g. `Rejected: SchemaMismatch — please refresh`) stays there: later state changes do
 * not overwrite it. `#hud-flash` lights up for `FLASH_MS` on every horn.
 */
export class Hud {
  private readonly tick: HTMLElement;
  private readonly rtt: HTMLElement;
  private readonly entities: HTMLElement;
  private readonly regions: HTMLElement;
  private readonly bytes: HTMLElement;
  private readonly joins: HTMLElement;
  private readonly state: HTMLElement;
  private readonly flashEl: HTMLElement;
  private final = false;
  private shownRegions: FrameRegions | null = null;
  /** Frame time since `#hud-bytes` was refreshed; `null` before its first refresh. */
  private sinceBytes: number | null = null;
  private flashes = 0;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(doc: Document) {
    this.tick = required(doc, HUD_IDS.tick);
    this.rtt = required(doc, HUD_IDS.rtt);
    this.entities = required(doc, HUD_IDS.entities);
    this.regions = required(doc, HUD_IDS.regions);
    this.bytes = required(doc, HUD_IDS.bytes);
    this.joins = required(doc, HUD_IDS.joins);
    this.state = required(doc, HUD_IDS.state);
    this.flashEl = required(doc, HUD_IDS.flash);
  }

  /** `CreateClientOpts.onFrame`; `net` (the client's `NetClient`) feeds `#hud-bytes`. */
  update(frame: FrameContext<SandboxInput>, net?: ByteRateSource): void {
    setText(this.tick, String(Math.max(0, Math.floor(frame.renderTick))));
    setText(this.rtt, `${frame.clock.rttMs.toFixed(1)} ms`);
    let visible = 0;
    for (const _ of frame.replica.visibleAt(frame.renderTick)) visible++;
    setText(this.entities, String(visible));
    this.showRegions(frame.regions);
    if (net !== undefined) this.showBytes(frame.dt, net);
  }

  setState(state: ClientState): void {
    if (!this.final) setText(this.state, state);
  }

  /**
   * `GameClient`'s `disconnected`: a loss the client retries leaves `reconnecting` (set by the state
   * change just before) in place; a final close shows `closed (<code> <reason>)`.
   */
  setDisconnected(info: DisconnectInfo): void {
    if (this.final || info.willReconnect) return;
    setText(
      this.state,
      info.reason === '' ? `closed (${info.code})` : `closed (${info.code} ${info.reason})`,
    );
  }

  /** The session's join counter from the server's `Joins` message. */
  setJoins(total: number): void {
    setText(this.joins, String(total));
    this.joins.dataset['total'] = String(total);
  }

  /** A message that ends the connection for good: a rejection or a failed connect. */
  setFinal(text: string): void {
    this.final = true;
    setText(this.state, text);
  }

  private showBytes(dt: number, net: ByteRateSource): void {
    if (this.sinceBytes !== null && this.sinceBytes + dt < BYTES_REFRESH_S) {
      this.sinceBytes += dt;
      return;
    }
    this.sinceBytes = 0;
    const rates = net.stats();
    setText(this.bytes, formatByteRates(rates));
    const data = this.bytes.dataset;
    data['in'] = String(Math.round(rates.bytesInPerSec));
    data['out'] = String(Math.round(rates.bytesOutPerSec));
  }

  /** `FrameContext.regions` is rebuilt only when it changes, so an unchanged object is skipped. */
  private showRegions(regions: FrameRegions): void {
    if (regions === this.shownRegions) return;
    this.shownRegions = regions;
    const { loaded, loading, releasing } = summarizeRegions(regions);
    const counts = [`${loaded.length} loaded`, `${loading.length} loading`];
    if (releasing.length > 0) counts.push(`${releasing.length} releasing`);
    const lines = [counts.join(', ')];
    for (const [label, ids] of [
      ['loaded', loaded],
      ['loading', loading],
      ['releasing', releasing],
    ] as const) {
      if (ids.length > 0) lines.push(`${label}: ${ids.join(' ')}`);
    }
    setText(this.regions, lines.join('\n'));
    const data = this.regions.dataset;
    data['loaded'] = String(loaded.length);
    data['loading'] = String(loading.length);
    data['releasing'] = String(releasing.length);
    data['wanted'] = String(regions.wanted.length);
  }

  /**
   * Lights `#hud-flash` with `text` (class `on`) for `FLASH_MS`. `data-count` counts flashes,
   * `data-event-tick` is the event's server tick and `data-render-tick` the render tick it was shown
   * at, so a test can check it appeared when the render clock reached the event.
   */
  flash(text: string, eventTick: number, renderTick: number): void {
    const el = this.flashEl;
    this.flashes += 1;
    el.textContent = text;
    el.dataset['count'] = String(this.flashes);
    el.dataset['eventTick'] = String(eventTick);
    el.dataset['renderTick'] = renderTick.toFixed(2);
    el.classList.add('on');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => el.classList.remove('on'), FLASH_MS);
  }
}
