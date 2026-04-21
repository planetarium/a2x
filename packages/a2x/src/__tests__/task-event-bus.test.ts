import { describe, it, expect } from 'vitest';
import { InMemoryTaskEventBus } from '../a2x/task-event-bus.js';
import type { TaskEvent } from '../a2x/task-event-bus.js';
import { TaskState } from '../types/task.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';

function statusEvent(
  taskId: string,
  state: TaskState = TaskState.WORKING,
): TaskStatusUpdateEvent {
  return {
    taskId,
    contextId: `ctx-${taskId}`,
    status: { state, timestamp: new Date().toISOString() },
  };
}

function artifactEvent(taskId: string, text: string): TaskArtifactUpdateEvent {
  return {
    taskId,
    contextId: `ctx-${taskId}`,
    artifact: {
      artifactId: `artifact-${taskId}`,
      parts: [{ text }],
    },
    append: true,
    lastChunk: false,
  };
}

describe('InMemoryTaskEventBus', () => {
  it('drops events published before subscribe (no history)', async () => {
    const bus = new InMemoryTaskEventBus();
    bus.publish('t1', statusEvent('t1'));
    bus.publish('t1', artifactEvent('t1', 'chunk'));

    const received: TaskEvent[] = [];
    const iter = bus.subscribe('t1');

    // Schedule close so the iterator completes.
    queueMicrotask(() => bus.close('t1'));

    for await (const event of iter) {
      received.push(event);
    }

    expect(received).toEqual([]);
  });

  it('delivers events to all subscribers after subscribe', async () => {
    const bus = new InMemoryTaskEventBus();

    const received1: TaskEvent[] = [];
    const received2: TaskEvent[] = [];

    const iter1 = bus.subscribe('t1');
    const iter2 = bus.subscribe('t1');

    const consume1 = (async () => {
      for await (const event of iter1) received1.push(event);
    })();
    const consume2 = (async () => {
      for await (const event of iter2) received2.push(event);
    })();

    // Yield to let both subscribers attach to the set.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const e1 = statusEvent('t1');
    const e2 = artifactEvent('t1', 'chunk');
    bus.publish('t1', e1);
    bus.publish('t1', e2);
    bus.close('t1');

    await Promise.all([consume1, consume2]);

    expect(received1).toEqual([e1, e2]);
    expect(received2).toEqual([e1, e2]);
  });

  it('close() ends all subscribers generators', async () => {
    const bus = new InMemoryTaskEventBus();

    const iter = bus.subscribe('t1');

    queueMicrotask(() => bus.close('t1'));

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('hasSubscribers() reflects live state', async () => {
    const bus = new InMemoryTaskEventBus();

    expect(bus.hasSubscribers('t1')).toBe(false);

    const iter1 = bus.subscribe('t1');
    const iter2 = bus.subscribe('t1');

    // Prime both generators so they register in the subscriber set.
    const p1 = iter1.next();
    const p2 = iter2.next();

    expect(bus.hasSubscribers('t1')).toBe(true);

    bus.close('t1');
    await p1;
    await p2;

    // Exhaust to drain the finally block that removes each subscriber.
    await iter1.next();
    await iter2.next();

    expect(bus.hasSubscribers('t1')).toBe(false);
  });

  it('abort signal ends subscribe() generator', async () => {
    const bus = new InMemoryTaskEventBus();
    const controller = new AbortController();

    const iter = bus.subscribe('t1', controller.signal);

    queueMicrotask(() => controller.abort());

    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});
