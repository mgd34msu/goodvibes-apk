import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GoodVibesTokenStore } from '@pellux/goodvibes-sdk/auth';
import type { ReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
import * as Keychain from 'react-native-keychain';
import type {
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatTurnEvent,
  CreateCompanionChatSessionInput,
  CreateCompanionChatSessionOutput,
  GetCompanionChatSessionOutput,
  PostCompanionChatMessageInput,
  PostCompanionChatMessageOutput,
  UpdateCompanionChatSessionInput,
  UpdateCompanionChatSessionOutput,
} from '../types/companion-chat';
import type {
  CurrentModelResponse,
  ListProvidersResponse,
  PatchCurrentModelResponse,
  ProviderAuthRoute,
  ProviderConfiguredVia,
  ProviderEntry,
} from '../types/provider-model';

const TOKEN_KEY = 'goodvibes.companion.token';
const BASE_URL_KEY = 'goodvibes.companion.base-url';
const TOKEN_SERVICE = 'com.pellux.goodvibescompanion.auth';
const CHAT_SESSION_IDS_KEY_PREFIX = 'goodvibes.companion.chat-session-ids.';
const SELECTED_CHAT_SESSION_ID_KEY_PREFIX =
  'goodvibes.companion.chat-session-selected.';

export const MOBILE_SURFACE_KIND = 'web';
export const MOBILE_SURFACE_ID = 'goodvibes-mobile-companion';

export interface GoodVibesAuthProbeResult {
  readonly authenticated: boolean;
  readonly authMode?: string;
  readonly authorizationHeaderPresent?: boolean;
  readonly principalId?: string;
  readonly scopes?: readonly string[];
}

export interface CreateMobileGoodVibesSdkOptions {
  readonly authToken?: string | null;
}

export interface GoodVibesSseEvent {
  readonly id: string | null;
  readonly event: string;
  readonly data: unknown;
}

export interface GoodVibesSseStream {
  close(): void;
}

export interface OpenAuthorizedSseOptions {
  readonly onOpen?: () => void;
  readonly onEvent: (event: GoodVibesSseEvent) => void;
  readonly onError?: (error: Error) => void;
}

interface HttpError extends Error {
  readonly status: number;
}

function createHttpError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError;
  Object.defineProperty(error, 'status', {
    value: status,
    enumerable: true,
  });
  return error;
}

function createScopedStorageKey(prefix: string, baseUrl: string): string {
  return `${prefix}${encodeURIComponent(normalizeBaseUrl(baseUrl))}`;
}

async function readTokenFromKeychain(): Promise<string | null> {
  try {
    const credentials = await Keychain.getGenericPassword({
      service: TOKEN_SERVICE,
    });
    return credentials ? credentials.password : null;
  } catch {
    await Keychain.resetGenericPassword({
      service: TOKEN_SERVICE,
    }).catch(() => undefined);
    return null;
  }
}

async function writeTokenToKeychain(token: string | null): Promise<void> {
  if (!token) {
    await Keychain.resetGenericPassword({
      service: TOKEN_SERVICE,
    }).catch(() => undefined);
    return;
  }

  await Keychain.setGenericPassword(TOKEN_KEY, token, {
    service: TOKEN_SERVICE,
  });
}

function createMobileTokenStore(): GoodVibesTokenStore {
  return {
    async getToken() {
      return await readTokenFromKeychain();
    },
    async setToken(token) {
      await writeTokenToKeychain(token);
    },
    async clearToken() {
      await writeTokenToKeychain(null);
    },
  };
}

async function requestAuthorizedJson<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token.trim()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  const rawBody = await response.text();
  let parsedBody: unknown = null;

  if (rawBody.trim()) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  if (!response.ok) {
    if (typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody) {
      const message = (parsedBody as { readonly error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) {
        throw createHttpError(message.trim(), response.status);
      }
    }
    throw createHttpError(`Request failed [${response.status}]`, response.status);
  }

  if (parsedBody === null) {
    throw createHttpError('Request returned an empty response.', response.status);
  }

  return parsedBody as T;
}

function collectUniqueStrings(values: readonly (readonly string[] | undefined)[]): readonly string[] {
  return [...new Set(values.flatMap((entry) => entry ?? []).filter((value) => value.trim().length > 0))];
}

