/** Recovery is bounded per user turn, including failures while continuing. */
export const DIRECT_CHAT_RETRY_DELAYS = [2_000, 8_000] as const;

export function directChatRetryDelay(error: unknown, retry: number) {
  const delay = DIRECT_CHAT_RETRY_DELAYS[retry];
  if (delay === undefined) return undefined;
  const failure = error as {
    name?: string;
    message?: string;
    status?: number;
    retryAfterMs?: number;
  } | null;
  if (failure?.name === "AbortError") return undefined;
  const message = String(failure?.message ?? error);
  const status =
    failure?.status ?? Number(/^(?:HTTP\s+)?(\d{3})\b/.exec(message)?.[1]);
  if (Number.isFinite(status)) {
    if (status !== 408 && status !== 429 && !(status >= 500 && status <= 599)) {
      return undefined;
    }
  } else if (
    failure?.name !== "NetworkError" &&
    !/NetworkError|Error in input stream|Failed to fetch|fetch failed|network error|network request failed|network connection was lost|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|connection (?:was )?(?:reset|closed|refused|lost)/i.test(
      message,
    )
  ) {
    return undefined;
  }
  const retryAfter = failure?.retryAfterMs;
  // Do not retry earlier than the provider requests, or wait indefinitely.
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    if (retryAfter > 60_000) return undefined;
    return Math.max(delay, retryAfter);
  }
  return delay;
}

export function throwIfChatAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error("Cancelled");
    error.name = "AbortError";
    throw error;
  }
}

export function waitForChatRetry(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfChatAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      const error = new Error("Cancelled");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/**
 * Buffer only the continuation's opening while it could repeat an existing
 * suffix. Remove exact overlaps of at least 16 characters, never fuzzy matches
 * or short punctuation/word matches. Bound buffering and matching to 2048 characters.
 */
export function createContinuationDeltas(
  existing: string,
  emit: (delta: string) => void,
) {
  const tail = existing.slice(-2048);
  const candidates: string[] = [];
  for (let length = 16; length <= tail.length; length++) {
    candidates.push(tail.slice(-length));
  }
  let pending = "";
  let decided = !candidates.length;
  const flush = () => {
    if (!pending) return;
    let overlap = 0;
    for (const candidate of candidates) {
      if (pending.startsWith(candidate)) overlap = candidate.length;
    }
    const delta = pending.slice(overlap);
    pending = "";
    decided = true;
    if (delta) emit(delta);
  };
  return {
    push(delta: string) {
      if (decided) {
        if (delta) emit(delta);
        return;
      }
      pending += delta;
      if (!candidates.some((candidate) => candidate.startsWith(pending)))
        flush();
    },
    flush,
  };
}
