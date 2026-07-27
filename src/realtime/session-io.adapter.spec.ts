import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'http';
import type { Server, Socket } from 'socket.io';
import { DEFAULT_CORS_ORIGIN, resolveCorsOrigin } from '../config/cors';
import {
  REALTIME_ADMIN_NAMESPACE,
  REALTIME_ERRORS,
  REALTIME_NAMESPACE_ALLOWLIST,
} from './realtime.constants';
import type { SocketMiddleware } from './realtime.handshake';
import { originGuard, sealNamespaces } from './session-io.adapter';

const configWith = (corsOrigin?: string): ConfigService =>
  ({
    get: (key: string, fallback?: string) =>
      key === 'CORS_ORIGIN' ? (corsOrigin ?? fallback) : fallback,
  }) as unknown as ConfigService;

const requestFrom = (origin?: string): IncomingMessage =>
  ({ headers: origin === undefined ? {} : { origin } }) as IncomingMessage;

const ask = (
  allowlist: string | string[],
  origin?: string,
): { err: string | null; ok: boolean } => {
  let captured: { err: string | null; ok: boolean } = { err: null, ok: false };
  originGuard(allowlist)(requestFrom(origin), (err, ok) => {
    captured = { err, ok };
  });
  return captured;
};

describe('resolveCorsOrigin', () => {
  it('falls back to the Vite dev server when CORS_ORIGIN is unset', () => {
    expect(resolveCorsOrigin(configWith())).toBe(DEFAULT_CORS_ORIGIN);
  });

  it('returns a single origin as a string', () => {
    expect(resolveCorsOrigin(configWith('https://app.example'))).toBe(
      'https://app.example',
    );
  });

  it('parses a comma-separated list into trimmed origins', () => {
    expect(
      resolveCorsOrigin(
        configWith('https://app.example, https://tunnel.example'),
      ),
    ).toEqual(['https://app.example', 'https://tunnel.example']);
  });
});

describe('originGuard (the CSWSH control)', () => {
  // socket.io's `cors` option only governs the polling transport; the raw WebSocket upgrade is not
  // subject to CORS at all. `allowRequest` is what closes that hole, on EVERY transport.
  it('accepts an allowlisted origin', () => {
    expect(ask('https://app.example', 'https://app.example')).toEqual({
      err: null,
      ok: true,
    });
  });

  it('rejects a foreign origin with FORBIDDEN_ORIGIN', () => {
    expect(ask('https://app.example', 'https://evil.example')).toEqual({
      err: REALTIME_ERRORS.forbiddenOrigin,
      ok: false,
    });
  });

  it('allows a MISSING Origin — a same-origin XHR omits it and a browser cannot suppress it on an upgrade', () => {
    expect(ask('https://app.example', undefined)).toEqual({
      err: null,
      ok: true,
    });
  });

  it('is exact-match: a prefix, a suffix or a different port is NOT allowlisted', () => {
    const allow = 'https://app.example';
    expect(ask(allow, 'https://app.example.evil.com').ok).toBe(false);
    expect(ask(allow, 'https://app.example:8443').ok).toBe(false);
    expect(ask(allow, 'http://app.example').ok).toBe(false);
    expect(ask(allow, 'https://app.example/').ok).toBe(false);
  });

  it('accepts every member of a comma-separated CORS_ORIGIN, parsed identically to HTTP CORS', () => {
    const allowlist = resolveCorsOrigin(
      configWith('http://localhost:2200, https://tunnel.example'),
    );

    expect(ask(allowlist, 'http://localhost:2200').ok).toBe(true);
    expect(ask(allowlist, 'https://tunnel.example').ok).toBe(true);
    expect(ask(allowlist, 'https://evil.example').ok).toBe(false);
  });

  it('never wildcards: "*" as an Origin is just another foreign origin', () => {
    expect(ask('https://app.example', '*').ok).toBe(false);
  });
});

/**
 * A minimal stand-in for `socket.io`'s `Server`, faithful in the two ways that matter here:
 *
 * - `of(name)` creates the namespace on demand and emits `new_namespace` for **every name except
 *   `/`** (socket.io guards on `name !== "/"`), which is exactly why `sealNamespaces` has to seal
 *   `/` explicitly;
 * - `on(event, cb)` registers on the `/` namespace's emitter, because socket.io redirects
 *   `Server.prototype.on` to `this.sockets` (which IS `/`).
 *
 * `sealNamespaces` is tested directly against this rather than through a mocked `INestApplication`:
 * building a fake Nest app to reach `createIOServer` would be mocking the framework to test five
 * lines of ours, and `createIOServer`'s real wiring is covered by `test/realtime.e2e-spec.ts`.
 */
