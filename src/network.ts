/**
 * A deliberately unreliable "network" for the browser demo: every message
 * gets a random delay, so messages routinely arrive out of order. This is
 * what actually exercises the CRDT's out-of-order handling - on a real
 * network you wouldn't get to choose the delivery order either.
 */
export interface SimulatedNetworkOptions {
  minDelayMs: number;
  maxDelayMs: number;
}

export class SimulatedNetwork<T> {
  private options: SimulatedNetworkOptions;
  private onDeliver: (msg: T, fromSite: number, toSite: number) => void;

  constructor(
    options: SimulatedNetworkOptions,
    onDeliver: (msg: T, fromSite: number, toSite: number) => void
  ) {
    this.options = options;
    this.onDeliver = onDeliver;
  }

  /** Send `msg` from `fromSite` to `toSite` after a random delay. */
  send(msg: T, fromSite: number, toSite: number): void {
    const { minDelayMs, maxDelayMs } = this.options;
    const delay = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
    setTimeout(() => this.onDeliver(msg, fromSite, toSite), delay);
  }
}
