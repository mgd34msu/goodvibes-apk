import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  StatusBar,
  Text,
  TextInput,
  View,
} from "react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import LinearGradient from "react-native-linear-gradient";
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { palette, spacing } from "./src/theme";
import { useCompanionApp } from "./src/hooks/use-companion-app";
import { normalizeBaseUrl } from "./src/lib/goodvibes";
import { parseGoodVibesQrPayload } from "./src/lib/goodvibes-qr";
import {
  formatGoodVibesQrScanError,
  isGoodVibesQrScanCancelled,
  isGoodVibesQrScannerAvailable,
  scanGoodVibesQrCode,
} from "./src/lib/goodvibes-qr-scanner";
import type {
  ActivityEntry,
  GoodVibesApprovalRecord,
  GoodVibesCompanionChatMessage,
  GoodVibesCompanionChatSession,
  GoodVibesSessionInputRecord,
  GoodVibesSessionMessageRecord,
  GoodVibesSessionRecord,
  GoodVibesTaskRecord,
} from "./src/types/goodvibes";
import type {
  ProviderEntry,
  ProviderModelEntry,
  ProviderModelRef,
} from "./src/types/provider-model";

type AuthMode = "password" | "token";
type AppMode = "chat" | "shared" | "control";
type DashboardTab =
  | "overview"
  | "models"
  | "sessions"
  | "tasks"
  | "approvals"
  | "activity";
type SessionComposerMode = "chat" | "follow-up";

const OPEN_SESSION_RECENCY_WINDOW_MS = 5 * 60_000;
const OPEN_SESSION_ACTIVITY_WINDOW_MS = 30 * 60_000;
const STALE_PENDING_INPUT_WINDOW_MS = 10 * 60_000;

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

