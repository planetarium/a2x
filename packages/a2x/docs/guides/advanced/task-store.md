# Custom Task Stores

The **task store** is where A2X persists the state of every in-flight and recently-completed A2A task. Clients call `tasks/get` to poll long-running work and `tasks/cancel` to abort it; both read/write through the task store.

## The default: `InMemoryTaskStore`

```ts
import { InMemoryTaskStore } from '@a2x/sdk';

const taskStore = new InMemoryTaskStore();
```

Characteristics:

- All state lives in the process's memory.
- Lost on restart. Not shared across replicas.
- Has a TTL and max-size cap so it doesn't leak (default values are sane; tune via constructor options).

Good for: local development, stateless serverless functions where each invocation owns its own tasks, demos.

Not good for: multi-replica deployments where one worker might submit a task and another reply to `tasks/get` for the same `id`.

## When you need to swap it

- You deploy multiple agent replicas behind a load balancer.
- Tasks can outlive the process (long-running pipelines).
- You want to inspect tasks from an admin tool (Postgres/Redis are easier to query than process memory).

## Implementing a custom store

`TaskStore` is a narrow interface. The methods you implement:

```ts
interface TaskStore {
  save(task: Task): Promise<void>;
  get(id: string): Promise<Task | null>;
  delete(id: string): Promise<void>;
}
```

A Redis-backed version in its entirety:

```ts
import type { Task, TaskStore } from '@a2x/sdk';
import { Redis } from 'ioredis';

const KEY = (id: string) => `a2x:task:${id}`;

export class RedisTaskStore implements TaskStore {
  constructor(private redis: Redis, private ttlSeconds = 3600) {}

  async save(task: Task): Promise<void> {
    await this.redis.set(KEY(task.id), JSON.stringify(task), 'EX', this.ttlSeconds);
  }

  async get(id: string): Promise<Task | null> {
    const raw = await this.redis.get(KEY(id));
    return raw ? (JSON.parse(raw) as Task) : null;
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(KEY(id));
  }
}
```

Wire it in:

```ts
const taskStore = new RedisTaskStore(new Redis(process.env.REDIS_URL!));
const a2xAgent = new A2XAgent({ taskStore, executor });
```

## Choosing a TTL

Tasks should live long enough for a reasonable client to:

- Poll `tasks/get` after a unary call (seconds to minutes).
- Cancel a streaming task that went rogue (seconds to minutes).
- Retrieve the result of a long-running job (hours).

For most deployments, 1 hour is fine. Lengthen it for human-in-the-loop workflows.

## Pitfalls

- **Don't share a single Redis key prefix across agents** if they have overlapping task-id spaces. Namespace per agent (`a2x:support:task:*` vs `a2x:billing:task:*`).
- **Serialize carefully.** `Task` objects contain nested message parts and artifacts. `JSON.stringify` works but be aware that binary file parts (as base64 strings) can grow large; consider offloading to object storage and storing just a URI.
- **Monitor cardinality.** A task store that grows unboundedly is a memory/disk leak waiting to happen. Always use a TTL or periodic cleanup.
