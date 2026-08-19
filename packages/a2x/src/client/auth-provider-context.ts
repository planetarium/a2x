interface AsyncContextCarrier<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

interface AsyncContextVariable<T> {
  get(): T | undefined;
  run<R>(value: T, callback: () => R): R;
}

type AsyncContextVariableConstructor = new <T>() => AsyncContextVariable<T>;
type AsyncLocalStorageConstructor = new <T>() => AsyncContextCarrier<T>;

export interface AuthProviderInvocation {
  client: object;
  callback: 'provide' | 'refresh';
  active: boolean;
}

export interface AuthProviderInvocationContext {
  close(invocation: AuthProviderInvocation): void;
  getStore(client: object): AuthProviderInvocation | undefined;
  run<R>(invocation: AuthProviderInvocation, callback: () => R): R;
}

function detectAsyncContextCarrier<T>(): AsyncContextCarrier<T> | undefined {
  const AsyncContextVariable = (globalThis as {
    AsyncContext?: { Variable?: AsyncContextVariableConstructor };
  }).AsyncContext?.Variable;
  if (AsyncContextVariable) {
    const variable = new AsyncContextVariable<T>();
    return {
      getStore: () => variable.get(),
      run: (store, callback) => variable.run(store, callback),
    };
  }

  const nodeProcess = (globalThis as {
    process?: { getBuiltinModule?: (id: string) => object | undefined };
  }).process;
  try {
    const asyncHooks = nodeProcess?.getBuiltinModule?.('node:async_hooks') as
      | { AsyncLocalStorage?: AsyncLocalStorageConstructor }
      | undefined;
    if (asyncHooks?.AsyncLocalStorage) {
      return new asyncHooks.AsyncLocalStorage<T>();
    }
  } catch {
    // Non-Node runtimes may expose a partial process shim. Fall through to
    // the conservative tracker instead of making the client entry unloadable.
  }
  return undefined;
}

/**
 * Track provider callbacks without forcing the client entry to import a
 * platform-specific async-context module.
 *
 * Runtimes without implicit async context cannot distinguish callback-caused
 * re-entry from an unrelated same-client call. The fallback therefore favors
 * failing fast over recreating the promise cycle, while still allowing calls
 * through other client instances.
 */
export function createAuthProviderInvocationContext(
  carrier: AsyncContextCarrier<AuthProviderInvocation> | null =
    detectAsyncContextCarrier<AuthProviderInvocation>() ?? null,
): AuthProviderInvocationContext {
  const active = new Set<AuthProviderInvocation>();
  return {
    close(invocation) {
      active.delete(invocation);
    },
    getStore(client) {
      if (carrier) {
        const invocation = carrier.getStore();
        return invocation?.active && invocation.client === client
          ? invocation
          : undefined;
      }
      return [...active].find(
        (invocation) => invocation.active && invocation.client === client,
      );
    },
    run(invocation, callback) {
      active.add(invocation);
      return carrier ? carrier.run(invocation, callback) : callback();
    },
  };
}

export const authProviderInvocation = createAuthProviderInvocationContext();
