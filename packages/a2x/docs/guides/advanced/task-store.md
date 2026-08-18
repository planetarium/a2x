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
- Supports a TTL and a max-size cap so it doesn't leak. **Both default to unlimited** — pass `ttlMs` / `maxSize` to the constructor to bound it.

Good for: local development, stateless serverless functions where each invocation owns its own tasks, demos.

Not good for: multi-replica deployments where one worker might submit a task and another reply to `tasks/get` for the same `id`.

## When you need to swap it

- You deploy multiple agent replicas behind a load balancer.
- Tasks can outlive the process (long-running pipelines).
- You want to inspect tasks from an admin tool (Postgres/Redis are easier to query than process memory).

## Implementing a custom store

`TaskStore` is a narrow interface. The methods you implement:

```ts
interface CreateTaskParams {
  contextId?: string;
  metadata?: Record<string, unknown>;
}

interface TaskUpdate {
  status?: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

interface TaskStore {
  createTask(params: CreateTaskParams): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, update: TaskUpdate): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
}
```

Contract notes:

- `createTask()` mints the task id and `contextId` (fall back to a fresh UUID when the caller didn't supply one) and starts the task in `submitted`.
- `updateTask()` applies only the fields present on the update — an absent field means "leave as is", not "clear". `metadata` merges; `artifacts` and `history` replace.
- `updateTask()` should reject a status change on a task that is already terminal (`completed` / `failed` / `canceled` / `rejected`). `InMemoryTaskStore` throws.

A Redis-backed version in its entirety:

```ts
import type { Task, TaskStore, CreateTaskParams, TaskUpdate } from '@a2x/sdk';
import { TaskState, TERMINAL_STATES } from '@a2x/sdk';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

const KEY = (id: string) => `a2x:task:${id}`;

export class RedisTaskStore implements TaskStore {
  constructor(private redis: Redis, private ttlSeconds = 3600) {}

  async createTask(params: CreateTaskParams): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      contextId: params.contextId ?? randomUUID(),
      status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    await this._write(task);
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const raw = await this.redis.get(KEY(id));
    return raw ? (JSON.parse(raw) as Task) : null;
  }

  async updateTask(id: string, update: TaskUpdate): Promise<Task> {
    const current = await this.getTask(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    if (update.status && TERMINAL_STATES.has(current.status.state)) {
      throw new Error(`Cannot update task in terminal state: ${id}`);
    }

    const next: Task = {
      ...current,
      ...(update.status ? { status: update.status } : {}),
      ...(update.artifacts ? { artifacts: update.artifacts } : {}),
      ...(update.history ? { history: update.history } : {}),
      ...(update.metadata
        ? { metadata: { ...current.metadata, ...update.metadata } }
        : {}),
    };
    await this._write(next);
    return next;
  }

  async deleteTask(id: string): Promise<void> {
    await this.redis.del(KEY(id));
  }

  private async _write(task: Task): Promise<void> {
    await this.redis.set(KEY(task.id), JSON.stringify(task), 'EX', this.ttlSeconds);
  }
}
```

Wire it in:

```ts
const taskStore = new RedisTaskStore(new Redis(process.env.REDIS_URL!));
const a2xServer = new A2XServer({ taskStore, executor });
```

## Tasks handed out are snapshots

Every `Task` a store returns is a **snapshot**. Mutating it changes nothing on the store side — a serializing store parsed it out of JSON, and `InMemoryTaskStore` deliberately returns defensive copies so that in-memory development behaves the same way as production.

Two consequences:

- **Custom stores must not return their live record.** Return a copy (`structuredClone`, or the value you just deserialized). `cloneTask(task)` is exported for this.
- **Custom handlers or executors must write every transition back** with `updateTask()`. Setting `task.status = ...` on a task you were handed persists nothing.

The SDK's `DefaultRequestHandler` does exactly that: it writes the `working` transition, the result of `message/send`, each `message/stream` status transition (with the artifacts accumulated so far), and `tasks/cancel` through `updateTask()`, so the response a caller receives always matches a subsequent `tasks/get`.

Two details worth knowing when you write a store:

- **The terminal write carries the final artifact set.** The handler does not patch artifacts onto a task after it terminated, so a store that rejects *every* update to a terminal task (stricter than `InMemoryTaskStore`, which only rejects status changes) stays correct.
- **Artifacts survive across turns.** `updateTask` replaces the artifact list, but a continuation turn (`input-required` → resume) starts the agent's list from scratch, so the handler folds the new artifacts onto the ones the task already carried. Same `artifactId` supersedes.

If you fold streamed artifact chunks yourself, `applyArtifactUpdate(artifacts, event)` implements the spec's `append` semantics (append to the artifact with the same `artifactId`, otherwise replace):

```ts
import { applyArtifactUpdate, type Artifact } from '@a2x/sdk';

let artifacts: Artifact[] = [];
for await (const event of stream) {
  if ('artifact' in event) {
    artifacts = applyArtifactUpdate(artifacts, event);
  }
}
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
- **Don't return the record you keep.** A store that hands back its own mutable object hides persistence bugs: code that mutates a task in place appears to work, then loses every transition the moment the store is swapped for a real database.
- **Monitor cardinality.** A task store that grows unboundedly is a memory/disk leak waiting to happen. Always use a TTL or periodic cleanup.
