import { Packr } from 'msgpackr';
import type { ClientMessage, ServerMessage } from './messages.ts';

// Typed arrays are encoded natively by msgpackr; records are off so any client can decode.
const packr = new Packr({ useRecords: false, moreTypes: true });

export function encode(msg: ClientMessage | ServerMessage | object): Uint8Array {
  return packr.pack(msg);
}

export function decode<T = ClientMessage | ServerMessage>(data: Uint8Array | ArrayBuffer): T {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return packr.unpack(bytes) as T;
}
