export type ProviderConfiguredVia = 'env' | 'secrets' | 'subscription' | 'anonymous';
export type ProviderAuthMode = 'anonymous' | 'api-key' | 'none' | 'oauth';

export interface ProviderAuthRoute {
  readonly route: string;
  readonly label: string;
  readonly configured: boolean;
  readonly usable: boolean;
  readonly detail?: string;
  readonly envVars: readonly string[];
  readonly repairHints: readonly string[];
}

export interface ProviderModelRef {
  readonly registryKey: string;
  readonly provider: string;
  readonly id: string;
}

export interface ProviderModelEntry {
  readonly id: string;
  readonly registryKey: string;
  readonly provider: string;
  readonly label?: string;
  readonly contextWindow?: number;
  readonly selectable?: boolean;
}

export interface ProviderEntry {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly configuredVia?: ProviderConfiguredVia;
  readonly authMode?: ProviderAuthMode;
  readonly usable: boolean;
  readonly local: boolean;
  readonly detail?: string;
  readonly envVars: readonly string[];
  readonly routes: readonly ProviderAuthRoute[];
  readonly models: readonly ProviderModelEntry[];
}

export interface ListProvidersResponse {
  readonly providers: readonly ProviderEntry[];
  readonly currentModel: ProviderModelRef | null;
}

export interface CurrentModelResponse {
  readonly model: ProviderModelRef | null;
  readonly configured: boolean;
  readonly configuredVia?: ProviderConfiguredVia;
}

export interface PatchCurrentModelResponse extends CurrentModelResponse {
  readonly persisted: boolean;
}

export interface PatchCurrentModelError {
  readonly error: string;
  readonly code:
    | 'INVALID_REQUEST'
    | 'MODEL_NOT_FOUND'
    | 'PROVIDER_NOT_CONFIGURED'
    | 'SET_MODEL_FAILED';
  readonly missingEnvVars?: readonly string[];
}
