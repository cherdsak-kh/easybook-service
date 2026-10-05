import { SESSION_ABSOLUTE_MAX_AGE_MS } from '../auth.constants';

/**
 * LOGIN-SESSIONS-1 — constants shared by the session tracker, the login log and the DTOs.
 * Design: `claude_planning/feature/20261004_2055_login_sessions_and_revocation/02_design_log.md` §2.2.
 */

export const DEVICE_TYPES = ['desktop', 'tablet', 'phone', 'unknown'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const UA_OS = [
  'Windows',
  'macOS',
  'iOS',
  'iPadOS',
  'Android',
  'ChromeOS',
  'Linux',
] as const;
export type UaOs = (typeof UA_OS)[number];

export const UA_BROWSERS = [
  'LINE',
  'Edge',
  'Opera',
  'Samsung Internet',
  'Firefox',
  'Chrome',
  'Safari',
] as const;
export type UaBrowser = (typeof UA_BROWSERS)[number];

/** Exactly 10, 20 or 50 — anything else is a 400, never clamped (the announcements convention). */
export const LOGIN_HISTORY_PAGE_SIZES = [10, 20, 50] as const;

/** Login rows older than this are purged daily AND filtered out of every read (AC-19). */
export const LOGIN_LOG_RETENTION_DAYS = 90;

export const USER_AGENT_MAX_LENGTH = 512;
export const IP_MAX_LENGTH = 64;

/**
 * TTL of the per-user index Set: the absolute session cap plus a minute, re-armed at every login.
 * Every member is past its absolute cap (i.e. not live) by `lastLogin + 24h`, so the index can never
 * expire while it still references a live session (design §1.4.2).
 */
export const SESSION_INDEX_TTL_SECONDS =
  SESSION_ABSOLUTE_MAX_AGE_MS / 1000 + 60; // 86_460

export const SESSION_NOT_FOUND = 'Session not found.';
export const CANNOT_REVOKE_CURRENT_SESSION =
  'The current session cannot be revoked here. Use logout instead.';