const PROVIDER_LABEL_MAP: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  inceptionlabs: 'Inception Labs',
  'amazon-bedrock': 'Amazon Bedrock',
  'amazon-bedrock-mantle': 'Amazon Bedrock (Mantle)',
  'anthropic-vertex': 'Anthropic (Vertex)',
  'github-copilot': 'GitHub Copilot',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  'ollama-cloud': 'Ollama Cloud',
  ollama: 'Ollama',
  'lm-studio': 'LM Studio',
  huggingface: 'Hugging Face',
  nvidia: 'NVIDIA',
  llm7: 'LLM7',
  perplexity: 'Perplexity',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs',
  microsoft: 'Microsoft',
  vydra: 'Vydra',
  byteplus: 'BytePlus',
  fal: 'fal.ai',
  comfy: 'ComfyUI',
  runway: 'Runway',
  alibaba: 'Alibaba Cloud',
  synthetic: 'Synthetic (Local)',
};

function formatProviderLabel(providerId: string): string {
  const trimmed = providerId.trim();
  if (!trimmed) {
    return 'Unknown';
  }
  if (PROVIDER_LABEL_MAP[trimmed]) {
    return PROVIDER_LABEL_MAP[trimmed];
  }
  return trimmed
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isPrivateNetworkHost(value: string): boolean {
  return /(?:^|[^0-9])(127\.0\.0\.1|localhost|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?:[^0-9]|$)/i.test(
    value,
  );
}

function isLikelyLocalProvider(
  providerId: string,
  label?: string,
  detail?: string,
): boolean {
  const haystack = [providerId, label ?? '', detail ?? '']
    .join(' ')
    .toLowerCase();
  return (
    haystack.includes('lm studio') ||
    haystack.includes('lm-studio') ||
    haystack.includes('ollama') ||
    haystack.includes('llama.cpp') ||
    haystack.includes('llama-cpp') ||
    haystack.includes('comfyui') ||
    haystack.includes('comfy ui') ||
    haystack.includes('comfy') ||
    haystack.includes('local provider') ||
    haystack.includes('local endpoint') ||
    haystack.includes('local server') ||
    isPrivateNetworkHost(haystack) ||
    haystack.includes('.local')
  );
}

function deriveProviderIdFromRegistryKey(registryKey: string | null | undefined): string | null {
  if (!registryKey?.trim()) {
    return null;
  }
  const normalized = registryKey.trim();
  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }
  return normalized.slice(0, separatorIndex);
}

function toStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      )
    : [];
}

function normalizeProviderRoute(route: unknown): ProviderAuthRoute | null {
  if (typeof route !== 'object' || route === null) {
    return null;
  }

  const record = route as Record<string, unknown>;
  const routeId =
    typeof record.route === 'string' && record.route.trim().length > 0
      ? record.route.trim()
      : null;
  const label =
    typeof record.label === 'string' && record.label.trim().length > 0
      ? record.label.trim()
      : routeId;
  if (!routeId || !label) {
    return null;
  }

  const freshness =
    typeof record.freshness === 'string' && record.freshness.trim().length > 0
      ? (record.freshness.trim() as ProviderAuthRoute['freshness'])
      : undefined;
  const providerId =
    typeof record.providerId === 'string' && record.providerId.trim().length > 0
      ? record.providerId.trim()
      : undefined;

  return {
    route: routeId,
    label,
    configured: Boolean(record.configured),
    usable:
      typeof record.usable === 'boolean'
        ? record.usable
        : Boolean(record.configured),
    ...(typeof record.detail === 'string' && record.detail.trim().length > 0
      ? { detail: record.detail.trim() }
      : {}),
    envVars: toStringArray(record.envVars),
    repairHints: toStringArray(record.repairHints),
    ...(freshness ? { freshness } : {}),
    ...(providerId ? { providerId } : {}),
  };
}

