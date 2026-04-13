/**
 * Layer 2: SessionService interface.
 */

import type { Session } from './context.js';

export interface SessionService {
  createSession(appName: string, userId?: string): Promise<Session>;
  getSession(appName: string, sessionId: string): Promise<Session | null>;
  updateSession(session: Session): Promise<void>;
  deleteSession(appName: string, sessionId: string): Promise<void>;
}
