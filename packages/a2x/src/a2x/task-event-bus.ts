/**
 * Layer 3: TaskEventBus - task-keyed fan-out for streaming events.
 *
 * `tasks/resubscribe` needs to attach additional consumers to an execution
 * that is already running under `message/stream`. The bus provides that
 * multiplexing: the primary stream publishes each event it yields; any
 * number of resubscribers call `subscribe()` to receive events from that
 * point forward.
 */

import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';

export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export interface TaskEventBus {
  /** Publish an event to all current subscribers for the given taskId. */
  publish(taskId: string, event: TaskEvent): void;

  /**
   * Close the channel for a task: every current and future subscriber
   * sees the generator end normally. Subsequent publish() calls for the
   * same taskId are no-ops.
   */
  close(taskId: string): void;

  /**
   * Open an async iterator over live events for a task. Events published
   * BEFORE the call to subscribe() are NOT replayed (resubscribe is
   * forward-only). The iterator ends when close(taskId) is called or
   * when the signal aborts.
   */
  subscribe(taskId: string, signal?: AbortSignal): AsyncGenerator<TaskEvent>;

  /** True if at least one subscriber is currently attached. */
  hasSubscribers(taskId: string): boolean;
}

// Per-subscriber state: pending queue + a resolver for the awaiting next().
// Unbounded queue is acceptable for the initial implementation; bounded
// backpressure is a follow-up (see Issue #39 discussion).
interface Subscriber {
  queue: TaskEvent[];
  waiter: ((value: IteratorResult<TaskEvent>) => void) | null;
  closed: boolean;
}

export class InMemoryTaskEventBus implements TaskEventBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  publish(taskId: string, event: TaskEvent): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    for (const sub of set) {
      if (sub.closed) continue;
      if (sub.waiter) {
        const resolve = sub.waiter;
        sub.waiter = null;
        resolve({ value: event, done: false });
      } else {
        sub.queue.push(event);
      }
    }
  }

  close(taskId: string): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    for (const sub of set) {
      sub.closed = true;
      if (sub.waiter) {
        const resolve = sub.waiter;
        sub.waiter = null;
        resolve({ value: undefined, done: true });
      }
    }
  }

  async *subscribe(
    taskId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskEvent> {
    const sub: Subscriber = { queue: [], waiter: null, closed: false };

    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set();
      this.subscribers.set(taskId, set);
    }
    set.add(sub);

    const abortListener = () => {
      sub.closed = true;
      if (sub.waiter) {
        const resolve = sub.waiter;
        sub.waiter = null;
        resolve({ value: undefined, done: true });
      }
    };
    if (signal) {
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    try {
      while (true) {
        // Drain buffered events first so late-joining subscribers that had
        // events pushed between subscribe() entry and the first yield still
        // deliver them in order.
        if (sub.queue.length > 0) {
          const next = sub.queue.shift()!;
          yield next;
          continue;
        }
        if (sub.closed) return;

        const nextResult = await new Promise<IteratorResult<TaskEvent>>(
          (resolve) => {
            sub.waiter = resolve;
          },
        );
        if (nextResult.done) return;
        yield nextResult.value;
      }
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abortListener);
      }
      const subs = this.subscribers.get(taskId);
      if (subs) {
        subs.delete(sub);
        if (subs.size === 0) {
          this.subscribers.delete(taskId);
        }
      }
    }
  }

  hasSubscribers(taskId: string): boolean {
    const set = this.subscribers.get(taskId);
    return set !== undefined && set.size > 0;
  }
}
