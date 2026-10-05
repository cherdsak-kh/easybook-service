import {
  USER_AGENT_MAX_LENGTH,
  type DeviceType,
  type UaBrowser,
  type UaOs,
} from './sessions.constants';

/**
 * In-house User-Agent parser (OQ-4: zero dependencies — `ua-parser-js` v2 is AGPL). Pure, never throws.
 *
 * It is applied at READ time to the raw string (live sessions carry it in Redis, history rows in
 * Postgres), so a parser fix improves past rows too and nothing parsed is ever stored.
 *
 * ⚠️ ORDER IS LOAD-BEARING in both tables below: iPad/iPhone must precede Mac (their UA says "like Mac OS X"),
 * Android must precede Linux (an Android UA contains "Linux"), and most Chromium skins carry `Chrome/`, so
 * LINE / Edge / Opera / Samsung must be tested before Chrome. The first match wins.
 *
 * ⚠️ DESCRIPTIVE ONLY. Nothing may ever compare a parsed value for authentication.
 */

export interface ParsedUserAgent {
  deviceType: DeviceType;
  os: UaOs | null;
  /** Major version only, a string of digits (or a Windows marketing number such as `8.1`); `null` when a UA cannot tell. */
  osVersion: string | null;
  browser: UaBrowser | null;
  /** Major version only. */
  browserVersion: string | null;
}

const UNKNOWN: ParsedUserAgent = {
  deviceType: 'unknown',
  os: null,
  osVersion: null,
  browser: null,
  browserVersion: null,
};

/** Windows NT → marketing version. `10.0` is deliberately absent: Windows 10 and 11 are not distinguishable. */
const WINDOWS_NT_VERSIONS: Readonly<Record<string, string>> = {
  '6.1': '7',
  '6.2': '8',
  '6.3': '8.1',
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Normalises the `User-Agent` header before it is stored: control characters stripped, truncated to
 * `USER_AGENT_MAX_LENGTH`, and a missing header becomes `''` (which parses as `unknown`).
 */
export function sanitizeUa(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(CONTROL_CHARS, '').slice(0, USER_AGENT_MAX_LENGTH);
}

const major = (match: RegExpMatchArray | null): string | null =>
  match?.[1] ?? null;

interface OsResult {
  os: UaOs;
  deviceType: DeviceType;
  osVersion: string | null;
  /** The raw major from the UA's OS token, kept for the Safari-26 rule. */
  rawIosMajor: number | null;
}

function parseOs(ua: string): OsResult | null {
  if (/\biPad\b/.test(ua)) {
    const v = major(ua.match(/OS (\d+)_/));
    return {
      os: 'iPadOS',
      deviceType: 'tablet',
      osVersion: v,
      rawIosMajor: v === null ? null : Number(v),
    };
  }
  if (/\b(?:iPhone|iPod)\b/.test(ua)) {
    const v = major(ua.match(/OS (\d+)_/));
    return {
      os: 'iOS',
      deviceType: 'phone',
      osVersion: v,
      rawIosMajor: v === null ? null : Number(v),
    };
  }
  if (/\bAndroid\b/.test(ua)) {
    return {
      os: 'Android',
      deviceType: /\bMobile\b/.test(ua) ? 'phone' : 'tablet',
      // Chrome's UA reduction freezes the token at `Android 10; K` — a number that is not true.
      osVersion: /Android 10; K\)/.test(ua)
        ? null
        : major(ua.match(/Android (\d+)/)),
      rawIosMajor: null,
    };
  }
  if (/\bCrOS\b/.test(ua)) {
    return {
      os: 'ChromeOS',
      deviceType: 'desktop',
      osVersion: null,
      rawIosMajor: null,
    };
  }
  const nt = ua.match(/\bWindows NT (\d+\.\d+)/);
  if (nt) {
    return {
      os: 'Windows',
      deviceType: 'desktop',
      osVersion: WINDOWS_NT_VERSIONS[nt[1]] ?? null,
      rawIosMajor: null,
    };
  }
  if (/\b(?:Macintosh|Mac OS X)\b/.test(ua)) {
    // Safari and Chrome freeze this at 10_15_7, so there is no honest version to report. An iPadOS >= 13
    // Safari in its default desktop mode lands here too and parses as desktop/macOS — accepted (plan §4.2).
    return {
      os: 'macOS',
      deviceType: 'desktop',
      osVersion: null,
      rawIosMajor: null,
    };
  }
  if (/\b(?:Linux|X11)\b/.test(ua)) {
    return {
      os: 'Linux',
      deviceType: 'desktop',
      osVersion: null,
      rawIosMajor: null,
    };
  }
  return null;
}

interface BrowserResult {
  browser: UaBrowser;
  browserVersion: string | null;
}

function parseBrowser(ua: string): BrowserResult | null {
  const table: ReadonlyArray<readonly [UaBrowser, RegExp]> = [
    // Case-sensitive on purpose: "Linux" has no "/", and the in-app browser token is exactly `Line/`.
    ['LINE', /\bLine\/(\d+)/],
    ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /\b(?:OPR|OPiOS)\/(\d+)/],
    ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
    ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
    // `Chromium/` does not match.
    ['Chrome', /\b(?:CriOS|Chrome)\/(\d+)/],
  ];
  for (const [browser, pattern] of table) {
    const v = ua.match(pattern);
    if (v) return { browser, browserVersion: v[1] };
  }
  const safariVersion = ua.match(/\bVersion\/(\d+)/);
  if (safariVersion && /\bSafari\//.test(ua)) {
    return { browser: 'Safari', browserVersion: safariVersion[1] };
  }
  return null;
}

/** Never throws; empty or garbage input is `UNKNOWN`. Input is cut to 512 chars before any regex runs. */
export function parseUserAgent(
  raw: string | null | undefined,
): ParsedUserAgent {
  try {
    if (typeof raw !== 'string' || raw.length === 0) return { ...UNKNOWN };
    const ua = raw.slice(0, USER_AGENT_MAX_LENGTH);

    const os = parseOs(ua);
    const browser = parseBrowser(ua);

    let osVersion = os?.osVersion ?? null;
    // Safari 26+ freezes the iOS token at `18_6`; Safari's own `Version/NN` then IS the iOS version.
    // Applied to Safari only: another iOS browser on iOS 26 carries the same frozen token, but its own
    // version says nothing about iOS, so it keeps the (possibly stale) token rather than a guess.
    if (
      os?.rawIosMajor === 18 &&
      browser?.browser === 'Safari' &&
      browser.browserVersion !== null &&
      Number(browser.browserVersion) >= 26
    ) {
      osVersion = browser.browserVersion;
    }

    if (!os && !browser) return { ...UNKNOWN };

    return {
      deviceType: os?.deviceType ?? 'unknown',
      os: os?.os ?? null,
      osVersion,
      browser: browser?.browser ?? null,
      browserVersion: browser?.browserVersion ?? null,
    };
  } catch {
    return { ...UNKNOWN };
  }
}
