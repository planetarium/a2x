# Host: Next.js Server Action / Route Handler

Call a remote A2A agent from Next.js server-side code — server actions, route handlers, or `getServerSideProps`. The key distinction: **credentials come from the incoming user session**, not from global env.

---

## Pattern: Per-Request Client

Because the credential depends on the authenticated user (their bearer token, their API key), you typically construct the `A2XClient` per request:

```typescript
// src/lib/agent.ts
import { A2XClient } from '@a2x/sdk/client';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
} from '@a2x/sdk/client';
import type { AuthProvider } from '@a2x/sdk/client';
import { getApprovedCard, noRedirectFetch } from './approved-agent-card.js';

class SessionAuthProvider implements AuthProvider {
  constructor(private readonly session: { apiKey?: string; bearerToken?: string }) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      if (this.tryFill(group)) return group;
    }
    throw new Error('User session lacks required credentials');
  }

  async refresh(): Promise<AuthScheme[]> {
    // Token refresh is the auth layer's responsibility, not ours.
    // Surface 401 to the browser so the user re-logs-in.
    throw new Error('REAUTH_REQUIRED');
  }

  private tryFill(group: AuthScheme[]): boolean {
    for (const scheme of group) {
      if (scheme instanceof ApiKeyAuthScheme && this.session.apiKey) {
        scheme.setCredential(this.session.apiKey);
        continue;
      }
      if (scheme instanceof HttpBearerAuthScheme && this.session.bearerToken) {
        scheme.setCredential(this.session.bearerToken);
        continue;
      }
      return false;
    }
    return true;
  }
}

export async function agentClientFor(session: { apiKey?: string; bearerToken?: string }) {
  const resolved = await getApprovedCard(); // policy-bound cache below
  return new A2XClient(resolved.card, {
    fetch: noRedirectFetch,
    authProvider: new SessionAuthProvider(session),
  });
}
```

---

## Pattern: Cached Card + Per-Request Client

The agent card rarely changes — cache it at module scope and pass the resolved card to avoid per-request GETs of `/.well-known/agent.json`:

```typescript
// src/lib/approved-agent-card.ts
import {
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';
import type { ResolvedAgentCard } from '@a2x/sdk/client';

let cardPromise: Promise<ResolvedAgentCard> | undefined;
export const noRedirectFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: 'error' });

function exactHttpsUrl(raw: string | undefined, label: string): string {
  if (!raw) throw new Error(`${label} is required`);
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    url.search || url.hash
  ) throw new Error(`${label} must be an exact credential-free HTTPS URL`);
  return url.toString();
}

export function getApprovedCard() {
  cardPromise ??= (async () => {
    const cardUrl = exactHttpsUrl(process.env.AGENT_CARD_URL, 'AGENT_CARD_URL');
    if (!new URL(cardUrl).pathname.endsWith('.json')) {
      throw new Error('AGENT_CARD_URL must name one exact JSON card document');
    }
    const resolved = await resolveAgentCard(cardUrl, { fetch: noRedirectFetch });
    const endpoint = exactHttpsUrl(
      getAgentEndpointUrl(resolved.card, resolved.version),
      'AgentCard endpoint',
    );
    const expected = exactHttpsUrl(
      process.env.AGENT_ENDPOINT_URL,
      'AGENT_ENDPOINT_URL',
    );
    if (endpoint !== expected) {
      throw new Error(`AgentCard endpoint is not approved: ${endpoint}`);
    }
    return resolved;
  })();
  return cardPromise;
}
```

Card cache survives across requests (module-level), but invalidates on a fresh deploy. Never attach a session credential until both the exact card document and its resolved JSON-RPC endpoint match host policy. If you need to bust the cache at runtime, expose an internal endpoint that sets `cardPromise = undefined` and re-run the same checks.

---

## App Router — Route Handler

```typescript
// src/app/api/agent/send/route.ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { agentClientFor } from '@/lib/agent';
import crypto from 'node:crypto';
import type { SendMessageParams } from '@a2x/sdk';

export async function POST(request: Request) {
  const { message } = await request.json() as { message: string };

  const session = await getSession(await cookies());
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  try {
    const client = await agentClientFor(session);
    const params: SendMessageParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ text: message }],
      },
    };
    const task = await client.sendMessage(params);
    // Auth failure surfaces as a task state, not a thrown error.
    if (task.status.state === 'auth-required') {
      return NextResponse.json({ error: 'reauth_required' }, { status: 401 });
    }
    return NextResponse.json(task);
  } catch (err) {
    if (err instanceof Error && err.message === 'REAUTH_REQUIRED') {
      return NextResponse.json({ error: 'reauth_required' }, { status: 401 });
    }
    console.error('agent call failed', err);
    return NextResponse.json({ error: 'agent_unavailable' }, { status: 502 });
  }
}
```

---

## App Router — Server Action

