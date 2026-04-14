/**
 * RemoteA2AAgent — Integrates a remote A2A agent into local a2x pipelines.
 *
 * Uses A2XClient internally to communicate with the remote agent.
 * The remote agent is treated as a local BaseAgent, yielding AgentEvents
 * from the streamed A2A response.
 */

import type { AgentEvent } from '../agent/base-agent.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type { SendMessageConfiguration } from '../types/jsonrpc.js';
import { TaskState } from '../types/task.js';
import type { Message, Part } from '../types/common.js';
import { A2XClient } from '../client/a2x-client.js';
import type { A2XClientOptions } from '../client/a2x-client.js';

// ─── Types ───

export interface RemoteA2AAgentOptions {
  name: string;
  description: string;
  agentCardUrl?: string;
  agentCard?: AgentCardV03 | AgentCardV10;
  client?: A2XClient;
  auth?: { token: string; scheme?: string };
  sendConfiguration?: SendMessageConfiguration;
  fetchImpl?: typeof globalThis.fetch;
}

// ─── RemoteA2AAgent ───

export class RemoteA2AAgent extends BaseAgent {
  private readonly _options: RemoteA2AAgentOptions;
  private _client: A2XClient | null;

  constructor(options: RemoteA2AAgentOptions) {
    super({ name: options.name, description: options.description });

    if (!options.agentCardUrl && !options.agentCard && !options.client) {
      throw new Error(
        'RemoteA2AAgent requires at least one of: agentCardUrl, agentCard, or client',
      );
    }

    this._options = options;
    this._client = options.client ?? null;
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const client = this._ensureClient();
    const message = this._buildMessageFromContext(context);

    const eventStream = client.sendMessageStream({
      message,
      configuration: this._options.sendConfiguration,
    });

    for await (const event of eventStream) {
      if ('status' in event) {
        // TaskStatusUpdateEvent
        const state = event.status.state;

        if (state === TaskState.FAILED) {
          const errorText = event.status.message?.parts
            .map((p) => ('text' in p ? p.text : ''))
            .filter(Boolean)
            .join('') || 'Remote agent failed';
          yield { type: 'error', error: new Error(errorText) };
          return;
        }

        if (state === TaskState.COMPLETED) {
          yield { type: 'done' };
          return;
        }

        // WORKING, SUBMITTED, etc. — informational, no AgentEvent needed
      } else {
        // TaskArtifactUpdateEvent
        for (const part of event.artifact.parts) {
          if ('text' in part) {
            yield { type: 'text', text: part.text, role: 'agent' };
          }
        }
      }
    }

    // Stream ended without explicit COMPLETED — yield done
    yield { type: 'done' };
  }

  /**
   * Lazily create A2XClient based on constructor options.
   * Priority: client > agentCard > agentCardUrl
   */
  private _ensureClient(): A2XClient {
    if (this._client) return this._client;

    const clientOptions: A2XClientOptions = {
      fetch: this._options.fetchImpl,
    };

    if (this._options.auth) {
      const scheme = this._options.auth.scheme ?? 'Bearer';
      clientOptions.headers = {
        Authorization: `${scheme} ${this._options.auth.token}`,
      };
    }

    if (this._options.agentCard) {
      this._client = new A2XClient(this._options.agentCard, clientOptions);
    } else if (this._options.agentCardUrl) {
      this._client = new A2XClient(this._options.agentCardUrl, clientOptions);
    } else {
      throw new Error('No agentCard, agentCardUrl, or client provided');
    }

    return this._client;
  }

  /**
   * Build a Message from the InvocationContext session events.
   * Extracts the most recent user text input.
   */
  private _buildMessageFromContext(context: InvocationContext): Message {
    const events = context.session.events;
    const parts: Part[] = [];

    // Scan from the end for the most recent user text
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'text' && event.role !== 'agent') {
        parts.push({ text: event.text });
        break;
      }
    }

    if (parts.length === 0) {
      throw new Error(
        'No user input found in session — cannot invoke remote agent',
      );
    }

    return {
      messageId: crypto.randomUUID(),
      role: 'user',
      parts,
    };
  }
}
