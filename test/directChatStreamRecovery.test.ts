import { assert } from "chai";
import {
  callDirectChatTurnWithRecovery,
  type DirectChatRecoveryEvent,
} from "../src/modules/contextPanel/directChatCompletion";
import {
  createContinuationDeltas,
  directChatRetryDelay,
  waitForChatRetry,
} from "../src/modules/contextPanel/directChatRecovery";
import {
  type ChatParams,
  parseStreamResponse,
  parseResponsesStream,
} from "../src/utils/llmClient";

const request: ChatParams = {
  prompt: "Explain this paper.",
  history: [{ role: "user", content: "Earlier question" }],
  context: "Paper context",
  systemMessages: ["Use citations"],
  authMode: "api_key",
  model: "test-model",
  apiKey: "test-only",
  apiBase: "https://example.invalid/v1",
};
const networkError = () => new Error("Error in input stream");
const complete = (text: string) => ({
  text,
  completion: { status: "complete" as const },
});
const noWait = async () => undefined;

async function expectFailure(run: () => Promise<unknown>, message: string) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, Error);
  assert.include((error as Error).message, message);
}

// Emit one chunk per pull so a later read failure does not discard queued text.
function stream(events: unknown[], ending: "error" | "close" | "open") {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) {
        const event = events[index++];
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
          ),
        );
      } else if (ending === "error") controller.error(networkError());
      else if (ending === "close") controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

