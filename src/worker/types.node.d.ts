// Minimal typing for the one Node built-in the Worker uses (available under nodejs_compat).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
