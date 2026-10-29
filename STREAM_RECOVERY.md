# Stream recovery fork

This fork is based on `yilewang/llm-for-zotero` 3.9.15, commit
`9c2641c503623dd154166cc042308629e4120b7d`. The custom build is
`3.9.15-stream-recovery.1`; original authorship and AGPL licensing are preserved.

## Behavior

Ordinary API-key chat now handles transient connection failures without
immediately ending the turn:

- Retry at most twice per turn, after 2 seconds and then 8 seconds. A provider's
  `Retry-After` can extend either wait up to 60 seconds; longer cooldowns are
  surfaced without an early retry.
- Before any answer text arrives, resend the current request. After partial
  text arrives, start a new request with the original context and conversation,
  the original question, and the partial answer, asking the model to continue
  at the cutoff. Both the initial Send and the existing Retry flow use this.
- Keep one assistant message while recovering. Remove only exact repeated
  suffixes of at least 16 characters, considering the last 2048 characters.
  Short repeated words and punctuation remain intact.
- Show the retry attempt and wait duration. Stop cancels both the active request
  and the retry wait. Exhaustion keeps the partial answer and existing manual
  retry controls.
- Retry network failures, HTTP 408, 429, and 5xx. Do not automatically retry
  authentication failures, invalid requests, user cancellation, or arbitrary
  application errors. Native auth and Agent retry policies are unchanged.
- For direct Chat Completions and Responses SSE, detect EOF without a terminal
  event. Finish on `[DONE]` or a terminal Responses event; a known Chat
  Completions `finish_reason` also establishes completion, while allowing a
  following usage event to be read.
- Preserve the existing single recovery attempt for a reasoning-only output
  limit. This does not reset the network retry budget.

## Limits

This is a new generation using the partial answer as context, not byte-exact
server-side stream replay. It may consume additional tokens and can still
repeat or change wording. The plugin cannot repair an unavailable provider or
an unstable network. Provider usage for a disconnected request can be missing;
its final billing is authoritative. Use a shorter answer or another provider
if all attempts fail.

No provider credentials, user prompts, local diagnostic logs, or papers are
included in this repository.

## Install and roll back

In Zotero, choose **Tools → Plugins/Add-ons → gear → Install Add-on From File**,
select the custom XPI, then restart Zotero. The add-on ID is unchanged, so this
replaces the existing plugin and uses its settings and conversations.

This branch's package metadata points to this fork. Automatic updates require
release metadata published in this fork; this build is intended for manual
installation. To return to upstream, install its official XPI over this one.

## Build and validation

```sh
npm ci
npm run typecheck
npm run test:unit
npm run lint:check
npm run build
```

Focused regression tests:

```sh
npx tsx node_modules/mocha/bin/mocha.js --require ./test/register.cjs \
  test/directChatCompletion.test.ts \
  test/directChatStreamRecovery.test.ts \
  test/llmClient.outputOutcome.test.ts
```

The new tests exercise both SSE protocols with real `ReadableStream` objects,
read errors and premature EOF, terminal events without socket closure,
fragmented overlap, retries without text, retry exhaustion, HTTP error
classification, `Retry-After`, and cancellation during a real backoff timer.
The existing output-limit regression tests remain in place.

`test-workflows/chatTurnLifecycle.workflow.test.ts` additionally checks recovery
and cancellation through the actual Zotero panel and stored message rows,
using a fake provider and an isolated test database. No real API is needed:

```sh
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/path/to/zotero npm run test:workflow -- \
  test-workflows/chatTurnLifecycle.workflow.test.ts \
  test-workflows/chatStreamingTransition.workflow.test.ts
```
