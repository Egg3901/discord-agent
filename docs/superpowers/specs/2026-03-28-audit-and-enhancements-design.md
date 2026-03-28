# Discord Agent: Audit Fixes & Enhancement Spec

**Date:** 2026-03-28
**Scope:** 4 critical fixes, 10 high fixes, 8 medium fixes, 18 feature enhancements
**Approach:** Surgical per-file fixes (no middleware refactor)
**Commit strategy:** One commit per phase, pushed incrementally

---

## Phase 1 — Critical Security Fixes

### C1: Command injection in `build_project`
**File:** `src/tools/devToolExecutor.ts`
**Fix:** Remove the custom command passthrough in `detectBuildCommand()`. Only allow the 4 known actions (`build`, `test`, `lint`, `typecheck`). Return an error string for anything else instead of passing it through to `bash -c`.

### C2: Path traversal on Windows
**File:** `src/tools/scriptExecutor.ts`
**Fix:** Replace `resolved.startsWith(sandboxDir)` with:
```ts
const relative = path.relative(sandboxDir, resolved);
if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
```

### C3: Parent dir extraction uses `/` not `path.dirname()`
**File:** `src/tools/scriptExecutor.ts`
**Fix:** Replace `resolved.substring(0, resolved.lastIndexOf('/'))` with `path.dirname(resolved)`.

### C4: `/cancel` has no auth check
**File:** `src/bot/commands/cancel.ts`
**Fix:** Add `session.userId !== interaction.user.id` check. Also add `isAllowed()` check and try-catch wrapper. Make reply ephemeral.

---

## Phase 2 — High Priority Fixes

### H1: Missing `isAllowed()` on commands
**Files:** cancel.ts, export.ts, sandbox.ts, model.ts, session.ts, thinking.ts, repo.ts, config.ts
**Fix:** Add `isAllowed(interaction.member)` check at the top of each `execute()`. Import `isAllowed` and `GuildMember` type where missing.

### H2: No try-catch on most commands
**Files:** Same as H1 plus usage.ts, version.ts
**Fix:** Wrap each `execute()` body in try-catch. Catch sends `formatApiError(err)` as ephemeral reply (or editReply if deferred).

### H3: `/review` streamer initialized with `null`
**File:** `src/bot/commands/review.ts`
**Fix:** Pass the actual message from `interaction.editReply('Reviewing PR...')` as the thinking message to `ResponseStreamer`. The `editReply` returns a `Message` object.

### H4: CC subprocess zombie/leak
**File:** `src/claude/aiClient.ts`
**Fix:** In `spawnClaudeCodeProcess`, add cleanup in the `finally` block:
```ts
finally {
  clearTimeout(timer);
  proc.stdout?.removeAllListeners();
  proc.stderr?.removeAllListeners();
  proc.removeAllListeners();
  if (proc.exitCode === null) proc.kill('SIGTERM');
  proc.unref();
}
```

### H5: ResponseStreamer timers leak on error
**File:** `src/claude/responseFormatter.ts`
**Fix:** Add a `destroy()` method that calls `stopTimers()`. Update all callers to call `destroy()` in finally blocks. Also make `finish()` idempotent (call `stopTimers()` at the start of `finish()`).

### H6: Gemini usage always reports 0 tokens
**File:** `src/claude/aiClient.ts`
**Fix:** Extract usage from Gemini response metadata:
```ts
const usage = (response as any).usageMetadata || {};
options.onUsage?.({
  tokensIn: usage.promptTokenCount || 0,
  tokensOut: usage.candidatesTokenCount || 0,
  model, keyId: key.id,
});
```
Note: Gemini streaming may not provide per-chunk usage. Accumulate from final chunk or response object.

### H7: Token counting ignores system prompt
**File:** `src/claude/aiClient.ts`
**Fix:** In `streamAnthropic`, estimate system prompt tokens and subtract from context budget:
```ts
const systemTokenEstimate = Math.ceil(systemPrompt.length / 4);
const trimmed = trimConversation(messages, config.MAX_CONTEXT_TOKENS - systemTokenEstimate);
```

### H8: Session trimming invalid role sequences
**File:** `src/sessions/sessionManager.ts`
**Fix:** After trimming, if `tail` is empty, skip the bridge message entirely. Only insert the assistant bridge if tail starts with a user message.

### H9: `thinkingEnabled`/`thinkingBudget` not persisted
**File:** `src/storage/database.ts`, `src/sessions/sessionManager.ts`
**Fix:** Add DB migration for two new columns (`thinking_enabled INTEGER`, `thinking_budget INTEGER`). Update `persistSession()` INSERT to include them (11 params). Update `loadFromDatabase()` to restore them.

