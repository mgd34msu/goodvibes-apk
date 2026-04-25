import { AppState } from "react-native";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  clearSavedToken,
  createCompanionChatSession,
  createMobileGoodVibesSdk,
  getCompanionChatSession,
  isCompanionChatTurnEvent,
  listProviderCatalog,
  MOBILE_SURFACE_ID,
  MOBILE_SURFACE_KIND,
  normalizeBaseUrl,
  openAuthorizedSseStream,
  postCompanionChatMessage,
  probeGoodVibesToken,
  readSavedBaseUrl,
  readSavedCompanionChatSessionIds,
  readSavedSelectedCompanionChatSessionId,
  readSavedToken,
  saveBaseUrl,
  saveCompanionChatSessionIds,
  saveSelectedCompanionChatSessionId,
  switchCurrentProviderModel,
  updateCompanionChatSession,
} from "../lib/goodvibes";
import type {
  ActivityEntry,
  AgentEvent,
  ControlPlaneEvent,
  GoodVibesApprovalsSnapshot,
  GoodVibesAuthContext,
  GoodVibesCompanionChatMessage,
  GoodVibesCompanionChatSession,
  GoodVibesCompanionChatTurnEvent,
  GoodVibesCompanionChatTurnState,
  GoodVibesControlSnapshot,
  GoodVibesPatchCurrentModelError,
  GoodVibesProviderEvent,
  GoodVibesProvidersCatalog,
  GoodVibesSdk,
  GoodVibesSharedSessionTurnState,
  GoodVibesSessionFollowUpResult,
  GoodVibesSessionInputRecord,
  GoodVibesSessionInputsSnapshot,
  GoodVibesSessionMessageRecord,
  GoodVibesSessionMessageSubmitResult,
  GoodVibesSessionMessagesSnapshot,
  GoodVibesSessionRecord,
  GoodVibesSessionsSnapshot,
  GoodVibesTasksSnapshot,
  TaskEvent,
} from "../types/goodvibes";
import type { ProviderModelRef } from "../types/provider-model";

export interface PasswordSignInInput {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
}

export interface TokenSignInInput {
  readonly baseUrl: string;
  readonly token: string;
}

export interface SessionSubmissionStatus {
  readonly sessionId: string;
  readonly inputId: string;
  readonly mode: GoodVibesSessionFollowUpResult["mode"];
  readonly state: GoodVibesSessionFollowUpResult["input"]["state"];
  readonly agentId: string | null;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error?: string;
}

interface SelectedSessionPayload {
  readonly session: GoodVibesSessionRecord | null;
  readonly messages: GoodVibesSessionMessagesSnapshot | null;
  readonly inputs: readonly GoodVibesSessionInputRecord[];
}

interface SelectedChatSessionPayload {
  readonly sessions: readonly GoodVibesCompanionChatSession[];
  readonly selectedSessionId: string | null;
  readonly session: GoodVibesCompanionChatSession | null;
  readonly messages: readonly GoodVibesCompanionChatMessage[];
}

interface CompanionConversationRouteResult {
  readonly messageId: string;
  readonly routedTo: "conversation";
}

type GoodVibesConversationMessageSubmitResult =
  | GoodVibesSessionMessageSubmitResult
  | CompanionConversationRouteResult;

export interface CompanionAppModel {
  readonly phase: "booting" | "signed-out" | "ready";
  readonly savedBaseUrl: string;
  readonly authenticating: boolean;
  readonly refreshing: boolean;
  readonly loadingSession: boolean;
  readonly loadingChatSession: boolean;
  readonly creatingChatSession: boolean;
  readonly pendingApprovalId: string | null;
  readonly sendingSessionId: string | null;
  readonly sendingChatSessionId: string | null;
  readonly chatTurnState: GoodVibesCompanionChatTurnState | null;
  readonly sharedSessionTurnState: GoodVibesSharedSessionTurnState | null;
  readonly providerCatalog: GoodVibesProvidersCatalog | null;
  readonly switchingModelKey: string | null;
  readonly settingChatModelSessionId: string | null;
  readonly pendingChatModel: ProviderModelRef | null;
  readonly error: string | null;
  readonly foreground: boolean;
  readonly lastUpdatedAt: number | null;
  readonly auth: GoodVibesAuthContext | null;
  readonly control: GoodVibesControlSnapshot | null;
  readonly tasks: GoodVibesTasksSnapshot | null;
  readonly sessions: GoodVibesSessionsSnapshot | null;
  readonly approvals: GoodVibesApprovalsSnapshot | null;
  readonly chatSessions: readonly GoodVibesCompanionChatSession[];
  readonly selectedChatSessionId: string | null;
  readonly selectedChatSession: GoodVibesCompanionChatSession | null;
  readonly chatMessages: readonly GoodVibesCompanionChatMessage[];
  readonly selectedSessionId: string | null;
  readonly selectedSession: GoodVibesSessionRecord | null;
  readonly sessionMessages: GoodVibesSessionMessagesSnapshot | null;
  readonly sessionInputs: readonly GoodVibesSessionInputRecord[];
  readonly sessionSubmission: SessionSubmissionStatus | null;
  readonly activity: readonly ActivityEntry[];
  signInWithPassword(input: PasswordSignInInput): Promise<boolean>;
  signInWithToken(input: TokenSignInInput): Promise<boolean>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  createChatSession(title?: string): Promise<string | null>;
  selectChatSession(sessionId: string): Promise<void>;
  sendChatMessage(sessionId: string | null, body: string): Promise<boolean>;
  selectSession(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, body: string): Promise<boolean>;
  sendFollowUp(sessionId: string, body: string): Promise<boolean>;
  /**
   * Shared/TUI flow ONLY. Mutates the daemon's global current model. Do not
   * call from a remote-chat context — use {@link setChatSessionModel} or
   * {@link setPendingChatModel} instead.
   */
  switchProviderModel(registryKey: string): Promise<void>;
  /**
   * Remote chat flow. Updates a single companion chat session's provider/model
   * without touching the global daemon/TUI current model.
   */
  setChatSessionModel(sessionId: string, registryKey: string): Promise<void>;
  /**
   * Remote chat flow. Stages a provider/model selection to be applied when the
   * user creates a new companion chat session. Cleared after creation.
   */
  setPendingChatModel(model: ProviderModelRef | null): void;
  approve(approvalId: string): Promise<void>;
  deny(approvalId: string): Promise<void>;
}

interface DashboardPayload {
  readonly auth: GoodVibesAuthContext;
  readonly control: GoodVibesControlSnapshot;
  readonly tasks: GoodVibesTasksSnapshot;
  readonly sessions: GoodVibesSessionsSnapshot;
  readonly approvals: GoodVibesApprovalsSnapshot;
  readonly providerCatalog: GoodVibesProvidersCatalog | null;
  readonly chatSessions: readonly GoodVibesCompanionChatSession[];
  readonly selectedChatSession: GoodVibesCompanionChatSession | null;
  readonly chatMessages: readonly GoodVibesCompanionChatMessage[];
  readonly selectedChatSessionId: string | null;
  readonly selectedSession: GoodVibesSessionRecord | null;
  readonly sessionMessages: GoodVibesSessionMessagesSnapshot | null;
  readonly sessionInputs: readonly GoodVibesSessionInputRecord[];
  readonly selectedSessionId: string | null;
}

const OPEN_SESSION_RECENCY_WINDOW_MS = 5 * 60_000;
const OPEN_SESSION_ACTIVITY_WINDOW_MS = 30 * 60_000;
const CHAT_TURN_SETTLE_TIMEOUT_MS = 90_000;

type ControlRecentEvent = GoodVibesControlSnapshot["recentEvents"][number];
type RecentCompanionChatTurnEvent = GoodVibesCompanionChatTurnEvent & {
  readonly createdAt: number;
};

function buildCompanionChatTitle(now = Date.now()): string {
  return (
    "Companion Chat " +
    new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(now)
  );
}

function compareCompanionChatActivity(
  left: GoodVibesCompanionChatSession,
  right: GoodVibesCompanionChatSession,
): number {
  return right.updatedAt - left.updatedAt;
}

function compareSessionMessages(
  left: GoodVibesSessionMessageRecord,
  right: GoodVibesSessionMessageRecord,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function readSessionMessageCorrelationId(
  message: GoodVibesSessionMessageRecord,
): string | null {
  const value = message.metadata?.messageId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getSessionMessageMergeKey(
  message: GoodVibesSessionMessageRecord,
): string {
  return readSessionMessageCorrelationId(message) ?? message.id;
}

function hasMatchingSessionMessage(
  messages: readonly GoodVibesSessionMessageRecord[],
  candidate: GoodVibesSessionMessageRecord,
): boolean {
  const candidateKey = getSessionMessageMergeKey(candidate);
  return messages.some(
    (message) =>
      message.id === candidate.id ||
      getSessionMessageMergeKey(message) === candidateKey,
  );
}

function mergeSessionMessages(
  messages: readonly GoodVibesSessionMessageRecord[],
  extras: readonly GoodVibesSessionMessageRecord[],
): readonly GoodVibesSessionMessageRecord[] {
  if (!extras.length) {
    return messages;
  }

  const merged = new Map<string, GoodVibesSessionMessageRecord>();
  for (const message of messages) {
    merged.set(getSessionMessageMergeKey(message), message);
  }
  for (const message of extras) {
    const key = getSessionMessageMergeKey(message);
    if (!merged.has(key)) {
      merged.set(key, message);
    }
  }

  return [...merged.values()].sort(compareSessionMessages);
}

function applySessionMessageToSession(
  session: GoodVibesSessionRecord,
  message: GoodVibesSessionMessageRecord,
  incrementCount = false,
): GoodVibesSessionRecord {
  const lastMessageAt = Math.max(session.lastMessageAt ?? 0, message.createdAt);
  return {
    ...session,
    updatedAt: Math.max(session.updatedAt, message.createdAt),
    lastMessageAt,
    ...(incrementCount ? { messageCount: session.messageCount + 1 } : {}),
  };
}

function hasPendingSharedSessionConversation(
  session: GoodVibesSessionRecord | null,
  messagesSnapshot: GoodVibesSessionMessagesSnapshot | null,
  now = Date.now(),
): boolean {
  if (
    !session ||
    session.status !== "active" ||
    !messagesSnapshot?.messages.length
  ) {
    return false;
  }

  const latestUserMessage = [...messagesSnapshot.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage) {
    return false;
  }

  const latestNonUserMessage = [...messagesSnapshot.messages]
    .reverse()
    .find((message) => message.role !== "user");
  if (
    latestNonUserMessage &&
    latestNonUserMessage.createdAt >= latestUserMessage.createdAt
  ) {
    return false;
  }

  return now - latestUserMessage.createdAt <= CHAT_TURN_SETTLE_TIMEOUT_MS;
}

function hasActiveCompanionChatTurn(
  turnState: GoodVibesCompanionChatTurnState | null,
  sessionId: string | null,
): boolean {
  return Boolean(
    turnState &&
      sessionId &&
      turnState.sessionId === sessionId &&
      turnState.status !== "error",
  );
}

function reconcileSharedSessionTurnState(
  turnState: GoodVibesSharedSessionTurnState | null,
  sessionId: string | null,
  session: GoodVibesSessionRecord | null,
  messagesSnapshot: GoodVibesSessionMessagesSnapshot | null,
  now = Date.now(),
): GoodVibesSharedSessionTurnState | null {
  if (!sessionId || !session || session.status !== "active") {
    return null;
  }

  const current =
    turnState && turnState.sessionId === sessionId ? turnState : null;
  if (!current) {
    return null;
  }

  const messages = messagesSnapshot?.messages ?? [];
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user") ?? null;
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role !== "user") ?? null;

  if (
    latestAssistantMessage &&
    latestUserMessage &&
    latestAssistantMessage.createdAt >= latestUserMessage.createdAt
  ) {
    return null;
  }

  if (
    latestUserMessage &&
    current.userMessageId &&
    latestUserMessage.id !== current.userMessageId &&
    latestUserMessage.createdAt >= current.submittedAt
  ) {
    return null;
  }

  if (
    (current.status === "waiting" || current.status === "streaming") &&
    now - current.updatedAt > CHAT_TURN_SETTLE_TIMEOUT_MS
  ) {
    return {
      ...current,
      status: "error",
      error: "Assistant turn timed out. Pull to refresh or retry.",
      updatedAt: now,
    };
  }

  return current;
}

function isCompanionChatMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = (error as { readonly status?: unknown }).status;
  return status === 404 || status === 410;
}

