/**
 * Layer 3: PushNotificationSender — webhook delivery for the
 * `tasks/pushNotificationConfig/*` family.
 *
 * `PushNotificationConfigStore` only persists configs; it doesn't
 * actually call the webhook URL when a task transitions. The sender is
 * the missing half: given a stored `TaskPushNotificationConfig` and the
 * spec-mapped wire body of the current task, it POSTs the body to
 * `config.url` so the client receives an out-of-band lifecycle
 * notification.
 *
 * Wire one in via `A2XAgentOptions.pushNotificationSender`. Without it,
 * `capabilities.pushNotifications` stays `false` even when a config
 * store is configured, because advertising the capability without
 * delivery would be a false promise. See issue #119.
 */

import type { TaskPushNotificationConfig } from '../types/jsonrpc.js';

// ─── PushNotificationSender Interface ───

export interface PushNotificationSender {
  /**
   * Deliver a single push notification to the webhook registered in
   * `config`. `body` is the already version-mapped Task wire payload
   * (v0.3 `kind` discriminators / v1.0 UPPER_CASE state and role) — the
   * caller is responsible for mapping the internal Task through a
   * `ResponseMapper` so the bytes on the wire match the spec for the
   * agent's declared `protocolVersion`.
   *
   * Implementations should NOT throw on delivery failure (best-effort):
   * a webhook the client mis-configured shouldn't break the task
   * pipeline. Log + drop is fine; queue + retry is also fine if the
   * implementation owns durable retries.
   */
  send(config: TaskPushNotificationConfig, body: unknown): Promise<void>;
}

// ─── FetchPushNotificationSender ───

/**
 * Default sender: POSTs the JSON-encoded wire `body` to `config.url`.
 *
 * Authentication is best-effort by spec — `PushNotificationConfig.token`
 * is included as `X-A2A-Notification-Token` for symmetric secret
 * verification, and `authentication.credentials` (when present and the
 * scheme is `Bearer`) is forwarded as `Authorization: Bearer <token>`.
 * More elaborate auth schemes (JWT-signed bodies per the v1.0 spec) are
 * the embedder's responsibility — provide a custom `PushNotificationSender`
 * for those.
 *
 * The fetch implementation defaults to `globalThis.fetch`; pass one in
 * for testing or to swap in an HTTP client with retry/backoff policies.
 */
export interface FetchPushNotificationSenderOptions {
  fetch?: typeof globalThis.fetch;
  /**
   * Per-call timeout in milliseconds. The sender aborts the request if
   * the webhook does not respond within this window so a slow webhook
   * cannot stall the agent's lifecycle. Defaults to 10_000 ms.
   */
  timeoutMs?: number;
  /**
   * Logger called when a webhook delivery fails. Defaults to
   * `console.warn`. Set to `() => {}` to silence.
   */
  onError?: (err: unknown, config: TaskPushNotificationConfig) => void;
}

export class FetchPushNotificationSender implements PushNotificationSender {
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _timeoutMs: number;
  private readonly _onError: (
    err: unknown,
    config: TaskPushNotificationConfig,
  ) => void;

  constructor(options: FetchPushNotificationSenderOptions = {}) {
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this._timeoutMs = options.timeoutMs ?? 10_000;
    this._onError =
      options.onError ??
      ((err, config) => {
        console.warn(
          `[@a2x/sdk] Push notification delivery to ${config.pushNotificationConfig.url} failed:`,
          err,
        );
      });
  }

  async send(config: TaskPushNotificationConfig, body: unknown): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const inner = config.pushNotificationConfig;
    if (inner.token) {
      // Symmetric token verification per v0.3 §PushNotificationConfig.
      headers['X-A2A-Notification-Token'] = inner.token;
    }

    const auth = inner.authentication;
    if (auth) {
      // We pick Bearer credentials directly. Anything else (HMAC-signed
      // bodies, OAuth flows) is up to a custom sender.
      const isBearer = auth.schemes.some((s) => s.toLowerCase() === 'bearer');
      if (isBearer && auth.credentials) {
        headers['Authorization'] = `Bearer ${auth.credentials}`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const response = await this._fetch(inner.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        this._onError(
          new Error(`Webhook returned ${response.status} ${response.statusText}`),
          config,
        );
      }
    } catch (err) {
      this._onError(err, config);
    } finally {
      clearTimeout(timeout);
    }
  }
}
