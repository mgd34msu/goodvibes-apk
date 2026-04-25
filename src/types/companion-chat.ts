export type CompanionChatSessionKind = "companion-chat";
export type CompanionChatSessionStatus = "active" | "closed";
export type CompanionChatMessageRole = "user" | "assistant";

export interface ConversationMessageEnvelope {
  readonly sessionId: string;
  readonly messageId: string;
  readonly body: string;
  readonly source: string;
  readonly timestamp: number;
}

export interface CompanionChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: CompanionChatMessageRole;
  readonly content: string;
  readonly createdAt: number;
}

export interface CompanionChatSession {
  readonly id: string;
  readonly kind: CompanionChatSessionKind;
  readonly title: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly systemPrompt: string | null;
  readonly status: CompanionChatSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly messageCount: number;
}

export interface CreateCompanionChatSessionInput {
  readonly title?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly systemPrompt?: string;
}

export interface CreateCompanionChatSessionOutput {
  readonly sessionId: string;
  readonly createdAt: number;
}

export interface PostCompanionChatMessageInput {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

export interface PostCompanionChatMessageOutput {
  readonly messageId: string;
}

export interface GetCompanionChatSessionOutput {
  readonly session: CompanionChatSession;
  readonly messages: CompanionChatMessage[];
}

export interface UpdateCompanionChatSessionInput {
  readonly title?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly systemPrompt?: string | null;
}

export interface UpdateCompanionChatSessionOutput {
  readonly session: CompanionChatSession;
}

export interface CompanionChatTurnStartedEvent {
  readonly type: "turn.started";
  readonly sessionId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly envelope: ConversationMessageEnvelope;
}

export interface CompanionChatTurnDeltaEvent {
  readonly type: "turn.delta";
  readonly sessionId: string;
  readonly turnId: string;
  readonly delta: string;
}

export interface CompanionChatTurnToolCallEvent {
  readonly type: "turn.tool_call";
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}

export interface CompanionChatTurnToolResultEvent {
  readonly type: "turn.tool_result";
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
}

export interface CompanionChatTurnCompletedEvent {
  readonly type: "turn.completed";
  readonly sessionId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly envelope: ConversationMessageEnvelope;
}

export interface CompanionChatTurnErrorEvent {
  readonly type: "turn.error";
  readonly sessionId: string;
  readonly turnId: string;
  readonly error: string;
}

export type CompanionChatTurnEvent =
  | CompanionChatTurnStartedEvent
  | CompanionChatTurnDeltaEvent
  | CompanionChatTurnToolCallEvent
  | CompanionChatTurnToolResultEvent
  | CompanionChatTurnCompletedEvent
  | CompanionChatTurnErrorEvent;