```typescript
// src/app/actions/agent.ts
'use server';

import { agentClientFor } from '@/lib/agent';
import { cookies } from 'next/headers';
import crypto from 'node:crypto';

export async function sendMessage(message: string) {
  const session = await getSession(await cookies());
  if (!session) throw new Error('unauthenticated');

  const client = await agentClientFor(session);
  const task = await client.sendMessage({
    message: {
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ text: message }],
    },
  });
  return { taskId: task.id, state: task.status?.state };
}
```

Call from a client component:

```tsx
'use client';
import { sendMessage } from '@/app/actions/agent';

export function Chat() {
  async function submit(formData: FormData) {
    const result = await sendMessage(formData.get('message') as string);
    // …
  }
  return <form action={submit}>…</form>;
}
```

---

## App Router — Streaming

Next.js route handlers can return a `Response` with an SSE body. Bridge the SDK's `AsyncGenerator` into a `ReadableStream`:

```typescript
// src/app/api/agent/stream/route.ts
export const runtime = 'nodejs';

import { agentClientFor } from '@/lib/agent';
import { cookies } from 'next/headers';
import crypto from 'node:crypto';
import type { SendMessageParams } from '@a2x/sdk';

export async function POST(request: Request) {
  const { message } = await request.json() as { message: string };
  const session = await getSession(await cookies());
  if (!session) return new Response('unauthenticated', { status: 401 });

  const client = await agentClientFor(session);
  const params: SendMessageParams = {
    message: {
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ text: message }],
    },
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of client.sendMessageStream(params)) {
          controller.enqueue(encoder.encode(
            `event: ${'status' in event ? 'status_update' : 'artifact_update'}\n` +
            `data: ${JSON.stringify(event)}\n\n`,
          ));
        }
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
      } catch (err) {
        controller.enqueue(encoder.encode(
          `event: error\ndata: ${JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })}\n\n`,
        ));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

**Important**: Set `runtime = 'nodejs'` — the SDK uses `fetch` and `URL`, both available in Edge, but the device-code flow, `node:crypto`, and some Node globals referenced elsewhere in your auth provider require Node.

The direct bridge above is appropriate only for unpaid, non-funds-bearing streams. Do **not** use the browser connection as the owner of an x402 stream, especially with batch settlement: a disconnect can close the upstream generator after payment submission and leave the financial result ambiguous.

For paid streams, enqueue a durable job before returning a subscription identifier. A worker should own and drain `sendMessageStream()` through terminal receipt, reconciliation, or quarantine; persist sanitized events; and expose a replayable SSE subscription to the browser. Browser cancellation closes only that subscription. Apply worker-owned deadlines and handle `X402ReconciliationError`—never derive the upstream abort signal from `request.signal` after payment submission.

Minimal architecture skeleton (the queue and stores are application adapters). The job and an outbox row must be committed atomically under a unique owner-scoped idempotency key; an unconditional enqueue after `createOnce` can enqueue the same paid job twice:

```typescript
// POST /api/agent/jobs — authenticate session and enforce CSRF/rate/budget policy.
const idempotencyKey = requireOwnerScopedIdempotencyKey(
  request.headers.get('Idempotency-Key'),
  session.userId,
);
const job = await jobs.createOnceWithOutbox({
  ownerId: session.userId,
  idempotencyKey, // unique with ownerId
  text: boundedMessage,
  credentialRef: session.a2aCredentialRef, // reference, never a browser token
  outbox: {
    topic: 'payer-jobs',
    partitionKey: `${AGENT_URL}:${PAYER_ADDRESS}`,
  },
});
return Response.json({ jobId: job.id }, { status: 202 });
```

An outbox dispatcher publishes each row with `job.id` as the queue deduplication key and marks it delivered transactionally/idempotently. Repeating the POST returns the existing job and cannot create another outbox row.

```typescript
// One active worker per partition; clientForWorker injects server credentials,
// signer policy, and durable batchSettlement storage.
import {
  TERMINAL_STATES,
  TaskState,
  type Task,
} from '@a2x/sdk';
import type { A2XClient } from '@a2x/sdk/client';
import {
  X402ReconciliationError,
  getX402PaymentRequirements,
  getX402Receipts,
} from '@a2x/sdk/x402';

