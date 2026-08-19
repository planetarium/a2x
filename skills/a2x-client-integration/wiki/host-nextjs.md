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

export function agentClientFor(session: { apiKey?: string; bearerToken?: string }) {
  return new A2XClient(process.env.AGENT_URL!, {
    authProvider: new SessionAuthProvider(session),
  });
}
```

---

## Pattern: Cached Card + Per-Request Client

The agent card rarely changes — cache it at module scope and pass the resolved card to avoid per-request GETs of `/.well-known/agent.json`:

```typescript
import { A2XClient, resolveAgentCard } from '@a2x/sdk/client';
import type { ResolvedAgentCard } from '@a2x/sdk/client';

let cardPromise: Promise<ResolvedAgentCard> | undefined;

function getCard() {
  cardPromise ??= resolveAgentCard(process.env.AGENT_URL!);
  return cardPromise;
}

export async function agentClientFor(session: { /* … */ }) {
  const resolved = await getCard();
  return new A2XClient(resolved.card, {
    authProvider: new SessionAuthProvider(session),
  });
}
```

Card cache survives across requests (module-level), but invalidates on a fresh deploy. If you need to bust the cache at runtime, expose an internal endpoint that sets `cardPromise = undefined`.

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

Minimal architecture skeleton (the queue and stores are application adapters):

```typescript
// POST /api/agent/jobs — authenticate session and enforce CSRF/rate/budget policy.
const job = await jobs.createOnce({
  ownerId: session.userId,
  idempotencyKey: request.headers.get('Idempotency-Key')!,
  text: boundedMessage,
  credentialRef: session.a2aCredentialRef, // reference, never a browser token
});
await payerQueue.enqueue(job.id, {
  partitionKey: `${AGENT_URL}:${PAYER_ADDRESS}`,
});
return Response.json({ jobId: job.id }, { status: 202 });
```

```typescript
// One active worker per partition; clientForWorker injects server credentials,
// signer policy, and durable batchSettlement storage.
import { X402ReconciliationError } from '@a2x/sdk/x402';

async function executePaidJob(job: AgentJob): Promise<void> {
  const client = await clientForWorker(job.credentialRef);
  try {
    for await (const event of client.sendMessageStream(job.params)) {
      await jobEvents.append(job.id, sanitizeForBrowser(event));
    }
    await jobs.complete(job.id);
  } catch (error) {
    if (error instanceof X402ReconciliationError) {
      await jobs.quarantine(job.id, error);
    }
    throw error;
  }
}
```

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
