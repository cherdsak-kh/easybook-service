import { HTTPFetchError } from '@line/bot-sdk';
import {
  classifyLineError,
  LineCallError,
  withTimeout,
  type LineErrorKind,
} from './line-call-error';

/** A real SDK error, carrying a body that must never leak (it can name recipients). */
const httpError = (status: number): HTTPFetchError =>
  new HTTPFetchError(`${status} - x`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{"message":"secret","details":[{"property":"to[0]"}]}',
  });

describe('classifyLineError (design §1.2)', () => {
  it.each<[number, LineErrorKind]>([
    [400, 'REJECTED'],
    [401, 'NOT_CONFIGURED'],
    [403, 'NOT_CONFIGURED'],
    [409, 'ALREADY_ACCEPTED'],
    [413, 'REJECTED'],
    [429, 'RATE_LIMITED'],
    [500, 'TRANSIENT'],
    [503, 'TRANSIENT'],
  ])('HTTP %i → %s, status carried', (status, kind) => {
    const e = classifyLineError(httpError(status));
    expect(e).toBeInstanceOf(LineCallError);
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
  });

  it('a network failure (fetch TypeError) → TRANSIENT, status null', () => {
    const e = classifyLineError(new TypeError('fetch failed'));
    expect(e.kind).toBe('TRANSIENT');
    expect(e.status).toBeNull();
  });

  it('a SyntaxError from parsing a 2xx body → TRANSIENT (the retry then gets 409 → accepted)', () => {
    expect(classifyLineError(new SyntaxError('Unexpected token')).kind).toBe(
      'TRANSIENT',
    );
  });

  it('a non-Error value → TRANSIENT', () => {
    expect(classifyLineError('boom').kind).toBe('TRANSIENT');
  });

  it('an existing LineCallError is returned unchanged', () => {
    const original = new LineCallError('NOT_CONFIGURED', null);
    expect(classifyLineError(original)).toBe(original);
  });

  it('never carries LINE’s response body in its message (D-C)', () => {
    for (const status of [400, 401, 409, 429, 500]) {
      const e = classifyLineError(httpError(status));
      expect(e.message).not.toContain('secret');
      expect(e.message).not.toContain('to[0]');
      expect(e.message).toBe(`LINE call failed: ${e.kind} (${status})`);
    }
    expect(new LineCallError('TRANSIENT', null).message).toBe(
      'LINE call failed: TRANSIENT',
    );
  });
});

describe('withTimeout (design S-2)', () => {
  afterEach(() => jest.useRealTimers());

  it('passes a settled value through and clears its timer', async () => {
    jest.useFakeTimers();
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes a rejection through unchanged', async () => {
    const err = new Error('x');
    await expect(withTimeout(Promise.reject(err), 1000)).rejects.toBe(err);
  });

  it('rejects TRANSIENT when the promise never settles in time', async () => {
    jest.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 1000);
    const assertion = expect(pending).rejects.toEqual(
      new LineCallError('TRANSIENT', null),
    );
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('a rejection arriving AFTER the timeout is not an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate!: (e: Error) => void;
      const late = new Promise<never>((_r, reject) => (rejectLate = reject));
      await expect(withTimeout(late, 5)).rejects.toBeInstanceOf(LineCallError);
      rejectLate(new Error('late'));
      // Let the microtask queue and one macrotask turn drain so Node would have reported it.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