function getSessionActivityAt(session: GoodVibesSessionRecord): number {
  const participantSeenAt = session.participants.reduce(
    (latest, participant) => Math.max(latest, participant.lastSeenAt),
    0,
  );
  return Math.max(session.updatedAt, session.lastMessageAt ?? 0, participantSeenAt);
}

function compareSharedSessionActivity(
  left: GoodVibesSessionRecord,
  right: GoodVibesSessionRecord,
): number {
  const rightAt = getSessionActivityAt(right);
  const leftAt = getSessionActivityAt(left);
  if (rightAt !== leftAt) {
    return rightAt - leftAt;
  }
  return right.id.localeCompare(left.id);
}

function getIdleTuiSessionKey(session: GoodVibesSessionRecord): string | null {
  if (
    session.status !== "active" ||
    session.activeAgentId ||
    session.pendingInputCount > 0 ||
    session.messageCount > 0 ||
    session.routeIds.length > 0
  ) {
    return null;
  }

  const tuiParticipants = session.participants.filter(
    (participant) => participant.surfaceKind === "tui",
  );
  if (!tuiParticipants.length) {
    return null;
  }

  const primaryParticipant = tuiParticipants[0];
  if (!primaryParticipant) {
    return null;
  }
  const source =
    typeof session.metadata.source === "string" ? session.metadata.source : "";
  return [source, session.title, primaryParticipant.surfaceId].join("::");
}

function isSupersededIdleTuiSession(
  session: GoodVibesSessionRecord,
  sessions: readonly GoodVibesSessionRecord[],
): boolean {
  const key = getIdleTuiSessionKey(session);
  if (!key) {
    return false;
  }

  const newest = sessions
    .filter((candidate) => getIdleTuiSessionKey(candidate) === key)
    .sort(compareSharedSessionActivity)[0];
  return Boolean(newest && newest.id !== session.id);
}

function isSessionOpen(
  session: GoodVibesSessionRecord,
  sessions: readonly GoodVibesSessionRecord[],
  now = Date.now(),
): boolean {
  if (session.status !== "active") return false;
  if (isSupersededIdleTuiSession(session, sessions)) return false;
  if (session.activeAgentId) return true;
  if (session.pendingInputCount > 0) return true;
  if (
    session.participants.some(
      (participant) =>
        participant.lastSeenAt >= now - OPEN_SESSION_RECENCY_WINDOW_MS,
    )
  ) {
    return true;
  }
  const hasConversation =
    session.messageCount > 0 ||
    session.routeIds.length > 0 ||
    Boolean(session.lastMessageAt);
  return (
    hasConversation &&
    getSessionActivityAt(session) >= now - OPEN_SESSION_ACTIVITY_WINDOW_MS
  );
}

function createActivityEntry(input: Omit<ActivityEntry, "id">): ActivityEntry {
  return {
    id:
      input.domain +
      "-" +
      input.type +
      "-" +
      input.createdAt +
      "-" +
      Math.random().toString(36).slice(2, 8),
    ...input,
  };
}

function extractTransportBody(error: unknown): Record<string, unknown> | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidates = [
    (error as { readonly body?: unknown }).body,
    (error as { readonly responseBody?: unknown }).responseBody,
    (error as { readonly payload?: unknown }).payload,
    (error as { readonly data?: unknown }).data,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate)
    ) {
      return candidate as Record<string, unknown>;
    }

    if (typeof candidate === "string" && candidate.trim()) {
      try {
        const parsed = JSON.parse(candidate);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore invalid JSON bodies.
      }
    }
  }

  return null;
}

function formatError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as {
      readonly message?: unknown;
      readonly hint?: unknown;
      readonly status?: unknown;
    };
    const body = extractTransportBody(error);
    const messageFromBody =
      typeof body?.error === "string" && body.error.trim()
        ? body.error.trim()
        : null;
    const message =
      messageFromBody ??
      (typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : "Request failed.");
    const hint =
      typeof record.hint === "string" && record.hint.trim()
        ? " " + record.hint.trim()
        : "";
    const status =
      typeof record.status === "number" ? " [" + record.status + "]" : "";
    return message + status + hint;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Request failed.";
}

function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(label + " timed out."));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function extractProviderSwitchError(
  error: unknown,
): GoodVibesPatchCurrentModelError | null {
  const body = extractTransportBody(error);
  if (!body) {
    return null;
  }

  const code = body.code;
  const message = body.error;
  const missingEnvVars = body.missingEnvVars;
  if (typeof code !== "string" || typeof message !== "string") {
    return null;
  }

  return {
    error: message,
    code: code as GoodVibesPatchCurrentModelError["code"],
    ...(Array.isArray(missingEnvVars)
      ? {
          missingEnvVars: missingEnvVars.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        }
      : {}),
  };
}

function getCompanionChatTurnEvent(
  entry: ControlRecentEvent,
): RecentCompanionChatTurnEvent | null {
  if (!isCompanionChatTurnEvent(entry.event, entry.payload)) {
    return null;
  }

  return {
    ...(entry.payload as GoodVibesCompanionChatTurnEvent),
    createdAt: entry.createdAt,
  };
}

function mergeCompanionChatMessagesFromRecentEvents(
  messages: readonly GoodVibesCompanionChatMessage[],
  sessionId: string,
  recentEvents: readonly ControlRecentEvent[],
): readonly GoodVibesCompanionChatMessage[] {
  const merged = new Map<string, GoodVibesCompanionChatMessage>();
  for (const message of messages) {
    merged.set(message.id, message);
  }

  for (const entry of recentEvents) {
    const event = getCompanionChatTurnEvent(entry);
    if (!event || event.sessionId !== sessionId) {
      continue;
    }

    if (event.type === "turn.started" && !merged.has(event.messageId)) {
      merged.set(event.messageId, {
        id: event.messageId,
        sessionId,
        role: "user",
        content: event.envelope.body,
        createdAt: event.envelope.timestamp,
      });
    }

    if (
      event.type === "turn.completed" &&
      !merged.has(event.assistantMessageId)
    ) {
      merged.set(event.assistantMessageId, {
        id: event.assistantMessageId,
        sessionId,
        role: "assistant",
        content: event.envelope.body,
        createdAt: event.envelope.timestamp,
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function reconcileCompanionChatTurnState(
  turnState: GoodVibesCompanionChatTurnState | null,
  sessionId: string | null,
  session: GoodVibesCompanionChatSession | null,
  messages: readonly GoodVibesCompanionChatMessage[],
  recentEvents: readonly ControlRecentEvent[],
  now = Date.now(),
): GoodVibesCompanionChatTurnState | null {
  if (!sessionId) {
    return null;
  }

  if (session?.status === "closed") {
    return null;
  }

  const latestMessage = messages[messages.length - 1] ?? null;
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user") ?? null;
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant") ?? null;
  const currentTurn =
    turnState && turnState.sessionId === sessionId ? turnState : null;
  const trackingCurrentUserTurn =
    currentTurn &&
    (!latestUserMessage ||
      !currentTurn.userMessageId ||
      currentTurn.userMessageId === latestUserMessage.id)
      ? currentTurn
      : null;

  if (
    latestUserMessage &&
    latestAssistantMessage &&
    latestAssistantMessage.createdAt >= latestUserMessage.createdAt
  ) {
    return null;
  }

  const sessionEvents = recentEvents
    .map((entry) => getCompanionChatTurnEvent(entry))
    .filter(
      (event): event is RecentCompanionChatTurnEvent =>
        event !== null && event.sessionId === sessionId,
    )
    .sort((left, right) => left.createdAt - right.createdAt);

  const lowerBound =
    trackingCurrentUserTurn?.submittedAt ??
    latestUserMessage?.createdAt ??
    currentTurn?.submittedAt ??
    0;
  const relevantEvents = sessionEvents.filter((event) => {
    if (trackingCurrentUserTurn?.turnId) {
      return event.turnId === trackingCurrentUserTurn.turnId;
    }
    if (
      trackingCurrentUserTurn?.userMessageId &&
      event.type === "turn.started" &&
      event.messageId === trackingCurrentUserTurn.userMessageId
    ) {
      return true;
    }
    if (
      latestUserMessage &&
      event.type === "turn.started" &&
      event.messageId === latestUserMessage.id
    ) {
      return true;
    }
    return event.createdAt >= Math.max(0, lowerBound - 1_500);
  });

  const latestStarted = [...relevantEvents]
    .reverse()
    .find((event) => event.type === "turn.started") as
    | (RecentCompanionChatTurnEvent & { readonly type: "turn.started" })
    | undefined;
  const latestCompleted = [...relevantEvents]
    .reverse()
    .find((event) => event.type === "turn.completed");
  const latestError = [...relevantEvents]
    .reverse()
    .find((event) => event.type === "turn.error") as
    | (RecentCompanionChatTurnEvent & { readonly type: "turn.error" })
    | undefined;

  if (latestCompleted) {
    return null;
  }

  if (latestError) {
    return {
      sessionId,
      userMessageId:
        latestUserMessage?.id ?? trackingCurrentUserTurn?.userMessageId ?? null,
      turnId: latestError.turnId,
      status: "error",
      error: latestError.error,
      submittedAt:
        trackingCurrentUserTurn?.submittedAt ??
        latestUserMessage?.createdAt ??
        latestError.createdAt,
      updatedAt: latestError.createdAt,
    };
  }

  if (!latestUserMessage && trackingCurrentUserTurn) {
    return latestStarted
      ? {
          ...trackingCurrentUserTurn,
          turnId: latestStarted.turnId,
          updatedAt: Math.max(
            trackingCurrentUserTurn.updatedAt,
            latestStarted.createdAt,
          ),
        }
      : trackingCurrentUserTurn;
  }

  if (latestMessage?.role === "user" && latestUserMessage) {
    const lastSignalAt =
      latestStarted?.createdAt ?? trackingCurrentUserTurn?.updatedAt ?? latestUserMessage.createdAt;
    const submittedAt =
      trackingCurrentUserTurn?.submittedAt ?? latestUserMessage.createdAt;

    if (now - lastSignalAt > CHAT_TURN_SETTLE_TIMEOUT_MS) {
      return {
        sessionId,
        userMessageId: latestUserMessage.id,
        turnId: latestStarted?.turnId ?? trackingCurrentUserTurn?.turnId ?? null,
        status: "error",
        error: "Assistant turn timed out. Pull to refresh or retry.",
        submittedAt,
        updatedAt: now,
      };
    }

    return {
      sessionId,
      userMessageId: latestUserMessage.id,
      turnId: latestStarted?.turnId ?? trackingCurrentUserTurn?.turnId ?? null,
      status: "waiting",
      error: null,
      submittedAt,
      updatedAt: lastSignalAt,
    };
  }

  return trackingCurrentUserTurn?.status === "error"
    ? trackingCurrentUserTurn
    : null;
}

function buildAgentActivity(event: AgentEvent): ActivityEntry {
  switch (event.type) {
    case "AGENT_SPAWNING":
      return createActivityEntry({
        domain: "agents",
        type: event.type,
        title: "Agent spawning",
        detail: event.task,
        createdAt: Date.now(),
        tone: "accent",
      });
    case "AGENT_RUNNING":
      return createActivityEntry({
        domain: "agents",
        type: event.type,
        title: "Agent running",
        detail: event.taskId ?? event.agentId,
        createdAt: Date.now(),
        tone: "violet",
      });
    case "AGENT_PROGRESS":
      return createActivityEntry({
        domain: "agents",
        type: event.type,
        title: "Agent progress",
        detail: event.progress,
        createdAt: Date.now(),
        tone: "violet",
      });
    case "AGENT_COMPLETED":
      return createActivityEntry({
        domain: "agents",
        type: event.type,
        title: "Agent completed",
        detail: event.output?.trim()
          ? event.output.trim().slice(0, 180)
          : `${event.agentId} finished in ${event.durationMs}ms`,
        createdAt: Date.now(),
        tone: "success",
      });
    case "AGENT_FAILED":
      return createActivityEntry({
        domain: "agents",
        type: event.type,
        title: "Agent failed",
        detail: event.error,
        createdAt: Date.now(),
        tone: "danger",
      });
    case "AGENT_CANCELLED":
      return createActivityEntry({
        domain: "agents",
        type: event.type,
        title: "Agent cancelled",
        detail: event.reason ?? event.agentId,
        createdAt: Date.now(),
        tone: "warn",
      });
  }
}

function buildTaskActivity(event: TaskEvent): ActivityEntry {
  switch (event.type) {
    case "TASK_CREATED":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task queued",
        detail: event.description,
        createdAt: Date.now(),
        tone: "accent",
      });
    case "TASK_STARTED":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task started",
        detail: event.taskId,
        createdAt: Date.now(),
        tone: "violet",
      });
    case "TASK_BLOCKED":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task blocked",
        detail: event.reason,
        createdAt: Date.now(),
        tone: "warn",
      });
    case "TASK_PROGRESS":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task progress",
        detail: event.message ?? `${event.progress}%`,
        createdAt: Date.now(),
        tone: "accent",
      });
    case "TASK_COMPLETED":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task completed",
        detail: `${event.taskId} completed in ${event.durationMs}ms`,
        createdAt: Date.now(),
        tone: "success",
      });
    case "TASK_FAILED":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task failed",
        detail: event.error,
        createdAt: Date.now(),
        tone: "danger",
      });
    case "TASK_CANCELLED":
      return createActivityEntry({
        domain: "tasks",
        type: event.type,
        title: "Task cancelled",
        detail: event.reason ?? event.taskId,
        createdAt: Date.now(),
        tone: "warn",
      });
  }
}

