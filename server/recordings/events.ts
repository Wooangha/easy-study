// Server-Sent Events of one recording (DESIGN §22, GET …/recordings/:rid/events) and of a document's annotations
// (DESIGN §25, GET …/annotations/events): `event: <type>` + JSON data (RecordingEvent / AnnotationEvent),
// `id: <segment id>` on segment events so EventSource reconnects with Last-Event-ID. A real `event: ping` every
// 10 s (EventSource hides `:` comments from JavaScript, so clients could not notice a half-open stream without it;
// the live spike saw stalls of up to 182 s).
import type { RecordingEvent } from '../../shared/types.ts';

export const RECORDING_PING_MS = 10_000;

/** What the hub needs of an HTTP response. */
export interface SseTarget {
  write(chunk: string): boolean;
  end(): void;
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
}

export function sseFrame<E extends { type: string }>(event: E, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

interface Subscriber {
  timer: NodeJS.Timeout;
  /** The subscriber's client id (annotations: its own writes are not echoed back to it), if it gave one. */
  client?: string;
}

export class EventHub<E extends { type: string } = RecordingEvent> {
  private readonly subscribers = new Map<SseTarget, Subscriber>();
  private readonly pingMs: number;
  /** closeAll() was called: later subscribers are ended right away (the recording is gone or the server stops). */
  private closed = false;

  constructor(pingMs: number = RECORDING_PING_MS) {
    this.pingMs = pingMs;
  }

  get size(): number {
    return this.subscribers.size;
  }

  add(target: SseTarget, client?: string): void {
    if (this.closed) {
      if (!target.writableEnded && !target.destroyed) target.end();
      return;
    }
    const timer = setInterval(() => this.writeTo(target, sseFrame({ type: 'ping' })), this.pingMs);
    timer.unref?.();
    this.subscribers.set(target, client ? { timer, client } : { timer });
  }

  remove(target: SseTarget): void {
    const subscriber = this.subscribers.get(target);
    if (subscriber) clearInterval(subscriber.timer);
    this.subscribers.delete(target);
  }

  private writeTo(target: SseTarget, frame: string): void {
    if (target.writableEnded || target.destroyed) {
      this.remove(target);
      return;
    }
    target.write(frame);
  }

  /** Sends to every subscriber, except the ones whose client id is `skipClient` (the writer of the change). */
  send(event: E, id?: number, skipClient?: string): void {
    const frame = sseFrame(event, id);
    for (const [target, subscriber] of [...this.subscribers]) {
      if (skipClient !== undefined && subscriber.client === skipClient) continue;
      this.writeTo(target, frame);
    }
  }

  /** Ends every stream (the recording was deleted, or the server stops). */
  closeAll(): void {
    this.closed = true;
    for (const target of [...this.subscribers.keys()]) {
      this.remove(target);
      if (!target.writableEnded && !target.destroyed) target.end();
    }
  }
}