describe("direct chat stream recovery", function () {
  it("retries an empty stream at 2s and 8s, then emits a non-stream fallback once", async function () {
    const requests: ChatParams[] = [];
    const delays: number[] = [];
    const progress: DirectChatRecoveryEvent[] = [];
    let visible = "";
    const result = await callDirectChatTurnWithRecovery({
      request,
      onDelta: (delta) => (visible += delta),
      onRecovery: (event) => progress.push(event),
      wait: async (ms) => {
        delays.push(ms);
      },
      call: async (next) => {
        requests.push(next);
        if (requests.length < 3) throw networkError();
        return complete("Recovered");
      },
    });
    assert.deepEqual(delays, [2000, 8000]);
    assert.deepEqual(
      requests.map((r) => r.prompt),
      Array(3).fill(request.prompt),
    );
    assert.deepEqual(
      progress.map((p) => p.phase),
      ["waiting", "retrying", "waiting", "retrying"],
    );
    assert.equal(visible, "Recovered");
    assert.equal(result.text, visible);
  });

  it("continues partial text in the same answer with original context and exact overlap removal", async function () {
    const prefix = "The paper's first important result is ";
    const requests: ChatParams[] = [];
    let visible = "";
    const result = await callDirectChatTurnWithRecovery({
      request: { ...request, continuationState: { responseId: "old" } },
      onDelta: (delta) => (visible += delta),
      wait: noWait,
      call: async (next, emit) => {
        requests.push(next);
        if (requests.length === 1) {
          emit(prefix);
          throw networkError();
        }
        // The new model repeats a suffix across multiple chunks.
        emit("first important ");
        emit("result is ");
        emit("a lower error rate.");
        return complete("first important result is a lower error rate.");
      },
    });
    assert.equal(visible, prefix + "a lower error rate.");
    assert.equal(result.text, visible);
    assert.deepEqual(requests[1].history, [
      ...request.history!,
      { role: "user", content: request.prompt },
      { role: "assistant", content: prefix },
    ]);
    assert.isUndefined(requests[1].continuationState);
    for (const key of [
      "context",
      "systemMessages",
      "model",
      "apiKey",
      "apiBase",
    ] as const) {
      assert.deepEqual(requests[1][key], request[key]);
    }
    assert.include(requests[1].prompt, "Continue exactly");
  });

  it("bounds retries across successive partial failures and retains all received text", async function () {
    let calls = 0;
    let visible = "";
    await expectFailure(
      () =>
        callDirectChatTurnWithRecovery({
          request,
          onDelta: (delta) => (visible += delta),
          wait: noWait,
          call: async (_next, emit) => {
            emit(`part${++calls} `);
            throw networkError();
          },
        }),
      "input stream",
    );
    assert.equal(calls, 3);
    assert.equal(visible, "part1 part2 part3 ");
  });

  it("never retries authentication, invalid requests, cancellation, or native auth", async function () {
    for (const error of [
      Object.assign(new Error("401 Unauthorized"), { status: 401 }),
      new Error("403 Forbidden"),
      new Error("400 Bad Request"),
      new Error("404 Model not found"),
      new Error("Unexpected application failure"),
      Object.assign(networkError(), { name: "AbortError" }),
    ]) {
      let calls = 0;
      await expectFailure(
        () =>
          callDirectChatTurnWithRecovery({
            request,
            onDelta: () => undefined,
            wait: noWait,
            call: async () => {
              calls++;
              throw error;
            },
          }),
        error.message,
      );
      assert.equal(calls, 1);
    }
    let calls = 0;
    await expectFailure(
      () =>
        callDirectChatTurnWithRecovery({
          request: { ...request, authMode: "codex_auth" },
          onDelta: () => undefined,
          wait: noWait,
          call: async () => {
            calls++;
            throw networkError();
          },
        }),
      "input stream",
    );
    assert.equal(calls, 1);
  });

  it("Stop cancels a real retry wait immediately without sending another request", async function () {
    const controller = new AbortController();
    let calls = 0;
    let visible = "";
    await expectFailure(
      () =>
        callDirectChatTurnWithRecovery({
          request: { ...request, signal: controller.signal },
          onDelta: (delta) => (visible += delta),
          wait: (ms, signal) => {
            const waiting = waitForChatRetry(ms, signal);
            controller.abort();
            return waiting;
          },
          call: async (_next, emit) => {
            calls++;
            emit("Keep me");
            throw networkError();
          },
        }),
      "Cancelled",
    );
    assert.equal(calls, 1);
    assert.equal(visible, "Keep me");
  });

  it("honors retry-after and does not hide a long provider cooldown", function () {
    assert.equal(
      directChatRetryDelay({ status: 429, retryAfterMs: 15000 }, 0),
      15000,
    );
    assert.equal(directChatRetryDelay({ status: 503 }, 1), 8000);
    assert.isUndefined(
      directChatRetryDelay({ status: 429, retryAfterMs: 120000 }, 0),
    );
    assert.isUndefined(directChatRetryDelay(networkError(), 2));
  });

  it("keeps short natural repetitions and flushes an undecided prefix on failure", function () {
    let text = "";
    const short = createContinuationDeltas("word ", (delta) => (text += delta));
    short.push("word again");
    short.flush();
    assert.equal(text, "word again");
    text = "";
    const pending = createContinuationDeltas(
      "a long repeated phrase",
      (delta) => (text += delta),
    );
    pending.push("a long");
    pending.flush();
    assert.equal(text, "a long");
  });

  for (const protocol of ["chat", "responses"] as const) {
    const parse =
      protocol === "chat" ? parseStreamResponse : parseResponsesStream;
    const delta = (text: string) =>
      protocol === "chat"
        ? { choices: [{ delta: { content: text } }] }
        : { type: "response.output_text.delta", delta: text };
    const terminal =
      protocol === "chat" ? "[DONE]" : { type: "response.completed" };

    for (const ending of ["error", "close"] as const) {
      it(`recovers a real ${protocol} stream after ${ending} without losing text`, async function () {
        let calls = 0;
        let visible = "";
        const result = await callDirectChatTurnWithRecovery({
          request,
          onDelta: (d) => (visible += d),
          wait: noWait,
          call: async (next, emit) => {
            const input =
              ++calls === 1
                ? stream([delta("Beginning. ")], ending)
                : stream([delta("Ending."), terminal], "close");
            return parse(input.body, emit, undefined, undefined, {
              requireCompletion: next.requireStreamCompletion,
            });
          },
        });
        assert.equal(calls, 2);
        assert.equal(result.text, "Beginning. Ending.");
        assert.equal(visible, result.text);
      });
    }

    it(`does not await socket closure after the ${protocol} terminal event`, async function () {
      const input = stream([delta("Done"), terminal], "open");
      const result = await parse(
        input.body,
        () => undefined,
        undefined,
        undefined,
        { requireCompletion: true },
      );
      assert.equal(result.text, "Done");
      assert.isTrue(input.cancelled());
    });
  }

  it("does not retry a known finish_reason when the socket then errors", async function () {
    const input = stream(
      [
        {
          choices: [{ delta: { content: "Finished" }, finish_reason: "stop" }],
        },
      ],
      "error",
    );
    const result = await parseStreamResponse(
      input.body,
      () => undefined,
      undefined,
      undefined,
      { requireCompletion: true },
    );
    assert.equal(result.text, "Finished");
  });
});
