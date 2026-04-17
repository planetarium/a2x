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
import { AuthenticationRequiredError } from '@a2x/sdk';
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
    return NextResponse.json(task);
  } catch (err) {
    if (err instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: 'reauth_required' }, { status: 401 });
    }
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