async function executePaidJob(job: AgentJob): Promise<void> {
  const client = await clientForWorker(job.credentialRef);
  // Atomic and durable: only a never-started job can return `start`.
  // Redelivery of an existing execution always enters recovery and must
  // never invoke the original message again.
  const execution = await paidExecutions.claimOrLoad(job.id);
  if (execution.mode !== 'start') {
    await recoverPersistedPaidExecution(job, execution, client);
    return;
  }

  let terminalTask: Task | undefined;
  try {
    for await (const event of client.sendMessageStream(job.params)) {
      await jobEvents.append(job.id, sanitizeForBrowser(event));
      if ('status' in event) {
        const eventTask: Task = {
          id: event.taskId,
          contextId: event.contextId,
          status: event.status,
        };
        if (
          event.status.state === TaskState.INPUT_REQUIRED &&
          getX402PaymentRequirements(eventTask)
        ) {
          // The async generator is paused at this yield. Commit the merchant
          // task handle before requesting the next event, which is the point
          // at which A2XClient signs and submits payment.
          await paidExecutions.recordPaymentBoundary(job.id, {
            taskId: event.taskId,
            contextId: event.contextId,
          });
        }
        if (TERMINAL_STATES.has(event.status.state)) terminalTask = eventTask;
      }
    }

    if (!terminalTask) {
      await jobs.quarantine(job.id, new Error('paid stream ended before a terminal status'));
      return;
    }
    if (terminalTask.status.state !== TaskState.COMPLETED) {
      await jobs.fail(job.id, terminalTask.status);
      return;
    }
    const receipt = getX402Receipts(terminalTask).at(-1);
    if (!receipt?.success) {
      await jobs.quarantine(job.id, new Error('completed paid stream omitted a successful receipt'));
      return;
    }
    await jobs.complete(job.id);
  } catch (error) {
    if (error instanceof X402ReconciliationError) {
      await jobs.quarantine(job.id, error);
      return;
    }
    // The worker may already have submitted payment. Do not let the queue
    // auto-retry an ambiguous paid attempt.
    await jobs.quarantine(job.id, error);
  }
}

async function recoverPersistedPaidExecution(
  job: AgentJob,
  execution: PaidExecution,
  client: A2XClient,
): Promise<void> {
  if (!execution.taskId) {
    await jobs.quarantine(
      job.id,
      new Error('worker stopped before persisting a recoverable A2A task'),
    );
    return;
  }
  const task = await client.getTask(execution.taskId);
  if (!TERMINAL_STATES.has(task.status.state)) {
    await paidExecutions.scheduleRecoveryPoll(job.id); // recovery only; no resend
    return;
  }
  if (task.status.state !== TaskState.COMPLETED) {
    await jobs.fail(job.id, task.status);
    return;
  }
  const receipt = getX402Receipts(task).at(-1);
  if (!receipt?.success) {
    await jobs.quarantine(job.id, new Error('recovered task has no successful receipt'));
    return;
  }
  await jobs.complete(job.id);
}
```

The durable execution row is separate from queue deduplication: it prevents an at-least-once delivery from starting the paid operation twice. The high-level stream can persist the payment boundary and safely query an existing task, but it cannot reconstruct every signed exact/upto payload or batch reconciliation object after process death. For automatic recovery beyond querying the merchant task, use the [low-level x402 flow](https://github.com/planetarium/a2x/blob/main/packages/a2x/docs/guides/advanced/x402-payments.md#low-level-signx402payment) and durably store the signed payload, task/context IDs, batch binding, and attempt state before submission. Otherwise quarantine an ambiguous attempt; never call `sendMessageStream(job.params)` again.

```typescript
// GET /api/agent/jobs/:id/events — verify session ownership on every read.
const after = request.headers.get('Last-Event-ID');
return replayableSse(jobEvents.subscribe(job.id, { after }), {
  onBrowserCancel: subscription => subscription.close(),
}); // never cancels executePaidJob
```

On worker recovery, reconcile any persisted pending task/attempt before the partition accepts another paid job. See [host-backend.md](./host-backend.md#horizontal-x402-ownership) for the non-overlapping ownership contract.

---

## Pages Router — API Route

```typescript
// src/pages/api/agent/send.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { agentClientFor } from '@/lib/agent';
import crypto from 'node:crypto';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const session = getSessionFromReq(req);
  if (!session) return res.status(401).json({ error: 'unauthenticated' });

  const client = await agentClientFor(session);
  const task = await client.sendMessage({
    message: {
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ text: req.body.message as string }],
    },
  });
  res.json(task);
}
```

---

## Do NOT

- **Do not** construct `A2XClient` in a client component with a user-provided token. `'use client'` files end up in the browser bundle — the `@a2x/sdk/client` package works there, but calling agents directly from the browser means CORS, and your API key ends up in network-inspectable requests. Always proxy through a route handler / server action.
- **Do not** cache `A2XClient` across users. The auth schemes are per-user.
- **Do not** expose `agentClientFor` or the raw client to client-side code via a direct import — keep server-only modules under a clear naming convention or use `server-only`.

```typescript
// src/lib/agent.ts
import 'server-only';
// …
```

This makes the file fail to import from a client component, catching leakage at build time.

---

## Environment Variables

```env
# .env.local
AGENT_URL=https://agent.example.com
# If your auth provider needs secrets beyond the user session:
# AGENT_CLIENT_ID=...
# AGENT_CLIENT_SECRET=...
```

Only `AGENT_URL` is typically needed — user credentials come from the session, not env.
