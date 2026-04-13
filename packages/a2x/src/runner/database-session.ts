/**
 * Layer 2: DatabaseSessionService stub.
 * Full implementation deferred to Phase 2.
 */

import type { Session } from './context.js';
import type { SessionService } from './session-service.js';

export class DatabaseSessionService implements SessionService {
  async createSession(_appName: string, _userId?: string): Promise<Session> {
    throw new Error('DatabaseSessionService not yet implemented (Phase 2)');
  }

  async getSession(_appName: string, _sessionId: string): Promise<Session | null> {
    throw new Error('DatabaseSessionService not yet implemented (Phase 2)');
  }

  async updateSession(_session: Session): Promise<void> {
    throw new Error('DatabaseSessionService not yet implemented (Phase 2)');
  }

  async deleteSession(_appName: string, _sessionId: string): Promise<void> {
    throw new Error('DatabaseSessionService not yet implemented (Phase 2)');
  }
}