### H10: Git credential exposed via env
**File:** `src/tools/devToolExecutor.ts`
**Fix:** Instead of passing `GIT_AUTH_TOKEN` as a persistent env var, write a temporary credential file with restricted permissions, use `GIT_CONFIG_GLOBAL` to point to it, and delete it after the git command completes. Alternatively, use `git credential-store` with a temporary file.

---

## Phase 3 — Enhancements Batch A: Streaming & Display

### E1: `/ask` streaming
**File:** `src/bot/commands/ask.ts`
**Change:** Replace `getResponse()` with `streamResponse()` + `ResponseStreamer`. Defer reply, create a "Thinking..." message, stream chunks through the streamer. For CC provider, handle `tool_use` events the same way as `messageCreate.ts`.

### E2: CC tool result timing
**Files:** `src/bot/commands/code.ts`, `src/bot/events/messageCreate.ts`
**Change:** When a new `tool_use` event arrives and `lastToolMsg` exists, edit the previous tool message with a checkmark before creating the new one. This way each tool gets marked done when the *next* tool starts (or when the final text arrives), not only on `stop`.

### E3: AI-generated thread names
**File:** `src/bot/commands/code.ts`
**Change:** After thread creation, fire-and-forget a short AI call to generate a 4-6 word title from the prompt. Use the effective model only if it's not CC (to avoid subprocess overhead); otherwise use truncated prompt as today. Edit thread name via `thread.setName()`. Wrap in try-catch — failure is non-fatal.

### E4: Session timeout warning
**File:** `src/sessions/sessionManager.ts`
**Change:** In `pruneStale()`, before deleting a session, check if it's within 5 minutes of expiry. If so, send a warning message to the thread channel via the Discord client. This requires passing the Discord client to `SessionManager` (or emitting an event). Approach: add an `onSessionExpiring` callback in the constructor that the index.ts wires up to send a message via the client.

### E5: Reaction controls (stop)
**File:** `src/bot/events/messageCreate.ts` (or new file `src/bot/events/reactionAdd.ts`)
**Change:** Listen for `messageReactionAdd` events. If reaction is `stop_sign` on a bot message in an active session thread, and the reactor is the session owner, abort the active controller. Register in index.ts alongside messageCreate.

---

## Phase 4 — Enhancements Batch B: Commands & UX

### E6: Model autocomplete on `/model`
**File:** `src/bot/commands/model.ts`
**Change:** Add `setAutocomplete(true)` to the model option. Add `autocomplete()` handler with a hardcoded list:
```
claude-code, claude-code-sonnet, claude-code-opus,
claude-sonnet-4-5-20250514, claude-opus-4-5-20250414,
claude-haiku-4-5-20251001,
gemini-2.5-pro, gemini-2.5-flash
```
Filter by focused input. No API call needed.

### E7: CC model variants in help
**File:** `src/bot/commands/help.ts`
**Change:** Add a "Models" section mentioning `claude-code` (default, Max plan), `claude-code-sonnet`, `claude-code-opus`, and that Anthropic API / Gemini models are available if API keys are configured.

### E8: `/status` command
**File:** NEW `src/bot/commands/status.ts`
**Behavior:** Shows current session info in the thread:
- Active model (with provider label)
- Repo attached (if any)
- Thinking mode (on/off, budget)
- Message count and session age
- Session ID
Must be used in a thread with an active session. Ephemeral reply.
**Registration:** Add to index.ts commands array. Add to help text.

### E9: `/retry` command
**File:** NEW `src/bot/commands/retry.ts`
**Behavior:** Pops the last assistant message from session history, re-sends the last user message through the AI. Must be in an active session thread. Owner-only. Creates new streaming response.
**Edge cases:** If last message isn't assistant, reply "Nothing to retry." If session has < 2 messages, reply "No previous response to retry."
**Registration:** Add to index.ts, help text.

### E10: `/persona` (system prompt override)
**File:** NEW `src/bot/commands/persona.ts`
**Behavior:** `/persona set <text>` — sets a custom system prompt prefix for the session. `/persona clear` — removes it. Stored on the session object as `session.systemPrompt`. The `contextBuilder.buildSystemPrompt()` prepends it to the system prompt if present.
**Persistence:** Add `system_prompt TEXT` column to sessions table. Include in persist/restore.
**Registration:** Add to index.ts, help text.

### E11: CC session `/reset`
**File:** `src/bot/commands/session.ts` (add subcommand)
**Behavior:** `/session reset` — clears the CC session ID for the current thread so next message starts a fresh CC conversation. Also clears the session messages array. Owner-only.

### E12: `/ask` optional threading
**File:** `src/bot/commands/ask.ts`
**Change:** Add a boolean option `thread` (default false). If true, create a thread like `/code` does and start a session. Reuse the same streaming logic.

### E13: `/review` output to thread
**File:** `src/bot/commands/review.ts`
**Change:** Instead of replying ephemerally, create a thread (like `/code`). Stream the review into the thread. Start a session so the user can follow up with questions about the review.

