/**
 * Client-side AuthProvider interface.
 *
 * The SDK calls the AuthProvider when an agent requires authentication.
 * The client implements this interface to acquire credentials dynamically
 * based on the agent's declared security schemes.
 */

import type { AuthScheme } from './auth-scheme.js';

export interface AuthProvider {
  /**
   * Called by SDK with security requirements as AuthScheme[][].
   *
   * Structure mirrors OR-of-ANDs from the agent card:
   *   - outer array: OR groups (satisfy ANY one group)
   *   - inner array: AND schemes (satisfy ALL in the group)
   *
   * Client iterates groups, resolves all schemes in a group via
   * setCredential(), and returns the resolved group.
   * Throw if no group can be satisfied — authentication fails.
   * Do not call an authenticated operation on the same A2XClient from this
   * callback. Use a separate client or transport for credential acquisition.
   */
  provide(requirements: AuthScheme[][]): Promise<AuthScheme[]>;

  /**
   * Called by SDK when a previously-authenticated request gets
   * an auth error (e.g., token expired). Optional.
   * Receives the same scheme array that was previously returned by provide().
   * Do not call an authenticated operation on the same A2XClient from this
   * callback. Use a separate client or transport for credential refresh.
   */
  refresh?(schemes: AuthScheme[]): Promise<AuthScheme[]>;
}