function isConversationRouteResult(
  value: unknown,
): value is CompanionConversationRouteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "routedTo" in value &&
    (value as { readonly routedTo?: unknown }).routedTo === "conversation"
  );
}

function buildSessionInputActivity(
  input: GoodVibesSessionInputRecord,
  previousState: GoodVibesSessionInputRecord["state"],
): ActivityEntry {
  const preview =
    input.body.replace(/\s+/g, " ").trim().slice(0, 140) || "(empty input)";
  const detailSuffix = input.activeAgentId
    ? " · agent " + input.activeAgentId
    : input.error
      ? " · " + input.error
      : "";

  switch (input.state) {
    case "delivered":
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_DELIVERED",
        title: "Message delivered",
        detail: preview + detailSuffix,
        createdAt: Date.now(),
        tone: "accent",
      });
    case "spawned":
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_SPAWNED",
        title: "Message spawned",
        detail: preview + detailSuffix,
        createdAt: Date.now(),
        tone: "violet",
      });
    case "completed":
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_COMPLETED",
        title: "Message completed",
        detail: preview + " · from " + previousState,
        createdAt: Date.now(),
        tone: "success",
      });
    case "failed":
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_FAILED",
        title: "Message failed",
        detail: preview + detailSuffix,
        createdAt: Date.now(),
        tone: "danger",
      });
    case "cancelled":
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_CANCELLED",
        title: "Message cancelled",
        detail: preview,
        createdAt: Date.now(),
        tone: "warn",
      });
    case "rejected":
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_REJECTED",
        title: "Message rejected",
        detail: preview + detailSuffix,
        createdAt: Date.now(),
        tone: "danger",
      });
    case "queued":
    default:
      return createActivityEntry({
        domain: "app",
        type: "SESSION_INPUT_QUEUED",
        title: "Message queued",
        detail: preview,
        createdAt: Date.now(),
        tone: "warn",
      });
  }
}

function buildControlPlaneActivity(event: ControlPlaneEvent): ActivityEntry {
  switch (event.type) {
    case "CONTROL_PLANE_CLIENT_CONNECTED":
      return createActivityEntry({
        domain: "control-plane",
        type: event.type,
        title: "Client connected",
        detail: `${event.clientKind} via ${event.transport}`,
        createdAt: Date.now(),
        tone: "accent",
      });
    case "CONTROL_PLANE_CLIENT_DISCONNECTED":
      return createActivityEntry({
        domain: "control-plane",
        type: event.type,
        title: "Client disconnected",
        detail: event.reason,
        createdAt: Date.now(),
        tone: "warn",
      });
    case "CONTROL_PLANE_AUTH_GRANTED":
      return createActivityEntry({
        domain: "control-plane",
        type: event.type,
        title: "Control auth granted",
        detail: `${event.principalId} (${event.principalKind})`,
        createdAt: Date.now(),
        tone: "success",
      });
    case "CONTROL_PLANE_AUTH_REJECTED":
      return createActivityEntry({
        domain: "control-plane",
        type: event.type,
        title: "Control auth rejected",
        detail: event.reason,
        createdAt: Date.now(),
        tone: "danger",
      });
  }
}

function buildProviderActivity(event: GoodVibesProviderEvent): ActivityEntry {
  switch (event.type) {
    case "PROVIDERS_CHANGED":
      return createActivityEntry({
        domain: "providers",
        type: event.type,
        title: "Providers changed",
        detail:
          "Added " +
          event.added.length +
          " · Updated " +
          event.updated.length +
          " · Removed " +
          event.removed.length,
        createdAt: Date.now(),
        tone: "accent",
      });
    case "PROVIDER_WARNING":
      return createActivityEntry({
        domain: "providers",
        type: event.type,
        title: "Provider warning",
        detail: event.message,
        createdAt: Date.now(),
        tone: "warn",
      });
    case "MODEL_FALLBACK":
      return createActivityEntry({
        domain: "providers",
        type: event.type,
        title: "Model fallback",
        detail: event.from + " → " + event.to + " on " + event.provider,
        createdAt: Date.now(),
        tone: "warn",
      });
    case "MODEL_CHANGED":
      return createActivityEntry({
        domain: "providers",
        type: event.type,
        title: "Model changed",
        detail:
          event.previous
            ? event.previous.registryKey + " → " + event.registryKey
            : event.registryKey + " on " + event.provider,
        createdAt: Date.now(),
        tone: "success",
      });
  }
}

