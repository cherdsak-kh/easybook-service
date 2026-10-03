import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceContext } from './incident.types';

/** The request's trace context, visible to every `await` the request makes (design §2.5.1). */
export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function currentTrace(): TraceContext | undefined {
  return traceStorage.getStore();
}
