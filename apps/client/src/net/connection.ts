import {
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientMessage,
  type ServerMessage,
} from '@transportsim/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/** Resolve the server URL: ?server=host:port, VITE_SERVER_URL, or same origin /ws. */
export function serverUrl(): string {
  const param = new URLSearchParams(location.search).get('server');
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  const raw = param ?? env;
  if (raw) {
    if (/^wss?:\/\//.test(raw)) return raw;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${raw.replace(/\/$/, '')}/ws`;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** WebSocket with automatic reconnect and msgpack framing. */
export class Connection {
  status: ConnectionStatus = 'closed';
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private readonly url: string;
  private readonly hello: () => ClientMessage;
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (status: ConnectionStatus) => void = () => {};

  constructor(url: string, hello: () => ClientMessage) {
    this.url = url;
    this.hello = hello;
  }

  connect(): void {
    this.stopped = false;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      this.send(this.hello());
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return;
      try {
        this.onMessage(decodeFrame<ServerMessage>(ev.data as ArrayBuffer));
      } catch (e) {
        console.error('Bad server message', e);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('closed');
      if (!this.stopped) {
        const delay = Math.min(10_000, 500 * 2 ** this.retry++);
        setTimeout(() => !this.stopped && this.connect(), delay);
      }
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(msg));
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.onStatus(s);
  }
}

export { PROTOCOL_VERSION };