function formatTimestamp(value?: number | null): string {
  if (!value) return "n/a";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatChatTime(value?: number | null): string {
  if (!value) return "n/a";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatChatHeaderTitle(value?: string | null): string {
  if (!value) return "New chat";
  return value.startsWith("Companion Chat ") ? "Companion Chat" : value;
}

function formatRelativeTime(value?: number | null): string {
  if (!value) return "n/a";
  const deltaMs = value - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (Math.abs(deltaMinutes) < 1) return "just now";
  if (Math.abs(deltaMinutes) < 60) {
    return `${Math.abs(deltaMinutes)}m ${deltaMinutes < 0 ? "ago" : "from now"}`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return `${Math.abs(deltaHours)}h ${deltaHours < 0 ? "ago" : "from now"}`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${Math.abs(deltaDays)}d ${deltaDays < 0 ? "ago" : "from now"}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function formatMessagePreview(message: GoodVibesSessionMessageRecord): string {
  return truncate(message.body.replace(/\s+/g, " ").trim(), 240);
}

function formatSharedSessionMessageAuthor(
  message: GoodVibesSessionMessageRecord,
): string {
  if (message.displayName?.trim()) {
    return message.displayName.trim();
  }
  if (message.role === "assistant") {
    return "Assistant";
  }
  if (message.role === "system") {
    return "System";
  }
  return "You";
}

function formatCompanionChatBody(content: string): string {
  return content.replace(/\r\n/g, "\n").trim() || "(empty message)";
}

function findLatestNonUserMessageAt(
  messages: readonly GoodVibesSessionMessageRecord[] | null | undefined,
): number | null {
  if (!messages?.length) return null;
  let latest: number | null = null;
  for (const message of messages) {
    if (message.role === "user") continue;
    latest =
      latest === null ? message.createdAt : Math.max(latest, message.createdAt);
  }
  return latest;
}

function formatArgs(args: unknown): string {
  if (!args) return "No structured args.";
  try {
    return truncate(JSON.stringify(args, null, 2), 280);
  } catch {
    return "Args available but could not be formatted.";
  }
}

function toneColor(
  tone: "accent" | "success" | "warn" | "danger" | "violet",
): string {
  switch (tone) {
    case "success":
      return palette.success;
    case "warn":
      return palette.warn;
    case "danger":
      return palette.danger;
    case "violet":
      return palette.violet;
    case "accent":
    default:
      return palette.accent;
  }
}

function statusColor(status?: string): string {
  switch (status) {
    case "completed":
    case "approved":
    case "active":
      return palette.success;
    case "running":
    case "claimed":
    case "delivered":
      return palette.accent;
    case "blocked":
    case "pending":
    case "queued":
      return palette.warn;
    case "failed":
    case "denied":
    case "expired":
    case "cancelled":
    case "rejected":
      return palette.danger;
    case "spawned":
    default:
      return palette.violet;
  }
}

function statusTone(
  status?: string,
): "accent" | "success" | "warn" | "danger" | "violet" {
  switch (status) {
    case "completed":
    case "approved":
    case "active":
      return "success";
    case "running":
    case "claimed":
    case "delivered":
      return "accent";
    case "blocked":
    case "pending":
    case "queued":
      return "warn";
    case "failed":
    case "denied":
    case "expired":
    case "cancelled":
    case "rejected":
      return "danger";
    case "spawned":
    default:
      return "violet";
  }
}

function followUpModeTone(
  mode?: "continued-live" | "queued-follow-up" | "rejected" | "spawn" | null,
): "accent" | "success" | "warn" | "danger" | "violet" {
  switch (mode) {
    case "continued-live":
      return "success";
    case "queued-follow-up":
      return "warn";
    case "rejected":
      return "danger";
    case "spawn":
    default:
      return "violet";
  }
}

function formatInputStateLabel(
  state: GoodVibesSessionInputRecord["state"],
): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "delivered":
      return "Delivered";
    case "spawned":
      return "Spawned";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "rejected":
      return "Rejected";
    default:
      return state;
  }
}

function formatFollowUpModeLabel(
  mode?: "continued-live" | "queued-follow-up" | "rejected" | "spawn" | null,
): string {
  switch (mode) {
    case "continued-live":
      return "Live Session";
    case "queued-follow-up":
      return "Queued";
    case "rejected":
      return "Rejected";
    case "spawn":
      return "Spawned Agent";
    default:
      return "No recent submit";
  }
}

function formatInputIntentLabel(
  intent: GoodVibesSessionInputRecord["intent"],
): string {
  switch (intent) {
    case "follow-up":
      return "Queued Follow-up";
    case "steer":
      return "Steer";
    case "submit":
      return "Main Chat Message";
    default:
      return intent;
  }
}

function isPendingInputState(
  state: GoodVibesSessionInputRecord["state"],
): boolean {
  return !["completed", "failed", "cancelled", "rejected"].includes(state);
}

function formatCompactId(value: string): string {
  return value.length > 18 ? value.slice(0, 8) + "…" + value.slice(-6) : value;
}

function formatDashboardTabLabel(tab: DashboardTab): string {
  switch (tab) {
    case "models":
      return "Models";
    case "sessions":
      return "Shared Sessions";
    case "tasks":
      return "Runtime Tasks";
    case "approvals":
      return "Approvals";
    case "activity":
      return "Activity";
    case "overview":
    default:
      return "Overview";
  }
}

function formatProviderConfiguredVia(value?: string | null): string {
  if (!value) return "not configured";
  switch (value) {
    case "env":
      return "environment";
    case "secrets":
      return "secrets";
    case "subscription":
      return "subscription";
    case "anonymous":
      return "local / anonymous";
    default:
      return value;
  }
}

function formatProviderAvailability(provider: ProviderEntry): string {
  if (provider.local && provider.usable) {
    return "local / available";
  }
  if (provider.local) {
    return "local / daemon decides";
  }
  if (provider.usable) {
    return provider.authMode === "anonymous" || provider.authMode === "none"
      ? "available"
      : "ready";
  }
  if (provider.detail?.trim()) {
    return provider.detail.trim();
  }
  return "try switch";
}

function formatProviderAvailabilityTone(
  provider: ProviderEntry,
): "success" | "warn" | "accent" {
  if (provider.usable) {
    return provider.local ? "accent" : "success";
  }
  return provider.local ? "accent" : "warn";
}

function formatProviderName(value?: string | null): string {
  if (!value?.trim()) return "Unknown";
  switch (value.trim()) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    case "inceptionlabs":
      return "Inception Labs";
    case "lm-studio":
      return "LM Studio";
    case "ollama":
      return "Ollama";
    case "ollama-cloud":
      return "Ollama Cloud";
    case "huggingface":
      return "Hugging Face";
    case "github-copilot":
      return "GitHub Copilot";
    case "amazon-bedrock":
      return "Amazon Bedrock";
    case "anthropic-vertex":
      return "Anthropic (Vertex)";
    case "synthetic":
      return "Synthetic (Local)";
    default:
      return value
        .trim()
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function formatCurrentModelSummary(model: ProviderModelRef | null | undefined): string {
  if (!model) return "No model selected";
  return model.registryKey + " · " + formatProviderName(model.provider);
}

function formatChatSessionModelSummary(
  session: GoodVibesCompanionChatSession | null | undefined,
): string | null {
  if (!session?.model) {
    return null;
  }
  if (
    session.provider &&
    !session.model.startsWith(session.provider + ":")
  ) {
    return formatProviderName(session.provider) + ":" + session.model;
  }
  return session.model;
}

function resolveProviderModelRef(
  providers: readonly ProviderEntry[],
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): ProviderModelRef | null {
  const trimmedModelId = modelId?.trim();
  if (!trimmedModelId) {
    return null;
  }

  const candidateProviders = providerId?.trim()
    ? providers.filter((provider) => provider.id === providerId.trim())
    : providers;
  const matchingModel = candidateProviders
    .flatMap((provider) => provider.models)
    .find(
      (model) =>
        model.id === trimmedModelId ||
        model.registryKey === trimmedModelId ||
        (providerId?.trim()
          ? model.registryKey === providerId.trim() + ":" + trimmedModelId
          : false),
    );

  if (matchingModel) {
    return {
      registryKey: matchingModel.registryKey,
      provider: matchingModel.provider,
      id: matchingModel.id,
    };
  }

  const provider = providerId?.trim() || (trimmedModelId.includes(":")
    ? trimmedModelId.split(":")[0] ?? "unknown"
    : "unknown");
  return {
    registryKey: trimmedModelId.includes(":")
      ? trimmedModelId
      : provider + ":" + trimmedModelId,
    provider,
    id: trimmedModelId.includes(":")
      ? trimmedModelId.split(":")[1] ?? trimmedModelId
      : trimmedModelId,
  };
}

function formatProviderModelLabel(model: ProviderModelEntry): string {
  return model.label?.trim() || model.registryKey;
}

interface DisplaySessionInput {
  readonly input: GoodVibesSessionInputRecord;
  readonly state: GoodVibesSessionInputRecord["state"];
  readonly inferred: boolean;
}

function reconcileSessionInputs(
  inputs: readonly GoodVibesSessionInputRecord[],
  pendingInputCount: number,
  latestNonUserMessageAt: number | null,
  now = Date.now(),
): readonly DisplaySessionInput[] {
  let remainingPending = Math.max(0, pendingInputCount);
  return [...inputs]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((input) => {
      if (!isPendingInputState(input.state)) {
        return {
          input,
          state: input.state,
          inferred: false,
        };
      }

      if (
        !input.activeAgentId &&
        latestNonUserMessageAt !== null &&
        latestNonUserMessageAt > input.createdAt
      ) {
        return {
          input,
          state: "completed",
          inferred: true,
        };
      }

      if (
        !input.activeAgentId &&
        input.updatedAt < now - STALE_PENDING_INPUT_WINDOW_MS
      ) {
        return {
          input,
          state: "completed",
          inferred: true,
        };
      }

      if (remainingPending > 0) {
        remainingPending -= 1;
        return {
          input,
          state: input.state,
          inferred: false,
        };
      }

      return {
        input,
        state: "completed",
        inferred: true,
      };
    });
}

function isLiveTask(task: GoodVibesTaskRecord): boolean {
  return (
    !task.endedAt &&
    (task.status === "queued" ||
      task.status === "running" ||
      task.status === "blocked")
  );
}

function AppShell() {
  const model = useCompanionApp();
  const insets = useSafeAreaInsets();
  const [authMode, setAuthMode] = useState<AuthMode>("password");
  const [appMode, setAppMode] = useState<AppMode>("chat");
  const [activeTab, setActiveTab] = useState<DashboardTab>("sessions");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [scanningQr, setScanningQr] = useState(false);
  const [composerMode, setComposerMode] = useState<SessionComposerMode>("chat");
  const [chatDraftMessage, setChatDraftMessage] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelApplyScope, setModelApplyScope] = useState<"global" | "chat">(
    "global",
  );
  const [inputsExpanded, setInputsExpanded] = useState(false);
  const [sessionInspectorExpanded, setSessionInspectorExpanded] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const chatMessageScrollRef = useRef<ScrollView | null>(null);
  const sharedSessionScrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    setBaseUrl(model.savedBaseUrl);
  }, [model.savedBaseUrl]);

  useEffect(() => {
    if (!model.selectedSessionId) {
      setDraftMessage("");
    }
  }, [model.selectedSessionId]);

  useEffect(() => {
    const providers = model.providerCatalog?.providers ?? [];
    if (!providers.length) {
      setSelectedProviderId(null);
      return;
    }

    if (
      selectedProviderId &&
      providers.some((provider) => provider.id === selectedProviderId)
    ) {
      return;
    }

    const activeProviderId = model.providerCatalog?.currentModel?.provider ?? null;
    const preferredProviderId =
      activeProviderId &&
      providers.some((provider) => provider.id === activeProviderId)
        ? activeProviderId
        : providers[0]?.id ?? null;
    setSelectedProviderId(preferredProviderId);
  }, [model.providerCatalog, selectedProviderId]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(
        Math.max(0, event.endCoordinates.height - insets.bottom),
      );
      if (appMode === "chat") {
        setTimeout(() => {
          chatMessageScrollRef.current?.scrollToEnd({ animated: true });
        }, 36);
      } else if (appMode === "shared") {
        setTimeout(() => {
          sharedSessionScrollRef.current?.scrollToEnd({ animated: true });
        }, 36);
      }
      if (appMode === "control" && activeTab === "sessions") {
        setTimeout(() => {
          sharedSessionScrollRef.current?.scrollToEnd({ animated: true });
        }, 36);
      }
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [activeTab, appMode, insets.bottom]);

  const canApprove = model.auth?.scopes.includes("write:approvals") ?? false;
  const canWriteSessions =
    model.auth?.scopes.includes("write:sessions") ?? false;
  const canSwitchModels =
    model.auth?.scopes.includes("write:control-plane") ?? false;
  const canScanQr = isGoodVibesQrScannerAvailable();
  const currentProviderModel = model.providerCatalog?.currentModel ?? null;
  const providerCount = model.providerCatalog?.providers.length ?? 0;
  const normalizedProviderSearch = providerSearch.trim().toLowerCase();
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const filteredProviders = (model.providerCatalog?.providers ?? []).filter(
    (provider) => {
      if (!normalizedProviderSearch) {
        return true;
      }
      const providerEnvVars = Array.isArray(provider.envVars) ? provider.envVars : [];
      const providerRoutes = Array.isArray(provider.routes) ? provider.routes : [];
      const haystack = [
        provider.id,
        provider.label,
        provider.configuredVia ?? "",
        provider.authMode ?? "",
        provider.detail ?? "",
        ...providerEnvVars,
        ...providerRoutes.map((route) => route.label),
        ...providerRoutes.map((route) => route.detail ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedProviderSearch);
    },
  );
  const selectedProvider =
    filteredProviders.find((provider) => provider.id === selectedProviderId) ??
    (selectedProviderId
      ? (model.providerCatalog?.providers ?? []).find(
          (provider) => provider.id === selectedProviderId,
        ) ?? null
      : null) ??
    filteredProviders[0] ??
    null;
  const filteredModels = (selectedProvider?.models ?? []).filter((entry) => {
    if (!normalizedModelSearch) {
      return true;
    }
    const haystack = [
      entry.id,
      entry.registryKey,
      entry.label ?? "",
      entry.provider,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedModelSearch);
  });
  const sessionListNow = Date.now();
  const selectedChatSession =
    model.selectedChatSession ??
    model.chatSessions.find(
      (session) => session.id === model.selectedChatSessionId,
    ) ??
    null;
  const loadedChatMessages = model.chatMessages;
  const chatPinnedModelRef = resolveProviderModelRef(
    model.providerCatalog?.providers ?? [],
    selectedChatSession?.provider,
    selectedChatSession?.model,
  );
  const selectedChatModelSummary =
    (chatPinnedModelRef ? formatCurrentModelSummary(chatPinnedModelRef) : null) ??
    formatChatSessionModelSummary(selectedChatSession) ??
    (selectedChatSession ? "daemon default" : null);
  const selectedChatTurnState =
    model.chatTurnState?.sessionId === selectedChatSession?.id
      ? model.chatTurnState
      : null;
  const selectedChatActivityAt =
    selectedChatSession?.updatedAt ?? selectedChatSession?.createdAt ?? null;
  const chatIsClosed = selectedChatSession?.status === "closed";
  const effectiveScope: "global" | "chat" =
    modelApplyScope === "chat" && !selectedChatSession && !model.pendingChatModel
      ? "chat"
      : modelApplyScope;
  const pickerCurrentModel: ProviderModelRef | null =
    effectiveScope === "chat"
      ? chatPinnedModelRef ?? model.pendingChatModel ?? null
      : currentProviderModel;
  const pickerBusy =
    Boolean(model.switchingModelKey) ||
    Boolean(model.settingChatModelSessionId);
  const chatTurnFailed = selectedChatTurnState?.status === "error";
  const chatReplyPending =
    Boolean(selectedChatSession) &&
    !chatIsClosed &&
    (Boolean(model.sendingChatSessionId) ||
      selectedChatTurnState?.status === "waiting");
  // Per-session model selection is intentionally independent from the global
  // currentProviderModel now — the daemon honors them separately. The previous
  // "mismatch" warning was a relic of the old single-model contract.
  const chatModelMismatch = false;
  const chatStatusLabel = model.loadingChatSession
    ? "Loading conversation"
    : model.creatingChatSession
      ? "Creating conversation"
      : model.sendingChatSessionId
        ? "Sending message"
        : chatIsClosed
          ? "Conversation closed"
          : chatTurnFailed
            ? "Assistant turn failed"
            : chatReplyPending
              ? "Waiting for assistant"
              : selectedChatSession
                ? "Last active " + formatRelativeTime(selectedChatActivityAt)
                : "Companion chat ready";
  const chatStatusDetail = model.loadingChatSession
    ? "Pulling the latest companion chat thread."
    : model.creatingChatSession
      ? "Creating a new companion-only conversation on the daemon."
      : model.sendingChatSessionId
        ? "Waiting for the daemon to accept the message."
        : chatIsClosed
          ? "This conversation is closed. Create a new one from the menu to continue chatting."
          : chatTurnFailed
            ? selectedChatTurnState?.error ??
              "The assistant turn failed before it finished."
            : chatReplyPending
              ? "Waiting for the assistant reply. The app is polling the daemon for the completed turn."
              : selectedChatSession
                  ? String(loadedChatMessages.length) +
                    " messages in this thread." +
                    (selectedChatModelSummary
                      ? " Bound to " + selectedChatModelSummary + "."
                      : "")
                  : "Open the menu to switch chats, or send the first message to create one.";
  const chatStatusColor = model.loadingChatSession
    ? palette.accent
    : model.creatingChatSession || model.sendingChatSessionId
      ? palette.accent
      : chatIsClosed
        ? palette.warn
        : chatTurnFailed
          ? palette.danger
          : chatReplyPending
            ? palette.violet
            : palette.success;
  const showChatActivity =
    model.loadingChatSession ||
    model.creatingChatSession ||
    Boolean(model.sendingChatSessionId) ||
    Boolean(chatTurnFailed) ||
    Boolean(chatReplyPending);
  const chatSendDisabled =
    !chatDraftMessage.trim() ||
    !canWriteSessions ||
    model.creatingChatSession ||
    Boolean(model.sendingChatSessionId) ||
    (chatReplyPending && !chatTurnFailed) ||
    chatIsClosed;

  useEffect(() => {
    if (appMode !== "chat") {
      return;
    }

    const timer = setTimeout(() => {
      chatMessageScrollRef.current?.scrollToEnd({ animated: false });
    }, 40);

    return () => {
      clearTimeout(timer);
    };
  }, [
    appMode,
    loadedChatMessages.length,
    model.loadingChatSession,
    model.sendingChatSessionId,
    selectedChatSession?.id,
    selectedChatSession?.status,
  ]);

  const visibleSessions = model.sessions?.sessions ?? [];
  const openSessions = [...visibleSessions]
    .filter((session) => isSessionOpen(session, visibleSessions, sessionListNow))
    .sort(compareSharedSessionActivity);
  const visibleOpenSessions = openSessions.length;
  const visibleInactiveSessions = visibleSessions.filter(
    (session) =>
      session.status === "active" &&
      !isSessionOpen(session, visibleSessions, sessionListNow),
  ).length;
  const visibleClosedSessions = visibleSessions.filter(
    (session) => session.status === "closed",
  ).length;
  const selectedSession =
    model.selectedSession ??
    visibleSessions.find((session) => session.id === model.selectedSessionId) ??
    null;
  const latestNonUserMessageAt = findLatestNonUserMessageAt(
    model.sessionMessages?.messages,
  );
  const reconciledSessionInputs = reconcileSessionInputs(
    model.sessionInputs,
    selectedSession?.pendingInputCount ?? 0,
    latestNonUserMessageAt,
  );
  const pendingSessionInputs = reconciledSessionInputs.filter((entry) =>
    isPendingInputState(entry.state),
  );
  const recentSessionInputs = reconciledSessionInputs.slice(0, 6);
  const displayedPendingInputCount = pendingSessionInputs.length;
  const liveTasks = (model.tasks?.tasks ?? []).filter((task) =>
    isLiveTask(task),
  );
  const queuedTaskCount = liveTasks.filter(
    (task) => task.status === "queued",
  ).length;
  const runningTaskCount = liveTasks.filter(
    (task) => task.status === "running",
  ).length;
  const blockedTaskCount = liveTasks.filter(
    (task) => task.status === "blocked",
  ).length;
  const failedTaskCount = (model.tasks?.tasks ?? []).filter(
    (task) => task.status === "failed",
  ).length;
  const trackedSubmission =
    model.sessionSubmission?.sessionId === selectedSession?.id
      ? model.sessionSubmission
      : null;
  const trackedSubmissionInput = trackedSubmission
    ? (reconciledSessionInputs.find(
        (entry) => entry.input.id === trackedSubmission.inputId,
      ) ?? null)
    : null;
  const visibleSubmission =
    trackedSubmission && trackedSubmissionInput
      ? {
          ...trackedSubmission,
          state: trackedSubmissionInput.state,
          agentId:
            trackedSubmissionInput.input.activeAgentId ??
            trackedSubmission.agentId,
          body: trackedSubmissionInput.input.body,
          createdAt: trackedSubmissionInput.input.createdAt,
          updatedAt: trackedSubmissionInput.input.updatedAt,
          ...(trackedSubmissionInput.input.error
            ? { error: trackedSubmissionInput.input.error }
            : {}),
        }
      : selectedSession && displayedPendingInputCount === 0
        ? null
        : trackedSubmission;
  const selectedSessionMessages = model.sessionMessages?.messages ?? [];
  const selectedSharedSessionTurn =
    model.sharedSessionTurnState?.sessionId === selectedSession?.id
      ? model.sharedSessionTurnState
      : null;
  const selectedSessionLatestMessage =
    selectedSessionMessages[selectedSessionMessages.length - 1] ?? null;
  const selectedSessionLatestAssistantLikeMessage = [...selectedSessionMessages]
    .reverse()
    .find((message) => message.role !== "user") ?? null;
  const selectedSessionReplyPending = Boolean(
    selectedSession &&
      selectedSession.status === "active" &&
      !visibleSubmission &&
      (selectedSharedSessionTurn
        ? selectedSharedSessionTurn.status !== "error"
        : selectedSessionLatestMessage?.role === "user" &&
          (!selectedSessionLatestAssistantLikeMessage ||
            selectedSessionLatestAssistantLikeMessage.createdAt <
              selectedSessionLatestMessage.createdAt)),
  );
  const sharedSessionStatusLabel = model.loadingSession
    ? "Loading session"
    : !selectedSession
      ? "Pick a shared session"
      : model.sendingSessionId === selectedSession.id
        ? composerMode === "chat"
          ? "Sending to main chat"
          : "Queueing follow-up"
        : selectedSharedSessionTurn?.status === "completed"
          ? "Reply ready"
          : selectedSharedSessionTurn?.status === "streaming"
            ? "Assistant replying"
            : selectedSharedSessionTurn?.status === "error"
              ? "Assistant turn failed"
              : selectedSession.lastError
                ? "Session reported an error"
                : visibleSubmission
                  ? formatFollowUpModeLabel(visibleSubmission.mode)
                  : selectedSession.activeAgentId
                    ? "Assistant working"
                    : selectedSessionReplyPending
                      ? "Waiting for reply"
                      : displayedPendingInputCount
                        ? String(displayedPendingInputCount) + " pending inputs"
                        : "Live conversation ready";
  const sharedSessionStatusDetail = !selectedSession
    ? "Select one of the open shared sessions to read and continue it."
    : model.loadingSession
      ? "Pulling the latest transcript, queue state, and daemon session snapshot."
      : model.sendingSessionId === selectedSession.id
        ? composerMode === "chat"
          ? "Posting your message into the shared session conversation."
          : "Submitting this follow-up into the execution queue."
        : selectedSharedSessionTurn?.status === "completed"
          ? "The assistant reply arrived over the runtime event bus. Waiting for transcript persistence to catch up."
          : selectedSharedSessionTurn?.status === "streaming"
            ? "Streaming the assistant reply from runtime turn events while the shared transcript catches up."
            : selectedSharedSessionTurn?.status === "error"
              ? selectedSharedSessionTurn.error ?? "The assistant turn failed."
              : selectedSession.lastError
                ? selectedSession.lastError
                : visibleSubmission
                  ? "Latest queued work updated " +
                    formatRelativeTime(visibleSubmission.updatedAt) +
                    ". Open the inspector below for queue and agent details."
                  : selectedSession.activeAgentId
                    ? "Agent " +
                      formatCompactId(selectedSession.activeAgentId) +
                      " is currently attached to this session."
                    : selectedSessionReplyPending
                      ? "The latest shared-session message is waiting on an assistant reply."
                      : selectedSessionMessages.length
                        ? String(selectedSessionMessages.length) +
                          " transcript messages loaded for this shared session."
                        : "No persisted conversation history is loaded yet.";
  const sharedSessionStatusColor = model.loadingSession
    ? palette.accent
    : !selectedSession
      ? palette.faintInk
      : model.sendingSessionId === selectedSession.id
        ? palette.accent
        : selectedSharedSessionTurn?.status === "completed"
          ? palette.success
          : selectedSharedSessionTurn?.status === "streaming"
            ? palette.accent
            : selectedSharedSessionTurn?.status === "error"
              ? palette.danger
              : selectedSession.lastError
                ? palette.danger
                : visibleSubmission
                  ? toneColor(followUpModeTone(visibleSubmission.mode))
                  : selectedSession.activeAgentId
                    ? palette.violet
                    : selectedSessionReplyPending
                      ? palette.accent
                      : displayedPendingInputCount
                        ? palette.warn
                        : palette.success;
  const sharedSessionSendDisabled =
    !model.selectedSessionId ||
    !draftMessage.trim() ||
    !canWriteSessions ||
    Boolean(model.sendingSessionId);
  const showProviderEnvVars = Boolean(
    selectedProvider &&
      !selectedProvider.local &&
      selectedProvider.authMode !== "anonymous" &&
      selectedProvider.authMode !== "none" &&
      selectedProvider.envVars.length,
  );
  const showSharedSessionActivity = Boolean(
    selectedSession ||
      model.loadingSession ||
      model.sendingSessionId ||
      selectedSharedSessionTurn ||
      selectedSessionReplyPending,
  );
  const sharedSessionHeaderTitle = selectedSession?.title ?? "Shared Session";
  const sharedSessionHeaderMeta = selectedSession
    ? selectedSession.id + " · " + sharedSessionStatusLabel
    : "Open a shared session from the menu or the live sessions list.";
  const controlTitle = formatDashboardTabLabel(activeTab);
  const controlSubtitle =
    activeTab === "overview"
      ? `${model.auth?.principalId ?? "Unknown principal"} on ${model.control?.server.baseUrl ?? model.savedBaseUrl}`
      : activeTab === "models"
        ? providerCount
          ? formatCurrentModelSummary(currentProviderModel)
          : "Provider catalog is not available yet."
        : activeTab === "sessions"
          ? `${visibleOpenSessions} open · ${displayedPendingInputCount} pending in selected session`
          : activeTab === "tasks"
            ? `${runningTaskCount} running · ${blockedTaskCount} blocked · ${failedTaskCount} failed`
            : activeTab === "approvals"
              ? model.approvals?.awaitingDecision
                ? "A decision is required now."
                : "No approval is currently waiting."
              : model.activity.length
                ? `${model.activity.length} recent events loaded`
                : "Realtime events will appear here.";
  const controlStatusColor =
    activeTab === "overview"
      ? palette.accent
      : activeTab === "models"
        ? currentProviderModel
          ? palette.success
          : providerCount
            ? palette.warn
            : palette.accent
        : activeTab === "sessions"
          ? selectedSession?.activeAgentId
            ? palette.violet
            : displayedPendingInputCount
              ? palette.warn
              : palette.success
          : activeTab === "tasks"
            ? runningTaskCount
              ? palette.violet
              : blockedTaskCount
                ? palette.warn
                : palette.success
            : activeTab === "approvals"
              ? model.approvals?.awaitingDecision
                ? palette.warn
                : palette.success
              : model.activity.length
                ? palette.accent
                : palette.success;

  useEffect(() => {
    if (appMode !== "shared") {
      return;
    }

    const timer = setTimeout(() => {
      sharedSessionScrollRef.current?.scrollToEnd({
        animated: selectedSessionMessages.length > 0,
      });
    }, 40);

    return () => {
      clearTimeout(timer);
    };
  }, [
    appMode,
    model.loadingSession,
    model.sendingSessionId,
    selectedSession?.id,
    selectedSessionMessages.length,
    selectedSharedSessionTurn?.updatedAt,
  ]);

  const handleScanQr = async () => {
    if (model.phase === "booting" || model.authenticating || scanningQr) {
      return;
    }

    setScanningQr(true);

    try {
      const rawPayload = await scanGoodVibesQrCode();
      const parsed = parseGoodVibesQrPayload(rawPayload);
      const nextBaseUrl = parsed.baseUrl
        ? normalizeBaseUrl(parsed.baseUrl)
        : baseUrl.trim();
      const nextUsername = parsed.username ?? username.trim();

      if (parsed.baseUrl) {
        setBaseUrl(nextBaseUrl);
      }

      if (parsed.authMode === "token") {
        setAuthMode("token");
        if (parsed.username !== undefined) {
          setUsername(parsed.username);
        }
        if (parsed.password !== undefined) {
          setPassword(parsed.password);
        } else {
          setPassword("");
        }
        if (parsed.token !== undefined) {
          setToken(parsed.token);
        }

        if (nextBaseUrl && parsed.token) {
          const tokenConnected = await model.signInWithToken({
            baseUrl: nextBaseUrl,
            token: parsed.token,
          });
          if (tokenConnected) {
            return;
          }

          if (nextUsername && parsed.password) {
            setAuthMode("password");
            const passwordConnected = await model.signInWithPassword({
              baseUrl: nextBaseUrl,
              username: nextUsername,
              password: parsed.password,
            });
            if (passwordConnected) {
              return;
            }
          }
        }

        Alert.alert(
          "QR Imported",
          parsed.password
            ? "Token auth was rejected by the daemon. Password details were also loaded."
            : "Token details were loaded. Complete any missing fields and attach the token.",
        );
        return;
      }

      setAuthMode("password");
      setToken("");
      if (parsed.username !== undefined) {
        setUsername(parsed.username);
      }
      if (parsed.password !== undefined) {
        setPassword(parsed.password);
      }

      if (nextBaseUrl && nextUsername && parsed.password) {
        void model.signInWithPassword({
          baseUrl: nextBaseUrl,
          username: nextUsername,
          password: parsed.password,
        });
        return;
      }

      Alert.alert(
        "QR Imported",
        "Password details were loaded. Complete any missing fields and sign in.",
      );
    } catch (error) {
      if (!isGoodVibesQrScanCancelled(error)) {
        Alert.alert("QR Scan Failed", formatGoodVibesQrScanError(error));
      }
    } finally {
      setScanningQr(false);
    }
  };

  if (model.phase !== "ready") {
    return (
      <LinearGradient
        colors={[palette.backgroundTop, "#072937", palette.backgroundBottom]}
        style={styles.screen}
      >
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          <StatusBar
            barStyle="light-content"
            backgroundColor={palette.backgroundTop}
          />
          <ScrollView
            contentContainerStyle={styles.connectionScroll}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.heroCard}>
              <Text style={styles.eyebrow}>GoodVibes Mobile Companion</Text>
              <Text style={styles.heroTitle}>
                Control the daemon without the terminal.
              </Text>
              <Text style={styles.heroBody}>
                Connect this React Native app directly to the GoodVibes control
                plane using the published `@pellux/goodvibes-sdk` mobile
                entrypoint. It keeps tokens in secure storage, wakes on realtime
                events, and reloads read models when the app returns to the
                foreground.
              </Text>
              <View style={styles.heroCallout}>
                <Text style={styles.heroCalloutTitle}>Connection tip</Text>
                <Text style={styles.heroCalloutText}>
                  On a physical device, use the machine&apos;s LAN address like
                  `http://192.168.1.24:3210`, not `localhost`.
                </Text>
              </View>
            </View>

            <Card title="Connect">
              <SegmentedControl<AuthMode>
                options={[
                  { key: "password", label: "Password" },
                  { key: "token", label: "Bearer Token" },
                ]}
                value={authMode}
                onChange={setAuthMode}
              />

              <Text style={styles.fieldLabel}>Daemon URL</Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                editable={!model.authenticating}
                keyboardType="url"
                onChangeText={setBaseUrl}
                placeholder="http://192.168.1.24:3210"
                placeholderTextColor={palette.faintInk}
                style={styles.input}
                value={baseUrl}
              />

              {authMode === "password" ? (
                <>
                  <Text style={styles.fieldLabel}>Username</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!model.authenticating}
                    onChangeText={setUsername}
                    placeholder="operator"
                    placeholderTextColor={palette.faintInk}
                    style={styles.input}
                    value={username}
                  />
                  <Text style={styles.fieldLabel}>Password</Text>
                  <TextInput
                    editable={!model.authenticating}
                    onChangeText={setPassword}
                    placeholder="Password"
                    placeholderTextColor={palette.faintInk}
                    secureTextEntry
                    style={styles.input}
                    value={password}
                  />
                </>
              ) : (
                <>
                  <Text style={styles.fieldLabel}>Bearer Token</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!model.authenticating}
                    multiline
                    onChangeText={setToken}
                    placeholder="Paste a shared bearer token"
                    placeholderTextColor={palette.faintInk}
                    style={[styles.input, styles.tokenInput]}
                    value={token}
                  />
                </>
              )}

              {canScanQr ? (
                <>
                  <GhostButton
                    disabled={
                      model.phase === "booting" ||
                      model.authenticating ||
                      scanningQr
                    }
                    label={scanningQr ? "Opening Scanner…" : "Scan QR"}
                    onPress={() => {
                      void handleScanQr();
                    }}
                  />
                  <Text style={styles.helperText}>
                    Scan a QR payload with the daemon URL plus either
                    username/password or a bearer token.
                  </Text>
                </>
              ) : null}

              {model.error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{model.error}</Text>
                </View>
              ) : null}

              <Pressable
                disabled={
                  model.authenticating ||
                  !baseUrl.trim() ||
                  (authMode === "password"
                    ? !username.trim() || !password
                    : !token.trim())
                }
                onPress={() => {
                  if (authMode === "password") {
                    void model.signInWithPassword({
                      baseUrl,
                      username,
                      password,
                    });
                    return;
                  }
                  void model.signInWithToken({ baseUrl, token });
                }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.buttonPressed,
                  model.authenticating && styles.buttonDisabled,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {model.authenticating
                    ? "Connecting..."
                    : authMode === "password"
                      ? "Sign In"
                      : "Attach Token"}
                </Text>
              </Pressable>
            </Card>
          </ScrollView>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  if (appMode === "chat") {
    return (
      <LinearGradient
        colors={[palette.backgroundTop, "#061A23", palette.backgroundBottom]}
        style={styles.screen}
      >
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          <StatusBar
            barStyle="light-content"
            backgroundColor={palette.backgroundTop}
          />
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            keyboardVerticalOffset={Platform.OS === "ios" ? Math.max(insets.top, 12) : 0}
            style={styles.screen}
          >
            <View style={styles.chatShell}>
              <View style={styles.chatHeader}>
                <HamburgerButton
                  onPress={() => {
                    setChatDrawerOpen(true);
                  }}
                />
                <View style={styles.chatHeaderCopy}>
                  <Text style={styles.chatHeaderTitle} numberOfLines={1}>
                    {formatChatHeaderTitle(selectedChatSession?.title)}
                  </Text>
                  <Text style={styles.chatHeaderMeta} numberOfLines={1}>
                    {selectedChatModelSummary
                      ? selectedChatModelSummary + " · " + chatStatusLabel
                      : chatStatusLabel}
                  </Text>
                </View>
                <View style={styles.chatHeaderState}>
                  <View
                    style={[
                      styles.chatHeaderStateDot,
                      { backgroundColor: chatStatusColor },
                    ]}
                  />
                </View>
              </View>

              {model.error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{model.error}</Text>
                </View>
              ) : null}

              <View style={styles.chatDivider} />

              <ScrollView
                ref={chatMessageScrollRef}
                style={styles.chatThread}
                contentContainerStyle={[
                  styles.chatThreadContent,
                  keyboardHeight > 0 && styles.chatThreadContentKeyboardOpen,
                ]}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => {
                  chatMessageScrollRef.current?.scrollToEnd({
                    animated: loadedChatMessages.length > 0,
                  });
                }}
              >
                {loadedChatMessages.length ? (
                  loadedChatMessages.map((message) => (
                    <ChatMessageBubble key={message.id} message={message} />
                  ))
                ) : (
                  <View style={styles.chatThreadEmpty}>
                    <Text style={styles.chatThreadEmptyTitle}>
                      {selectedChatSession
                        ? "No messages yet"
                        : "Start a new chat"}
                    </Text>
                    <Text style={styles.chatThreadEmptyBody}>
                      {selectedChatSession
                        ? "This conversation is ready. Send a message below to start talking to the remote session."
                        : "Open the menu to choose a conversation, or send the first message and the app will create one for you."}
                    </Text>
                  </View>
                )}

                {selectedChatTurnState?.status === "error" ? (
                  <ChatTurnBubble
                    content={
                      selectedChatTurnState.error ??
                      "The assistant turn failed before it finished."
                    }
                    meta="Refresh or retry this message."
                    variant="error"
                  />
                ) : null}

                {showChatActivity ? (
                  <View style={styles.chatActivityRow}>
                    <View
                      style={[
                        styles.chatActivityDot,
                        { backgroundColor: chatStatusColor },
                      ]}
                    />
                    <View style={styles.chatActivityCopy}>
                      <Text style={styles.chatActivityTitle}>
                        {model.creatingChatSession
                          ? "Creating conversation"
                          : model.sendingChatSessionId
                            ? "Sending message"
                            : chatStatusLabel}
                      </Text>
                      <Text style={styles.chatActivityDetail}>
                        {model.creatingChatSession
                          ? "Creating a new companion-owned session."
                          : model.sendingChatSessionId
                            ? "Waiting for the daemon to accept the message."
                            : chatStatusDetail}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </ScrollView>

              <View
                style={[
                  styles.chatComposerDock,
                  keyboardHeight > 0 && styles.chatComposerDockLifted,
                ]}
              >
                <TextInput
                  editable={
                    canWriteSessions &&
                    !chatIsClosed &&
                    !model.creatingChatSession &&
                    !model.sendingChatSessionId &&
                    !(chatReplyPending && !chatTurnFailed)
                  }
                  multiline
                  onChangeText={setChatDraftMessage}
                  placeholder={
                    canWriteSessions
                      ? chatIsClosed
                        ? "This conversation is closed"
                        : selectedChatSession
                          ? "Reply to this conversation"
                          : "Message the daemon"
                      : "This token is read-only for sessions"
                  }
                  placeholderTextColor={palette.faintInk}
                  style={styles.chatComposerField}
                  value={chatDraftMessage}
                />
                <View style={styles.chatComposerFooter}>
                  <Text style={styles.chatComposerHint} numberOfLines={1}>
                    {canWriteSessions
                      ? chatIsClosed
                        ? "Create a new chat to continue."
                        : selectedChatModelSummary
                          ? "This chat uses " + selectedChatModelSummary
                          : chatStatusLabel
                      : "This token cannot write to sessions"}
                  </Text>
                  <Pressable
                    disabled={chatSendDisabled}
                    onPress={() => {
                      const nextMessage = chatDraftMessage;
                      void (async () => {
                        const sent = await model.sendChatMessage(
                          model.selectedChatSessionId,
                          nextMessage,
                        );
                        if (sent) {
                          setChatDraftMessage("");
                        }
                      })();
                    }}
                    style={({ pressed }) => [
                      styles.chatComposerSendButton,
                      pressed && styles.buttonPressed,
                      chatSendDisabled && styles.chatComposerSendButtonDisabled,
                    ]}
                  >
                    <Text style={styles.chatComposerSendButtonText}>
                      {model.creatingChatSession
                        ? "Creating"
                        : model.sendingChatSessionId
                          ? "Sending"
                          : "Send"}
                    </Text>
                  </Pressable>
                </View>
              </View>

              <AppDrawer
                activeTab={activeTab}
                appMode={appMode}
                approvalSummary={
                  model.approvals?.awaitingDecision
                    ? "Decision required"
                    : "No pending approval"
                }
                canWriteSessions={canWriteSessions}
                chatSessions={model.chatSessions}
                creatingChatSession={model.creatingChatSession}
                onClose={() => {
                  setChatDrawerOpen(false);
                }}
                onCreateChat={() => {
                  void (async () => {
                    const sessionId = await model.createChatSession();
                    if (sessionId) {
                      setChatDrawerOpen(false);
                    }
                  })();
                }}
                onRefresh={() => {
                  void model.refresh();
                }}
                onSelectChat={() => {
                  setAppMode("chat");
                  setChatDrawerOpen(false);
                }}
                onSelectChatSession={(sessionId) => {
                  setAppMode("chat");
                  setChatDrawerOpen(false);
                  void model.selectChatSession(sessionId);
                }}
                onSelectSharedSession={(sessionId) => {
                  setAppMode("shared");
                  setChatDrawerOpen(false);
                  void model.selectSession(sessionId);
                }}
                onSelectTab={(tab) => {
                  setAppMode("control");
                  setActiveTab(tab);
                  setChatDrawerOpen(false);
                }}
                onSignOut={() => {
                  setChatDrawerOpen(false);
                  void model.signOut();
                }}
                open={chatDrawerOpen}
                principalId={model.auth?.principalId ?? null}
                refreshLabel={model.refreshing ? "Syncing..." : "Refresh"}
                modelSummary={formatCurrentModelSummary(currentProviderModel)}
                selectedChatSessionId={model.selectedChatSessionId}
                selectedChatTitle={selectedChatSession?.title ?? null}
                selectedSharedSessionId={model.selectedSessionId}
                selectedSharedTitle={selectedSession?.title ?? null}
                sharedSessions={openSessions}
                sessionSummary={`${visibleOpenSessions} open sessions`}
                taskSummary={`${queuedTaskCount + runningTaskCount + blockedTaskCount} live tasks`}
              />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  if (appMode === "shared") {
    return (
      <LinearGradient
        colors={[palette.backgroundTop, "#081B26", palette.backgroundBottom]}
        style={styles.screen}
      >
        <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
          <StatusBar
            barStyle="light-content"
            backgroundColor={palette.backgroundTop}
          />
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            keyboardVerticalOffset={Platform.OS === "ios" ? Math.max(insets.top, 12) : 0}
            style={styles.screen}
          >
            <View style={styles.chatShell}>
              <View style={styles.chatHeader}>
                <HamburgerButton
                  onPress={() => {
                    setChatDrawerOpen(true);
                  }}
                />
                <View style={styles.chatHeaderCopy}>
                  <Text style={styles.chatHeaderTitle} numberOfLines={1}>
                    {sharedSessionHeaderTitle}
                  </Text>
                  <Text style={styles.chatHeaderMeta} numberOfLines={1}>
                    {sharedSessionHeaderMeta}
                  </Text>
                </View>
                <View style={styles.chatHeaderState}>
                  <View
                    style={[
                      styles.chatHeaderStateDot,
                      { backgroundColor: sharedSessionStatusColor },
                    ]}
                  />
                </View>
              </View>

              {model.error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{model.error}</Text>
                </View>
              ) : null}

              <View style={styles.chatDivider} />

              <ScrollView
                ref={sharedSessionScrollRef}
                style={styles.chatThread}
                contentContainerStyle={[
                  styles.chatThreadContent,
                  keyboardHeight > 0 && styles.chatThreadContentKeyboardOpen,
                ]}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => {
                  sharedSessionScrollRef.current?.scrollToEnd({
                    animated: selectedSessionMessages.length > 0,
                  });
                }}
              >
                {selectedSession ? (
                  selectedSessionMessages.length ? (
                    selectedSessionMessages.map((message) => (
                      <SharedSessionMessageBubble
                        key={message.id}
                        message={message}
                      />
                    ))
                  ) : (
                    <View style={styles.chatThreadEmpty}>
                      <Text style={styles.chatThreadEmptyTitle}>
                        No conversation yet
                      </Text>
                      <Text style={styles.chatThreadEmptyBody}>
                        This shared session is active, but the daemon has not
                        persisted any transcript messages yet.
                      </Text>
                    </View>
                  )
                ) : (
                  <View style={styles.chatThreadEmpty}>
                    <Text style={styles.chatThreadEmptyTitle}>
                      Choose a shared session
                    </Text>
                    <Text style={styles.chatThreadEmptyBody}>
                      Open the menu or the control-plane live sessions list to
                      pick a shared conversation.
                    </Text>
                  </View>
                )}

                {selectedSharedSessionTurn?.status === "error" ? (
                  <ChatTurnBubble
                    content={
                      selectedSharedSessionTurn.error ??
                      "The assistant turn failed before the transcript updated."
                    }
                    meta="The runtime turn failed before the shared transcript could persist the assistant reply."
                    variant="error"
                  />
                ) : selectedSession?.lastError ? (
                  <ChatTurnBubble
                    content={selectedSession.lastError}
                    meta="The daemon attached an error to this shared session."
                    variant="error"
                  />
                ) : null}

                {!selectedSession?.lastError &&
                selectedSharedSessionTurn?.status === "completed" &&
                selectedSharedSessionTurn.content ? (
                  <ChatTurnBubble
                    content={selectedSharedSessionTurn.content}
                    meta="Live runtime reply received. Waiting for the persisted shared transcript to catch up."
                    variant="streaming"
                  />
                ) : null}

                {!selectedSession?.lastError &&
                selectedSharedSessionTurn?.status === "streaming" ? (
                  <ChatTurnBubble
                    content={
                      selectedSharedSessionTurn.content?.trim().length
                        ? selectedSharedSessionTurn.content
                        : "The assistant is responding to the shared-session turn."
                    }
                    meta="Streaming the runtime turn directly while the transcript catches up."
                    variant="streaming"
                  />
                ) : null}

                {!selectedSession?.lastError &&
                !selectedSharedSessionTurn &&
                selectedSessionReplyPending ? (
                  <ChatTurnBubble
                    content={
                      selectedSession?.activeAgentId
                        ? "The assistant is still working on the latest shared-session turn."
                        : "Waiting for the next assistant message to be persisted into this shared session."
                    }
                    meta={
                      selectedSession?.activeAgentId
                        ? "Agent " +
                          formatCompactId(selectedSession.activeAgentId) +
                          " is attached to this session."
                        : "The app will keep polling this session until the reply lands or the daemon reports an error."
                    }
                    variant="streaming"
                  />
                ) : null}

                {showSharedSessionActivity ? (
                  <View style={styles.chatActivityRow}>
                    <View
                      style={[
                        styles.chatActivityDot,
                        { backgroundColor: sharedSessionStatusColor },
                      ]}
                    />
                    <View style={styles.chatActivityCopy}>
                      <Text style={styles.chatActivityTitle}>
                        {sharedSessionStatusLabel}
                      </Text>
                      <Text style={styles.chatActivityDetail}>
                        {sharedSessionStatusDetail}
                      </Text>
                    </View>
                  </View>
                ) : null}

                <SectionToggle
                  expanded={sessionInspectorExpanded}
                  onPress={() => {
                    setSessionInspectorExpanded((current) => !current);
                  }}
                  title="Execution Inspector"
                  trailing={
                    selectedSession ? (
                      <MetaPill
                        label={
                          displayedPendingInputCount
                            ? String(displayedPendingInputCount) + " pending"
                            : "Idle"
                        }
                        tone={displayedPendingInputCount ? "warn" : "success"}
                      />
                    ) : null
                  }
                />

                {sessionInspectorExpanded ? (
                  <View style={styles.sharedSessionInspector}>
                    {selectedSession ? (
                      <View style={styles.sessionStatusPanel}>
                        <View style={styles.dualColumn}>
                          <InlineFact
                            label="Session"
                            value={selectedSession.status}
                          />
                          <InlineFact
                            label="Pending"
                            value={String(displayedPendingInputCount)}
                          />
                          <InlineFact
                            label="Active Agent"
                            value={
                              selectedSession.activeAgentId
                                ? formatCompactId(selectedSession.activeAgentId)
                                : "idle"
                            }
                          />
                          <InlineFact
                            label="Updated"
                            value={formatRelativeTime(selectedSession.updatedAt)}
                          />
                        </View>

                        <View style={styles.heroMetaRow}>
                          <MetaPill
                            label={
                              visibleSubmission
                                ? formatFollowUpModeLabel(visibleSubmission.mode)
                                : displayedPendingInputCount
                                  ? "Queued work present"
                                  : "Idle"
                            }
                            tone={
                              visibleSubmission
                                ? followUpModeTone(visibleSubmission.mode)
                                : displayedPendingInputCount
                                  ? "warn"
                                  : "success"
                            }
                          />
                          <MetaPill
                            label={
                              visibleSubmission
                                ? formatInputStateLabel(visibleSubmission.state)
                                : displayedPendingInputCount
                                  ? String(displayedPendingInputCount) + " pending"
                                  : "No pending inputs"
                            }
                            tone={
                              visibleSubmission
                                ? statusTone(visibleSubmission.state)
                                : displayedPendingInputCount
                                  ? "warn"
                                  : "success"
                            }
                          />
                          {visibleSubmission?.agentId ? (
                            <MetaPill
                              label={
                                "agent " +
                                formatCompactId(visibleSubmission.agentId)
                              }
                              tone="violet"
                            />
                          ) : null}
                        </View>

                        {visibleSubmission ? (
                          <Text style={styles.feedDetail}>
                            {"Latest follow-up updated " +
                              formatRelativeTime(visibleSubmission.updatedAt) +
                              ". It stays visible here until the daemon moves it out of the queue."}
                          </Text>
                        ) : (
                          <Text style={styles.helperText}>
                            Main chat is primary here; queue and agent state live
                            in this inspector.
                          </Text>
                        )}

                        {visibleSubmission?.error ? (
                          <Text style={styles.errorInline}>
                            {visibleSubmission.error}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}

                    <SectionToggle
                      expanded={inputsExpanded}
                      onPress={() => {
                        setInputsExpanded((current) => !current);
                      }}
                      title="Recent Inputs"
                      trailing={
                        <MetaPill
                          label={
                            displayedPendingInputCount
                              ? String(displayedPendingInputCount) + " pending"
                              : "Idle"
                          }
                          tone={displayedPendingInputCount ? "warn" : "success"}
                        />
                      }
                    />

                    {inputsExpanded ? (
                      <>
                        {recentSessionInputs.length ? (
                          recentSessionInputs.map((entry) => (
                            <SessionInputCard
                              input={entry.input}
                              key={entry.input.id}
                              state={entry.state}
                              inferred={entry.inferred}
                            />
                          ))
                        ) : (
                          <Text style={styles.emptyText}>
                            {model.selectedSessionId
                              ? "No follow-ups or queued inputs recorded for this session yet."
                              : "Select a session to inspect its queue."}
                          </Text>
                        )}

                        <Text style={styles.helperText}>
                          Queued means the daemon stored the follow-up but has
                          not started it yet. Spawned means a new agent was
                          created. Delivered means the live session accepted it.
                        </Text>
                      </>
                    ) : null}
                  </View>
                ) : null}
              </ScrollView>

              <View
                style={[
                  styles.sharedSessionComposerDock,
                  keyboardHeight > 0 && styles.sharedSessionComposerDockLifted,
                ]}
              >
                <SegmentedControl<SessionComposerMode>
                  options={[
                    { key: "chat", label: "Main Chat" },
                    { key: "follow-up", label: "Agent Follow-up" },
                  ]}
                  value={composerMode}
                  onChange={setComposerMode}
                />
                <TextInput
                  editable={
                    Boolean(model.selectedSessionId) &&
                    canWriteSessions &&
                    !model.sendingSessionId
                  }
                  multiline
                  onChangeText={setDraftMessage}
                  placeholder={
                    canWriteSessions
                      ? composerMode === "chat"
                        ? "Reply in the shared conversation"
                        : "Queue execution work for the session"
                      : "This token is read-only for sessions"
                  }
                  placeholderTextColor={palette.faintInk}
                  style={styles.sharedSessionComposerField}
                  value={draftMessage}
                />
                <View style={styles.chatComposerFooter}>
                  <Text style={styles.chatComposerHint}>
                    {composerMode === "chat"
                      ? "Main Chat writes directly into the shared session transcript."
                      : "Agent Follow-up feeds the execution queue for follow-on work."}
                  </Text>
                  <Pressable
                    disabled={sharedSessionSendDisabled}
                    onPress={() => {
                      if (!model.selectedSessionId) return;
                      const sessionId = model.selectedSessionId;
                      const nextMessage = draftMessage;
                      void (async () => {
                        const sent =
                          composerMode === "follow-up"
                            ? await model.sendFollowUp(sessionId, nextMessage)
                            : await model.sendMessage(sessionId, nextMessage);
                        if (sent) {
                          setDraftMessage("");
                        }
                      })();
                    }}
                    style={({ pressed }) => [
                      styles.chatComposerSendButton,
                      pressed && styles.buttonPressed,
                      sharedSessionSendDisabled &&
                        styles.chatComposerSendButtonDisabled,
                    ]}
                  >
                    <Text style={styles.chatComposerSendButtonText}>
                      {model.sendingSessionId
                        ? "Sending"
                        : composerMode === "follow-up"
                          ? "Queue"
                          : "Send"}
                    </Text>
                  </Pressable>
                </View>
              </View>

              <AppDrawer
                activeTab={activeTab}
                appMode={appMode}
                approvalSummary={
                  model.approvals?.awaitingDecision
                    ? "Decision required"
                    : "No pending approval"
                }
                canWriteSessions={canWriteSessions}
                chatSessions={model.chatSessions}
                creatingChatSession={model.creatingChatSession}
                onClose={() => {
                  setChatDrawerOpen(false);
                }}
                onCreateChat={() => {
                  void (async () => {
                    const sessionId = await model.createChatSession();
                    if (sessionId) {
                      setChatDrawerOpen(false);
                    }
                  })();
                }}
                onRefresh={() => {
                  void model.refresh();
                }}
                onSelectChat={() => {
                  setAppMode("chat");
                  setChatDrawerOpen(false);
                }}
                onSelectChatSession={(sessionId) => {
                  setAppMode("chat");
                  setChatDrawerOpen(false);
                  void model.selectChatSession(sessionId);
                }}
                onSelectSharedSession={(sessionId) => {
                  setAppMode("shared");
                  setChatDrawerOpen(false);
                  void model.selectSession(sessionId);
                }}
                onSelectTab={(tab) => {
                  setAppMode("control");
                  setActiveTab(tab);
                  setChatDrawerOpen(false);
                }}
                onSignOut={() => {
                  setChatDrawerOpen(false);
                  void model.signOut();
                }}
                open={chatDrawerOpen}
                principalId={model.auth?.principalId ?? null}
                refreshLabel={model.refreshing ? "Syncing..." : "Refresh"}
                modelSummary={formatCurrentModelSummary(currentProviderModel)}
                selectedChatSessionId={model.selectedChatSessionId}
                selectedChatTitle={selectedChatSession?.title ?? null}
                selectedSharedSessionId={model.selectedSessionId}
                selectedSharedTitle={selectedSession?.title ?? null}
                sharedSessions={openSessions}
                sessionSummary={`${visibleOpenSessions} open sessions`}
                taskSummary={`${queuedTaskCount + runningTaskCount + blockedTaskCount} live tasks`}
              />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={[palette.backgroundTop, "#08202A", palette.backgroundBottom]}
      style={styles.screen}
    >
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={palette.backgroundTop}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? Math.max(insets.top, 12) : 0}
          style={styles.screen}
        >
          <View style={styles.chatShell}>
            <View style={styles.chatHeader}>
              <HamburgerButton
                onPress={() => {
                  setChatDrawerOpen(true);
                }}
              />
              <View style={styles.chatHeaderCopy}>
                <Text style={styles.chatHeaderTitle} numberOfLines={1}>
                  {controlTitle}
                </Text>
                <Text style={styles.chatHeaderMeta} numberOfLines={1}>
                  {controlSubtitle}
                </Text>
              </View>
              <View style={styles.chatHeaderState}>
                <View
                  style={[
                    styles.chatHeaderStateDot,
                    { backgroundColor: controlStatusColor },
                  ]}
                />
              </View>
            </View>

            {model.error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{model.error}</Text>
              </View>
            ) : null}

            <View style={styles.chatDivider} />

            <ScrollView
              style={styles.controlScreenScroll}
              contentContainerStyle={styles.controlScreenContent}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl
                  onRefresh={() => {
                    void model.refresh();
                  }}
                  progressBackgroundColor={palette.cardStrong}
                  refreshing={model.refreshing}
                  tintColor={palette.accent}
                />
              }
            >
              {activeTab === "overview" ? (
                <>
                  <View style={styles.heroCard}>
                    <Text style={styles.eyebrow}>Connected</Text>
                    <Text style={styles.dashboardTitle}>
                      GoodVibes Companion
                    </Text>
                    <Text style={styles.heroBody}>
                      {model.auth?.principalId ?? "Unknown principal"} on{" "}
                      {model.control?.server.baseUrl ?? model.savedBaseUrl}
                    </Text>

                    <View style={styles.metricGrid}>
                      <MetricTile
                        label="Active Clients"
                        value={String(model.control?.totals.activeClients ?? 0)}
                        accent={palette.accent}
                      />
                      <MetricTile
                        label="Queued + Running"
                        value={String(queuedTaskCount + runningTaskCount)}
                        accent={palette.violet}
                      />
                      <MetricTile
                        label="Awaiting Approval"
                        value={model.approvals?.awaitingDecision ? "Yes" : "No"}
                        accent={palette.warn}
                      />
                      <MetricTile
                        label="Last Sync"
                        value={formatRelativeTime(model.lastUpdatedAt)}
                        accent={palette.rose}
                      />
                    </View>

                    <View style={styles.heroMetaRow}>
                      <MetaPill
                        label={
                          model.foreground ? "Realtime active" : "Backgrounded"
                        }
                        tone={model.foreground ? "success" : "warn"}
                      />
                      <MetaPill
                        label={model.auth?.authMode ?? "unknown"}
                        tone="accent"
                      />
                      <MetaPill
                        label={`${model.auth?.scopes.length ?? 0} scopes`}
                        tone="violet"
                      />
                    </View>
                  </View>

                  <Card title="Control Plane">
                    <View style={styles.dualColumn}>
                      <InlineFact
                        label="Host"
                        value={model.control?.server.host ?? "n/a"}
                      />
                      <InlineFact
                        label="Port"
                        value={String(model.control?.server.port ?? "n/a")}
                      />
                      <InlineFact
                        label="Streaming"
                        value={model.control?.server.streamingMode ?? "n/a"}
                      />
                      <InlineFact
                        label="Requests"
                        value={String(model.control?.totals.requests ?? 0)}
                      />
                      <InlineFact
                        label="Errors"
                        value={String(model.control?.totals.errors ?? 0)}
                      />
                      <InlineFact
                        label="Session TTL"
                        value={`${Math.round((model.control?.server.sessionTtlMs ?? 0) / 60_000)}m`}
                      />
                    </View>
                  </Card>

                  <Card
                    title="Surface Messages"
                    subtitle="Recent control-plane notices pushed by the daemon."
                  >
                    {model.control?.messages.length ? (
                      model.control.messages.slice(0, 4).map((message) => (
                        <View key={message.id} style={styles.feedRow}>
                          <View
                            style={[
                              styles.feedMarker,
                              {
                                backgroundColor: statusColor(
                                  message.level ?? "info",
                                ),
                              },
                            ]}
                          />
                          <View style={styles.feedCopy}>
                            <Text style={styles.feedTitle}>
                              {message.title}
                            </Text>
                            <Text style={styles.feedDetail}>
                              {truncate(message.body, 180)}
                            </Text>
                            <Text style={styles.feedMeta}>
                              {formatTimestamp(message.createdAt)}
                            </Text>
                          </View>
                        </View>
                      ))
                    ) : (
                      <Text style={styles.emptyText}>
                        No recent surface messages.
                      </Text>
                    )}
                  </Card>

                  <Card title="Connected Clients">
                    {model.control?.clients.length ? (
                      model.control.clients.slice(0, 5).map((client) => (
                        <View key={client.id} style={styles.clientRow}>
                          <View>
                            <Text style={styles.clientLabel}>
                              {client.label}
                            </Text>
                            <Text style={styles.feedMeta}>
                              {client.surface} · {client.userId ?? "anonymous"}
                            </Text>
                          </View>
                          <Text style={styles.feedMeta}>
                            {formatRelativeTime(client.lastSeenAt)}
                          </Text>
                        </View>
                      ))
                    ) : (
                      <Text style={styles.emptyText}>
                        No active clients reported.
                      </Text>
                    )}
                  </Card>
                </>
              ) : null}

              {activeTab === "models" ? (
                <>
                  <Card
                    title="Current Model"
                    subtitle={formatCurrentModelSummary(currentProviderModel)}
                  >
                    <View style={styles.dualColumn}>
                      <InlineFact
                        label="Selected"
                        value={currentProviderModel?.registryKey ?? "Not set"}
                      />
                      <InlineFact
                        label="Provider"
                        value={formatProviderName(currentProviderModel?.provider)}
                      />
                      <InlineFact
                        label="Catalog"
                        value={
                          providerCount
                            ? String(providerCount) + " providers"
                            : "Unavailable"
                        }
                      />
                      <InlineFact
                        label="Access"
                        value={canSwitchModels ? "Can switch" : "Read-only"}
                      />
                    </View>
                    <Text style={styles.helperText}>
                      {canSwitchModels
                        ? "New chats are created with the currently selected provider/model. Existing chats stay pinned to the model they were created with."
                        : "This auth context can read provider state but cannot switch the active model."}
                    </Text>
                    {model.switchingModelKey ? (
                      <Text style={styles.feedMeta}>
                        {"Applying " + model.switchingModelKey + "…"}
                      </Text>
                    ) : null}
                  </Card>

                  <Card
                    title="Apply Selection To"
                    subtitle={
                      effectiveScope === "chat"
                        ? selectedChatSession
                          ? "Tapping a model pins it to this remote chat only — the TUI/global model is not changed."
                          : "Tapping a model stages it for the next remote chat you create."
                        : "Tapping a model changes the daemon/TUI global model. Existing remote chats keep their own pinned models."
                    }
                  >
                    <View style={styles.actionRow}>
                      <Pressable
                        onPress={() => setModelApplyScope("global")}
                        style={({ pressed }) => [
                          styles.providerOptionRow,
                          modelApplyScope === "global" &&
                            styles.providerOptionRowSelected,
                          pressed && styles.buttonPressed,
                          { flex: 1 },
                        ]}
                      >
                        <View style={styles.providerOptionCopy}>
                          <Text style={styles.providerOptionTitle}>
                            Global / TUI
                          </Text>
                          <Text
                            style={styles.providerOptionMeta}
                            numberOfLines={2}
                          >
                            {currentProviderModel?.registryKey ?? "Not set"}
                          </Text>
                        </View>
                      </Pressable>
                      <Pressable
                        onPress={() => setModelApplyScope("chat")}
                        style={({ pressed }) => [
                          styles.providerOptionRow,
                          modelApplyScope === "chat" &&
                            styles.providerOptionRowSelected,
                          pressed && styles.buttonPressed,
                          { flex: 1 },
                        ]}
                      >
                        <View style={styles.providerOptionCopy}>
                          <Text style={styles.providerOptionTitle}>
                            This Chat
                          </Text>
                          <Text
                            style={styles.providerOptionMeta}
                            numberOfLines={2}
                          >
                            {selectedChatSession
                              ? chatPinnedModelRef?.registryKey ??
                                "Daemon default"
                              : model.pendingChatModel
                                ? "Staged: " +
                                  model.pendingChatModel.registryKey
                                : "No chat selected — stages for next chat"}
                          </Text>
                        </View>
                      </Pressable>
                    </View>
                  </Card>

                  <Card
                    title="Pick Provider"
                    subtitle={
                      selectedProvider
                        ? selectedProvider.label +
                          " · " +
                          formatProviderAvailability(selectedProvider)
                        : "Search and select a provider first."
                    }
                  >
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={setProviderSearch}
                      placeholder="Search providers"
                      placeholderTextColor={palette.faintInk}
                      style={styles.input}
                      value={providerSearch}
                    />
                    {filteredProviders.length ? (
                      filteredProviders.map((provider) => (
                        <ProviderOptionRow
                          key={provider.id}
                          onPress={() => {
                            setSelectedProviderId(provider.id);
                            setModelSearch("");
                          }}
                          provider={provider}
                          selected={provider.id === selectedProvider?.id}
                        />
                      ))
                    ) : (
                      <Text style={styles.emptyText}>
                        No providers matched that search.
                      </Text>
                    )}
                  </Card>

                  <Card
                    title={selectedProvider ? "Pick Model" : "Pick a provider first"}
                    subtitle={
                      selectedProvider
                        ? selectedProvider.label +
                          " · " +
                          String(selectedProvider.models.length) +
                          " models"
                        : "Choose a provider before searching models."
                    }
                  >
                    {selectedProvider ? (
                      <>
                        <TextInput
                          autoCapitalize="none"
                          autoCorrect={false}
                          onChangeText={setModelSearch}
                          placeholder={
                            "Search models for " + selectedProvider.label
                          }
                          placeholderTextColor={palette.faintInk}
                          style={styles.input}
                          value={modelSearch}
                        />
                        <View style={styles.heroMetaRow}>
                          <MetaPill
                            label={
                              selectedProvider.usable || selectedProvider.local
                                ? "Ready"
                                : "Try switch"
                            }
                            tone={
                              formatProviderAvailabilityTone(selectedProvider)
                            }
                          />
                          <MetaPill
                            label={
                              String(filteredModels.length) + " matching models"
                            }
                            tone="accent"
                          />
                          {selectedProvider.configuredVia ? (
                            <MetaPill
                              label={formatProviderConfiguredVia(
                                selectedProvider.configuredVia,
                              )}
                              tone="violet"
                            />
                          ) : null}
                        </View>
                        {showProviderEnvVars ? (
                          <Text style={styles.feedMeta}>
                            {"Env vars: " + selectedProvider.envVars.join(", ")}
                          </Text>
                        ) : null}
                        {selectedProvider.detail ? (
                          <Text style={styles.helperText}>
                            {selectedProvider.detail}
                          </Text>
                        ) : null}
                        {filteredModels.length ? (
                          filteredModels.map((entry) => (
                            <ProviderModelRow
                              canSwitch={canSwitchModels}
                              currentModel={pickerCurrentModel}
                              key={entry.registryKey}
                              model={entry}
                              onPress={() => {
                                if (modelApplyScope === "chat") {
                                  if (selectedChatSession) {
                                    void model.setChatSessionModel(
                                      selectedChatSession.id,
                                      entry.registryKey,
                                    );
                                  } else {
                                    model.setPendingChatModel({
                                      registryKey: entry.registryKey,
                                      provider: entry.provider,
                                      id: entry.id,
                                    });
                                  }
                                } else {
                                  void model.switchProviderModel(
                                    entry.registryKey,
                                  );
                                }
                              }}
                              provider={selectedProvider}
                              switching={
                                modelApplyScope === "global"
                                  ? model.switchingModelKey ===
                                    entry.registryKey
                                  : Boolean(
                                      selectedChatSession &&
                                        model.settingChatModelSessionId ===
                                          selectedChatSession.id &&
                                        chatPinnedModelRef?.registryKey !==
                                          entry.registryKey,
                                    )
                              }
                              switchingAny={pickerBusy}
                            />
                          ))
                        ) : (
                          <Text style={styles.emptyText}>
                            No models matched that search for this provider.
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text style={styles.emptyText}>
                        Select a provider to browse and switch its models.
                      </Text>
                    )}
                  </Card>
                </>
              ) : null}

              {activeTab === "sessions" ? (
                <>
                  <Card
                    title={selectedSession?.title ?? "Selected Shared Session"}
                    subtitle={
                      model.loadingSession
                        ? "Loading shared session…"
                        : selectedSession
                          ? selectedSession.id
                          : "Select one of the live shared sessions below."
                    }
                  >
                    <View style={styles.sharedSessionStatusRow}>
                      <View
                        style={[
                          styles.chatActivityDot,
                          { backgroundColor: sharedSessionStatusColor },
                        ]}
                      />
                      <View style={styles.chatActivityCopy}>
                        <Text style={styles.chatActivityTitle}>
                          {sharedSessionStatusLabel}
                        </Text>
                        <Text style={styles.chatActivityDetail}>
                          {sharedSessionStatusDetail}
                        </Text>
                      </View>
                    </View>

                    {selectedSession ? (
                      <View style={styles.heroMetaRow}>
                        <MetaPill
                          label={selectedSession.status}
                          tone={
                            selectedSession.status === "active"
                              ? "success"
                              : "warn"
                          }
                        />
                        <MetaPill
                          label={
                            selectedSession.activeAgentId
                              ? "agent " +
                                formatCompactId(selectedSession.activeAgentId)
                              : "no agent attached"
                          }
                          tone={
                            selectedSession.activeAgentId ? "violet" : "accent"
                          }
                        />
                        <MetaPill
                          label={
                            displayedPendingInputCount
                              ? String(displayedPendingInputCount) + " pending"
                              : "queue clear"
                          }
                          tone={displayedPendingInputCount ? "warn" : "success"}
                        />
                        <MetaPill
                          label={
                            String(selectedSessionMessages.length) + " transcript"
                          }
                          tone="accent"
                        />
                      </View>
                    ) : null}

                    <Text style={styles.helperText}>
                      Shared-session conversation moved to its own chat surface.
                      Open it from the drawer or tap a live session below.
                    </Text>

                    {selectedSession ? (
                      <GhostButton
                        label="Open Conversation"
                        onPress={() => {
                          setAppMode("shared");
                        }}
                      />
                    ) : null}
                  </Card>

                  <Card
                    title="Open Shared Sessions"
                    subtitle={
                      String(visibleOpenSessions) +
                      " open" +
                      (visibleInactiveSessions
                        ? " · " +
                          String(visibleInactiveSessions) +
                          " inactive hidden"
                        : "") +
                      (visibleClosedSessions
                        ? " · " +
                          String(visibleClosedSessions) +
                          " closed hidden"
                        : "")
                    }
                  >
                    {openSessions.length ? (
                      openSessions.slice(0, 10).map((session) => (
                        <SessionCard
                          key={session.id}
                          onPress={() => {
                            setAppMode("shared");
                            void model.selectSession(session.id);
                          }}
                          selected={session.id === model.selectedSessionId}
                          session={session}
                        />
                      ))
                    ) : (
                      <Text style={styles.emptyText}>
                        No open shared sessions are exposed by the daemon right
                        now.
                      </Text>
                    )}
                  </Card>
                </>
              ) : null}

              {activeTab === "tasks" ? (
                <Card
                  title="Runtime Tasks"
                  subtitle={`${runningTaskCount} running · ${blockedTaskCount} blocked · ${failedTaskCount} failed`}
                >
                  {liveTasks.length ? (
                    liveTasks
                      .slice(0, 16)
                      .map((task) => <TaskCard key={task.id} task={task} />)
                  ) : (
                    <Text style={styles.emptyText}>
                      The daemon is not reporting active runtime tasks right
                      now.
                    </Text>
                  )}
                </Card>
              ) : null}

              {activeTab === "approvals" ? (
                <Card
                  title="Approvals"
                  subtitle={
                    model.approvals?.awaitingDecision
                      ? "A decision is required now."
                      : "No approval is currently waiting."
                  }
                >
                  {model.approvals?.approvals.length ? (
                    model.approvals.approvals.map((approval) => (
                      <ApprovalCard
                        approval={approval}
                        canApprove={canApprove}
                        key={approval.id}
                        pending={model.pendingApprovalId === approval.id}
                        onApprove={() => {
                          Alert.alert(
                            "Approve request?",
                            approval.request.analysis?.summary ??
                              approval.request.tool,
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Approve",
                                style: "default",
                                onPress: () => {
                                  void model.approve(approval.id);
                                },
                              },
                            ],
                          );
                        }}
                        onDeny={() => {
                          Alert.alert(
                            "Deny request?",
                            approval.request.analysis?.summary ??
                              approval.request.tool,
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Deny",
                                style: "destructive",
                                onPress: () => {
                                  void model.deny(approval.id);
                                },
                              },
                            ],
                          );
                        }}
                      />
                    ))
                  ) : (
                    <Text style={styles.emptyText}>
                      No approvals have been recorded yet.
                    </Text>
                  )}
                </Card>
              ) : null}

              {activeTab === "activity" ? (
                <Card
                  title="Realtime Activity"
                  subtitle="WebSocket wake-up events from agents, tasks, and the control plane."
                >
                  {model.activity.length ? (
                    model.activity.map((entry) => (
                      <ActivityCard entry={entry} key={entry.id} />
                    ))
                  ) : (
                    <Text style={styles.emptyText}>
                      Realtime activity will appear here once the daemon emits
                      events.
                    </Text>
                  )}
                </Card>
              ) : null}
            </ScrollView>

            <AppDrawer
              activeTab={activeTab}
              appMode={appMode}
              approvalSummary={
                model.approvals?.awaitingDecision
                  ? "Decision required"
                  : "No pending approval"
              }
              canWriteSessions={canWriteSessions}
              chatSessions={model.chatSessions}
              creatingChatSession={model.creatingChatSession}
              onClose={() => {
                setChatDrawerOpen(false);
              }}
              onCreateChat={() => {
                void (async () => {
                  const sessionId = await model.createChatSession();
                  if (sessionId) {
                    setChatDrawerOpen(false);
                  }
                })();
              }}
              onRefresh={() => {
                void model.refresh();
              }}
              onSelectChat={() => {
                setAppMode("chat");
                setChatDrawerOpen(false);
              }}
              onSelectChatSession={(sessionId) => {
                setAppMode("chat");
                setChatDrawerOpen(false);
                void model.selectChatSession(sessionId);
              }}
              onSelectSharedSession={(sessionId) => {
                setAppMode("shared");
                setChatDrawerOpen(false);
                void model.selectSession(sessionId);
              }}
              onSelectTab={(tab) => {
                setAppMode("control");
                setActiveTab(tab);
                setChatDrawerOpen(false);
              }}
              onSignOut={() => {
                setChatDrawerOpen(false);
                void model.signOut();
              }}
              open={chatDrawerOpen}
              principalId={model.auth?.principalId ?? null}
              refreshLabel={model.refreshing ? "Syncing..." : "Refresh"}
              modelSummary={formatCurrentModelSummary(currentProviderModel)}
              selectedChatSessionId={model.selectedChatSessionId}
              selectedChatTitle={selectedChatSession?.title ?? null}
              selectedSharedSessionId={model.selectedSessionId}
              selectedSharedTitle={selectedSession?.title ?? null}
              sharedSessions={openSessions}
              sessionSummary={`${visibleOpenSessions} open sessions`}
              taskSummary={`${queuedTaskCount + runningTaskCount + blockedTaskCount} live tasks`}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </LinearGradient>
  );
}