function normalizeProviderModels(
  providerId: string,
  models: unknown,
): readonly ProviderEntry['models'][number][] {
  if (!Array.isArray(models)) {
    return [];
  }

  return models
    .map((model) => {
      if (typeof model !== 'object' || model === null) {
        return null;
      }
      const record = model as Record<string, unknown>;
      const id =
        typeof record.id === 'string' && record.id.trim().length > 0
          ? record.id.trim()
          : null;
      const registryKey =
        typeof record.registryKey === 'string' && record.registryKey.trim().length > 0
          ? record.registryKey.trim()
          : id
            ? `${providerId}:${id}`
            : null;
      if (!id || !registryKey) {
        return null;
      }

      return {
        id,
        registryKey,
        provider: providerId,
        ...(typeof record.label === 'string' && record.label.trim().length > 0
          ? { label: record.label.trim() }
          : typeof record.displayName === 'string' &&
              record.displayName.trim().length > 0
            ? { label: record.displayName.trim() }
            : {}),
        ...(typeof record.contextWindow === 'number' && Number.isFinite(record.contextWindow)
          ? { contextWindow: record.contextWindow }
          : {}),
        ...(typeof record.selectable === 'boolean'
          ? { selectable: record.selectable }
          : {}),
      };
    })
    .filter(
      (
        model,
      ): model is ProviderEntry['models'][number] => model !== null,
    );
}

function normalizeProviderEntryLike(provider: unknown): ProviderEntry | null {
  if (typeof provider !== 'object' || provider === null) {
    return null;
  }

  const record = provider as Record<string, unknown>;
  const id =
    (typeof record.id === 'string' && record.id.trim().length > 0
      ? record.id.trim()
      : null) ??
    (typeof record.providerId === 'string' && record.providerId.trim().length > 0
      ? record.providerId.trim()
      : null);
  if (!id) {
    return null;
  }

  const routes = Array.isArray(record.routes)
    ? record.routes
        .map(normalizeProviderRoute)
        .filter((route): route is ProviderAuthRoute => route !== null)
    : [];
  const label =
    typeof record.label === 'string' && record.label.trim().length > 0
      ? record.label.trim()
      : formatProviderLabel(id);
  const envVars = toStringArray(record.envVars);
  const authMode =
    typeof record.authMode === 'string' && record.authMode.trim().length > 0
      ? record.authMode.trim()
      : null;
  const detail =
    typeof record.detail === 'string' && record.detail.trim().length > 0
      ? record.detail.trim()
      : undefined;
  const local =
    Boolean(record.local) || isLikelyLocalProvider(id, label, detail);
  const configured = Boolean(record.configured);
  const usable =
    typeof record.usable === 'boolean'
      ? record.usable
      : routes.some((route) => route.usable) ||
        authMode === 'anonymous' ||
        authMode === 'none' ||
        configured ||
        local;

  return {
    id,
    label,
    configured,
    ...(typeof record.configuredVia === 'string' &&
    record.configuredVia.trim().length > 0
      ? { configuredVia: record.configuredVia as ProviderConfiguredVia }
      : {}),
    ...(authMode
      ? { authMode: authMode as ProviderEntry['authMode'] }
      : local
        ? { authMode: 'anonymous' as const }
        : {}),
    usable,
    local,
    ...(detail ? { detail } : {}),
    envVars,
    routes,
    models: normalizeProviderModels(id, record.models),
  };
}

function normalizeCurrentModelRef(
  model: CurrentModelResponse['model'],
  providers: readonly ProviderEntry[],
): CurrentModelResponse['model'] {
  if (!model) {
    return null;
  }

  const matchesProvider = (providerId: string) =>
    providers.some((provider) => provider.id === providerId);

  const providerFromRegistryKey = deriveProviderIdFromRegistryKey(model.registryKey);
  const providerFromCatalog = providers.find((provider) =>
    provider.models.some(
      (entry) => entry.registryKey === model.registryKey || entry.id === model.id,
    ),
  )?.id;

  const normalizedProvider =
    (typeof model.provider === 'string' &&
    model.provider.trim().length > 0 &&
    model.provider !== 'unknown' &&
    matchesProvider(model.provider.trim())
      ? model.provider.trim()
      : null) ??
    (providerFromRegistryKey && matchesProvider(providerFromRegistryKey)
      ? providerFromRegistryKey
      : null) ??
    providerFromCatalog ??
    (typeof model.provider === 'string' && model.provider.trim().length > 0
      ? model.provider.trim()
      : 'unknown');

  return {
    ...model,
    provider: normalizedProvider,
  };
}

function deriveProviderConfiguredVia(
  authMode: string | undefined,
  configured: boolean,
  envVars: readonly string[],
): ProviderConfiguredVia | undefined {
  if (authMode === 'anonymous' || authMode === 'none') {
    return 'anonymous';
  }
  if (!configured) {
    return undefined;
  }
  return envVars.length ? 'env' : undefined;
}

