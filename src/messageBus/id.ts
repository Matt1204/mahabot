let seq = 0;

/**
 * Generates process-local message ids for bus envelopes.
 * The timestamp prefix keeps ids easy to inspect in logs.
 */
export function createBusMessageId(now: () => number = () => Date.now()): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `msg_${now()}_${seq}`;
}
