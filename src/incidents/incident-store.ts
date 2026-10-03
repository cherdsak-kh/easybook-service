import type { Redis } from 'ioredis';
import { INCIDENT_CAP, INCIDENT_MAX_AGE_DAYS } from './incidents.constants';
import type {
  IncidentDetailRecord,
  IncidentDraftRecord,
  IncidentSummaryRecord,
} from './incident.types';

const DAY_MS = 86_400_000;

/**
 * The Hub 6 store: a capped Redis ring plus a detail hash (design §1.4, PO ruling OQ-P3-2).
 *
 * | Key (`<root>` = `eb:`, or `eb:test:` under jest)  | Type | Content                                   |
 * |----------------------------------------------------|------|-------------------------------------------|
 * | `<root>incident:ring`                              | LIST | summary JSON per incident, newest first   |
 * | `<root>incident:detail`                            | HASH | `id` -> detail JSON (stack + context)     |
 * | `<root>incident:seq`                               | STRING | `INCR` counter minting `ERR-<status>-<seq>` |
 *
 * 🔴 This class talks to the RAW ioredis client, never through `RedisService`. That is what keeps the
 * keys exactly as written above (`RedisService` would prefix `eb:cache:`), and it is what makes the
 * store non-recursive: `RedisService` reports its own failures to the recorder, so a store built on it
 * would try to record "Redis is down" by writing to Redis.
 *
 * Both Lua scripts run atomically, so a reader never sees a ring entry whose detail was already evicted
 * by the same call, and two instances cannot interleave a cap trim.
 */

const ADD_LUA = `
redis.call('LPUSH', KEYS[1], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[4])
local cap = tonumber(ARGV[5])
local cutoff = tonumber(ARGV[7]) - tonumber(ARGV[6])
for i = 1, 100 do
  local tail = redis.call('LINDEX', KEYS[1], -1)
  if not tail then break end
  local ok, rec = pcall(cjson.decode, tail)
  if not ok then
    redis.call('RPOP', KEYS[1])
  elseif tonumber(rec.atMs) < cutoff then
    redis.call('RPOP', KEYS[1])
    redis.call('HDEL', KEYS[2], rec.id)
  else
    break
  end
end
if redis.call('LLEN', KEYS[1]) > cap then
  local extra = redis.call('LRANGE', KEYS[1], cap, -1)
  for _, v in ipairs(extra) do
    local ok, rec = pcall(cjson.decode, v)
    if ok then redis.call('HDEL', KEYS[2], rec.id) end
  end
  redis.call('LTRIM', KEYS[1], 0, cap - 1)
end
redis.call('PEXPIRE', KEYS[1], ARGV[8])
redis.call('PEXPIRE', KEYS[2], ARGV[8])
return 1
`;

const PURGE_LUA = `
local all = redis.call('LRANGE', KEYS[1], 0, -1)
local kept = {}
local removed = 0
local cutoff = tonumber(ARGV[1])
for _, v in ipairs(all) do
  local ok, rec = pcall(cjson.decode, v)
  if ok and tonumber(rec.atMs) < cutoff then
    redis.call('HDEL', KEYS[2], rec.id)
    removed = removed + 1
  else
    kept[#kept + 1] = v
  end
end
if removed > 0 then
  redis.call('DEL', KEYS[1])
  local i = 1
  while i <= #kept do
    local j = math.min(i + 999, #kept)
    redis.call('RPUSH', KEYS[1], unpack(kept, i, j))
    i = j + 1
  end
  if #kept > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
end
return removed
`;

interface IncidentCommands {
  incidentAdd(
    ring: string,
    detail: string,
    id: string,
    atMs: string,
    summaryJson: string,
    detailJson: string,
    cap: number,
    maxAgeMs: number,
    nowMs: number,
    ttlMs: number,
  ): Promise<number>;
  incidentPurge(
    ring: string,
    detail: string,
    cutoffMs: number,
    ttlMs: number,
  ): Promise<number>;
}

export interface IncidentStoreOptions {
  cap?: number;
  maxAgeDays?: number;
}

export function summaryOf(rec: IncidentDetailRecord): IncidentSummaryRecord {
  return {
    id: rec.id,
    seq: rec.seq,
    traceId: rec.traceId,
    atMs: rec.atMs,
    severity: rec.severity,
    component: rec.component,
    status: rec.status,
    method: rec.method,
    path: rec.path,
    routeTemplate: rec.routeTemplate,
    message: rec.message,
    caller: rec.caller,
    ip: rec.ip,
  };
}

export class IncidentStore {
  readonly ringKey: string;
  readonly detailKey: string;
  readonly seqKey: string;
  private readonly cap: number;
  private readonly maxAgeMs: number;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: Redis,
    readonly root: string,
    options: IncidentStoreOptions = {},
  ) {
    this.ringKey = `${root}incident:ring`;
    this.detailKey = `${root}incident:detail`;
    this.seqKey = `${root}incident:seq`;
    this.cap = options.cap ?? INCIDENT_CAP;
    this.maxAgeMs = (options.maxAgeDays ?? INCIDENT_MAX_AGE_DAYS) * DAY_MS;
    this.ttlMs = this.maxAgeMs;
    redis.defineCommand('incidentAdd', { numberOfKeys: 2, lua: ADD_LUA });
    redis.defineCommand('incidentPurge', { numberOfKeys: 2, lua: PURGE_LUA });
  }

  private get cmd(): IncidentCommands {
    return this.redis as unknown as IncidentCommands;
  }

  /** Stores one redacted incident and returns its minted id. Rejects when Redis is unavailable. */
  async add(record: IncidentDraftRecord): Promise<string> {
    const seq = await this.redis.incr(this.seqKey);
    const id = `ERR-${record.status ?? 'SYS'}-${String(seq).padStart(4, '0')}`;
    const full: IncidentDetailRecord = { ...record, id, seq };
    await this.cmd.incidentAdd(
      this.ringKey,
      this.detailKey,
      id,
      String(record.atMs),
      JSON.stringify(summaryOf(full)),
      JSON.stringify(full),
      this.cap,
      this.maxAgeMs,
      Date.now(),
      this.ttlMs,
    );
    return id;
  }

  /** Every retained summary, newest first by `(atMs desc, seq desc)`. Entries past the age cap are dropped on read. */
  async list(now = Date.now()): Promise<IncidentSummaryRecord[]> {
    const raw = await this.redis.lrange(this.ringKey, 0, -1);
    const cutoff = now - this.maxAgeMs;
    const out: IncidentSummaryRecord[] = [];
    for (const entry of raw) {
      try {
        const rec = JSON.parse(entry) as IncidentSummaryRecord;
        if (rec.atMs >= cutoff) out.push(rec);
      } catch {
        // A corrupt entry is skipped, never a failed page.
      }
    }
    return out.sort((a, b) => b.atMs - a.atMs || b.seq - a.seq);
  }

  async detail(id: string): Promise<IncidentDetailRecord | null> {
    const raw = await this.redis.hget(this.detailKey, id);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as IncidentDetailRecord;
    } catch {
      return null;
    }
  }

  /** Removes every incident with `atMs < cutoffMs`. Idempotent; returns how many this call removed. */
  async purgeBefore(cutoffMs: number): Promise<number> {
    return this.cmd.incidentPurge(
      this.ringKey,
      this.detailKey,
      cutoffMs,
      this.ttlMs,
    );
  }
}