function mapProviderEntry(provider: {
  readonly providerId: string;
  readonly runtime?: {
    readonly auth?: {
      readonly mode?: string;
      readonly configured?: boolean;
      readonly detail?: string;
      readonly envVars?: readonly string[];
      readonly routes?: readonly ({
        readonly route: string;
        readonly label: string;
        readonly configured: boolean;
        readonly usable?: boolean;
        readonly detail?: string;
        readonly envVars?: readonly string[];
        readonly repairHints?: readonly string[];
      } | null | undefined)[];
    };
    readonly policy?: {
      readonly local?: boolean;
    };
    readonly notes?: readonly string[];
  };
  readonly models: readonly {
    readonly id: string;
    readonly registryKey: string;
    readonly displayName: string;
    readonly selectable: boolean;
    readonly contextWindow: number;
  }[];
}): ProviderEntry {
  const auth = provider.runtime?.auth;
  const inferredLabel = formatProviderLabel(provider.providerId);
  const routes: readonly ProviderAuthRoute[] = (auth?.routes ?? [])
    .filter((route): route is NonNullable<typeof route> => Boolean(route))
    .map((route) => {
      const r = route as typeof route & {
        readonly freshness?: ProviderAuthRoute['freshness'];
        readonly providerId?: string;
      };
      return {
        route: route.route,
        label: route.label,
        configured: route.configured,
        usable: route.usable ?? route.configured,
        ...(route.detail ? { detail: route.detail } : {}),
        envVars: route.envVars ?? [],
        repairHints: route.repairHints ?? [],
        ...(r.freshness ? { freshness: r.freshness } : {}),
        ...(r.providerId ? { providerId: r.providerId } : {}),
      };
    });
  const envVars = collectUniqueStrings([auth?.envVars, ...routes.map((route) => route.envVars)]);
  const authMode = auth?.mode;
  const usable =
    routes.some((route) => route.usable) ||
    authMode === 'anonymous' ||
    authMode === 'none' ||
    Boolean(auth?.configured);
  const configured = usable || Boolean(auth?.configured);
  const detail =
    auth?.detail?.trim() ||
    routes.find((route) => route.detail?.trim())?.detail ||
    provider.runtime?.notes?.[0] ||
    undefined;
  const local =
    Boolean(provider.runtime?.policy?.local) ||
    isLikelyLocalProvider(provider.providerId, inferredLabel, detail);
  const configuredVia = deriveProviderConfiguredVia(authMode, configured, envVars);

  return {
    id: provider.providerId,
    label: inferredLabel,
    configured,
    ...(configuredVia ? { configuredVia } : {}),
    ...(authMode
      ? { authMode: authMode as ProviderEntry['authMode'] }
      : local
        ? { authMode: 'anonymous' as const }
        : {}),
    usable: usable || local,
    local,
    ...(detail ? { detail } : {}),
    envVars,
    routes,
    models: provider.models.map((model) => ({
      id: model.id,
      registryKey: model.registryKey,
      provider: provider.providerId,
      label: model.displayName,
      contextWindow: model.contextWindow,
      selectable: model.selectable,
    })),
  };
}

function parseSseEventData(rawData: string): unknown {
  if (!rawData.trim()) {
    return '';
  }
  try {
    return JSON.parse(rawData);
  } catch {
    return rawData;
  }
}

function extractCompleteSseFrames(buffer: string): {
  readonly frames: readonly string[];
  readonly rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const frames: string[] = [];
  let start = 0;
  let index = normalized.indexOf('\n\n', start);
  while (index >= 0) {
    frames.push(normalized.slice(start, index));
    start = index + 2;
    index = normalized.indexOf('\n\n', start);
  }
  return {
    frames,
    rest: normalized.slice(start),
  };
}

