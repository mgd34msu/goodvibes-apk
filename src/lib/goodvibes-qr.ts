export type GoodVibesQrAuthMode = 'password' | 'token';

export interface GoodVibesQrPayload {
  readonly authMode: GoodVibesQrAuthMode;
  readonly baseUrl?: string;
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

interface ParsedQrFields {
  authMode?: GoodVibesQrAuthMode;
  baseUrl?: string;
  username?: string;
  password?: string;
  token?: string;
}

const BASE_URL_KEYS = ['baseUrl', 'base_url', 'daemonUrl', 'daemon_url', 'url', 'daemon'];
const USERNAME_KEYS = ['username', 'user', 'principal', 'login'];
const PASSWORD_KEYS = ['password', 'pass'];
const TOKEN_KEYS = ['token', 'bearer', 'bearerToken', 'bearer_token', 'accessToken', 'access_token'];
const AUTH_MODE_KEYS = ['authMode', 'auth_mode', 'mode', 'auth'];

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeAuthMode(value: unknown): GoodVibesQrAuthMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'password' || normalized === 'basic') return 'password';
  if (normalized === 'token' || normalized === 'bearer') return 'token';
  return undefined;
}

function flattenRecord(record: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record };

  const auth = record.auth;
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    Object.assign(next, auth as Record<string, unknown>);
  }

  const daemon = record.daemon;
  if (daemon && typeof daemon === 'object' && !Array.isArray(daemon)) {
    Object.assign(next, daemon as Record<string, unknown>);
  }

  return next;
}

function parseObjectPayload(record: Record<string, unknown>): ParsedQrFields {
  const flattened = flattenRecord(record);
  return {
    authMode: normalizeAuthMode(pickString(flattened, AUTH_MODE_KEYS)),
    baseUrl: pickString(flattened, BASE_URL_KEYS),
    username: pickString(flattened, USERNAME_KEYS),
    password: pickString(flattened, PASSWORD_KEYS),
    token: pickString(flattened, TOKEN_KEYS),
  };
}

function parseJsonPayload(raw: string): ParsedQrFields | null {
  if (!raw.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parseObjectPayload(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function parseQueryPayload(raw: string): ParsedQrFields | null {
  const normalized = raw.includes('\n')
    ? raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join('&')
    : raw;

  if (!normalized.includes('=')) return null;

  const params = new URLSearchParams(normalized.startsWith('?') ? normalized.slice(1) : normalized);
  const record = Object.fromEntries(params.entries());
  return parseObjectPayload(record);
}

function parseUrlPayload(raw: string): ParsedQrFields | null {
  try {
    const url = new URL(raw);
    const record: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());

    if ((url.protocol === 'http:' || url.protocol === 'https:') && Object.keys(record).length > 0) {
      record.baseUrl ??= `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    }

    return parseObjectPayload(record);
  } catch {
    return null;
  }
}

function inferAuthMode(fields: ParsedQrFields): GoodVibesQrAuthMode {
  if (fields.authMode) return fields.authMode;
  if (fields.token) return 'token';
  if (fields.password || fields.username) return 'password';
  return 'token';
}

export function parseGoodVibesQrPayload(raw: string): GoodVibesQrPayload {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('QR code was empty.');
  }

  const fields = parseJsonPayload(trimmed) ?? parseUrlPayload(trimmed) ?? parseQueryPayload(trimmed);
  if (!fields) {
    throw new Error('QR code did not contain GoodVibes connection data.');
  }

  if (!fields.baseUrl && !fields.username && !fields.password && !fields.token) {
    throw new Error('QR code did not include any supported GoodVibes fields.');
  }

  return {
    authMode: inferAuthMode(fields),
    baseUrl: fields.baseUrl,
    username: fields.username,
    password: fields.password,
    token: fields.token,
  };
}