---

## Phase 5 — Enhancements Batch C: Efficiency & Polish

### E14: CC session cleanup
**File:** `src/claude/aiClient.ts`, `src/sessions/sessionManager.ts`
**Change:** When `sessionManager.endSession()` is called, also clear the CC session from the in-memory map and delete from `claude_code_sessions` DB table. Add a `clearClaudeCodeSession(sessionKey)` export from database.ts. Wire it into `endSession()` and `pruneStale()`.

### E15: Prompt caching on conversation turns
**File:** `src/claude/aiClient.ts`
**Change:** When building `anthropicMessages`, add `cache_control: { type: 'ephemeral' }` to the last content block of the second-to-last user message (if it exists). This caches all messages up to the penultimate turn, so only the latest user message is re-processed.

### E16: Persist optimization
**File:** `src/sessions/sessionManager.ts`
**Change:** In `addMessage()`, remove the implicit persist call (there is none currently — only the timer persists). Wrap `persistAll()` in a DB transaction: `db.transaction(() => { for (const s of sessions) persistSession(s); })()`.

### E17: `/export` includes tool calls
**File:** `src/bot/commands/export.ts`
**Change:** When building markdown, check if `message.content` is a `ContentBlock[]`. For `tool_use` blocks, render as `> Tool: tool_name(input)`. For `tool_result` blocks, render as `> Result: content` (truncated to 500 chars).

### E18: URL paste from GitHub/Gist
**File:** `src/bot/events/messageCreate.ts`
**Change:** After processing attachments, scan message content for raw GitHub file URLs (`raw.githubusercontent.com/...` or `gist.githubusercontent.com/...`). Fetch the content and append as a code block, same as file attachments. Limit: 100KB, max 3 URLs per message.

---

## Phase 6 — Medium Fixes (woven into relevant phases)

### M1: CC stream backpressure
**File:** `src/claude/aiClient.ts`
**Woven into:** Phase 2 (H4 — CC subprocess cleanup)
**Fix:** Add `proc.stdout.pause()` when `lines.length > 100`, `resume()` when drained below 50.

### M2: `persistAll()` transaction
**Woven into:** Phase 5 (E16)

### M3: Config persistence log on failure
**File:** `src/config.ts`
**Fix:** Change `.catch(() => {})` to `.catch((err) => { logger.warn({ err, key }, 'Failed to persist config'); })`.

### M4: Image attachment silent drop
**File:** `src/claude/aiClient.ts`
**Fix:** Log warning when images are provided but no user message found.

### M5: Autocomplete error logging
**Files:** `src/bot/commands/code.ts`, `src/bot/commands/repo.ts`
**Fix:** Add `logger.debug({ err }, 'Autocomplete failed')` in the catch block.

### M6: GitHub API timeout
**File:** `src/github/repoFetcher.ts`
**Fix:** Add `request: { timeout: 15000 }` to Octokit constructor options.

### M7: GitHub tree truncated flag
**File:** `src/github/repoFetcher.ts`
**Fix:** Check `tree.truncated` and append `[tree truncated — repository too large for full listing]` to the result.

### M8: Temp sandbox cleanup
**File:** `src/tools/scriptExecutor.ts`
**Fix:** Add a `cleanupStaleSandboxes()` function that removes `tmp_*` dirs older than 1 hour. Call it from `sessionManager.pruneStale()`.

---

## Files Changed Per Phase

| Phase | Files Modified | Files Created |
|-------|---------------|---------------|
| 1 | devToolExecutor.ts, scriptExecutor.ts, cancel.ts | — |
| 2 | cancel.ts, export.ts, sandbox.ts, model.ts, session.ts, thinking.ts, repo.ts, config.ts, usage.ts, version.ts, review.ts, aiClient.ts, responseFormatter.ts, sessionManager.ts, database.ts, devToolExecutor.ts | — |
| 3 | ask.ts, code.ts, messageCreate.ts, sessionManager.ts | reactionAdd.ts |
| 4 | model.ts, help.ts, session.ts, ask.ts, review.ts, contextBuilder.ts, database.ts, sessionManager.ts, index.ts | status.ts, retry.ts, persona.ts |
| 5 | aiClient.ts, sessionManager.ts, database.ts, export.ts, messageCreate.ts | — |
| 6 | aiClient.ts, config.ts, code.ts, repo.ts, repoFetcher.ts, scriptExecutor.ts | — |

---

## Out of Scope

- Full middleware/decorator pattern for commands (premature for 16 commands)
- API key encryption at rest (operational concern, not code fix)
- Integration test suite (separate effort)
- SQL injection in keyStore (the current code uses parameterized queries for all user input; the hardcoded `0, 1` are constants, not injectable)