export function openAuthorizedSseStream(
  baseUrl: string,
  token: string,
  path: string,
  options: OpenAuthorizedSseOptions,
): GoodVibesSseStream {
  const xhr = new XMLHttpRequest();
  let closed = false;
  let opened = false;
  let processedLength = 0;
  let buffer = '';

  const emitFrame = (frame: string) => {
    const lines = frame.split('\n');
    let event = 'message';
    let id: string | null = null;
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim() || 'message';
        continue;
      }
      if (line.startsWith('id:')) {
        id = line.slice(3).trim() || null;
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (!dataLines.length && event === 'message') {
      return;
    }

    options.onEvent({
      id,
      event,
      data: parseSseEventData(dataLines.join('\n')),
    });
  };

  const flushProgress = () => {
    const nextText = xhr.responseText.slice(processedLength);
    if (!nextText) {
      return;
    }
    processedLength = xhr.responseText.length;
    buffer += nextText;
    const { frames, rest } = extractCompleteSseFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.trim().length) {
        emitFrame(frame);
      }
    }
  };

  const fail = (message: string) => {
    if (closed) {
      return;
    }
    options.onError?.(new Error(message));
  };

  xhr.onreadystatechange = () => {
    if (closed) {
      return;
    }
    if (xhr.readyState >= 2 && !opened) {
      opened = true;
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onOpen?.();
      } else {
        fail(`Unable to open SSE stream: ${xhr.status} [${xhr.status}]`);
      }
    }
    if (xhr.readyState === 4 && !closed) {
      flushProgress();
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(`SSE stream closed [${xhr.status}]`);
      } else {
        fail('SSE stream closed.');
      }
    }
  };

  xhr.onprogress = () => {
    if (!closed) {
      flushProgress();
    }
  };

  xhr.onerror = () => {
    fail(`SSE stream network error${xhr.status ? ` [${xhr.status}]` : ''}`);
  };

  xhr.open('GET', `${normalizeBaseUrl(baseUrl)}${path}`, true);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  xhr.setRequestHeader('Cache-Control', 'no-cache');
  xhr.setRequestHeader('Authorization', `Bearer ${token.trim()}`);
  xhr.send();

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      xhr.abort();
    },
  };
}

export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export async function readSavedToken(): Promise<string | null> {
  return await readTokenFromKeychain();
}

export async function saveToken(token: string | null): Promise<void> {
  await writeTokenToKeychain(token);
}

export async function clearSavedToken(): Promise<void> {
  await writeTokenToKeychain(null);
}

export async function createMobileGoodVibesSdk(
  baseUrl: string,
  options: CreateMobileGoodVibesSdkOptions = {},
): Promise<ReactNativeGoodVibesSdk> {
  const { createReactNativeGoodVibesSdk } = await import('@pellux/goodvibes-sdk/react-native');

  return createReactNativeGoodVibesSdk({
    baseUrl: normalizeBaseUrl(baseUrl),
    authToken: options.authToken ?? null,
    tokenStore: createMobileTokenStore(),
  });
}

export async function probeGoodVibesToken(
  baseUrl: string,
  token: string,
): Promise<GoodVibesAuthProbeResult> {
  return await requestAuthorizedJson<GoodVibesAuthProbeResult>(
    baseUrl,
    token,
    '/api/control-plane/auth',
    {
      method: 'GET',
    },
  );
}

export async function readSavedBaseUrl(): Promise<string | null> {
  return await AsyncStorage.getItem(BASE_URL_KEY);
}

export async function saveBaseUrl(baseUrl: string): Promise<void> {
  await AsyncStorage.setItem(BASE_URL_KEY, normalizeBaseUrl(baseUrl));
}

export async function readSavedCompanionChatSessionIds(
  baseUrl: string,
): Promise<readonly string[]> {
  const rawValue = await AsyncStorage.getItem(
    createScopedStorageKey(CHAT_SESSION_IDS_KEY_PREFIX, baseUrl),
  );
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

export async function saveCompanionChatSessionIds(
  baseUrl: string,
  sessionIds: readonly string[],
): Promise<void> {
  const key = createScopedStorageKey(CHAT_SESSION_IDS_KEY_PREFIX, baseUrl);
  const uniqueIds = [...new Set(sessionIds.filter((value) => value.trim().length > 0))];

  if (!uniqueIds.length) {
    await AsyncStorage.removeItem(key);
    return;
  }

  await AsyncStorage.setItem(key, JSON.stringify(uniqueIds));
}

export async function readSavedSelectedCompanionChatSessionId(
  baseUrl: string,
): Promise<string | null> {
  const value = await AsyncStorage.getItem(
    createScopedStorageKey(SELECTED_CHAT_SESSION_ID_KEY_PREFIX, baseUrl),
  );
  return value && value.trim() ? value : null;
}

export async function saveSelectedCompanionChatSessionId(
  baseUrl: string,
  sessionId: string | null,
): Promise<void> {
  const key = createScopedStorageKey(SELECTED_CHAT_SESSION_ID_KEY_PREFIX, baseUrl);
  if (!sessionId?.trim()) {
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, sessionId.trim());
}

export async function createCompanionChatSession(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
  input: CreateCompanionChatSessionInput = {},
): Promise<CreateCompanionChatSessionOutput> {
  return await sdk.operator.transport.requestJson<CreateCompanionChatSessionOutput>(
    '/api/companion/chat/sessions',
    {
      method: 'POST',
      body: input,
    },
  );
}

export async function getCompanionChatSession(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
  sessionId: string,
): Promise<GetCompanionChatSessionOutput> {
  return await sdk.operator.transport.requestJson<GetCompanionChatSessionOutput>(
    `/api/companion/chat/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
    },
  );
}

export async function postCompanionChatMessage(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
  sessionId: string,
  input: PostCompanionChatMessageInput,
): Promise<PostCompanionChatMessageOutput> {
  return await sdk.operator.transport.requestJson<PostCompanionChatMessageOutput>(
    `/api/companion/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      body: input,
    },
  );
}

