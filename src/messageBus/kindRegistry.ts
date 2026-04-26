import type {
  AgentToUserPayload,
  AnyBusEnvelope,
  BusEnvelope,
  MessageDirection,
  MessageKind,
  UserToAgentPayload,
  UserToAgentPart,
} from "./types.js";

const USER_TO_AGENT_KINDS = new Set<MessageKind>(["ui.user_message"]);
const AGENT_TO_USER_KINDS = new Set<MessageKind>([
  "agent.assistant_message",
  "agent.runtime.event",
  "agent.runtime.token_usage",
  "agent.runtime.inflight_update",
  "agent.runtime.thinking",
]);

export function assertEnvelopeValid(envelope: AnyBusEnvelope): void {
  validateTopLevel(envelope);
  validateDirectionAndKind(envelope.direction, envelope.kind);

  if (envelope.direction === "user_to_agent") {
    assertUserToAgentPayload(envelope as BusEnvelope<UserToAgentPayload>);
    return;
  }

  assertAgentToUserPayload(envelope as BusEnvelope<AgentToUserPayload>);
}

/**
 * Validates required top-level envelope fields that are shared by both directions.
 */
function validateTopLevel(envelope: AnyBusEnvelope): void {
  if (!envelope.id || typeof envelope.id !== "string") {
    throw new Error("Invalid message envelope: id must be a non-empty string.");
  }
  if (!envelope.sessionId || typeof envelope.sessionId !== "string") {
    throw new Error("Invalid message envelope: sessionId must be a non-empty string.");
  }
  if (typeof envelope.ts !== "number" || !Number.isFinite(envelope.ts)) {
    throw new Error("Invalid message envelope: ts must be a finite number.");
  }
  if (!envelope.source || typeof envelope.source !== "string") {
    throw new Error("Invalid message envelope: source must be a non-empty string.");
  }

  if (envelope.priority !== "high" && envelope.priority !== "normal" && envelope.priority !== "low") {
    throw new Error("Invalid message envelope: priority must be high|normal|low.");
  }
}

/**
 * Enforces direction-kind compatibility so producers cannot publish illegal combinations.
 */
function validateDirectionAndKind(direction: MessageDirection, kind: MessageKind): void {
  if (direction === "user_to_agent") {
    if (!USER_TO_AGENT_KINDS.has(kind)) {
      throw new Error(`Invalid message envelope: kind '${kind}' is not valid for user_to_agent.`);
    }
    return;
  }

  if (!AGENT_TO_USER_KINDS.has(kind)) {
    throw new Error(`Invalid message envelope: kind '${kind}' is not valid for agent_to_user.`);
  }
}

/**
 * Validates user_to_agent payload shape (structured parts array).
 */
function assertUserToAgentPayload(envelope: BusEnvelope<UserToAgentPayload>): void {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid user_to_agent payload: payload must be an object.");
  }

  if (!Array.isArray(payload.parts) || payload.parts.length === 0) {
    throw new Error("Invalid user_to_agent payload: parts must be a non-empty array.");
  }

  for (const part of payload.parts) {
    validateUserPart(part);
  }
}

/**
 * Validates each user input part. Supports text and image parts only.
 */
function validateUserPart(part: UserToAgentPart): void {
  if (!part || typeof part !== "object") {
    throw new Error("Invalid user_to_agent payload: every part must be an object.");
  }

  if (part.type === "text") {
    if (typeof part.text !== "string" || part.text.trim().length === 0) {
      throw new Error("Invalid user_to_agent payload: text part must contain non-empty text string.");
    }
    if (
      part.origin !== undefined &&
      part.origin !== "cli" &&
      part.origin !== "telegram_text" &&
      part.origin !== "telegram_voice_transcript"
    ) {
      throw new Error("Invalid user_to_agent payload: text.origin must be cli|telegram_text|telegram_voice_transcript.");
    }
    return;
  }

  if (part.type === "image") {
    if (part.source !== "local_file") {
      throw new Error("Invalid user_to_agent payload: image.source must be local_file.");
    }
    if (typeof part.path !== "string" || part.path.trim().length === 0) {
      throw new Error("Invalid user_to_agent payload: image part must contain non-empty path.");
    }
    if (typeof part.mimeType !== "string" || part.mimeType.trim().length === 0) {
      throw new Error("Invalid user_to_agent payload: image.mimeType must be a non-empty string.");
    }
    if (part.caption !== undefined && typeof part.caption !== "string") {
      throw new Error("Invalid user_to_agent payload: image.caption must be a string when provided.");
    }
    if (part.width !== undefined && !isFinitePositiveNumber(part.width)) {
      throw new Error("Invalid user_to_agent payload: image.width must be a finite positive number when provided.");
    }
    if (part.height !== undefined && !isFinitePositiveNumber(part.height)) {
      throw new Error("Invalid user_to_agent payload: image.height must be a finite positive number when provided.");
    }
    if (part.telegram !== undefined) {
      validateTelegramImageMetadata(part.telegram);
    }
    return;
  }

  throw new Error("Invalid user_to_agent payload: part.type must be text|image.");
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateTelegramImageMetadata(value: unknown): void {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid user_to_agent payload: image.telegram must be an object when provided.");
  }

  const metadata = value as Record<string, unknown>;
  if (typeof metadata.fileId !== "string" || metadata.fileId.length === 0) {
    throw new Error("Invalid user_to_agent payload: image.telegram.fileId must be a non-empty string.");
  }
  if (typeof metadata.fileUniqueId !== "string" || metadata.fileUniqueId.length === 0) {
    throw new Error("Invalid user_to_agent payload: image.telegram.fileUniqueId must be a non-empty string.");
  }
  if (typeof metadata.messageId !== "number" || !Number.isFinite(metadata.messageId)) {
    throw new Error("Invalid user_to_agent payload: image.telegram.messageId must be a finite number.");
  }
  if (metadata.mediaGroupId !== undefined && typeof metadata.mediaGroupId !== "string") {
    throw new Error("Invalid user_to_agent payload: image.telegram.mediaGroupId must be a string when provided.");
  }
}

/**
 * Validates agent_to_user payload shape (user-displayable text contract).
 */
function assertAgentToUserPayload(envelope: BusEnvelope<AgentToUserPayload>): void {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid agent_to_user payload: payload must be an object.");
  }

  if (typeof payload.text !== "string" || payload.text.length === 0) {
    throw new Error("Invalid agent_to_user payload: text must be a non-empty string.");
  }

  if (payload.format !== undefined && payload.format !== "plain" && payload.format !== "markdown") {
    throw new Error("Invalid agent_to_user payload: format must be plain|markdown when provided.");
  }

  if (payload.raw !== undefined && (typeof payload.raw !== "object" || payload.raw === null)) {
    throw new Error("Invalid agent_to_user payload: raw must be an object when provided.");
  }
}