interface FakeNamespace {
  name: string;
  /** The middleware array — socket.io's `_fns`. */
  fns: SocketMiddleware[];
  use(fn: SocketMiddleware): void;
}

const fakeIo = () => {
  const listeners: Array<(namespace: FakeNamespace) => void> = [];
  const namespaces = new Map<string, FakeNamespace>();

  const makeNamespace = (name: string): FakeNamespace => {
    const fns: SocketMiddleware[] = [];
    return {
      name,
      fns,
      use: (fn: SocketMiddleware) => {
        fns.push(fn);
      },
    };
  };

  const root = makeNamespace('/');
  namespaces.set('/', root);

  const io = {
    of(name: string): FakeNamespace {
      const existing = namespaces.get(name);
      if (existing) return existing;

      const namespace = makeNamespace(name);
      namespaces.set(name, namespace);
      if (name !== '/') {
        for (const listener of listeners) listener(namespace);
      }
      return namespace;
    },
    on(_event: 'new_namespace', cb: (namespace: FakeNamespace) => void) {
      listeners.push(cb);
      return io;
    },
  };

  return { io: io as unknown as Server, root, of: (n: string) => io.of(n) };
};

/** Runs a namespace middleware and reports exactly what it handed to `next`. */
const invoke = (fn: SocketMiddleware): Array<Error | undefined> => {
  const seen: Array<Error | undefined> = [];
  fn({} as Socket, (err?: Error) => seen.push(err));
  return seen;
};

describe('sealNamespaces (the fail-closed namespace allowlist)', () => {
  it('seals "/" explicitly — socket.io never emits new_namespace for it', () => {
    const { io, root } = fakeIo();

    sealNamespaces(io);

    expect(root.fns).toHaveLength(1);
  });

  it('the installed middleware always rejects with UNAUTHENTICATED and never calls next() cleanly', () => {
    const { io, root } = fakeIo();
    sealNamespaces(io);

    const seen = invoke(root.fns[0]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
    expect(seen[0]?.message).toBe(REALTIME_ERRORS.unauthenticated);
    expect(seen).not.toContain(undefined);
  });

  it('is a strict NO-OP for an allowlisted namespace — /admin gains zero middleware', () => {
    // The constraint that keeps the happy path byte-identical: no second cookieParser, no second
    // session read, no added latency on /admin's handshake.
    const { io, of } = fakeIo();
    sealNamespaces(io);

    const admin = of(REALTIME_ADMIN_NAMESPACE);

    expect(admin.fns).toHaveLength(0);
  });

  it('fails closed for a namespace that is NOT allowlisted, with the same code', () => {
    const { io, of } = fakeIo();
    sealNamespaces(io);

    const future = of('/future-gateway');

    expect(future.fns).toHaveLength(1);
    expect(invoke(future.fns[0])[0]?.message).toBe(
      REALTIME_ERRORS.unauthenticated,
    );
  });

  it('arms the new_namespace listener DURING the call, so namespaces created later are still caught', () => {
    const { io, of } = fakeIo();
    // Created before the seal: still open, because nothing has run yet.
    const early = of('/early');
    expect(early.fns).toHaveLength(0);

    sealNamespaces(io);
    const late = of('/late');

    expect(late.fns).toHaveLength(1);
    expect(invoke(late.fns[0])[0]?.message).toBe(
      REALTIME_ERRORS.unauthenticated,
    );
  });

  it('the no-op is unconditional: sealing an allowlisted namespace twice still leaves it empty', () => {
    const { io, of } = fakeIo();
    sealNamespaces(io);
    sealNamespaces(io);

    const admin = of(REALTIME_ADMIN_NAMESPACE);

    expect(admin.fns).toHaveLength(0);
  });

  it('REALTIME_NAMESPACE_ALLOWLIST is exactly ["/admin"] — widening it must be a reviewed diff', () => {
    expect(REALTIME_NAMESPACE_ALLOWLIST).toEqual([REALTIME_ADMIN_NAMESPACE]);
  });
});
