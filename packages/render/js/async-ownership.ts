import { getOwner, onCleanup, runWithOwner, type Owner } from "solid-js";

// Capture the owner where a callback/promise is created, never the active view
// at failure time. QuickJS hooks carry the same scope through native async/await.
type Scope = { owner: Owner; alive: boolean };
const scopes = new WeakMap<Owner, Scope>();
let asyncScope: Scope | undefined;
const scopeStack: (Scope | undefined)[] = [];
const promiseScopes = new WeakMap<object, Scope>();
const rejections = new Map<object, { scope: Scope; cause: unknown }>();
const hookFailures: { scope: Scope; cause: unknown }[] = [];
function currentScope(): Scope | undefined {
  const owner = getOwner();
  if (!owner) return asyncScope;
  let scope = scopes.get(owner);
  if (!scope || !scope.alive) {
    scope = { owner, alive: true };
    scopes.set(owner, scope);
    const captured = scope;
    // Property spreads run in short-lived computations. Their cleanup on a
    // reactive rerun does not retire the node or its installed callbacks. Tie
    // liveness to the surrounding root, retaining the captured error context.
    let lifetime = owner;
    while ("fn" in lifetime && lifetime.owner) lifetime = lifetime.owner;
    runWithOwner(lifetime, () =>
      onCleanup(() => {
        captured.alive = false;
      }),
    );
  }
  return scope;
}
export function owned<T extends (...args: any[]) => any>(callback: T): T {
  const scope = currentScope();
  if (!scope) return callback;
  return ((...args: Parameters<T>) => {
    if (!scope.alive) return;
    let result: ReturnType<T> | undefined;
    let failure: { cause: unknown } | undefined;
    runWithOwner(scope.owner, () => {
      // Finish the update batch before re-entering the owner's error handler.
      // Throwing through runWithOwner would discard valid writes queued by an
      // ordinary host callback before its failure.
      try {
        result = callback(...args);
      } catch (cause) {
        failure = { cause };
      }
    });
    if (failure) {
      const { cause } = failure;
      runWithOwner(scope.owner, () => {
        throw cause;
      });
    }
    return result;
  }) as T;
}
export function flushRejections() {
  const failures = [...rejections.values(), ...hookFailures];
  rejections.clear();
  hookFailures.length = 0;
  for (const { scope, cause } of failures) {
    if (scope.alive)
      runWithOwner(scope.owner, () => {
        throw cause;
      });
  }
}

export const promiseHooks = {
  resetPromiseScope() {
    asyncScope = undefined;
    scopeStack.length = 0;
  },
  promiseHook(kind: string, promise: object, parent: object) {
    if (kind === "init") {
      const scope = currentScope() ?? promiseScopes.get(parent);
      if (scope) promiseScopes.set(promise, scope);
    } else if (kind === "before") {
      scopeStack.push(asyncScope);
      asyncScope = promiseScopes.get(promise);
    } else if (kind === "after") asyncScope = scopeStack.pop();
  },
  promiseRejection(promise: object, cause: unknown, handled: boolean) {
    if (handled) rejections.delete(promise);
    else {
      const scope = promiseScopes.get(promise);
      if (scope?.alive) rejections.set(promise, { scope, cause });
    }
  },
  promiseHookError(promise: object, cause: unknown): boolean {
    const scope = promiseScopes.get(promise) ?? currentScope();
    if (!scope?.alive || hookFailures.length >= 16) return false;
    hookFailures.push({ scope, cause });
    return true;
  },
};

export function clearRejections() {
  rejections.clear();
  hookFailures.length = 0;
}
