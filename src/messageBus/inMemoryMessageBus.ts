import { assertEnvelopeValid } from "./kindRegistry.js";
import type {
  AgentToUserPayload,
  AnyBusEnvelope,
  BusEnvelope,
  MessageBus,
  MessageBusSubscriptionFilter,
  MessageBusSubscriptionHandler,
  UserToAgentPayload,
} from "./types.js";

/**
 * User -> Agent flow:
 * 1. Agent worker runLoop(), invoke getUserMsgFromBus(): try to get a message from bus.
 * 2. if queue has msg, return immediately and invoke Agent Loop
 * 3. if queue has no userEnvelop, a Promise of userEnvelope is returned. Workflow blocked until promise is resolved or rejected(system abort).
 * 4. a Promise resolver/rejector is wrapped as a 'PendingWaiter', and stored in the this.waitersBySession map.
 * 5. when new user message comes in, routeUserToAgent() is invoked which resolve() that stored 'PendingWaiter'.
 * 6. agent loop can be invoked.
 */

/**
 * PendingWaiter is a wrapper for the callack of a Promise. 
 * When a queue consumer try get a message from queue, BUT the queue is empty
 * => a Promise returned to consumer, a 'PendingWaiter' created and added to the waitersBySession map.
 * In future, when the queue has a message, that stored 'PendingWaiter' will be resolved.
 */
interface PendingWaiter {
  resolve: (envelope: BusEnvelope<UserToAgentPayload>) => void;
  reject: (error: unknown) => void;
  cleanupAbort?: () => void;
}

interface RegisteredSubscriber {
  handler: MessageBusSubscriptionHandler;
  filter?: MessageBusSubscriptionFilter;
}

/**
 * In-memory MessageBus for single-process runtime.
 *
 * Key properties:
 * - publish() validates contract and returns immediately.
 * - takeNextUserMessage() uses event-driven wakeup (no polling/sleep loops).
 * - subscriber failures are isolated so one consumer cannot break others.
 */
export class InMemoryMessageBus implements MessageBus {
  // Global ingress log of user->agent messages, mainly for diagnostics/tests.
  private readonly ingressQueue: BusEnvelope<UserToAgentPayload>[] = [];

  // agent -> user: contains assistant message only.
  private readonly assistantEgressQueue: BusEnvelope<AgentToUserPayload>[] = [];
  // agent -> user: contains runtime status info (event/token/thinking/inflight_update).
  private readonly statusEgressQueue: BusEnvelope<AgentToUserPayload>[] = [];
  // user -> agent: contains user message only.
  private readonly ingressBySession = new Map<string, BusEnvelope<UserToAgentPayload>[]>();
  // maintain the PendingWaiter for each session, so when new user message comes in, we can resolve the Promise.
  private readonly waitersBySession = new Map<string, PendingWaiter[]>();

  private readonly subscribers = new Map<number, RegisteredSubscriber>();

  private nextSubscriberId = 1;
  private readonly logger: Pick<Console, "warn">;

  constructor(logger: Pick<Console, "warn"> = console) {
    this.logger = logger;
  }

  /**
   * When new message comes in: validate it and enqueue it into the appropriate queue.
   */
  publish(envelope: AnyBusEnvelope): void {
    assertEnvelopeValid(envelope);

    if (envelope.direction === "user_to_agent") {
      this.routeUserToAgent(envelope as BusEnvelope<UserToAgentPayload>);
    } else {
      this.routeAgentToUser(envelope as BusEnvelope<AgentToUserPayload>);
    }

    // Publish path stays lightweight: dispatch is deferred to microtask queue.
    queueMicrotask(() => this.dispatch(envelope));
  }

  /**
   * when a queue consumer tries to take a message from queue 
   */
  getUserMsgFromBus(
    sessionId: string,
    abortSignal?: AbortSignal
  ): Promise<BusEnvelope<UserToAgentPayload>> {
    // Check if there is already a message in ingress queue.
    const queuedUserEnvelope = this.shiftSessionIngress(sessionId);
    if (queuedUserEnvelope) {
      return Promise.resolve(queuedUserEnvelope);
    }

    if (abortSignal?.aborted) {
      return Promise.reject(createAbortError("takeNextUserMessage aborted before waiting."));
    }
    
    // if no message in queue, return the Promise of the "Envelope",
    // and add a 'PendingWaiter' to the waitersBySession map.
    return new Promise<BusEnvelope<UserToAgentPayload>>((resolve, reject) => {
      const waitersOfSession = this.waitersBySession.get(sessionId) ?? [];

      // pendingWaiter: is a wrapper for the callack of a Promise.
      const pendingWaiter: PendingWaiter = {
        resolve: (message) => {
          pendingWaiter.cleanupAbort?.();
          resolve(message);
        },
        reject: (error) => {
          pendingWaiter.cleanupAbort?.();
          reject(error);
        },
      };

      if (abortSignal) {
        const onAbort = () => {
          this.removeWaiter(sessionId, pendingWaiter);
          pendingWaiter.reject(createAbortError("takeNextUserMessage aborted while waiting."));
        };

        abortSignal.addEventListener("abort", onAbort, { once: true });
        // Remove the listener once we resolve or reject normally so the waiter does not leak.
        pendingWaiter.cleanupAbort = () => abortSignal.removeEventListener("abort", onAbort);
      }

      // add promise resolver/rejector to this.waitersOfSession
      waitersOfSession.push(pendingWaiter);
      this.waitersBySession.set(sessionId, waitersOfSession);
    });
  }

