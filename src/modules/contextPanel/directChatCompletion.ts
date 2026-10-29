import {
  callLLMStream,
  type ChatParams,
  type ModelTurnCompletion,
  type ModelTurnOutcome,
  type ReasoningEvent,
  type UsageStats,
} from "../../utils/llmClient";
import { sanitizeText } from "../../utils/textSanitization";
import {
  createContinuationDeltas,
  DIRECT_CHAT_RETRY_DELAYS,
  directChatRetryDelay,
  throwIfChatAborted,
  waitForChatRetry,
} from "./directChatRecovery";

export type DirectChatRecoveryEvent = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  hasPartialText: boolean;
  phase: "waiting" | "retrying";
};

export const EMPTY_OUTPUT_LIMIT_MESSAGE =
  "The model used its available output on reasoning before producing an answer. Try Continue, lower reasoning effort, or choose another model.";

export function resolveEmptyModelOutcomeMessage(
  completion: ModelTurnCompletion,
): string {
  if (completion.status === "complete") {
    return "The model completed without producing visible text.";
  }
  if (completion.status === "incomplete") {
    if (completion.reason === "output_limit") {
      return EMPTY_OUTPUT_LIMIT_MESSAGE;
    }
    if (completion.reason === "context_limit") {
      return "The response stopped because the model's context window was exhausted. Start a new conversation or reduce the attached context.";
    }
    return "The provider paused this response before producing visible text. Try Continue.";
  }
  if (completion.reason === "safety") {
    return "The provider stopped this response for a safety reason.";
  }
  if (completion.reason === "refusal") {
    return "The model refused this request.";
  }
  if (completion.reason === "malformed_tool_call") {
    return "The model returned an incomplete tool call that was not executed.";
  }
  return "The provider ended the response without usable output.";
}

export function appendContinuationText(
  existingText: string,
  continuationText: string,
): string {
  const existing = sanitizeText(existingText);
  const continuation = sanitizeText(continuationText);
  if (!existing) return continuation;
  if (!continuation) return existing;
  if (continuation.startsWith(existing)) return continuation;
  const maxOverlap = Math.min(existing.length, continuation.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.endsWith(continuation.slice(0, overlap))) {
      return existing + continuation.slice(overlap);
    }
  }
  return existing + continuation;
}

export async function callDirectChatTurnWithRecovery(params: {
  request: ChatParams;
  onDelta: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  onRecovery?: (event: DirectChatRecoveryEvent) => void;
  call?: typeof callLLMStream;
  wait?: typeof waitForChatRetry;
}): Promise<ModelTurnOutcome> {
  const call = params.call ?? callLLMStream;
  const wait = params.wait ?? waitForChatRetry;
  const originalRequest = { ...params.request, requireStreamCompletion: true };
  let request = originalRequest;
  let text = "";
  let retries = 0;
  let recoveredEmptyOutput = false;

  while (true) {
    throwIfChatAborted(params.request.signal);
    let receivedDelta = false;
    const deltas = createContinuationDeltas(text, (delta) => {
      text += delta;
      params.onDelta(delta);
    });
    let outcome: ModelTurnOutcome;
    try {
      outcome = await call(
        request,
        (delta) => {
          if (delta) receivedDelta = true;
          deltas.push(delta);
        },
        params.onReasoning,
        params.onUsage,
      );
    } catch (error) {
      // Flush even on failure so the existing interrupted-turn UI retains text.
      deltas.flush();
      throwIfChatAborted(params.request.signal);
      const delay = directChatRetryDelay(error, retries);
      if (
        delay === undefined ||
        (params.request.authMode && params.request.authMode !== "api_key")
      ) {
        throw error;
      }
      const recovery: DirectChatRecoveryEvent = {
        attempt: ++retries,
        maxAttempts: DIRECT_CHAT_RETRY_DELAYS.length,
        delayMs: delay,
        hasPartialText: !!text,
        phase: "waiting",
      };
      params.onRecovery?.(recovery);
      await wait(delay, params.request.signal);
      throwIfChatAborted(params.request.signal);
      params.onRecovery?.({ ...recovery, phase: "retrying" });
      if (text) {
        // A failed POST stream has no portable replay cursor. Start a new
        // generation with the original context and the visible partial answer.
        request = {
          ...originalRequest,
          continuationState: undefined,
          history: [
            ...(params.request.history || []),
            { role: "user", content: params.request.prompt },
            { role: "assistant", content: text },
          ],
          prompt:
            "The connection was interrupted during your previous answer. Continue exactly where that answer stopped, including any unfinished sentence or code block. Do not repeat any text already shown, restart the answer, or add a preamble. Preserve the original language and formatting.",
        };
      }
      continue;
    }
    // Some non-streaming providers return their text without invoking onDelta.
    if (!receivedDelta && outcome.text) deltas.push(outcome.text);
    deltas.flush();
    throwIfChatAborted(params.request.signal);
    if (
      recoveredEmptyOutput ||
      outcome.completion.status !== "incomplete" ||
      outcome.completion.reason !== "output_limit" ||
      text.trim()
    ) {
      return { ...outcome, text };
    }

    recoveredEmptyOutput = true;
    const responseId =
      outcome.continuationState &&
      typeof outcome.continuationState === "object" &&
      typeof (outcome.continuationState as { responseId?: unknown })
        .responseId === "string"
        ? (outcome.continuationState as { responseId: string }).responseId
        : undefined;
    request = {
      ...originalRequest,
      prompt:
        "Continue from the prior response. Produce the answer now without repeating prior text.",
      history: responseId
        ? undefined
        : [
            ...(params.request.history || []),
            { role: "user", content: params.request.prompt },
          ],
      ...(responseId
        ? {
            context: undefined,
            attachments: undefined,
            continuationState: { responseId },
          }
        : {}),
    };
  }
}