export function useCompanionApp(): CompanionAppModel {
  const sdkRef = useRef<GoodVibesSdk | null>(null);
  const baseUrlRef = useRef("");
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const bootstrappedRef = useRef(false);
  const companionChatSessionIdsRef = useRef<readonly string[]>([]);
  const selectedChatSessionIdRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const sharedSessionStreamStopRef = useRef<(() => void) | null>(null);
  const sharedSessionStreamRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sharedSessionEventFloorRef = useRef<{
    readonly sessionId: string;
    readonly timestamp: number;
  } | null>(null);
  const pendingSessionMessagesRef = useRef<
    Map<string, readonly GoodVibesSessionMessageRecord[]>
  >(new Map());
  const sessionInputStatesRef = useRef<
    Map<string, GoodVibesSessionInputRecord["state"]>
  >(new Map());
  const sessionInputSessionRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<"booting" | "signed-out" | "ready">(
    "booting",
  );
  const [savedBaseUrl, setSavedBaseUrl] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingChatSession, setLoadingChatSession] = useState(false);
  const [creatingChatSession, setCreatingChatSession] = useState(false);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(
    null,
  );
  const [sendingSessionId, setSendingSessionId] = useState<string | null>(null);
  const [sendingChatSessionId, setSendingChatSessionId] = useState<
    string | null
  >(null);
  const [chatTurnState, setChatTurnState] = useState<
    GoodVibesCompanionChatTurnState | null
  >(null);
  const [sharedSessionTurnState, setSharedSessionTurnState] = useState<
    GoodVibesSharedSessionTurnState | null
  >(null);
  const [providerCatalog, setProviderCatalog] = useState<
    GoodVibesProvidersCatalog | null
  >(null);
  const [switchingModelKey, setSwitchingModelKey] = useState<string | null>(null);
  const [settingChatModelSessionId, setSettingChatModelSessionId] = useState<
    string | null
  >(null);
  const [pendingChatModel, setPendingChatModelState] =
    useState<ProviderModelRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [foreground, setForeground] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [auth, setAuth] = useState<GoodVibesAuthContext | null>(null);
  const [control, setControl] = useState<GoodVibesControlSnapshot | null>(null);
  const [tasks, setTasks] = useState<GoodVibesTasksSnapshot | null>(null);
  const [sessions, setSessions] = useState<GoodVibesSessionsSnapshot | null>(
    null,
  );
  const [approvals, setApprovals] = useState<GoodVibesApprovalsSnapshot | null>(
    null,
  );
  const [chatSessions, setChatSessions] = useState<
    readonly GoodVibesCompanionChatSession[]
  >([]);
  const [selectedChatSessionId, setSelectedChatSessionId] = useState<
    string | null
  >(null);
  const [selectedChatSession, setSelectedChatSession] = useState<
    GoodVibesCompanionChatSession | null
  >(null);
  const [chatMessages, setChatMessages] = useState<
    readonly GoodVibesCompanionChatMessage[]
  >([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [selectedSession, setSelectedSession] =
    useState<GoodVibesSessionRecord | null>(null);
  const [sessionMessages, setSessionMessages] =
    useState<GoodVibesSessionMessagesSnapshot | null>(null);
  const [sessionInputs, setSessionInputs] = useState<
    readonly GoodVibesSessionInputRecord[]
  >([]);
  const [sessionSubmission, setSessionSubmission] =
    useState<SessionSubmissionStatus | null>(null);
  const [activity, setActivity] = useState<readonly ActivityEntry[]>([]);

  useEffect(() => {
    baseUrlRef.current = savedBaseUrl;
  }, [savedBaseUrl]);

  useEffect(() => {
    selectedChatSessionIdRef.current = selectedChatSessionId;
  }, [selectedChatSessionId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    setChatTurnState((current) =>
      current && current.sessionId === selectedChatSessionId ? current : null,
    );
  }, [selectedChatSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      sharedSessionEventFloorRef.current = null;
      return;
    }

    const existingFloor = sharedSessionEventFloorRef.current;
    const latestMessage =
      sessionMessages?.messages[sessionMessages.messages.length - 1] ?? null;
    const latestUserMessage = [...(sessionMessages?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    const nextTimestamp = hasPendingSharedSessionConversation(
      selectedSession,
      sessionMessages,
    )
      ? latestUserMessage?.createdAt ??
        latestMessage?.createdAt ??
        selectedSession?.updatedAt ??
        Date.now()
      : latestMessage?.createdAt ?? selectedSession?.updatedAt ?? Date.now();

    if (
      !existingFloor ||
      existingFloor.sessionId !== selectedSessionId ||
      existingFloor.timestamp < nextTimestamp
    ) {
      sharedSessionEventFloorRef.current = {
        sessionId: selectedSessionId,
        timestamp: nextTimestamp,
      };
    }
  }, [selectedSession, selectedSessionId, sessionMessages]);

  const pushActivity = useEffectEvent((entry: ActivityEntry) => {
    startTransition(() => {
      setActivity((current) => [entry, ...current].slice(0, 32));
    });
  });

  const mergeSharedSessionStreamMessage = useEffectEvent(
    (message: GoodVibesSessionMessageRecord) => {
      const pendingMessages = pendingSessionMessagesRef.current.get(message.sessionId);
      if (pendingMessages?.length) {
        const messageKey = getSessionMessageMergeKey(message);
        const unresolved = pendingMessages.filter(
          (pending) =>
            pending.id !== message.id &&
            getSessionMessageMergeKey(pending) !== messageKey,
        );
        if (unresolved.length) {
          pendingSessionMessagesRef.current.set(message.sessionId, unresolved);
        } else {
          pendingSessionMessagesRef.current.delete(message.sessionId);
        }
      }

      sharedSessionEventFloorRef.current = {
        sessionId: message.sessionId,
        timestamp: message.createdAt,
      };

      startTransition(() => {
        setSelectedSession((current) => {
          if (current?.id !== message.sessionId) {
            return current;
          }
          return applySessionMessageToSession(
            current,
            message,
            !hasMatchingSessionMessage(sessionMessages?.messages ?? [], message),
          );
        });
        setSessions((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === message.sessionId
                ? applySessionMessageToSession(
                    session,
                    message,
                    !hasMatchingSessionMessage(sessionMessages?.messages ?? [], message),
                  )
                : session,
            ),
          };
        });
        setSessionMessages((current) => {
          if (!current || current.session.id !== message.sessionId) {
            return current;
          }
          const alreadyPresent = hasMatchingSessionMessage(current.messages, message);
          const merged = mergeSessionMessages(current.messages, [message]);
          return {
            ...current,
            session: {
              ...applySessionMessageToSession(current.session, message, !alreadyPresent),
              messageCount: Math.max(
                current.session.messageCount + (alreadyPresent ? 0 : 1),
                merged.length,
              ),
            },
            messages: merged,
          };
        });
        if (message.role !== "user") {
          setSharedSessionTurnState((current) =>
            current?.sessionId === message.sessionId ? null : current,
          );
        }
      });
    },
  );

  const applySignedOutState = useEffectEvent(
    (baseUrl: string, nextError: string | null = null) => {
      baseUrlRef.current = baseUrl;
      companionChatSessionIdsRef.current = [];
      selectedChatSessionIdRef.current = null;
      sharedSessionStreamStopRef.current?.();
      sharedSessionStreamStopRef.current = null;
      if (sharedSessionStreamRetryRef.current) {
        clearTimeout(sharedSessionStreamRetryRef.current);
        sharedSessionStreamRetryRef.current = null;
      }
      sharedSessionEventFloorRef.current = null;
      pendingSessionMessagesRef.current = new Map();
      sessionInputStatesRef.current = new Map();
      sessionInputSessionRef.current = null;
      startTransition(() => {
        setPhase("signed-out");
        setSavedBaseUrl(baseUrl);
        setAuth(null);
        setControl(null);
        setTasks(null);
        setSessions(null);
        setApprovals(null);
        setChatSessions([]);
        setLoadingChatSession(false);
        setCreatingChatSession(false);
        setSendingChatSessionId(null);
        setChatTurnState(null);
        setSharedSessionTurnState(null);
        setProviderCatalog(null);
        setSwitchingModelKey(null);
        setSelectedChatSessionId(null);
        setSelectedChatSession(null);
        setChatMessages([]);
        setSelectedSessionId(null);
        setSelectedSession(null);
        setSessionMessages(null);
        setSessionInputs([]);
        setSessionSubmission(null);
        setLastUpdatedAt(null);
        setError(nextError);
      });
    },
  );

  const persistCompanionChatRegistry = useEffectEvent(
    async (
      baseUrl: string,
      sessionIds: readonly string[],
      selectedSessionId: string | null,
    ) => {
      companionChatSessionIdsRef.current = sessionIds;
      selectedChatSessionIdRef.current = selectedSessionId;
      await Promise.all([
        saveCompanionChatSessionIds(baseUrl, sessionIds),
        saveSelectedCompanionChatSessionId(baseUrl, selectedSessionId),
      ]);
    },
  );

  const loadSelectedSession = useEffectEvent(
    async (
      sdk: GoodVibesSdk,
      nextSessionId: string | null,
      options: { readonly silent?: boolean } = {},
    ): Promise<SelectedSessionPayload> => {
      if (!nextSessionId) {
        startTransition(() => {
          setSelectedSessionId(null);
          setSelectedSession(null);
          setSessionMessages(null);
          setSessionInputs([]);
          setSharedSessionTurnState(null);
        });
        return {
          session: null,
          messages: null,
          inputs: [],
        };
      }

      if (!options.silent) {
        setLoadingSession(true);
      }

      try {
        const [nextMessages, nextInputs] = await Promise.all([
          sdk.operator.sessions.messages.list(nextSessionId, {
            limit: 40,
          }),
          sdk.operator.invoke<GoodVibesSessionInputsSnapshot>(
            "sessions.inputs.list",
            {
              sessionId: nextSessionId,
              limit: 40,
            },
          ),
        ]);
        if (sdkRef.current !== sdk) {
          return {
            session: null,
            messages: null,
            inputs: [],
          };
        }
        const persistedMessages = nextMessages.messages;
        const pendingMessages =
          pendingSessionMessagesRef.current.get(nextSessionId) ?? [];
        const unresolvedPending = pendingMessages.filter(
          (message) => !hasMatchingSessionMessage(persistedMessages, message),
        );
        if (unresolvedPending.length) {
          pendingSessionMessagesRef.current.set(nextSessionId, unresolvedPending);
        } else {
          pendingSessionMessagesRef.current.delete(nextSessionId);
        }
        const mergedMessages = mergeSessionMessages(
          persistedMessages,
          unresolvedPending,
        );
        const loadedSession = nextInputs.session ?? nextMessages.session ?? null;
        const nextSession =
          loadedSession && mergedMessages.length
            ? {
                ...loadedSession,
                updatedAt: Math.max(
                  loadedSession.updatedAt,
                  mergedMessages[mergedMessages.length - 1]?.createdAt ??
                    loadedSession.updatedAt,
                ),
                lastMessageAt: Math.max(
                  loadedSession.lastMessageAt ?? 0,
                  mergedMessages[mergedMessages.length - 1]?.createdAt ?? 0,
                ),
                messageCount: Math.max(
                  loadedSession.messageCount,
                  mergedMessages.length,
                ),
              }
            : loadedSession;
        const nextMessagesSnapshot = {
          ...nextMessages,
          ...(nextSession ? { session: nextSession } : {}),
          messages: mergedMessages,
        };
        startTransition(() => {
          setSelectedSessionId(nextSessionId);
          setSelectedSession(nextSession);
          setSessions((current) => {
            if (!current || !nextSession) {
              return current;
            }
            return {
              ...current,
              sessions: current.sessions.map((entry) =>
                entry.id === nextSessionId ? { ...entry, ...nextSession } : entry,
              ),
            };
          });
          setSessionMessages(nextMessagesSnapshot);
          setSessionInputs(nextInputs.inputs);
          setSharedSessionTurnState((current) =>
            reconcileSharedSessionTurnState(
              current,
              nextSessionId,
              nextSession,
              nextMessagesSnapshot,
            ),
          );
          setLastUpdatedAt(Date.now());
        });
        return {
          session: nextSession,
          messages: nextMessagesSnapshot,
          inputs: nextInputs.inputs,
        };
      } finally {
        if (!options.silent) {
          setLoadingSession(false);
        }
      }
    },
  );

  const syncCompanionChats = useEffectEvent(
    async (sdk: GoodVibesSdk): Promise<SelectedChatSessionPayload> => {
      const baseUrl = baseUrlRef.current;
      if (!baseUrl) {
        return {
          sessions: [],
          selectedSessionId: null,
          session: null,
          messages: [],
        };
      }

      const storedSessionIds = companionChatSessionIdsRef.current;
      if (!storedSessionIds.length) {
        await persistCompanionChatRegistry(baseUrl, [], null);
        return {
          sessions: [],
          selectedSessionId: null,
          session: null,
          messages: [],
        };
      }

      const payloads = await Promise.all(
        storedSessionIds.map(async (sessionId) => {
          try {
            return await getCompanionChatSession(sdk, sessionId);
          } catch (nextError) {
            if (isCompanionChatMissing(nextError)) {
              return null;
            }
            throw nextError;
          }
        }),
      );
      const livePayloads = payloads.filter(
        (payload) => payload !== null,
      ) as Awaited<ReturnType<typeof getCompanionChatSession>>[];
      const nextSessions = [...livePayloads]
        .map((payload) => payload.session)
        .sort(compareCompanionChatActivity);
      const nextSessionIds = nextSessions.map((session) => session.id);
      const nextSelectedId =
        selectedChatSessionIdRef.current &&
        nextSessions.some(
          (session) => session.id === selectedChatSessionIdRef.current,
        )
          ? selectedChatSessionIdRef.current
          : (nextSessions[0]?.id ?? null);
      const nextSelectedPayload = nextSelectedId
        ? (livePayloads.find((payload) => payload.session.id === nextSelectedId) ??
          null)
        : null;

      if (
        JSON.stringify(nextSessionIds) !==
          JSON.stringify(companionChatSessionIdsRef.current) ||
        nextSelectedId !== selectedChatSessionIdRef.current
      ) {
        await persistCompanionChatRegistry(baseUrl, nextSessionIds, nextSelectedId);
      }

      return {
        sessions: nextSessions,
        selectedSessionId: nextSelectedId,
        session: nextSelectedPayload?.session ?? null,
        messages: nextSelectedPayload?.messages ?? [],
      };
    },
  );

  const loadChatSession = useEffectEvent(
    async (
      sdk: GoodVibesSdk,
      nextSessionId: string | null,
      options: { readonly silent?: boolean } = {},
    ): Promise<SelectedChatSessionPayload> => {
      if (!nextSessionId) {
        startTransition(() => {
          setSelectedChatSessionId(null);
          setSelectedChatSession(null);
          setChatMessages([]);
          setChatTurnState(null);
        });
        const baseUrl = baseUrlRef.current;
        if (baseUrl) {
          await persistCompanionChatRegistry(baseUrl, companionChatSessionIdsRef.current, null);
        }
        return {
          sessions: chatSessions,
          selectedSessionId: null,
          session: null,
          messages: [],
        };
      }

      if (!options.silent) {
        setLoadingChatSession(true);
      }

      try {
        const baseUrl = baseUrlRef.current;
        if (!baseUrl) {
          return {
            sessions: [],
            selectedSessionId: null,
            session: null,
            messages: [],
          };
        }
        const payload = await withTimeout(
          getCompanionChatSession(sdk, nextSessionId),
          "Chat session load",
        );
        if (sdkRef.current !== sdk) {
          return {
            sessions: [],
            selectedSessionId: null,
            session: null,
            messages: [],
          };
        }

        const hydratedMessages = mergeCompanionChatMessagesFromRecentEvents(
          payload.messages,
          payload.session.id,
          control?.recentEvents ?? [],
        );
        const hydratedSession = {
          ...payload.session,
          updatedAt: Math.max(
            payload.session.updatedAt,
            hydratedMessages[hydratedMessages.length - 1]?.createdAt ??
              payload.session.updatedAt,
          ),
          messageCount: Math.max(
            payload.session.messageCount,
            hydratedMessages.length,
          ),
        };
        const nextSessions = [
          hydratedSession,
          ...chatSessions.filter((session) => session.id !== hydratedSession.id),
        ].sort(compareCompanionChatActivity);
        const nextSessionIds = nextSessions.map((session) => session.id);
        await persistCompanionChatRegistry(baseUrl, nextSessionIds, hydratedSession.id);
        startTransition(() => {
          setChatSessions(nextSessions);
          setSelectedChatSessionId(hydratedSession.id);
          setSelectedChatSession(hydratedSession);
          setChatMessages(hydratedMessages);
          setChatTurnState((current) =>
            reconcileCompanionChatTurnState(
              current,
              hydratedSession.id,
              hydratedSession,
              hydratedMessages,
              control?.recentEvents ?? [],
            ),
          );
        });
        return {
          sessions: nextSessions,
          selectedSessionId: hydratedSession.id,
          session: hydratedSession,
          messages: hydratedMessages,
        };
      } finally {
        if (!options.silent) {
          setLoadingChatSession(false);
        }
      }
    },
  );

  const fetchDashboard = useEffectEvent(
    async (
      sdk: GoodVibesSdk,
      options: { readonly silent?: boolean } = {},
    ): Promise<DashboardPayload | null> => {
      const currentAuth = await withTimeout(sdk.auth.current(), "Auth check");
      if (!currentAuth.authenticated) {
        await clearSavedToken().catch(() => undefined);
        await sdk.auth.clearToken().catch(() => undefined);
        applySignedOutState(
          savedBaseUrl || "",
          "Saved token is missing or expired.",
        );
        return null;
      }

      const [
        nextControl,
        nextTasks,
        nextSessions,
        nextApprovals,
        nextChatState,
        nextProviderCatalog,
      ] = await withTimeout(
        Promise.all([
          sdk.operator.control.snapshot(),
          sdk.operator.tasks.list(),
          sdk.operator.sessions.list(),
          sdk.operator.approvals.list(),
          syncCompanionChats(sdk),
          listProviderCatalog(sdk).catch(() => null),
        ]),
        "Dashboard sync",
      );

      const nextChatMessages = nextChatState.selectedSessionId
        ? mergeCompanionChatMessagesFromRecentEvents(
            nextChatState.messages,
            nextChatState.selectedSessionId,
            nextControl.recentEvents,
          )
        : [];
      const nextSelectedChatSession = nextChatState.session
        ? {
            ...nextChatState.session,
            updatedAt: Math.max(
              nextChatState.session.updatedAt,
              nextChatMessages[nextChatMessages.length - 1]?.createdAt ??
                nextChatState.session.updatedAt,
            ),
            messageCount: Math.max(
              nextChatState.session.messageCount,
              nextChatMessages.length,
            ),
          }
        : null;
      const nextChatSessions = nextChatState.sessions
        .map((session) =>
          session.id === nextSelectedChatSession?.id
            ? nextSelectedChatSession
            : session,
        )
        .sort(compareCompanionChatActivity);

      const sessionListNow = Date.now();
      const prioritizedSessions = [...nextSessions.sessions].sort(
        compareSharedSessionActivity,
      );
      const openSessions = prioritizedSessions.filter((session) =>
        isSessionOpen(session, prioritizedSessions, sessionListNow),
      );
      const nextSelectedId =
        selectedSessionIdRef.current &&
        prioritizedSessions.some(
          (session) => session.id === selectedSessionIdRef.current,
        )
          ? selectedSessionIdRef.current
          : (openSessions[0]?.id ?? prioritizedSessions[0]?.id ?? null);
      const nextSelectedSession = await withTimeout(
        loadSelectedSession(sdk, nextSelectedId, {
          silent: options.silent ?? false,
        }),
        "Session sync",
      );

      return {
        auth: currentAuth,
        control: nextControl,
        tasks: nextTasks,
        sessions: nextSessions,
        approvals: nextApprovals,
        providerCatalog: nextProviderCatalog,
        chatSessions: nextChatSessions,
        selectedChatSession: nextSelectedChatSession,
        chatMessages: nextChatMessages,
        selectedChatSessionId: nextChatState.selectedSessionId,
        selectedSession: nextSelectedSession.session,
        sessionMessages: nextSelectedSession.messages,
        sessionInputs: nextSelectedSession.inputs,
        selectedSessionId: nextSelectedId,
      };
    },
  );
  const refreshInternal = useEffectEvent(
    async (options: { readonly silent?: boolean } = {}) => {
      if (refreshInFlightRef.current) {
        await refreshInFlightRef.current;
        return;
      }

      const sdk = sdkRef.current;
      if (!sdk) return;

      const task = (async () => {
        if (!options.silent) {
          setRefreshing(true);
        }

        try {
          const payload = await fetchDashboard(sdk, options);
          if (!payload || sdkRef.current !== sdk) {
            return;
          }
          startTransition(() => {
            setPhase("ready");
            setAuth(payload.auth);
            setControl(payload.control);
            setTasks(payload.tasks);
            setSessions(payload.sessions);
            setApprovals(payload.approvals);
            setProviderCatalog(payload.providerCatalog);
            setChatSessions(payload.chatSessions);
            setSelectedChatSessionId(payload.selectedChatSessionId);
            setSelectedChatSession(payload.selectedChatSession);
            setChatMessages(payload.chatMessages);
            setChatTurnState((current) =>
              reconcileCompanionChatTurnState(
                current,
                payload.selectedChatSessionId,
                payload.selectedChatSession,
                payload.chatMessages,
                payload.control.recentEvents,
              ),
            );
            setSharedSessionTurnState((current) =>
              reconcileSharedSessionTurnState(
                current,
                payload.selectedSessionId,
                payload.selectedSession,
                payload.sessionMessages,
              ),
            );
            setSelectedSessionId(payload.selectedSessionId);
            setSelectedSession(payload.selectedSession);
            setSessionMessages(payload.sessionMessages);
            setSessionInputs(payload.sessionInputs);
            setSessionSubmission((current) => {
              if (!current) {
                return current;
              }

              const nextInput = payload.sessionInputs.find(
                (input) => input.id === current.inputId,
              );
              if (!nextInput) {
                const currentSession = payload.sessions.sessions.find(
                  (session) => session.id === current.sessionId,
                );
                if (currentSession && currentSession.pendingInputCount === 0) {
                  return null;
                }
                return current;
              }

              return {
                sessionId: current.sessionId,
                inputId: current.inputId,
                mode: current.mode,
                state: nextInput.state,
                agentId: nextInput.activeAgentId ?? current.agentId,
                body: nextInput.body,
                createdAt: nextInput.createdAt,
                updatedAt: nextInput.updatedAt,
                ...(nextInput.error ? { error: nextInput.error } : {}),
              };
            });
            setLastUpdatedAt(Date.now());
            setError(null);
          });
        } catch (nextError) {
          setError(formatError(nextError));
        } finally {
          if (!options.silent) {
            setRefreshing(false);
          }
        }
      })();

      refreshInFlightRef.current = task;

      try {
        await task;
      } finally {
        if (refreshInFlightRef.current === task) {
          refreshInFlightRef.current = null;
        }
      }
    },
  );

  const queueRefresh = useEffectEvent(() => {
    if (refreshTimerRef.current) {
      return;
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshInternal({ silent: true });
    }, 900);
  });

  const signInWithPassword = useEffectEvent(
    async (input: PasswordSignInInput): Promise<boolean> => {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      setAuthenticating(true);
      setError(null);

      try {
        await saveBaseUrl(baseUrl);
        const [storedChatSessionIds, storedSelectedChatSessionId] =
          await Promise.all([
            readSavedCompanionChatSessionIds(baseUrl),
            readSavedSelectedCompanionChatSessionId(baseUrl),
          ]);
        baseUrlRef.current = baseUrl;
        companionChatSessionIdsRef.current = storedChatSessionIds;
        selectedChatSessionIdRef.current = storedSelectedChatSessionId;
        setSavedBaseUrl(baseUrl);
        const sdk = await createMobileGoodVibesSdk(baseUrl);
        sdkRef.current = sdk;
        await withTimeout(
          sdk.auth.login(
            {
              username: input.username.trim(),
              password: input.password,
            },
            { persistToken: true },
          ),
          "Password sign-in",
        );
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: "SIGNED_IN",
            title: "Connected to daemon",
            detail: baseUrl,
            createdAt: Date.now(),
            tone: "success",
          }),
        );
        await refreshInternal({ silent: true });
        return true;
      } catch (nextError) {
        await clearSavedToken().catch(() => undefined);
        await sdkRef.current?.auth.clearToken().catch(() => undefined);
        applySignedOutState(baseUrl, formatError(nextError));
        return false;
      } finally {
        setAuthenticating(false);
      }
    },
  );
  const signInWithToken = useEffectEvent(
    async (input: TokenSignInInput): Promise<boolean> => {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const nextToken = input.token.trim();
      setAuthenticating(true);
      setError(null);

      try {
        await saveBaseUrl(baseUrl);
        const [storedChatSessionIds, storedSelectedChatSessionId] =
          await Promise.all([
            readSavedCompanionChatSessionIds(baseUrl),
            readSavedSelectedCompanionChatSessionId(baseUrl),
          ]);
        baseUrlRef.current = baseUrl;
        companionChatSessionIdsRef.current = storedChatSessionIds;
        selectedChatSessionIdRef.current = storedSelectedChatSessionId;
        setSavedBaseUrl(baseUrl);
        const authSnapshot = await withTimeout(
          probeGoodVibesToken(baseUrl, nextToken),
          "Token auth check",
        );
        if (!authSnapshot.authenticated) {
          throw new Error(
            `Token was rejected by the daemon (${authSnapshot.authMode ?? "unknown"}).`,
          );
        }

        const sdk = await createMobileGoodVibesSdk(baseUrl, {
          authToken: nextToken,
        });
        sdkRef.current = sdk;
        await sdk.auth.setToken(nextToken);
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: "TOKEN_ATTACHED",
            title: "Token loaded",
            detail: baseUrl,
            createdAt: Date.now(),
            tone: "success",
          }),
        );
        await refreshInternal({ silent: true });
        return true;
      } catch (nextError) {
        await clearSavedToken().catch(() => undefined);
        await sdkRef.current?.auth.clearToken().catch(() => undefined);
        applySignedOutState(baseUrl, formatError(nextError));
        return false;
      } finally {
        setAuthenticating(false);
      }
    },
  );
  const signOut = useEffectEvent(async () => {
    const baseUrl = savedBaseUrl;
    await clearSavedToken().catch(() => undefined);
    await sdkRef.current?.auth.clearToken().catch(() => undefined);
    pushActivity(
      createActivityEntry({
        domain: "app",
        type: "SIGNED_OUT",
        title: "Signed out",
        detail: baseUrl || "GoodVibes daemon",
        createdAt: Date.now(),
        tone: "warn",
      }),
    );
    applySignedOutState(baseUrl);
  });

  const createChatSession = useEffectEvent(
    async (title?: string): Promise<string | null> => {
      const sdk = sdkRef.current;
      if (!sdk) return null;

      setCreatingChatSession(true);
      setError(null);

      try {
        const baseUrl = baseUrlRef.current;
        if (!baseUrl) {
          throw new Error("Daemon URL is not available.");
        }
        const nextTitle = title?.trim() || buildCompanionChatTitle();
        // Remote chat sessions are session-local. Use the staged pendingChatModel
        // (set by the per-chat picker) — NOT the global providerCatalog.currentModel,
        // which is bound to the TUI/shared session.
        const selectedModel = pendingChatModel;
        const result = await withTimeout(
          createCompanionChatSession(sdk, {
            title: nextTitle,
            ...(selectedModel
              ? {
                  model: selectedModel.registryKey,
                  provider: selectedModel.provider,
                }
              : {}),
          }),
          "Chat session create",
        );
        const nextSessionIds = [
          result.sessionId,
          ...companionChatSessionIdsRef.current.filter(
            (sessionId) => sessionId !== result.sessionId,
          ),
        ];
        await persistCompanionChatRegistry(baseUrl, nextSessionIds, result.sessionId);
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: "CHAT_SESSION_CREATED",
            title: "Remote chat ready",
            detail:
              nextTitle +
              (selectedModel ? " · " + selectedModel.registryKey : ""),
            createdAt: Date.now(),
            tone: "success",
          }),
        );
        await loadChatSession(sdk, result.sessionId, { silent: true });
        return result.sessionId;
      } catch (nextError) {
        setError(formatError(nextError));
        return null;
      } finally {
        setCreatingChatSession(false);
        // Clear any staged model selection — the new session now owns its model.
        setPendingChatModelState(null);
      }
    },
  );

  const setChatSessionModel = useEffectEvent(
    async (sessionId: string, registryKey: string): Promise<void> => {
      const sdk = sdkRef.current;
      const trimmedSessionId = sessionId.trim();
      const trimmedRegistryKey = registryKey.trim();
      if (!sdk || !trimmedSessionId || !trimmedRegistryKey) {
        return;
      }

      // Resolve provider from the catalog so the daemon receives both fields.
      const providerEntry =
        providerCatalog?.providers.find((provider) =>
          provider.models.some(
            (entry) => entry.registryKey === trimmedRegistryKey,
          ),
        ) ?? null;
      const providerId = providerEntry?.id ?? null;

      setSettingChatModelSessionId(trimmedSessionId);
      setError(null);

      try {
        const result = await withTimeout(
          updateCompanionChatSession(sdk, trimmedSessionId, {
            model: trimmedRegistryKey,
            ...(providerId ? { provider: providerId } : {}),
          }),
          "Chat session model update",
        );
        const nextSession = result.session;
        startTransition(() => {
          setChatSessions((prev) =>
            prev.map((session) =>
              session.id === nextSession.id ? nextSession : session,
            ),
          );
          setSelectedChatSession((prev) =>
            prev && prev.id === nextSession.id ? nextSession : prev,
          );
        });
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: "CHAT_MODEL_CHANGED",
            title: "Chat model updated",
            detail:
              (nextSession.title || nextSession.id) +
              " · " +
              (nextSession.model ?? trimmedRegistryKey),
            createdAt: Date.now(),
            tone: "accent",
          }),
        );
      } catch (nextError) {
        setError(formatError(nextError));
      } finally {
        setSettingChatModelSessionId(null);
      }
    },
  );

  const setPendingChatModel = useEffectEvent(
    (model: ProviderModelRef | null): void => {
      setPendingChatModelState(model);
    },
  );

  const selectChatSession = useEffectEvent(async (sessionId: string) => {
    const sdk = sdkRef.current;
    if (!sdk) return;
    await loadChatSession(sdk, sessionId);
  });

  const sendChatMessage = useEffectEvent(
    async (sessionId: string | null, body: string): Promise<boolean> => {
      const sdk = sdkRef.current;
      if (!sdk) return false;
      const nextBody = body.trim();
      if (!nextBody) return false;

      let targetSessionId = sessionId;
      if (!targetSessionId) {
        targetSessionId = await createChatSession();
        if (!targetSessionId) {
          return false;
        }
      }

      setSendingChatSessionId(targetSessionId);
      setError(null);
      try {
        const baseUrl = baseUrlRef.current;
        if (!baseUrl) {
          throw new Error("Daemon URL is not available.");
        }
        const submittedAt = Date.now();
        const result = await withTimeout(
          postCompanionChatMessage(sdk, targetSessionId, {
            content: nextBody,
          }),
          "Chat message send",
        );
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: "CHAT_MESSAGE_SENT",
            title: "Chat message sent",
            detail: nextBody.slice(0, 140),
            createdAt: submittedAt,
            tone: "accent",
          }),
        );
        startTransition(() => {
          setChatMessages((current) =>
            current.some((message) => message.id === result.messageId)
              ? current
              : [
                  ...current,
                  {
                    id: result.messageId,
                    sessionId: targetSessionId!,
                    role: "user",
                    content: nextBody,
                    createdAt: submittedAt,
                  },
                ],
          );
          setSelectedChatSession((current) =>
            current?.id === targetSessionId
              ? {
                  ...current,
                  updatedAt: Math.max(current.updatedAt, submittedAt),
                  messageCount: current.messageCount + 1,
                }
              : current,
          );
          setChatSessions((current) =>
            current
              .map((session) =>
                session.id === targetSessionId
                  ? {
                      ...session,
                      updatedAt: Math.max(session.updatedAt, submittedAt),
                      messageCount: session.messageCount + 1,
                    }
                  : session,
              )
              .sort(compareCompanionChatActivity),
          );
          setChatTurnState({
            sessionId: targetSessionId!,
            userMessageId: result.messageId,
            turnId: null,
            status: "waiting",
            error: null,
            submittedAt,
            updatedAt: submittedAt,
          });
        });
        await loadChatSession(sdk, targetSessionId, { silent: true });
        queueRefresh();
        return true;
      } catch (nextError) {
        setError(formatError(nextError));
        return false;
      } finally {
        setSendingChatSessionId(null);
      }
    },
  );

  const selectSession = useEffectEvent(async (sessionId: string) => {
    const sdk = sdkRef.current;
    if (!sdk) return;
    await loadSelectedSession(sdk, sessionId);
  });

  const sendSessionInput = useEffectEvent(
    async (
      sessionId: string,
      body: string,
      intent: "submit" | "follow-up",
    ): Promise<boolean> => {
      const sdk = sdkRef.current;
      if (!sdk) return false;
      const nextBody = body.trim();
      if (!nextBody) return false;

      const noun = intent === "follow-up" ? "Follow-up" : "Main chat";
      setSendingSessionId(sessionId);
      setError(null);
      try {
        const result: GoodVibesConversationMessageSubmitResult =
          intent === "follow-up"
            ? await withTimeout(
                sdk.operator.sessions.followUp({
                  sessionId,
                  body: nextBody,
                  surfaceKind: MOBILE_SURFACE_KIND,
                  surfaceId: MOBILE_SURFACE_ID,
                }),
                "Follow-up submit",
              )
            : await withTimeout(
                sdk.operator.sessions.messages.create(sessionId, {
                  body: nextBody,
                  kind: "message",
                  surfaceKind: MOBILE_SURFACE_KIND,
                  surfaceId: MOBILE_SURFACE_ID,
                }),
                "Session message submit",
              );

        const stageSessionMessage = (
          message: GoodVibesSessionMessageRecord,
          nextSession: GoodVibesSessionRecord | null = null,
        ) => {
          const pendingMessages =
            pendingSessionMessagesRef.current.get(sessionId) ?? [];
          pendingSessionMessagesRef.current.set(
            sessionId,
            mergeSessionMessages(pendingMessages, [message]),
          );

          startTransition(() => {
            setSelectedSession((current) => {
              if (nextSession?.id === sessionId) {
                return applySessionMessageToSession(nextSession, message);
              }
              if (current?.id !== sessionId) {
                return current;
              }
              return applySessionMessageToSession(current, message, true);
            });
            setSessions((current) => {
              if (!current) {
                return current;
              }
              return {
                ...current,
                sessions: current.sessions.map((entry) => {
                  if (entry.id !== sessionId) {
                    return entry;
                  }
                  if (nextSession?.id === sessionId) {
                    return applySessionMessageToSession(nextSession, message);
                  }
                  return applySessionMessageToSession(entry, message, true);
                }),
              };
            });
            setSessionMessages((current) => {
              if (!current || current.session.id !== sessionId) {
                return current;
              }
              const merged = mergeSessionMessages(current.messages, [message]);
              const alreadyPresent = hasMatchingSessionMessage(
                current.messages,
                message,
              );
              const nextSessionRecord =
                nextSession?.id === sessionId
                  ? {
                      ...applySessionMessageToSession(nextSession, message),
                      messageCount: Math.max(nextSession.messageCount, merged.length),
                    }
                  : {
                      ...applySessionMessageToSession(
                        current.session,
                        message,
                        !alreadyPresent,
                      ),
                      messageCount: Math.max(
                        current.session.messageCount + (alreadyPresent ? 0 : 1),
                        merged.length,
                      ),
                    };
              return {
                ...current,
                session: nextSessionRecord,
                messages: merged,
              };
            });
          });
        };

        if (intent === "submit") {
          if (isConversationRouteResult(result)) {
            const submittedAt = Date.now();
            stageSessionMessage({
              id: result.messageId,
              sessionId,
              role: "user",
              body: nextBody,
              createdAt: submittedAt,
              surfaceKind: MOBILE_SURFACE_KIND,
              surfaceId: MOBILE_SURFACE_ID,
              metadata: {
                source: "companion-followup",
                messageId: result.messageId,
                timestamp: submittedAt,
                optimistic: true,
              },
            });
            sharedSessionEventFloorRef.current = {
              sessionId,
              timestamp: submittedAt,
            };
            startTransition(() => {
              setSessionSubmission(null);
              setSharedSessionTurnState({
                sessionId,
                userMessageId: result.messageId,
                turnId: null,
                status: "waiting",
                error: null,
                content: null,
                submittedAt,
                updatedAt: submittedAt,
              });
            });
            pushActivity(
              createActivityEntry({
                domain: "app",
                type: "SESSION_MESSAGE_SENT",
                title: "Main chat sent",
                detail: `${nextBody.slice(0, 140)} · delivered to the live conversation`,
                createdAt: submittedAt,
                tone: "accent",
              }),
            );
            await loadSelectedSession(sdk, sessionId, { silent: true });
            queueRefresh();
            return true;
          }

          if (result.mode !== "rejected") {
            stageSessionMessage(result.message, result.session ?? null);
          }
          startTransition(() => {
            setSessionSubmission(null);
          });
          const title =
            result.mode === "continued-live"
              ? "Main chat sent"
              : result.mode === "queued-follow-up"
                ? "Main chat queued"
                : result.mode === "spawn"
                  ? "Main chat started"
                  : "Main chat rejected";
          const detail =
            result.mode === "continued-live"
              ? `${nextBody.slice(0, 140)} · delivered to the live conversation`
              : result.mode === "queued-follow-up"
                ? `${nextBody.slice(0, 140)} · accepted but still queued by the daemon`
                : result.mode === "spawn"
                  ? `${nextBody.slice(0, 140)}${result.agentId ? ` · spawned ${result.agentId}` : " · agent work started"}`
                  : `${nextBody.slice(0, 140)}${result.input.error ? ` · ${result.input.error}` : ""}`;
          pushActivity(
            createActivityEntry({
              domain: "app",
              type: "SESSION_MESSAGE_SENT",
              title,
              detail,
              createdAt: Date.now(),
              tone:
                result.mode === "rejected"
                  ? "danger"
                  : result.mode === "queued-follow-up"
                    ? "warn"
                    : "accent",
            }),
          );
          await loadSelectedSession(sdk, sessionId, { silent: true });
          queueRefresh();
          return result.mode !== "rejected";
        }

        startTransition(() => {
          setSessionSubmission({
            sessionId,
            inputId: result.input.id,
            mode: result.mode,
            state: result.input.state,
            agentId: result.agentId,
            body: nextBody,
            createdAt: result.input.createdAt,
            updatedAt: result.input.updatedAt,
            ...(result.input.error ? { error: result.input.error } : {}),
          });
        });
        const title =
          result.mode === "continued-live"
            ? `${noun} delivered`
            : result.mode === "queued-follow-up"
              ? `${noun} queued`
              : result.mode === "spawn"
                ? `${noun} started`
                : `${noun} rejected`;
        const detail =
          result.mode === "continued-live"
            ? `${nextBody.slice(0, 140)}${result.agentId ? ` · live on ${result.agentId}` : ""}`
            : result.mode === "queued-follow-up"
              ? `${nextBody.slice(0, 140)} · waiting in the session queue`
              : result.mode === "spawn"
                ? `${nextBody.slice(0, 140)}${result.agentId ? ` · spawned ${result.agentId}` : ""}`
                : `${nextBody.slice(0, 140)}${result.input.error ? ` · ${result.input.error}` : ""}`;
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: "SESSION_MESSAGE_SENT",
            title,
            detail,
            createdAt: Date.now(),
            tone:
              result.mode === "rejected"
                ? "danger"
                : result.mode === "queued-follow-up"
                  ? "warn"
                  : "accent",
          }),
        );
        await loadSelectedSession(sdk, sessionId, { silent: true });
        queueRefresh();
        return result.mode !== "rejected";
      } catch (nextError) {
        setError(formatError(nextError));
        return false;
      } finally {
        setSendingSessionId(null);
      }
    },
  );

  const sendMessage = useEffectEvent(
    async (sessionId: string, body: string): Promise<boolean> => {
      return await sendSessionInput(sessionId, body, "submit");
    },
  );

  const sendFollowUp = useEffectEvent(
    async (sessionId: string, body: string): Promise<boolean> => {
      return await sendSessionInput(sessionId, body, "follow-up");
    },
  );

  const switchProviderModel = useEffectEvent(async (registryKey: string) => {
    const sdk = sdkRef.current;
    if (!sdk || !registryKey.trim()) {
      return;
    }

    setSwitchingModelKey(registryKey);
    setError(null);

    try {
      const result = await withTimeout(
        switchCurrentProviderModel(sdk, registryKey.trim()),
        "Model switch",
      );
      if (result.model) {
        pushActivity(
          buildProviderActivity({
            type: "MODEL_CHANGED",
            registryKey: result.model.registryKey,
            provider: result.model.provider,
          }),
        );
      }
      await refreshInternal({ silent: true });
    } catch (nextError) {
      const providerError = extractProviderSwitchError(nextError);
      const targetProvider =
        providerCatalog?.providers.find((provider) =>
          provider.models.some((entry) => entry.registryKey === registryKey.trim()),
        ) ?? null;
      if (
        providerError?.code === "PROVIDER_NOT_CONFIGURED" &&
        targetProvider &&
        (targetProvider.local ||
          targetProvider.authMode === "anonymous" ||
          targetProvider.authMode === "none" ||
          targetProvider.usable)
      ) {
        setError(
          `The daemon rejected ${targetProvider.label}. The app is not blocking this provider; the daemon still reported it as not configured.`,
        );
      } else {
        const missingEnvVars = providerError?.missingEnvVars?.length
          ? " Missing: " + providerError.missingEnvVars.join(", ")
          : "";
        setError(
          providerError
            ? providerError.error + missingEnvVars
            : formatError(nextError),
        );
      }
    } finally {
      setSwitchingModelKey(null);
    }
  });

  const approve = useEffectEvent(async (approvalId: string) => {
    const sdk = sdkRef.current;
    if (!sdk) return;
    setPendingApprovalId(approvalId);
    setError(null);

    try {
      const result = await sdk.operator.approvals.approve(approvalId);
      pushActivity(
        createActivityEntry({
          domain: "app",
          type: "APPROVAL_APPROVED",
          title: "Approval granted",
          detail: result.approval.request.tool,
          createdAt: Date.now(),
          tone: "success",
        }),
      );
      await refreshInternal({ silent: true });
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setPendingApprovalId(null);
    }
  });

  const deny = useEffectEvent(async (approvalId: string) => {
    const sdk = sdkRef.current;
    if (!sdk) return;
    setPendingApprovalId(approvalId);
    setError(null);

    try {
      const result = await sdk.operator.approvals.deny(approvalId);
      pushActivity(
        createActivityEntry({
          domain: "app",
          type: "APPROVAL_DENIED",
          title: "Approval denied",
          detail: result.approval.request.tool,
          createdAt: Date.now(),
          tone: "danger",
        }),
      );
      await refreshInternal({ silent: true });
    } catch (nextError) {
      setError(formatError(nextError));
    } finally {
      setPendingApprovalId(null);
    }
  });

  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;

    let cancelled = false;

    void (async () => {
      try {
        const [baseUrl, savedToken] = await Promise.all([
          readSavedBaseUrl(),
          readSavedToken(),
        ]);
        if (cancelled) {
          return;
        }

        if (!baseUrl) {
          applySignedOutState("");
          return;
        }

        const [storedChatSessionIds, storedSelectedChatSessionId] =
          await Promise.all([
            readSavedCompanionChatSessionIds(baseUrl),
            readSavedSelectedCompanionChatSessionId(baseUrl),
          ]);
        if (cancelled) {
          return;
        }

        baseUrlRef.current = baseUrl;
        companionChatSessionIdsRef.current = storedChatSessionIds;
        selectedChatSessionIdRef.current = storedSelectedChatSessionId;
        setSavedBaseUrl(baseUrl);
        if (!savedToken) {
          applySignedOutState(baseUrl);
          return;
        }

        const sdk = await createMobileGoodVibesSdk(baseUrl, {
          authToken: savedToken,
        });
        sdkRef.current = sdk;
        const currentAuth = await withTimeout(
          sdk.auth.current().catch(() => null),
          "Saved token check",
        );
        if (!currentAuth?.authenticated) {
          await clearSavedToken().catch(() => undefined);
          await sdk.auth.clearToken().catch(() => undefined);
          applySignedOutState(baseUrl);
          return;
        }

        await refreshInternal({ silent: true });
      } catch (nextError) {
        applySignedOutState("", formatError(nextError));
      }
    })();

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const nextForeground = state === "active";
      setForeground(nextForeground);
      if (nextForeground) {
        void refreshInternal({ silent: true });
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (phase !== "ready" || !foreground) {
      return;
    }

    const pollId = setInterval(() => {
      void refreshInternal({ silent: true });
    }, 20_000);

    return () => {
      clearInterval(pollId);
    };
  }, [phase, foreground]);

  useEffect(() => {
    if (phase !== "ready" || !foreground) {
      return;
    }

    const hasPendingSessionInput =
      Boolean(selectedSessionId) &&
      sessionInputs.some(
        (input) =>
          !["completed", "failed", "cancelled", "rejected"].includes(
            input.state,
          ),
      );
    const hasPendingSessionConversation = hasPendingSharedSessionConversation(
      selectedSession,
      sessionMessages,
    );
    const hasPendingChatWork = Boolean(
      selectedChatSessionId &&
      selectedChatSession?.status === "active" &&
      (sendingChatSessionId === selectedChatSessionId ||
        hasActiveCompanionChatTurn(chatTurnState, selectedChatSessionId)),
    );
    if (
      !hasPendingSessionInput &&
      !hasPendingSessionConversation &&
      !hasPendingChatWork
    ) {
      return;
    }

    const pollId = setInterval(() => {
      void refreshInternal({ silent: true });
    }, hasPendingChatWork || hasPendingSessionConversation ? 2_500 : 4_000);

    return () => {
      clearInterval(pollId);
    };
  }, [
    chatTurnState,
    foreground,
    phase,
    selectedChatSession?.status,
    selectedChatSessionId,
    selectedSession,
    selectedSessionId,
    sendingChatSessionId,
    sessionInputs,
    sessionMessages,
  ]);

  useEffect(() => {
    if (phase !== "ready" || !foreground || !selectedChatSessionId) {
      return;
    }

    const currentTurn =
      chatTurnState && chatTurnState.sessionId === selectedChatSessionId
        ? chatTurnState
        : null;
    if (!currentTurn || currentTurn.status === "error") {
      return;
    }

    const timeoutId = setTimeout(() => {
      startTransition(() => {
        setChatTurnState((state) => {
          if (
            !state ||
            state.sessionId !== currentTurn.sessionId ||
            state.updatedAt !== currentTurn.updatedAt ||
            state.status === "error"
          ) {
            return state;
          }
          return {
            ...state,
            status: "error",
            error: "Assistant turn timed out. Pull to refresh or retry.",
            updatedAt: Date.now(),
          };
        });
      });
    }, CHAT_TURN_SETTLE_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [chatTurnState, foreground, phase, selectedChatSessionId]);

  useEffect(() => {
    if (
      phase !== "ready" ||
      !foreground ||
      !selectedSessionId ||
      selectedSession?.status !== "active"
    ) {
      return;
    }

    const sdk = sdkRef.current;
    if (!sdk) {
      return;
    }

    const intervalMs = hasPendingSharedSessionConversation(
      selectedSession,
      sessionMessages,
    )
      ? 2_500
      : 4_000;
    const pollId = setInterval(() => {
      void loadSelectedSession(sdk, selectedSessionId, { silent: true });
    }, intervalMs);

    return () => {
      clearInterval(pollId);
    };
  }, [
    foreground,
    phase,
    selectedSession,
    selectedSessionId,
    sessionMessages,
  ]);

  useEffect(() => {
    if (
      phase !== "ready" ||
      !foreground ||
      !selectedSessionId ||
      selectedSession?.status !== "active"
    ) {
      sharedSessionStreamStopRef.current?.();
      sharedSessionStreamStopRef.current = null;
      if (sharedSessionStreamRetryRef.current) {
        clearTimeout(sharedSessionStreamRetryRef.current);
        sharedSessionStreamRetryRef.current = null;
      }
      return;
    }

    const sdk = sdkRef.current;
    const baseUrl = baseUrlRef.current;
    if (!sdk || !baseUrl) {
      return;
    }

    let disposed = false;

    const clearRetry = () => {
      if (sharedSessionStreamRetryRef.current) {
        clearTimeout(sharedSessionStreamRetryRef.current);
        sharedSessionStreamRetryRef.current = null;
      }
    };

    const closeStream = () => {
      sharedSessionStreamStopRef.current?.();
      sharedSessionStreamStopRef.current = null;
    };

    const scheduleReconnect = (delayMs = 1_500) => {
      if (disposed || selectedSessionIdRef.current !== selectedSessionId) {
        return;
      }
      clearRetry();
      sharedSessionStreamRetryRef.current = setTimeout(() => {
        sharedSessionStreamRetryRef.current = null;
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      closeStream();

      try {
        const token = await sdk.auth.getToken();
        if (disposed || sdkRef.current !== sdk) {
          return;
        }
        if (!token?.trim()) {
          throw new Error("Session stream auth token unavailable.");
        }
        if (selectedSessionIdRef.current !== selectedSessionId) {
          return;
        }

        const stream = openAuthorizedSseStream(
          baseUrl,
          token,
          `/api/sessions/${encodeURIComponent(selectedSessionId)}/events`,
          {
            onEvent: (event) => {
              handleSharedSessionStreamEvent(
                sdk,
                selectedSessionId,
                event.event,
                event.data,
              );
            },
            onError: () => {
              if (!disposed) {
                scheduleReconnect();
              }
            },
          },
        );

        if (disposed || selectedSessionIdRef.current !== selectedSessionId) {
          stream.close();
          return;
        }

        sharedSessionStreamStopRef.current = () => {
          stream.close();
        };
      } catch {
        if (!disposed) {
          scheduleReconnect();
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      clearRetry();
      closeStream();
    };
  }, [foreground, phase, selectedSession?.status, selectedSessionId]);

  useEffect(() => {
    if (phase !== "ready" || !selectedSessionId) {
      sessionInputStatesRef.current = new Map();
      sessionInputSessionRef.current = null;
      return;
    }

    if (sessionInputSessionRef.current !== selectedSessionId) {
      sessionInputSessionRef.current = selectedSessionId;
      sessionInputStatesRef.current = new Map(
        sessionInputs.map((input) => [input.id, input.state]),
      );
      return;
    }

    const previousStates = sessionInputStatesRef.current;
    const nextStates = new Map<string, GoodVibesSessionInputRecord["state"]>();

    for (const input of sessionInputs) {
      nextStates.set(input.id, input.state);
      const previousState = previousStates.get(input.id);
      if (previousState && previousState !== input.state) {
        pushActivity(buildSessionInputActivity(input, previousState));
      }
    }

    sessionInputStatesRef.current = nextStates;
  }, [phase, selectedSessionId, sessionInputs]);

  const handleSharedSessionTurnEnvelope = useEffectEvent(
    (
      sdk: GoodVibesSdk,
      envelope: {
        readonly ts?: number;
        readonly sessionId?: string;
        readonly turnId?: string;
        readonly payload: {
          readonly type: string;
          readonly turnId?: string;
          readonly prompt?: string;
          readonly content?: string;
          readonly accumulated?: string;
          readonly response?: string;
          readonly error?: string;
          readonly reason?: string;
        };
      },
    ) => {
      const sessionId =
        typeof envelope.sessionId === "string" && envelope.sessionId.trim().length > 0
          ? envelope.sessionId
          : null;
      if (!sessionId) {
        return;
      }

      const event = envelope.payload;
      const eventType = event.type;
      const eventAt = typeof envelope.ts === "number" ? envelope.ts : Date.now();
      const selected = selectedSessionIdRef.current === sessionId;

      const trackState = () => {
        startTransition(() => {
          setSharedSessionTurnState((current) => {
            if (!selected && current?.sessionId !== sessionId) {
              return current;
            }

            const tracked = current && current.sessionId === sessionId ? current : null;
            const latestUserMessage =
              sessionMessages?.session.id === sessionId
                ? [...sessionMessages.messages]
                    .reverse()
                    .find((message) => message.role === "user") ?? null
                : null;
            const userMessageId = tracked?.userMessageId ?? latestUserMessage?.id ?? null;
            const submittedAt = tracked?.submittedAt ?? latestUserMessage?.createdAt ?? eventAt;
            const turnId = event.turnId ?? envelope.turnId ?? tracked?.turnId ?? null;

            switch (eventType) {
              case "TURN_SUBMITTED":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: "waiting",
                  error: null,
                  content: null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              case "STREAM_START":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: tracked?.content ? "streaming" : "waiting",
                  error: null,
                  content: tracked?.content ?? null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              case "STREAM_DELTA":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: "streaming",
                  error: null,
                  content:
                    (typeof event.accumulated === "string" && event.accumulated.length
                      ? event.accumulated
                      : typeof event.content === "string" && event.content.length
                        ? (tracked?.content ?? "") + event.content
                        : tracked?.content) ?? null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              case "TURN_COMPLETED":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: "completed",
                  error: null,
                  content: typeof event.response === "string" ? event.response : tracked?.content ?? null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              case "TURN_ERROR":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: "error",
                  error:
                    typeof event.error === "string" && event.error.trim().length
                      ? event.error.trim()
                      : "Assistant turn failed.",
                  content: tracked?.content ?? null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              case "PREFLIGHT_FAIL":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: "error",
                  error:
                    typeof event.reason === "string" && event.reason.trim().length
                      ? event.reason.trim()
                      : "Assistant turn failed before execution.",
                  content: tracked?.content ?? null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              case "TURN_CANCEL":
                return {
                  sessionId,
                  userMessageId,
                  turnId,
                  status: "error",
                  error:
                    typeof event.reason === "string" && event.reason.trim().length
                      ? event.reason.trim()
                      : "Assistant turn was cancelled.",
                  content: tracked?.content ?? null,
                  submittedAt,
                  updatedAt: eventAt,
                };
              default:
                return tracked;
            }
          });
        });
      };

      if (
        eventType === "TURN_SUBMITTED" ||
        eventType === "STREAM_START" ||
        eventType === "STREAM_DELTA" ||
        eventType === "TURN_COMPLETED" ||
        eventType === "TURN_ERROR" ||
        eventType === "PREFLIGHT_FAIL" ||
        eventType === "TURN_CANCEL"
      ) {
        if (selected || sharedSessionTurnState?.sessionId === sessionId) {
          trackState();
        }
      }

      if (eventType === "TURN_COMPLETED") {
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: eventType,
            title: "Shared session reply ready",
            detail:
              (typeof event.response === "string" ? event.response : "Assistant replied")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 140),
            createdAt: eventAt,
            tone: "success",
          }),
        );
      } else if (eventType === "TURN_ERROR" || eventType === "PREFLIGHT_FAIL") {
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: eventType,
            title: "Shared session turn failed",
            detail:
              ((typeof event.error === "string" && event.error) ||
                (typeof event.reason === "string" && event.reason) ||
                "Assistant turn failed")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 140),
            createdAt: eventAt,
            tone: "danger",
          }),
        );
      }

      if (
        eventType === "TURN_COMPLETED" ||
        eventType === "TURN_ERROR" ||
        eventType === "PREFLIGHT_FAIL" ||
        eventType === "TURN_CANCEL"
      ) {
        if (selected) {
          void loadSelectedSession(sdk, sessionId, { silent: true });
        } else {
          queueRefresh();
        }
      }
    },
  );

  const handleSharedSessionStreamEvent = useEffectEvent(
    (
      sdk: GoodVibesSdk,
      sharedSessionId: string,
      eventName: string,
      data: unknown,
    ) => {
      if (typeof data !== "object" || data === null) {
        return;
      }

      const record = data as Record<string, unknown>;
      if (eventName === "turn") {
        const payload =
          typeof record.payload === "object" && record.payload !== null
            ? (record.payload as Record<string, unknown>)
            : null;
        const eventType = typeof payload?.type === "string" ? payload.type : null;
        if (!payload || !eventType) {
          return;
        }

        const eventAt =
          typeof record.timestamp === "number"
            ? record.timestamp
            : typeof record.ts === "number"
              ? record.ts
              : Date.now();
        const eventFloor = sharedSessionEventFloorRef.current;
        if (
          eventFloor &&
          eventFloor.sessionId === sharedSessionId &&
          eventAt < eventFloor.timestamp
        ) {
          return;
        }

        handleSharedSessionTurnEnvelope(sdk, {
          sessionId: sharedSessionId,
          ts: eventAt,
          turnId:
            typeof record.turnId === "string"
              ? record.turnId
              : typeof payload.turnId === "string"
                ? payload.turnId
                : undefined,
          payload: {
            type: eventType,
            ...(typeof payload.turnId === "string"
              ? { turnId: payload.turnId }
              : {}),
            ...(typeof payload.prompt === "string"
              ? { prompt: payload.prompt }
              : {}),
            ...(typeof payload.content === "string"
              ? { content: payload.content }
              : {}),
            ...(typeof payload.accumulated === "string"
              ? { accumulated: payload.accumulated }
              : {}),
            ...(typeof payload.response === "string"
              ? { response: payload.response }
              : {}),
            ...(typeof payload.error === "string"
              ? { error: payload.error }
              : {}),
            ...(typeof payload.reason === "string"
              ? { reason: payload.reason }
              : {}),
          },
        });
        return;
      }

      if (eventName !== "session-update") {
        return;
      }

      const updateType = typeof record.event === "string" ? record.event : null;
      const payload =
        typeof record.payload === "object" && record.payload !== null
          ? (record.payload as Record<string, unknown>)
          : null;
      if (!updateType) {
        return;
      }

      if (updateType === "session-message-appended" && payload) {
        const message = payload.message;
        if (
          typeof message === "object" &&
          message !== null &&
          typeof (message as { readonly id?: unknown }).id === "string" &&
          typeof (message as { readonly sessionId?: unknown }).sessionId ===
            "string" &&
          typeof (message as { readonly role?: unknown }).role === "string" &&
          typeof (message as { readonly body?: unknown }).body === "string" &&
          typeof (message as { readonly createdAt?: unknown }).createdAt ===
            "number"
        ) {
          mergeSharedSessionStreamMessage(
            message as GoodVibesSessionMessageRecord,
          );
        }
        return;
      }

      if (selectedSessionIdRef.current === sharedSessionId) {
        void loadSelectedSession(sdk, sharedSessionId, { silent: true });
      }
    },
  );

  useEffect(() => {
    if (phase !== "ready" || !foreground) {
      return;
    }

    const sdk = sdkRef.current;
    if (!sdk) {
      return;
    }

    const runtime = sdk.realtime.runtime();
    const unsubscribers = [
      runtime.session.onEnvelope("COMPANION_MESSAGE_RECEIVED", (envelope) => {
        const event = envelope.payload as {
          readonly sessionId: string;
          readonly body: string;
          readonly messageId: string;
          readonly source: string;
          readonly timestamp: number;
          readonly type: "COMPANION_MESSAGE_RECEIVED";
        };
        pushActivity(
          createActivityEntry({
            domain: "app",
            type: event.type,
            title: "Shared chat delivered",
            detail: event.body.replace(/\s+/g, " ").trim().slice(0, 140),
            createdAt: event.timestamp,
            tone: "accent",
          }),
        );
        if (selectedSessionIdRef.current === event.sessionId) {
          void loadSelectedSession(sdk, event.sessionId, { silent: true });
          return;
        }
        queueRefresh();
      }),
      runtime.agents.onEnvelope("AGENT_SPAWNING", (envelope) => {
        pushActivity(buildAgentActivity(envelope.payload as AgentEvent));
        queueRefresh();
      }),
      runtime.agents.onEnvelope("AGENT_RUNNING", (envelope) => {
        pushActivity(buildAgentActivity(envelope.payload as AgentEvent));
        queueRefresh();
      }),
      runtime.agents.onEnvelope("AGENT_PROGRESS", (envelope) => {
        pushActivity(buildAgentActivity(envelope.payload as AgentEvent));
      }),
      runtime.agents.onEnvelope("AGENT_COMPLETED", (envelope) => {
        pushActivity(buildAgentActivity(envelope.payload as AgentEvent));
        queueRefresh();
      }),
      runtime.agents.onEnvelope("AGENT_FAILED", (envelope) => {
        pushActivity(buildAgentActivity(envelope.payload as AgentEvent));
        queueRefresh();
      }),
      runtime.agents.onEnvelope("AGENT_CANCELLED", (envelope) => {
        pushActivity(buildAgentActivity(envelope.payload as AgentEvent));
        queueRefresh();
      }),
      runtime.tasks.onEnvelope("TASK_CREATED", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
        queueRefresh();
      }),
      runtime.tasks.onEnvelope("TASK_STARTED", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
        queueRefresh();
      }),
      runtime.tasks.onEnvelope("TASK_PROGRESS", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
      }),
      runtime.tasks.onEnvelope("TASK_BLOCKED", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
        queueRefresh();
      }),
      runtime.tasks.onEnvelope("TASK_COMPLETED", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
        queueRefresh();
      }),
      runtime.tasks.onEnvelope("TASK_FAILED", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
        queueRefresh();
      }),
      runtime.tasks.onEnvelope("TASK_CANCELLED", (envelope) => {
        pushActivity(buildTaskActivity(envelope.payload as TaskEvent));
        queueRefresh();
      }),
      runtime["control-plane"].onEnvelope(
        "CONTROL_PLANE_CLIENT_CONNECTED",
        (envelope) => {
          pushActivity(
            buildControlPlaneActivity(envelope.payload as ControlPlaneEvent),
          );
        },
      ),
      runtime["control-plane"].onEnvelope(
        "CONTROL_PLANE_CLIENT_DISCONNECTED",
        (envelope) => {
          pushActivity(
            buildControlPlaneActivity(envelope.payload as ControlPlaneEvent),
          );
        },
      ),
      runtime["control-plane"].onEnvelope(
        "CONTROL_PLANE_AUTH_GRANTED",
        (envelope) => {
          pushActivity(
            buildControlPlaneActivity(envelope.payload as ControlPlaneEvent),
          );
        },
      ),
      runtime["control-plane"].onEnvelope(
        "CONTROL_PLANE_AUTH_REJECTED",
        (envelope) => {
          pushActivity(
            buildControlPlaneActivity(envelope.payload as ControlPlaneEvent),
          );
        },
      ),
      runtime.providers.onEnvelope("MODEL_CHANGED", (envelope) => {
        pushActivity(buildProviderActivity(envelope.payload));
        queueRefresh();
      }),
      runtime.providers.onEnvelope("MODEL_FALLBACK", (envelope) => {
        pushActivity(buildProviderActivity(envelope.payload));
        queueRefresh();
      }),
      runtime.providers.onEnvelope("PROVIDER_WARNING", (envelope) => {
        pushActivity(buildProviderActivity(envelope.payload));
        queueRefresh();
      }),
      runtime.providers.onEnvelope("PROVIDERS_CHANGED", (envelope) => {
        pushActivity(buildProviderActivity(envelope.payload));
        queueRefresh();
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [foreground, phase]);

  return {
    phase,
    savedBaseUrl,
    authenticating,
    refreshing,
    loadingSession,
    loadingChatSession,
    creatingChatSession,
    pendingApprovalId,
    sendingSessionId,
    sendingChatSessionId,
    chatTurnState,
    sharedSessionTurnState,
    providerCatalog,
    switchingModelKey,
    error,
    foreground,
    lastUpdatedAt,
    auth,
    control,
    tasks,
    sessions,
    approvals,
    chatSessions,
    selectedChatSessionId,
    selectedChatSession,
    chatMessages,
    selectedSessionId,
    selectedSession,
    sessionMessages,
    sessionInputs,
    sessionSubmission,
    activity,
    signInWithPassword,
    signInWithToken,
    signOut,
    refresh: async () => {
      await refreshInternal();
    },
    createChatSession,
    selectChatSession,
    sendChatMessage,
    selectSession,
    sendMessage,
    sendFollowUp,
    switchProviderModel,
    setChatSessionModel,
    setPendingChatModel,
    settingChatModelSessionId,
    pendingChatModel,
    approve,
    deny,
  };
}
