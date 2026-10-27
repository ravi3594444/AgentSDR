import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { accountKey, type ClaudeAccount } from "./cli.server";

const scope = new AsyncLocalStorage<{ account: string; signal: AbortSignal }>();

/** Only an authorized app tool may make a nested structured call while its native parent waits. */
export function inNativeTool<T>(account: ClaudeAccount, signal: AbortSignal, work: () => T): T {
  return scope.run({ account: accountKey(account), signal }, work);
}

export function nativeToolParent(account: ClaudeAccount) {
  const parent = scope.getStore();
  return parent?.account === accountKey(account) ? parent : null;
}

/** Tool transports can abort promptly when their native turn is revoked or cancelled. */
export function nativeToolSignal(): AbortSignal | undefined { return scope.getStore()?.signal; }