export async function listProviderCatalog(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
): Promise<ListProvidersResponse> {
  try {
    const [providerList, currentModel] = await Promise.all([
      sdk.operator.providers.list(),
      getCurrentProviderModel(sdk).catch(() => ({ model: null, configured: false })),
    ]);
    const mappedProviders = providerList.providers.map(mapProviderEntry);
    return {
      providers: mappedProviders,
      currentModel: normalizeCurrentModelRef(currentModel.model, mappedProviders),
    };
  } catch {
    const legacy = await sdk.operator.transport.requestJson<{
      readonly providers?: unknown;
      readonly currentModel?: CurrentModelResponse['model'];
    }>(
      '/api/providers',
      {
        method: 'GET',
      },
    );
    const providers = Array.isArray(legacy.providers)
      ? legacy.providers
          .map(normalizeProviderEntryLike)
          .filter((provider): provider is ProviderEntry => provider !== null)
      : [];
    return {
      providers,
      currentModel: normalizeCurrentModelRef(legacy.currentModel ?? null, providers),
    };
  }
}


export async function getCurrentProviderModel(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
): Promise<CurrentModelResponse> {
  return await sdk.operator.transport.requestJson<CurrentModelResponse>(
    '/api/providers/current',
    {
      method: 'GET',
    },
  );
}

/**
 * Shared/TUI flow ONLY. Mutates the daemon's global current model and emits
 * MODEL_CHANGED. Do NOT call this when changing the model for a remote
 * companion chat session — use {@link updateCompanionChatSession} instead.
 */
export async function switchCurrentProviderModel(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
  registryKey: string,
): Promise<PatchCurrentModelResponse> {
  return await sdk.operator.transport.requestJson<PatchCurrentModelResponse>(
    '/api/providers/current',
    {
      method: 'PATCH',
      body: { registryKey },
    },
  );
}

/**
 * Remote companion chat flow. Updates a single companion-owned chat session's
 * provider/model (and optional title/systemPrompt) without touching the global
 * daemon/TUI current model. Use this for the per-chat picker.
 */
export async function updateCompanionChatSession(
  sdk: Pick<ReactNativeGoodVibesSdk, 'operator'>,
  sessionId: string,
  input: UpdateCompanionChatSessionInput,
): Promise<UpdateCompanionChatSessionOutput> {
  return await sdk.operator.transport.requestJson<UpdateCompanionChatSessionOutput>(
    `/api/companion/chat/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      body: input,
    },
  );
}

function readStringField(
  value: unknown,
  key: string,
): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

export function isCompanionChatTurnEvent(
  eventName: string,
  payload: unknown,
): payload is CompanionChatTurnEvent {
  const sessionId = readStringField(payload, 'sessionId');
  if (!sessionId) {
    return false;
  }

  const type =
    readStringField(payload, 'type') ??
    (eventName.startsWith('companion-chat.')
      ? eventName.slice('companion-chat.'.length)
      : eventName);

  return [
    'turn.started',
    'turn.delta',
    'turn.tool_call',
    'turn.tool_result',
    'turn.completed',
    'turn.error',
  ].includes(type);
}

export type {
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatTurnEvent,
  CreateCompanionChatSessionInput,
  CreateCompanionChatSessionOutput,
  GetCompanionChatSessionOutput,
  PostCompanionChatMessageInput,
  PostCompanionChatMessageOutput,
  UpdateCompanionChatSessionInput,
  UpdateCompanionChatSessionOutput,
  CurrentModelResponse,
  ListProvidersResponse,
  PatchCurrentModelResponse,
};
