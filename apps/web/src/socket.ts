import type { ClientEvent, ServerEvent } from '@relay/shared';

export type SocketStatus = 'connecting' | 'online' | 'offline';

/**
 * `resync` is not sent by the server. The socket emits it locally after a
 * RE-connection, to tell the UI "you may have missed events while offline,
 * refetch what you are showing". Real-time delivery is best effort; history
 * over REST is the source of truth.
 */
export type SocketEvent = ServerEvent | { type: 'resync' };

type Listener = (event: SocketEvent) => void;
type StatusListener = (status: SocketStatus) => void;

const PING_INTERVAL_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;

/** A WebSocket that authenticates itself and reconnects automatically. */
export class RealtimeSocket {
  private ws: WebSocket | null = null;
  private token = '';
  private stopped = true;
  private attempts = 0;
  private hasBeenReady = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<StatusListener>();

  start(token: string): void {
    this.token = token;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  send(event: ClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  private setStatus(status: SocketStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  private emit(event: SocketEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token } satisfies ClientEvent));
    };

    ws.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      if (event.type === 'ready') {
        this.attempts = 0;
        this.setStatus('online');
        if (this.hasBeenReady) this.emit({ type: 'resync' });
        this.hasBeenReady = true;
      }
      this.emit(event);
    };

    ws.onclose = (close) => {
      // Ignore the close of a socket we have already replaced or deliberately stopped.
      if (this.ws !== ws || this.stopped) return;
      this.setStatus('offline');
      // 4401 = the gateway rejected our token. Retrying with the same token cannot succeed.
      if (close.code === 4401) return;
      this.scheduleReconnect();
    };

    if (this.pingTimer) clearInterval(this.pingTimer);
    // Application-level ping: keeps idle connections from being closed by proxies.
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
  }

  /**
   * Exponential backoff with jitter. When a gateway restarts, thousands of
   * clients lose their connection in the same instant; if they all retried
   * immediately and on the same schedule they would knock the replacement
   * over (a "thundering herd"). The random factor spreads them out.
   */
  private scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
