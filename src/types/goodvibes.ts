import type { RuntimeEventRecord } from '@pellux/goodvibes-sdk';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk/contracts';
import type { ReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
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
} from './companion-chat';
import type {
  CurrentModelResponse,
  ListProvidersResponse,
  PatchCurrentModelError,
  PatchCurrentModelResponse,
} from './provider-model';

export type GoodVibesSdk = ReactNativeGoodVibesSdk;
export type GoodVibesAuthContext = OperatorMethodOutput<'control.auth.current'>;
export type GoodVibesControlSnapshot = OperatorMethodOutput<'control.snapshot'>;
export type GoodVibesTasksSnapshot = OperatorMethodOutput<'tasks.list'>;
export type GoodVibesSessionsSnapshot = OperatorMethodOutput<'sessions.list'>;
export type GoodVibesApprovalsSnapshot = OperatorMethodOutput<'approvals.list'>;
export type GoodVibesSessionMessagesSnapshot = OperatorMethodOutput<'sessions.messages.list'>;
export type GoodVibesSessionInputsSnapshot = OperatorMethodOutput<'sessions.inputs.list'>;
export type GoodVibesSessionFollowUpResult = OperatorMethodOutput<'sessions.followUp'>;
export type GoodVibesSessionMessageSubmitResult = OperatorMethodOutput<'sessions.messages.create'>;
export type GoodVibesSessionCreateResult = OperatorMethodOutput<'sessions.create'>;

export type GoodVibesSessionRecord = GoodVibesSessionsSnapshot['sessions'][number];
export type GoodVibesTaskRecord = GoodVibesTasksSnapshot['tasks'][number];
export type GoodVibesApprovalRecord = GoodVibesApprovalsSnapshot['approvals'][number];
export type GoodVibesSessionMessageRecord = GoodVibesSessionMessagesSnapshot['messages'][number];
export type GoodVibesSessionInputRecord = GoodVibesSessionInputsSnapshot['inputs'][number];

export type GoodVibesCompanionChatSession = CompanionChatSession;
export type GoodVibesCompanionChatMessage = CompanionChatMessage;
export type GoodVibesCompanionChatTurnEvent = CompanionChatTurnEvent;
export type GoodVibesCreateCompanionChatSessionInput = CreateCompanionChatSessionInput;
export type GoodVibesCreateCompanionChatSessionOutput = CreateCompanionChatSessionOutput;
export type GoodVibesGetCompanionChatSessionOutput = GetCompanionChatSessionOutput;
export type GoodVibesPostCompanionChatMessageInput = PostCompanionChatMessageInput;
export type GoodVibesPostCompanionChatMessageOutput = PostCompanionChatMessageOutput;
export type GoodVibesUpdateCompanionChatSessionInput = UpdateCompanionChatSessionInput;
export type GoodVibesUpdateCompanionChatSessionOutput = UpdateCompanionChatSessionOutput;
export type GoodVibesProvidersCatalog = ListProvidersResponse;
export type GoodVibesCurrentModelResponse = CurrentModelResponse;
export type GoodVibesPatchCurrentModelResponse = PatchCurrentModelResponse;
export type GoodVibesPatchCurrentModelError = PatchCurrentModelError;
export type GoodVibesProviderEvent = Extract<
  RuntimeEventRecord,
  {
    type:
      | 'PROVIDERS_CHANGED'
      | 'PROVIDER_WARNING'
      | 'MODEL_FALLBACK'
      | 'MODEL_CHANGED';
  }
>;

export interface GoodVibesCompanionChatTurnState {
  readonly sessionId: string;
  readonly userMessageId: string | null;
  readonly turnId: string | null;
  readonly status: 'waiting' | 'error';
  readonly error: string | null;
  readonly submittedAt: number;
  readonly updatedAt: number;
}

export interface GoodVibesSharedSessionTurnState {
  readonly sessionId: string;
  readonly userMessageId: string | null;
  readonly turnId: string | null;
  readonly status: 'waiting' | 'streaming' | 'completed' | 'error';
  readonly error: string | null;
  readonly content: string | null;
  readonly submittedAt: number;
  readonly updatedAt: number;
}

export type AgentEvent =
  | { type: 'AGENT_SPAWNING'; agentId: string; taskId?: string; task: string }
  | { type: 'AGENT_RUNNING'; agentId: string; taskId?: string }
  | { type: 'AGENT_PROGRESS'; agentId: string; taskId?: string; progress: string }
  | { type: 'AGENT_COMPLETED'; agentId: string; taskId?: string; durationMs: number; output?: string }
  | { type: 'AGENT_FAILED'; agentId: string; taskId?: string; error: string; durationMs: number }
  | { type: 'AGENT_CANCELLED'; agentId: string; taskId?: string; reason?: string };

export type TaskEvent =
  | { type: 'TASK_CREATED'; taskId: string; agentId?: string; description: string; priority: number }
  | { type: 'TASK_STARTED'; taskId: string; agentId?: string }
  | { type: 'TASK_BLOCKED'; taskId: string; agentId?: string; reason: string }
  | { type: 'TASK_PROGRESS'; taskId: string; agentId?: string; progress: number; message?: string }
  | { type: 'TASK_COMPLETED'; taskId: string; agentId?: string; durationMs: number }
  | { type: 'TASK_FAILED'; taskId: string; agentId?: string; error: string; durationMs: number }
  | { type: 'TASK_CANCELLED'; taskId: string; agentId?: string; reason?: string };

export type ControlPlaneEvent =
  | { type: 'CONTROL_PLANE_CLIENT_CONNECTED'; clientId: string; clientKind: string; transport: string }
  | { type: 'CONTROL_PLANE_CLIENT_DISCONNECTED'; clientId: string; reason: string }
  | { type: 'CONTROL_PLANE_AUTH_GRANTED'; clientId: string; principalId: string; principalKind: string; scopes: string[] }
  | { type: 'CONTROL_PLANE_AUTH_REJECTED'; clientId: string; principalId: string; reason: string };

export type ActivityTone = 'accent' | 'success' | 'warn' | 'danger' | 'violet';

export interface ActivityEntry {
  readonly id: string;
  readonly domain: 'agents' | 'tasks' | 'control-plane' | 'providers' | 'app';
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly createdAt: number;
  readonly tone: ActivityTone;
}
