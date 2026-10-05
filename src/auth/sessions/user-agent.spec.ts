import { parseUserAgent, sanitizeUa } from './user-agent';
import type { ParsedUserAgent } from './user-agent';

const UNKNOWN: ParsedUserAgent = {
  deviceType: 'unknown',
  os: null,
  osVersion: null,
  browser: null,
  browserVersion: null,
};

const row = (
  deviceType: ParsedUserAgent['deviceType'],
  os: ParsedUserAgent['os'],
  osVersion: string | null,
  browser: ParsedUserAgent['browser'],
  browserVersion: string | null,
): ParsedUserAgent => ({
  deviceType,
  os,
  osVersion,
  browser,
  browserVersion,
});

const TABLE: Array<[string, string, ParsedUserAgent]> = [
  [
    'Chrome on Windows 10/11 (osVersion is null: not distinguishable)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    row('desktop', 'Windows', null, 'Chrome', '128'),
  ],
  [
    'Chrome on Windows 7',
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
    row('desktop', 'Windows', '7', 'Chrome', '109'),
  ],
  [
    'Edge (Edg/) is not Chrome',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42',
    row('desktop', 'Windows', null, 'Edge', '128'),
  ],
  [
    'Opera (OPR/) is not Chrome',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0',
    row('desktop', 'Windows', null, 'Opera', '113'),
  ],
  [
    'Samsung Internet is not Chrome',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    row('phone', 'Android', '14', 'Samsung Internet', '25'),
  ],
  [
    'Firefox on Ubuntu is Linux',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
    row('desktop', 'Linux', null, 'Firefox', '129'),
  ],
  [
    'Safari on macOS (version frozen, so osVersion null)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    row('desktop', 'macOS', null, 'Safari', '17'),
  ],
  [
    'iPadOS desktop-mode Safari sends a Macintosh UA and parses as desktop/macOS (accepted, plan 4.2)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    row('desktop', 'macOS', null, 'Safari', '17'),
  ],
  [
    'iPad Safari',
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    row('tablet', 'iPadOS', '17', 'Safari', '17'),
  ],
  [
    'iPhone Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    row('phone', 'iOS', '17', 'Safari', '17'),
  ],
  [
    'iPhone LINE in-app browser is LINE, not Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0',
    row('phone', 'iOS', '17', 'LINE', '14'),
  ],
  [
    'Android LINE in-app browser is LINE, not Chrome',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 Line/14.9.1/IAB',
    row('phone', 'Android', '14', 'LINE', '14'),
  ],
  [
    'Android Chrome with a UA-reduced OS token (Android 10; K) has no honest version',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    row('phone', 'Android', null, 'Chrome', '128'),
  ],
  [
    'Firefox on Android 14',
    'Mozilla/5.0 (Android 14; Mobile; rv:129.0) Gecko/129.0 Firefox/129.0',
    row('phone', 'Android', '14', 'Firefox', '129'),
  ],
  [
    'an Android UA without "Mobile" is a tablet',
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    row('tablet', 'Android', '13', 'Chrome', '128'),
  ],
  [
    'Chrome on iOS (CriOS)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1',
    row('phone', 'iOS', '17', 'Chrome', '128'),
  ],
  [
    'Firefox on iOS (FxiOS)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15',
    row('phone', 'iOS', '17', 'Firefox', '129'),
  ],
  [
    'Edge on iOS (EdgiOS) is Edge although it also carries Version/ and Safari/',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/128.2739.50 Mobile/15E148 Safari/605.1.15',
    row('phone', 'iOS', '17', 'Edge', '128'),
  ],
  [
    'ChromeOS',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    row('desktop', 'ChromeOS', null, 'Chrome', '128'),
  ],
  [
    "Safari 26 freezes the iOS token at 18_6, so Safari's own Version/ is the iOS version",
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    row('phone', 'iOS', '26', 'Safari', '26'),
  ],
];

describe('parseUserAgent', () => {
  it.each(TABLE)('%s', (_label, ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['garbage', 'garbage'],
  ])('%s parses as unknown', (_label, input) => {
    expect(parseUserAgent(input)).toEqual(UNKNOWN);
  });

  it('never throws on a 10,000-char input, and answers fast (input is cut before any regex)', () => {
    const hostile = `${'(('.repeat(5000)} Chrome/9`;
    const started = Date.now();
    expect(() => parseUserAgent(hostile)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('does not read past 512 characters', () => {
    // A browser token placed after the cut must not be seen.
    const ua = `${'x'.repeat(512)} Firefox/129.0`;
    expect(parseUserAgent(ua)).toEqual(UNKNOWN);
  });

  it('returns a fresh object each time, so a caller cannot mutate the shared UNKNOWN', () => {
    const a = parseUserAgent('');
    a.os = 'Linux';
    expect(parseUserAgent('')).toEqual(UNKNOWN);
  });
});

describe('sanitizeUa', () => {
  it('turns a missing header into an empty string', () => {
    expect(sanitizeUa(undefined)).toBe('');
    expect(sanitizeUa(null)).toBe('');
  });

  it('strips control characters and truncates to 512', () => {
    expect(sanitizeUa('Mozilla\r\n\t/5.0\u0000')).toBe('Mozilla/5.0');
    expect(sanitizeUa('a'.repeat(600))).toHaveLength(512);
  });
});
