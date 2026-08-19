import { describe, expect, it } from 'vitest';
import {
  createAuthProviderInvocationContext,
  type AuthProviderInvocation,
} from '../client/auth-provider-context.js';

describe('AuthProvider invocation context', () => {
  it('fails safe without platform async-context support', async () => {
    const context = createAuthProviderInvocationContext(null);
    const client = {};
    const otherClient = {};
    const invocation: AuthProviderInvocation = {
      client,
      callback: 'provide',
      active: true,
    };

    await context.run(invocation, async () => {
      await Promise.resolve();
      expect(context.getStore(client)).toBe(invocation);
      expect(context.getStore(otherClient)).toBeUndefined();
    });

    invocation.active = false;
    context.close(invocation);
    expect(context.getStore(client)).toBeUndefined();
  });
});
