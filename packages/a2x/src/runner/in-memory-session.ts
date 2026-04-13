/**
 * Layer 2: InMemorySessionService - stores sessions in memory.
 */

import { randomUUID } from 'node:crypto';
import type { Session } from './context.js';
import type { SessionService } from './session-service.js';

export class InMemorySessionService implements SessionService {
  private readonly sessions = new Map<string, Session>();

  private key(appName: string, sessionId: string): string {
    return `${appName}:${sessionId}`;
  }

  async createSession(appName: string, userId?: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      appName,
      userId,
      state: {},
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(this.key(appName, session.id), session);
    return session;
  }

  async getSession(appName: string, sessionId: string): Promise<Session | null> {
    return this.sessions.get(this.key(appName, sessionId)) ?? null;
  }

  async updateSession(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    this.sessions.set(this.key(session.appName, session.id), session);
  }

  async deleteSession(appName: string, sessionId: string): Promise<void> {
    this.sessions.delete(this.key(appName, sessionId));
  }
}
