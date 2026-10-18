import { deflateSync, inflateSync } from 'fflate';
import { Packr } from 'msgpackr';
import type { ClientMessage, ServerMessage } from './messages.ts';

// Typed arrays are encoded natively by msgpackr; records are off so any client can decode.
const packr = new Packr({ useRecords: false, moreTypes: true });

/** Plain msgpack (used for snapshots and inside frames). */
export function encode(msg: ClientMessage | ServerMessage | object): Uint8Array {
  return packr.pack(msg);
}

export function decode<T = ClientMessage | ServerMessage>(data: Uint8Array | ArrayBuffer): T {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return packr.unpack(bytes) as T;
}

/**
 * Wire frames: 1 flag byte + payload. Flag 0 = msgpack, 1 = raw-deflated msgpack.
 * We compress at the application level instead of WebSocket permessage-deflate, which
 * (in Bun) drops large inbound messages and can't be tuned per message.
 */
const FRAME_PLAIN = 0;
const FRAME_DEFLATE = 1;
const COMPRESS_THRESHOLD = 2048;

export function encodeFrame(msg: ClientMessage | ServerMessage): Uint8Array {
  const body = packr.pack(msg);
  const deflated = body.length >= COMPRESS_THRESHOLD ? deflateSync(body, { level: 4 }) : null;
  const useDeflate = deflated !== null && deflated.length < body.length;
  const payload = useDeflate ? deflated : body;
  const out = new Uint8Array(payload.length + 1);
  out[0] = useDeflate ? FRAME_DEFLATE : FRAME_PLAIN;
  out.set(payload, 1);
  return out;
}

export function decodeFrame<T = ClientMessage | ServerMessage>(data: Uint8Array | ArrayBuffer): T {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 2) throw new Error('Empty frame');
  const payload = bytes.subarray(1);
  switch (bytes[0]) {
    case FRAME_PLAIN:
      return packr.unpack(payload) as T;
    case FRAME_DEFLATE:
      return packr.unpack(inflateSync(payload)) as T;
    default:
      throw new Error('Unknown frame type');
  }
}