  /**
   * Registers a subscriber with an optional filter.
   * Returns an unsubscribe function for deterministic cleanup.
   */
  subscribe(handler: MessageBusSubscriptionHandler, filter?: MessageBusSubscriptionFilter): () => void {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, { handler, filter });

    return () => {
      this.subscribers.delete(id);
    };
  }

  /**
   * getters
   */
  getQueues(): {
    ingressQueue: ReadonlyArray<BusEnvelope<UserToAgentPayload>>;
    assistantEgressQueue: ReadonlyArray<BusEnvelope<AgentToUserPayload>>;
    statusEgressQueue: ReadonlyArray<BusEnvelope<AgentToUserPayload>>;
  } {
    return {
      ingressQueue: [...this.ingressQueue],
      assistantEgressQueue: [...this.assistantEgressQueue],
      statusEgressQueue: [...this.statusEgressQueue],
    };
  }

  /**
   * Routes one user_to_agent envelope into:
   * 1) global ingress queue for observability
   * 2) per-session queue for worker consumption
   *
   * If a worker is already waiting, wake exactly one waiter for the same session.
   */
  private routeUserToAgent(userEnvelope: BusEnvelope<UserToAgentPayload>): void {
    // Monotonic log of all user→agent traffic (tests / debugging).
    this.ingressQueue.push(userEnvelope);

    // take ingress queue of session, enqueue it, put it back to the map.
    const ingressOfSession = this.ingressBySession.get(userEnvelope.sessionId) ?? [];
    ingressOfSession.push(userEnvelope);
    this.ingressBySession.set(userEnvelope.sessionId, ingressOfSession);

    // Wake one waiting worker for this session if available.
    const waitersOfSession = this.waitersBySession.get(userEnvelope.sessionId);
    if (!waitersOfSession || waitersOfSession.length === 0) {
      return;
    }

    // Exactly one parked await gets this publish: oldest waiter first (FIFO across waiters).
    const waiter = waitersOfSession.shift();
    if (waitersOfSession.length === 0) {
      this.waitersBySession.delete(userEnvelope.sessionId);
    }

    if (!waiter) {
      return;
    }

    // Hand off one message from the same per-session queue we just updated (pop front).
    // In normal use the waiter existed because the queue was empty; after push+shift, we deliver that envelope.
    const next = this.shiftSessionIngress(userEnvelope.sessionId);
    if (!next) {
      // Defensive fallback: should not happen because we just pushed one message.
      this.logger.warn("[message-bus] waiter awakened but no ingress message was available.");
      return;
    }

    waiter.resolve(next);
  }

  /**
   * Routes one agent_to_user envelope into either assistant egress queue
   * or status egress queue based on kind.
   */
  private routeAgentToUser(envelope: BusEnvelope<AgentToUserPayload>): void {
    if (envelope.kind === "agent.assistant_message") {
      this.assistantEgressQueue.push(envelope);
      return;
    }

    this.statusEgressQueue.push(envelope);
  }

  /**
   * Pops one pending user message for the target session in FIFO order.
   */
  private shiftSessionIngress(sessionId: string): BusEnvelope<UserToAgentPayload> | undefined {
    // get the ingress envelope array for given session.
    const ingressOfSession = this.ingressBySession.get(sessionId);
    if (!ingressOfSession || ingressOfSession.length === 0) {
      return undefined;
    }

    // shift() removes index 0 and returns it (FIFO queue semantics).
    const nextEnvelope = ingressOfSession.shift();
    // Drop the map entry when the per-session queue is drained so we don't keep empty arrays around.
    if (ingressOfSession.length === 0) {
      this.ingressBySession.delete(sessionId);
    }

    return nextEnvelope;
  }

  /**
   * Pushes one envelope to all matching subscribers.
   * Subscriber failures are isolated and logged so one consumer cannot poison dispatch.
   */
  private dispatch(envelope: AnyBusEnvelope): void {
    for (const [, subscriber] of this.subscribers) {
      if (!matchesFilter(envelope, subscriber.filter)) {
        continue;
      }

      try {
        subscriber.handler(envelope);
      } catch (error) {
        // Keep dispatch path resilient: one bad consumer should not break others.
        this.logger.warn(`[message-bus] subscriber error: ${String(error)}`);
      }
    }
  }

  /**
   * Removes a waiter from one session queue. Used by abort cleanup.
   */
  private removeWaiter(sessionId: string, waiter: PendingWaiter): void {
    const waiters = this.waitersBySession.get(sessionId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    const index = waiters.indexOf(waiter);
    if (index < 0) {
      return;
    }

    waiters.splice(index, 1);
    if (waiters.length === 0) {
      this.waitersBySession.delete(sessionId);
    }
  }
}

/**
 * Evaluates whether one envelope should be delivered to one subscriber.
 */
function matchesFilter(envelope: AnyBusEnvelope, filter?: MessageBusSubscriptionFilter): boolean {
  if (!filter) {
    return true;
  }

  if (filter.direction && envelope.direction !== filter.direction) {
    return false;
  }

  if (filter.sessionId && envelope.sessionId !== filter.sessionId) {
    return false;
  }

  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(envelope.kind)) {
    return false;
  }

  return true;
}

/**
 * Creates an AbortError-like instance for wait cancellation paths.
 */
function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