function DrawerNavItem(props: {
  readonly detail: string;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly title: string;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chatMenuSessionRow,
        props.selected && styles.chatMenuSessionRowSelected,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={styles.chatMenuSessionTitle}>{props.title}</Text>
      <Text style={styles.chatMenuSessionSnippet} numberOfLines={2}>
        {props.detail}
      </Text>
    </Pressable>
  );
}

function DrawerSectionToggle(props: {
  readonly detail: string;
  readonly expanded: boolean;
  readonly onPress: () => void;
  readonly title: string;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chatMenuSectionToggle,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.chatMenuSectionToggleCopy}>
        <Text style={styles.chatMenuSectionToggleTitle}>{props.title}</Text>
        <Text style={styles.chatMenuSectionToggleDetail} numberOfLines={1}>
          {props.detail}
        </Text>
      </View>
      <Text style={styles.chatMenuSectionToggleIcon}>
        {props.expanded ? "Hide" : "Show"}
      </Text>
    </Pressable>
  );
}

function AppDrawer(props: {
  readonly activeTab: DashboardTab;
  readonly appMode: AppMode;
  readonly approvalSummary: string;
  readonly canWriteSessions: boolean;
  readonly chatSessions: readonly GoodVibesCompanionChatSession[];
  readonly creatingChatSession: boolean;
  readonly onClose: () => void;
  readonly onCreateChat: () => void;
  readonly onRefresh: () => void;
  readonly onSelectChat: () => void;
  readonly onSelectChatSession: (sessionId: string) => void;
  readonly onSelectSharedSession: (sessionId: string) => void;
  readonly onSelectTab: (tab: DashboardTab) => void;
  readonly onSignOut: () => void;
  readonly open: boolean;
  readonly principalId: string | null;
  readonly modelSummary: string;
  readonly refreshLabel: string;
  readonly selectedChatSessionId: string | null;
  readonly selectedChatTitle: string | null;
  readonly selectedSharedSessionId: string | null;
  readonly selectedSharedTitle: string | null;
  readonly sharedSessions: readonly GoodVibesSessionRecord[];
  readonly sessionSummary: string;
  readonly taskSummary: string;
}) {
  const [chatSessionsExpanded, setChatSessionsExpanded] = useState(true);
  const [sharedSessionsExpanded, setSharedSessionsExpanded] = useState(true);

  if (!props.open) return null;

  return (
    <View style={styles.chatMenuOverlay}>
      <Pressable style={styles.chatMenuBackdrop} onPress={props.onClose} />
      <View style={styles.chatMenuDrawer}>
        <View style={styles.chatMenuHeader}>
          <Text style={styles.chatMenuTitle}>GoodVibes</Text>
          <Text style={styles.chatMenuSubtitle} numberOfLines={2}>
            {props.principalId ?? "Unknown principal"}
          </Text>
        </View>

        <ScrollView
          contentContainerStyle={styles.chatMenuBodyContent}
          keyboardShouldPersistTaps="handled"
          style={styles.chatMenuBody}
        >
          <Text style={styles.chatMenuSectionLabel}>Chat</Text>
          <DrawerNavItem
            detail={
              props.selectedChatTitle
                ? "Current conversation: " +
                  formatChatHeaderTitle(props.selectedChatTitle)
                : "Companion-owned remote conversations"
            }
            onPress={props.onSelectChat}
            selected={props.appMode === "chat"}
            title="Current Chat"
          />
          <Pressable
            disabled={!props.canWriteSessions || props.creatingChatSession}
            onPress={props.onCreateChat}
            style={({ pressed }) => [
              styles.chatMenuPrimaryAction,
              styles.chatMenuPrimaryActionBlock,
              pressed && styles.buttonPressed,
              (!props.canWriteSessions || props.creatingChatSession) &&
                styles.buttonDisabled,
            ]}
          >
            <Text style={styles.chatMenuPrimaryActionText}>
              {props.creatingChatSession ? "Creating..." : "New Chat"}
            </Text>
          </Pressable>
          <DrawerSectionToggle
            detail={
              props.chatSessions.length
                ? String(props.chatSessions.length) + " remote sessions"
                : "No saved chats yet"
            }
            expanded={chatSessionsExpanded}
            onPress={() => {
              setChatSessionsExpanded((current) => !current);
            }}
            title="Remote Sessions"
          />
          {chatSessionsExpanded ? (
            <View style={styles.chatMenuNestedList}>
              {props.chatSessions.length ? (
                props.chatSessions.map((session) => {
                  const selected = session.id === props.selectedChatSessionId;
                  const sessionMeta =
                    session.status === "closed"
                      ? "Closed"
                      : String(session.messageCount) + " messages";
                  return (
                    <Pressable
                      key={session.id}
                      onPress={() => {
                        props.onSelectChatSession(session.id);
                      }}
                      style={({ pressed }) => [
                        styles.chatMenuSessionRow,
                        selected && styles.chatMenuSessionRowSelected,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <View style={styles.chatMenuSessionHeader}>
                        <Text
                          style={styles.chatMenuSessionTitle}
                          numberOfLines={1}
                        >
                          {formatChatHeaderTitle(session.title)}
                        </Text>
                        <Text style={styles.chatMenuSessionMeta}>
                          {formatRelativeTime(session.updatedAt)}
                        </Text>
                      </View>
                      <Text
                        style={styles.chatMenuSessionSnippet}
                        numberOfLines={2}
                      >
                        {sessionMeta}
                      </Text>
                    </Pressable>
                  );
                })
              ) : (
                <Text style={styles.chatMenuEmpty}>
                  No chats yet. Send a message to create one.
                </Text>
              )}
            </View>
          ) : null}
          <DrawerSectionToggle
            detail={
              props.sharedSessions.length
                ? String(props.sharedSessions.length) + " live shared sessions"
                : "No open shared sessions"
            }
            expanded={sharedSessionsExpanded}
            onPress={() => {
              setSharedSessionsExpanded((current) => !current);
            }}
            title="Shared Sessions"
          />
          {sharedSessionsExpanded ? (
            <View style={styles.chatMenuNestedList}>
              {props.sharedSessions.length ? (
                props.sharedSessions.map((session) => {
                  const selected = session.id === props.selectedSharedSessionId;
                  const sessionMeta =
                    session.activeAgentId
                      ? "Agent " + formatCompactId(session.activeAgentId)
                      : String(session.messageCount) + " messages";
                  return (
                    <Pressable
                      key={session.id}
                      onPress={() => {
                        props.onSelectSharedSession(session.id);
                      }}
                      style={({ pressed }) => [
                        styles.chatMenuSessionRow,
                        selected && styles.chatMenuSessionRowSelected,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <View style={styles.chatMenuSessionHeader}>
                        <Text
                          style={styles.chatMenuSessionTitle}
                          numberOfLines={1}
                        >
                          {session.title}
                        </Text>
                        <Text style={styles.chatMenuSessionMeta}>
                          {formatRelativeTime(
                            session.lastMessageAt ?? session.updatedAt,
                          )}
                        </Text>
                      </View>
                      <Text
                        style={styles.chatMenuSessionSnippet}
                        numberOfLines={2}
                      >
                        {sessionMeta}
                      </Text>
                    </Pressable>
                  );
                })
              ) : (
                <Text style={styles.chatMenuEmpty}>
                  No shared sessions are open right now.
                </Text>
              )}
            </View>
          ) : null}

          <Text style={styles.chatMenuSectionLabel}>Control Plane</Text>
          <DrawerNavItem
            detail="Control plane state, client presence, and daemon notices"
            onPress={() => {
              props.onSelectTab("overview");
            }}
            selected={
              props.appMode === "control" && props.activeTab === "overview"
            }
            title="Overview"
          />

          <Text style={styles.chatMenuSectionLabel}>Provider & Model</Text>
          <DrawerNavItem
            detail={props.modelSummary}
            onPress={() => {
              props.onSelectTab("models");
            }}
            selected={
              props.appMode === "control" && props.activeTab === "models"
            }
            title="Provider and Model"
          />

          <Text style={styles.chatMenuSectionLabel}>Live</Text>
          <DrawerNavItem
            detail={props.sessionSummary}
            onPress={() => {
              props.onSelectTab("sessions");
            }}
            selected={
              props.appMode === "control" && props.activeTab === "sessions"
            }
            title="Open Sessions"
          />
          <DrawerNavItem
            detail={props.taskSummary}
            onPress={() => {
              props.onSelectTab("tasks");
            }}
            selected={
              props.appMode === "control" && props.activeTab === "tasks"
            }
            title="Live Tasks"
          />
          <DrawerNavItem
            detail={props.approvalSummary}
            onPress={() => {
              props.onSelectTab("approvals");
            }}
            selected={
              props.appMode === "control" && props.activeTab === "approvals"
            }
            title="Approvals"
          />

          <Text style={styles.chatMenuSectionLabel}>Recent Activity</Text>
          <DrawerNavItem
            detail="Agent, task, and control-plane wake-up events"
            onPress={() => {
              props.onSelectTab("activity");
            }}
            selected={
              props.appMode === "control" && props.activeTab === "activity"
            }
            title="Activity Feed"
          />
        </ScrollView>

        <View style={styles.chatMenuFooter}>
          <View style={styles.chatMenuActionRow}>
            <Pressable
              onPress={props.onRefresh}
              style={({ pressed }) => [
                styles.chatMenuSecondaryAction,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.chatMenuSecondaryActionText}>
                {props.refreshLabel}
              </Text>
            </Pressable>
            <Pressable
              onPress={props.onSignOut}
              style={({ pressed }) => [
                styles.chatMenuSecondaryAction,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.chatMenuSecondaryActionText}>Sign Out</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function Card(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{props.title}</Text>
      {props.subtitle ? (
        <Text style={styles.cardSubtitle}>{props.subtitle}</Text>
      ) : null}
      <View style={styles.cardBody}>{props.children}</View>
    </View>
  );
}

function MetricTile(props: {
  readonly label: string;
  readonly value: string;
  readonly accent: string;
}) {
  return (
    <View style={[styles.metricTile, { borderColor: `${props.accent}33` }]}>
      <View style={[styles.metricAccent, { backgroundColor: props.accent }]} />
      <Text style={styles.metricLabel}>{props.label}</Text>
      <Text style={styles.metricValue}>{props.value}</Text>
    </View>
  );
}

function MetaPill(props: {
  readonly label: string;
  readonly tone: "accent" | "success" | "warn" | "danger" | "violet";
}) {
  return (
    <View
      style={[styles.metaPill, { borderColor: `${toneColor(props.tone)}44` }]}
    >
      <View
        style={[styles.metaDot, { backgroundColor: toneColor(props.tone) }]}
      />
      <Text style={styles.metaPillText}>{props.label}</Text>
    </View>
  );
}

function InlineFact(props: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.inlineFact}>
      <Text style={styles.inlineFactLabel}>{props.label}</Text>
      <Text style={styles.inlineFactValue}>{props.value}</Text>
    </View>
  );
}

function GhostButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.ghostButton,
        pressed && styles.buttonPressed,
        props.disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={styles.ghostButtonText}>{props.label}</Text>
    </Pressable>
  );
}

function SegmentedControl<T extends string>(props: {
  readonly options: readonly { readonly key: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentedControl}>
      {props.options.map((option) => {
        const selected = option.key === props.value;
        return (
          <Pressable
            key={option.key}
            onPress={() => props.onChange(option.key)}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                selected && styles.segmentTextSelected,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SectionToggle(props: {
  readonly title: string;
  readonly expanded: boolean;
  readonly onPress: () => void;
  readonly trailing?: ReactNode;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.sectionToggleButton,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{props.title}</Text>
        <View style={styles.sectionHeaderAside}>
          {props.trailing ?? null}
          <Text style={styles.sectionToggleText}>
            {props.expanded ? "Hide" : "Show"}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

function SessionCard(props: {
  readonly session: GoodVibesSessionRecord;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.listCard,
        props.selected && styles.listCardSelected,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.cardRow}>
        <Text style={styles.listCardTitle}>{props.session.title}</Text>
        <Text
          style={[
            styles.statusChip,
            {
              color: statusColor(props.session.status),
              borderColor: `${statusColor(props.session.status)}55`,
            },
          ]}
        >
          {props.session.status}
        </Text>
      </View>
      <Text style={styles.feedDetail}>
        {props.session.messageCount} messages ·{" "}
        {props.session.pendingInputCount} pending inputs ·{" "}
        {props.session.surfaceKinds.join(", ") || "unknown surface"}
      </Text>
      <Text style={styles.feedMeta}>
        Updated {formatRelativeTime(props.session.updatedAt)} · routes{" "}
        {props.session.routeIds.join(", ") || "none"}
      </Text>
    </Pressable>
  );
}

function ChatSessionCard(props: {
  readonly session: GoodVibesSessionRecord;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.listCard,
        props.selected && styles.listCardSelected,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.cardRow}>
        <Text style={styles.listCardTitle}>{props.session.title}</Text>
        <Text
          style={[
            styles.statusChip,
            {
              color: statusColor(props.session.status),
              borderColor: `${statusColor(props.session.status)}55`,
            },
          ]}
        >
          {props.session.status}
        </Text>
      </View>
      <Text style={styles.feedDetail}>
        {props.session.messageCount} messages ·{" "}
        {props.session.pendingInputCount} in flight ·{" "}
        {props.session.surfaceKinds.join(", ") || "mobile surface"}
      </Text>
      <Text style={styles.feedMeta}>
        Last activity{" "}
        {formatRelativeTime(
          props.session.lastMessageAt ?? props.session.updatedAt,
        )}
        {props.session.activeAgentId
          ? ` · ${formatCompactId(props.session.activeAgentId)}`
          : ""}
      </Text>
    </Pressable>
  );
}

function HamburgerButton(props: { readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel="Open chat menu"
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chatHeaderMenuButton,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.chatHeaderMenuBars}>
        <View style={styles.chatHeaderMenuBar} />
        <View style={styles.chatHeaderMenuBarShort} />
        <View style={styles.chatHeaderMenuBar} />
      </View>
    </Pressable>
  );
}

function ChatMessageBubble(props: {
  readonly message: GoodVibesCompanionChatMessage;
}) {
  const isUser = props.message.role === "user";
  return (
    <View
      style={[
        styles.chatMessageRow,
        isUser ? styles.chatMessageRowUser : styles.chatMessageRowAssistant,
      ]}
    >
      <View
        style={[
          styles.chatMessageBubble,
          isUser
            ? styles.chatMessageBubbleUser
            : styles.chatMessageBubbleAssistant,
        ]}
      >
        {!isUser ? (
          <Text style={styles.chatMessageAuthor}>Assistant</Text>
        ) : null}
        <Text
          style={[
            styles.chatMessageBody,
            isUser
              ? styles.chatMessageBodyUser
              : styles.chatMessageBodyAssistant,
          ]}
        >
          {formatCompanionChatBody(props.message.content)}
        </Text>
        <Text
          style={[
            styles.chatMessageMeta,
            isUser
              ? styles.chatMessageMetaUser
              : styles.chatMessageMetaAssistant,
          ]}
        >
          {formatChatTime(props.message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

function ChatTurnBubble(props: {
  readonly variant: "streaming" | "error";
  readonly content: string;
  readonly meta: string;
}) {
  const isError = props.variant === "error";
  return (
    <View style={[styles.chatMessageRow, styles.chatMessageRowAssistant]}>
      <View
        style={[
          styles.chatMessageBubble,
          styles.chatMessageBubbleAssistant,
          isError ? styles.chatTurnBubbleError : styles.chatTurnBubbleStreaming,
        ]}
      >
        <Text
          style={[
            styles.chatMessageAuthor,
            isError && styles.chatTurnBubbleErrorLabel,
          ]}
        >
          {isError ? "Turn Failed" : "Assistant"}
        </Text>
        <Text
          style={[
            styles.chatMessageBody,
            styles.chatMessageBodyAssistant,
            isError && styles.chatTurnBubbleErrorBody,
          ]}
        >
          {props.content}
        </Text>
        <Text
          style={[
            styles.chatMessageMeta,
            styles.chatMessageMetaAssistant,
            isError && styles.chatTurnBubbleErrorMeta,
          ]}
        >
          {props.meta}
        </Text>
      </View>
    </View>
  );
}

function SharedSessionMessageBubble(props: {
  readonly message: GoodVibesSessionMessageRecord;
}) {
  const isUser = props.message.role === "user";
  const isSystem = props.message.role === "system";

  if (isSystem) {
    return (
      <View style={[styles.chatMessageRow, styles.sharedSessionMessageRowSystem]}>
        <View style={styles.sharedSessionMessageBubbleSystem}>
          <Text style={styles.sharedSessionSystemLabel}>System</Text>
          <Text style={styles.chatMessageBody}>
            {formatCompanionChatBody(props.message.body)}
          </Text>
          <Text style={[styles.chatMessageMeta, styles.sharedSessionSystemMeta]}>
            {formatTimestamp(props.message.createdAt)}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.chatMessageRow,
        isUser ? styles.chatMessageRowUser : styles.chatMessageRowAssistant,
      ]}
    >
      <View
        style={[
          styles.chatMessageBubble,
          isUser
            ? styles.chatMessageBubbleUser
            : styles.chatMessageBubbleAssistant,
        ]}
      >
        <Text style={styles.chatMessageAuthor}>
          {formatSharedSessionMessageAuthor(props.message)}
        </Text>
        <Text
          style={[
            styles.chatMessageBody,
            isUser
              ? styles.chatMessageBodyUser
              : styles.chatMessageBodyAssistant,
          ]}
        >
          {formatCompanionChatBody(props.message.body)}
        </Text>
        <Text
          style={[
            styles.chatMessageMeta,
            isUser
              ? styles.chatMessageMetaUser
              : styles.chatMessageMetaAssistant,
          ]}
        >
          {formatTimestamp(props.message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

function SessionInputCard(props: {
  readonly input: GoodVibesSessionInputRecord;
  readonly state: GoodVibesSessionInputRecord["state"];
  readonly inferred: boolean;
}) {
  const preview =
    props.input.body.replace(/\s+/g, " ").trim() || "(empty input)";
  return (
    <View style={styles.listCard}>
      <View style={styles.cardRow}>
        <Text style={styles.listCardTitle}>
          {formatInputIntentLabel(props.input.intent)}
        </Text>
        <Text
          style={[
            styles.statusChip,
            {
              color: statusColor(props.state),
              borderColor: String(statusColor(props.state)) + "55",
            },
          ]}
        >
          {formatInputStateLabel(props.state)}
        </Text>
      </View>
      <Text style={styles.feedDetail}>{truncate(preview, 220)}</Text>
      <Text style={styles.feedMeta}>
        {"Created " +
          formatTimestamp(props.input.createdAt) +
          " · updated " +
          formatRelativeTime(props.input.updatedAt)}
      </Text>
      {props.inferred ? (
        <Text style={styles.feedMeta}>
          {"Daemon still reports " +
            formatInputStateLabel(props.input.state).toLowerCase() +
            ", but live pending count indicates this input already settled."}
        </Text>
      ) : null}
      {props.input.activeAgentId ? (
        <Text style={styles.feedMeta}>
          {"Active agent " + formatCompactId(props.input.activeAgentId)}
        </Text>
      ) : null}
      {props.input.error ? (
        <Text style={styles.errorInline}>{props.input.error}</Text>
      ) : null}
    </View>
  );
}

function ProviderOptionRow(props: {
  readonly onPress: () => void;
  readonly provider: ProviderEntry;
  readonly selected: boolean;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.providerOptionRow,
        props.selected && styles.providerOptionRowSelected,
        pressed && styles.buttonPressed,
      ]}
    >
      <View style={styles.providerOptionCopy}>
        <Text style={styles.providerOptionTitle} numberOfLines={1}>
          {props.provider.label}
        </Text>
        <Text style={styles.providerOptionMeta} numberOfLines={2}>
          {props.provider.id +
            " · " +
            formatProviderAvailability(props.provider) +
            " · " +
            props.provider.models.length +
            " models"}
        </Text>
      </View>
      <Text
        style={[
          styles.providerOptionAction,
          props.selected && styles.providerOptionActionSelected,
        ]}
      >
        {props.selected ? "Selected" : "Choose"}
      </Text>
    </Pressable>
  );
}

function ProviderModelRow(props: {
  readonly canSwitch: boolean;
  readonly currentModel: ProviderModelRef | null;
  readonly model: ProviderModelEntry;
  readonly onPress: () => void;
  readonly provider: ProviderEntry;
  readonly switching: boolean;
  readonly switchingAny: boolean;
}) {
  const selected =
    props.currentModel?.registryKey === props.model.registryKey;
  const disabled = !props.canSwitch || props.switchingAny || selected;
  const actionLabel = props.switching
    ? "Applying…"
    : selected
      ? "Current"
      : !props.canSwitch
        ? "Read-only"
        : props.switchingAny
          ? "Busy"
          : props.provider.usable ||
              props.provider.local ||
              props.provider.authMode === "anonymous" ||
              props.provider.authMode === "none"
            ? "Switch"
            : "Try Switch";

  return (
    <Pressable
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.modelOptionRow,
        selected && styles.modelOptionRowSelected,
        disabled && styles.modelOptionRowDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <View style={styles.modelOptionCopy}>
        <Text style={styles.modelOptionTitle} numberOfLines={1}>
          {formatProviderModelLabel(props.model)}
        </Text>
        <Text style={styles.modelOptionMeta} numberOfLines={2}>
          {props.model.registryKey +
            (props.model.contextWindow
              ? " · " + props.model.contextWindow.toLocaleString() + " ctx"
              : "")}
        </Text>
      </View>
      <Text
        style={[
          styles.modelOptionAction,
          selected && styles.modelOptionActionSelected,
          disabled && !selected && styles.modelOptionActionDisabled,
        ]}
      >
        {actionLabel}
      </Text>
    </Pressable>
  );
}

function TaskCard(props: { readonly task: GoodVibesTaskRecord }) {
  return (
    <View style={styles.listCard}>
      <View style={styles.cardRow}>
        <Text style={styles.listCardTitle}>{props.task.title}</Text>
        <Text
          style={[
            styles.statusChip,
            {
              color: statusColor(props.task.status),
              borderColor: `${statusColor(props.task.status)}55`,
            },
          ]}
        >
          {props.task.status}
        </Text>
      </View>
      <Text style={styles.feedDetail}>
        {props.task.kind} · owner {props.task.owner}
      </Text>
      <Text style={styles.feedMeta}>
        queued {formatTimestamp(props.task.queuedAt)}
        {props.task.startedAt
          ? ` · started ${formatTimestamp(props.task.startedAt)}`
          : ""}
        {props.task.endedAt
          ? ` · ended ${formatTimestamp(props.task.endedAt)}`
          : ""}
      </Text>
      {props.task.error ? (
        <Text style={styles.errorInline}>{props.task.error}</Text>
      ) : null}
    </View>
  );
}

function ApprovalCard(props: {
  readonly approval: GoodVibesApprovalRecord;
  readonly pending: boolean;
  readonly canApprove: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}) {
  const analysis = props.approval.request.analysis;
  return (
    <View style={styles.listCard}>
      <View style={styles.cardRow}>
        <Text style={styles.listCardTitle}>{props.approval.request.tool}</Text>
        <Text
          style={[
            styles.statusChip,
            {
              color: statusColor(props.approval.status),
              borderColor: `${statusColor(props.approval.status)}55`,
            },
          ]}
        >
          {props.approval.status}
        </Text>
      </View>
      <View style={styles.approvalMetaRow}>
        <MetaPill label={props.approval.request.category} tone="accent" />
        {analysis?.riskLevel ? (
          <MetaPill
            label={analysis.riskLevel}
            tone={
              analysis.riskLevel === "critical" || analysis.riskLevel === "high"
                ? "danger"
                : analysis.riskLevel === "medium"
                  ? "warn"
                  : "success"
            }
          />
        ) : null}
      </View>
      <Text style={styles.feedDetail}>
        {analysis?.summary ?? "No summary provided."}
      </Text>
      <Text style={styles.feedMeta}>
        {analysis?.surface ?? "generic"} ·{" "}
        {analysis?.blastRadius ?? "unknown radius"} · session{" "}
        {props.approval.sessionId ?? "n/a"}
      </Text>
      <View style={styles.codeBlock}>
        <Text style={styles.codeBlockText}>
          {formatArgs(props.approval.request.args)}
        </Text>
      </View>

      {props.approval.status === "pending" ? (
        props.canApprove ? (
          <View style={styles.actionRow}>
            <Pressable
              disabled={props.pending}
              onPress={props.onDeny}
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.buttonPressed,
                props.pending && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                {props.pending ? "Working…" : "Deny"}
              </Text>
            </Pressable>
            <Pressable
              disabled={props.pending}
              onPress={props.onApprove}
              style={({ pressed }) => [
                styles.primaryButton,
                styles.inlineButton,
                pressed && styles.buttonPressed,
                props.pending && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {props.pending ? "Working…" : "Approve"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.emptyText}>
            This auth context is read-only for approvals.
          </Text>
        )
      ) : null}
    </View>
  );
}

function ActivityCard(props: { readonly entry: ActivityEntry }) {
  return (
    <View style={styles.feedRow}>
      <View
        style={[
          styles.feedMarker,
          { backgroundColor: toneColor(props.entry.tone) },
        ]}
      />
      <View style={styles.feedCopy}>
        <Text style={styles.feedTitle}>{props.entry.title}</Text>
        <Text style={styles.feedDetail}>{props.entry.detail}</Text>
        <Text style={styles.feedMeta}>
          {props.entry.domain} · {formatTimestamp(props.entry.createdAt)}
        </Text>
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  connectionScroll: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  dashboardScroll: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  chatShell: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  chatHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    minHeight: 56,
  },
  chatHeaderMenuButton: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  chatHeaderMenuBars: {
    gap: 4,
    width: 18,
  },
  chatHeaderMenuBar: {
    backgroundColor: palette.ink,
    borderRadius: 999,
    height: 2,
    width: "100%",
  },
  chatHeaderMenuBarShort: {
    alignSelf: "flex-start",
    backgroundColor: palette.mutedInk,
    borderRadius: 999,
    height: 2,
    width: 12,
  },
  chatHeaderCopy: {
    flex: 1,
    gap: 2,
  },
  chatHeaderTitle: {
    color: palette.ink,
    fontSize: 21,
    fontWeight: "700",
  },
  chatHeaderMeta: {
    color: palette.mutedInk,
    fontSize: 13,
    lineHeight: 18,
  },
  chatHeaderState: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 24,
  },
  chatHeaderStateDot: {
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  chatDivider: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    height: 1,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  chatThread: {
    flex: 1,
  },
  chatThreadContent: {
    flexGrow: 1,
    gap: spacing.md,
    justifyContent: "flex-end",
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  chatThreadContentKeyboardOpen: {
    paddingBottom: spacing.xl,
  },
  chatThreadEmpty: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 320,
    paddingHorizontal: spacing.xl,
  },
  chatThreadEmptyTitle: {
    color: palette.ink,
    fontSize: 30,
    fontWeight: "700",
    marginBottom: spacing.sm,
    textAlign: "center",
  },
  chatThreadEmptyBody: {
    color: palette.mutedInk,
    fontSize: 16,
    lineHeight: 24,
    maxWidth: 320,
    textAlign: "center",
  },
  chatMessageRow: {
    flexDirection: "row",
    width: "100%",
  },
  chatMessageRowAssistant: {
    justifyContent: "flex-start",
  },
  chatMessageRowUser: {
    justifyContent: "flex-end",
  },
  chatMessageBubble: {
    borderRadius: 24,
    maxWidth: "84%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chatMessageBubbleAssistant: {
    backgroundColor: "rgba(255, 255, 255, 0.045)",
    borderBottomLeftRadius: 10,
    borderColor: palette.border,
    borderWidth: 1,
  },
  chatMessageBubbleUser: {
    backgroundColor: "#0D353C",
    borderBottomRightRadius: 10,
    borderColor: "rgba(110, 231, 216, 0.22)",
    borderWidth: 1,
  },
  chatTurnBubbleStreaming: {
    borderColor: "rgba(124, 155, 255, 0.32)",
    borderStyle: "dashed",
  },
  chatTurnBubbleError: {
    backgroundColor: "rgba(255, 139, 123, 0.12)",
    borderColor: "rgba(255, 139, 123, 0.32)",
  },
  chatMessageAuthor: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  chatTurnBubbleErrorLabel: {
    color: palette.danger,
  },
  chatMessageBody: {
    fontSize: 16,
    lineHeight: 24,
  },
  chatMessageBodyAssistant: {
    color: palette.ink,
  },
  chatMessageBodyUser: {
    color: palette.ink,
  },
  chatMessageMeta: {
    fontSize: 11,
    marginTop: spacing.sm,
  },
  chatMessageMetaAssistant: {
    color: palette.faintInk,
  },
  chatMessageMetaUser: {
    color: "rgba(227, 241, 244, 0.72)",
  },
  chatTurnBubbleErrorBody: {
    color: palette.ink,
  },
  chatTurnBubbleErrorMeta: {
    color: palette.danger,
  },
  chatActivityRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  chatActivityDot: {
    borderRadius: 999,
    height: 10,
    marginTop: 4,
    width: 10,
  },
  chatActivityCopy: {
    flex: 1,
    gap: 2,
  },
  chatActivityTitle: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: "700",
  },
  chatActivityDetail: {
    color: palette.faintInk,
    fontSize: 13,
    lineHeight: 18,
  },
  chatComposerDock: {
    backgroundColor: "rgba(255, 255, 255, 0.055)",
    borderColor: palette.border,
    borderRadius: 24,
    borderWidth: 1,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  chatComposerDockLifted: {
    marginBottom: spacing.sm,
  },
  chatComposerField: {
    color: palette.ink,
    fontSize: 18,
    maxHeight: 148,
    minHeight: 42,
    paddingHorizontal: 0,
    paddingTop: 0,
    textAlignVertical: "top",
  },
  chatComposerFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  chatComposerHint: {
    color: palette.faintInk,
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  chatComposerSendButton: {
    alignItems: "center",
    backgroundColor: palette.accent,
    borderRadius: 999,
    justifyContent: "center",
    minHeight: 42,
    minWidth: 78,
    paddingHorizontal: spacing.md,
  },
  chatComposerSendButtonDisabled: {
    opacity: 0.4,
  },
  chatComposerSendButtonText: {
    color: "#032225",
    fontSize: 15,
    fontWeight: "800",
  },
  chatMenuOverlay: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  chatMenuBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.52)",
  },
  chatMenuDrawer: {
    backgroundColor: "#102127",
    borderColor: palette.border,
    borderRightWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    position: "absolute",
    top: 0,
    width: "84%",
  },
  chatMenuHeader: {
    gap: 4,
    marginBottom: spacing.lg,
  },
  chatMenuTitle: {
    color: palette.ink,
    fontSize: 28,
    fontWeight: "700",
  },
  chatMenuSubtitle: {
    color: palette.mutedInk,
    fontSize: 14,
    lineHeight: 20,
  },
  chatMenuBody: {
    flex: 1,
  },
  chatMenuBodyContent: {
    paddingBottom: spacing.lg,
  },
  chatMenuActionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  chatMenuPrimaryAction: {
    alignItems: "center",
    backgroundColor: palette.accent,
    borderRadius: 16,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: spacing.md,
  },
  chatMenuPrimaryActionText: {
    color: "#032225",
    fontSize: 15,
    fontWeight: "800",
  },
  chatMenuPrimaryActionBlock: {
    marginBottom: spacing.sm,
  },
  chatMenuSecondaryAction: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: spacing.md,
  },
  chatMenuSecondaryActionText: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  chatMenuSectionLabel: {
    color: palette.faintInk,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: "uppercase",
  },
  chatMenuSectionToggle: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.025)",
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chatMenuSectionToggleCopy: {
    flex: 1,
    gap: 2,
  },
  chatMenuSectionToggleTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  chatMenuSectionToggleDetail: {
    color: palette.mutedInk,
    fontSize: 13,
    lineHeight: 18,
  },
  chatMenuSectionToggleIcon: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  chatMenuNestedList: {
    paddingLeft: spacing.sm,
  },
  chatMenuSessionRow: {
    backgroundColor: "rgba(255, 255, 255, 0.035)",
    borderColor: "transparent",
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chatMenuSessionRowSelected: {
    backgroundColor: "rgba(110, 231, 216, 0.08)",
    borderColor: "rgba(110, 231, 216, 0.28)",
  },
  chatMenuSessionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
    marginBottom: 6,
  },
  chatMenuSessionTitle: {
    color: palette.ink,
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
  },
  chatMenuSessionMeta: {
    color: palette.faintInk,
    fontSize: 12,
  },
  chatMenuSessionSnippet: {
    color: palette.mutedInk,
    fontSize: 14,
    lineHeight: 20,
  },
  chatMenuEmpty: {
    color: palette.mutedInk,
    fontSize: 15,
    lineHeight: 22,
    paddingTop: spacing.md,
  },
  chatMenuFooter: {
    borderTopColor: palette.border,
    borderTopWidth: 1,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  controlScreenScroll: {
    flex: 1,
  },
  controlScreenContent: {
    gap: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  heroCard: {
    backgroundColor: palette.cardStrong,
    borderColor: palette.border,
    borderRadius: 28,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.xl,
  },
  eyebrow: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.8,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: palette.ink,
    fontSize: 32,
    fontWeight: "700",
    lineHeight: 38,
  },
  dashboardTitle: {
    color: palette.ink,
    fontSize: 28,
    fontWeight: "700",
  },
  heroBody: {
    color: palette.mutedInk,
    fontSize: 15,
    lineHeight: 22,
  },
  heroCallout: {
    backgroundColor: "rgba(110, 231, 216, 0.08)",
    borderColor: "rgba(110, 231, 216, 0.16)",
    borderRadius: 18,
    borderWidth: 1,
    gap: 6,
    padding: spacing.md,
  },
  heroCalloutTitle: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: "700",
  },
  heroCalloutText: {
    color: palette.mutedInk,
    fontSize: 14,
    lineHeight: 20,
  },
  heroHeaderRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
  },
  heroHeaderCopy: {
    flex: 1,
    gap: 6,
  },
  heroHeaderActions: {
    gap: spacing.sm,
  },
  card: {
    backgroundColor: palette.card,
    borderColor: palette.border,
    borderRadius: 24,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  cardTitle: {
    color: palette.ink,
    fontSize: 20,
    fontWeight: "700",
  },
  cardSubtitle: {
    color: palette.mutedInk,
    fontSize: 14,
    lineHeight: 20,
  },
  cardBody: {
    gap: spacing.md,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  metricTile: {
    backgroundColor: palette.cardSoft,
    borderRadius: 18,
    borderWidth: 1,
    flexBasis: "47%",
    gap: 6,
    minHeight: 96,
    overflow: "hidden",
    padding: spacing.md,
  },
  metricAccent: {
    borderRadius: 999,
    height: 5,
    width: 40,
  },
  metricLabel: {
    color: palette.mutedInk,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 6,
  },
  metricValue: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: "700",
  },
  heroMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  metaPill: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  metaDot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  metaPillText: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: "600",
  },
  fieldLabel: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    color: palette.ink,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  tokenInput: {
    minHeight: 110,
    textAlignVertical: "top",
  },
  helperText: {
    color: palette.faintInk,
    fontSize: 13,
    lineHeight: 18,
  },
  sessionStatusPanel: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: palette.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.md,
  },
  sharedSessionStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  sharedSessionThreadShell: {
    backgroundColor: "rgba(255, 255, 255, 0.035)",
    borderColor: palette.border,
    borderRadius: 24,
    borderWidth: 1,
    minHeight: 420,
    overflow: "hidden",
  },
  sharedSessionThread: {
    flexGrow: 0,
    maxHeight: 420,
  },
  sharedSessionThreadContent: {
    flexGrow: 1,
    gap: spacing.md,
    justifyContent: "flex-end",
    padding: spacing.lg,
  },
  sharedSessionComposerDock: {
    backgroundColor: "rgba(255, 255, 255, 0.045)",
    borderTopColor: palette.border,
    borderTopWidth: 1,
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  sharedSessionComposerDockLifted: {
    paddingBottom: spacing.md,
  },
  sharedSessionComposerField: {
    color: palette.ink,
    fontSize: 17,
    maxHeight: 148,
    minHeight: 42,
    paddingHorizontal: 0,
    paddingTop: 0,
    textAlignVertical: "top",
  },
  sharedSessionInspector: {
    gap: spacing.md,
  },
  sharedSessionMessageRowSystem: {
    justifyContent: "center",
  },
  sharedSessionMessageBubbleSystem: {
    backgroundColor: "rgba(255, 196, 122, 0.10)",
    borderColor: "rgba(255, 196, 122, 0.24)",
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: "92%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  sharedSessionSystemLabel: {
    color: palette.warn,
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
    textTransform: "uppercase",
  },
  sharedSessionSystemMeta: {
    color: palette.faintInk,
  },
  sectionHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  sectionHeaderAside: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "flex-end",
  },
  sectionToggleButton: {
    borderRadius: 14,
    marginTop: spacing.xs,
    paddingVertical: 4,
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  sectionToggleText: {
    color: palette.faintInk,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  composerInput: {
    minHeight: 104,
    textAlignVertical: "top",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: palette.accentDeep,
    borderRadius: 16,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  inlineButton: {
    flex: 1,
  },
  primaryButtonText: {
    color: "#032225",
    fontSize: 15,
    fontWeight: "800",
  },
  secondaryButton: {
    alignItems: "center",
    borderColor: `${palette.danger}66`,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  secondaryButtonText: {
    color: palette.danger,
    fontSize: 15,
    fontWeight: "700",
  },
  ghostButton: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderColor: palette.border,
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 42,
    minWidth: 86,
    paddingHorizontal: spacing.md,
  },
  ghostButtonText: {
    color: palette.ink,
    fontSize: 14,
    fontWeight: "700",
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.99 }],
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  errorBanner: {
    backgroundColor: "rgba(255, 139, 123, 0.1)",
    borderColor: "rgba(255, 139, 123, 0.25)",
    borderRadius: 16,
    borderWidth: 1,
    padding: spacing.md,
  },
  errorText: {
    color: palette.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  dualColumn: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  inlineFact: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderRadius: 16,
    flexBasis: "47%",
    gap: 8,
    padding: spacing.md,
  },
  inlineFactLabel: {
    color: palette.mutedInk,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  inlineFactValue: {
    color: palette.ink,
    fontSize: 16,
    fontWeight: "700",
  },
  feedRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.md,
  },
  feedMarker: {
    borderRadius: 999,
    height: 10,
    marginTop: 7,
    width: 10,
  },
  feedCopy: {
    flex: 1,
    gap: 4,
  },
  feedTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  feedDetail: {
    color: palette.mutedInk,
    fontSize: 14,
    lineHeight: 20,
  },
  feedMeta: {
    color: palette.faintInk,
    fontSize: 12,
  },
  clientRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  clientLabel: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  emptyText: {
    color: palette.mutedInk,
    fontSize: 14,
    lineHeight: 20,
  },
  segmentedControl: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: palette.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    padding: 6,
  },
  segment: {
    alignItems: "center",
    borderRadius: 12,
    flexGrow: 1,
    justifyContent: "center",
    minHeight: 42,
    minWidth: "18%",
    paddingHorizontal: 14,
  },
  segmentSelected: {
    backgroundColor: "rgba(110, 231, 216, 0.12)",
  },
  segmentText: {
    color: palette.mutedInk,
    fontSize: 14,
    fontWeight: "700",
  },
  segmentTextSelected: {
    color: palette.ink,
  },
  listCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: palette.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: spacing.md,
  },
  providerOptionRow: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  providerOptionRowSelected: {
    borderColor: "rgba(110, 231, 216, 0.4)",
    backgroundColor: "rgba(110, 231, 216, 0.08)",
  },
  providerOptionCopy: {
    flex: 1,
    gap: 4,
  },
  providerOptionTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  providerOptionMeta: {
    color: palette.mutedInk,
    fontSize: 12,
    lineHeight: 18,
  },
  providerOptionAction: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  providerOptionActionSelected: {
    color: palette.success,
  },
  modelOptionRow: {
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  modelOptionRowSelected: {
    borderColor: "rgba(110, 231, 216, 0.4)",
    backgroundColor: "rgba(110, 231, 216, 0.08)",
  },
  modelOptionRowDisabled: {
    opacity: 0.7,
  },
  modelOptionCopy: {
    flex: 1,
    gap: 4,
  },
  modelOptionTitle: {
    color: palette.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  modelOptionMeta: {
    color: palette.mutedInk,
    fontSize: 12,
    lineHeight: 18,
  },
  modelOptionAction: {
    color: palette.accent,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  modelOptionActionSelected: {
    color: palette.success,
  },
  modelOptionActionDisabled: {
    color: palette.faintInk,
  },
  listCardSelected: {
    borderColor: "rgba(110, 231, 216, 0.42)",
    shadowColor: palette.accent,
    shadowOpacity: 0.18,
    shadowRadius: 16,
  },
  listCardTitle: {
    color: palette.ink,
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    paddingRight: spacing.sm,
  },
  cardRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  statusChip: {
    borderRadius: 999,
    borderWidth: 1,
    fontSize: 12,
    fontWeight: "700",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 6,
    textTransform: "uppercase",
  },
  composer: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  messageBubble: {
    borderRadius: 18,
    gap: 8,
    padding: spacing.md,
  },
  messageBubbleUser: {
    backgroundColor: "rgba(110, 231, 216, 0.08)",
    borderColor: "rgba(110, 231, 216, 0.14)",
    borderWidth: 1,
  },
  messageBubbleAssistant: {
    backgroundColor: "rgba(124, 155, 255, 0.08)",
    borderColor: "rgba(124, 155, 255, 0.14)",
    borderWidth: 1,
  },
  messageRole: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  messageBody: {
    color: palette.ink,
    fontSize: 14,
    lineHeight: 20,
  },
  errorInline: {
    color: palette.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  approvalMetaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  codeBlock: {
    backgroundColor: "rgba(1, 9, 14, 0.68)",
    borderRadius: 16,
    padding: spacing.md,
  },
  codeBlockText: {
    color: palette.mutedInk,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
    fontSize: 12,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
});
