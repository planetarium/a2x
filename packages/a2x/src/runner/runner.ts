/**
 * Layer 2: Runner - orchestrates agent execution within a session.
 */

import type { BaseAgent, AgentEvent } from '../agent/base-agent.js';
import type { BasePlugin } from '../plugin/base-plugin.js';
import type { Message } from '../types/common.js';
import type { Session, InvocationContext } from './context.js';
import type { SessionService } from './session-service.js';
import { InMemorySessionService } from './in-memory-session.js';

// ─── Runner Options ───

export interface RunnerOptions {
  agent: BaseAgent;
  appName: string;
  sessionService?: SessionService;
  plugins?: BasePlugin[];
}

// ─── Runner ───

export class Runner {
  readonly agent: BaseAgent;
  readonly appName: string;
  protected readonly sessionService: SessionService;
  protected readonly plugins: BasePlugin[];

  constructor(options: RunnerOptions) {
    this.agent = options.agent;
    this.appName = options.appName;
    this.sessionService = options.sessionService ?? new InMemorySessionService();
    this.plugins = options.plugins ?? [];
  }

  /**
   * Run the agent asynchronously, yielding AgentEvents.
   */
  async *runAsync(session: Session, message: Message, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    // Store the incoming message in session events with user role
    session.events.push({ type: 'text', text: message.parts.map(p => ('text' in p ? p.text : '')).join(''), role: 'user' });
    await this.sessionService.updateSession(session);

    // Create invocation context
    const context: InvocationContext = {
      session,
      state: session.state,
      agentName: this.agent.name,
      plugins: this.plugins,
      signal,
    };

    // Run the agent and yield events
    for await (const event of this.agent.run(context)) {
      if (signal?.aborted) return;
      session.events.push(event);
      yield event;
    }

    await this.sessionService.updateSession(session);
  }

  /**
   * Create a new session.
   */
  async createSession(userId?: string): Promise<Session> {
    return this.sessionService.createSession(this.appName, userId);
  }

  /**
   * Get an existing session by ID.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessionService.getSession(this.appName, sessionId);
  }
}
