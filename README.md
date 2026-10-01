# @donvitocodes/pi-agent-council

Ask independent, read-only advisors the same engineering question from inside Pi:

```text
/council Should we refactor this service before adding retries?
```

The default members are **GPT-6.1 Sol** (`gpt-6.1-sol`) and **Claude Opus 5.5** (`claude-opus-5-5`). These are configurable selectors, not a guarantee that either model exists in your Pi catalog. The extension never silently substitutes a different model.

## Install

Requires Node.js **22.19+** and Pi **0.99.2** or a compatible version exposing `modelRegistry.streamSimple`. Tested against `@earendil-works/pi-coding-agent@0.99.2` and `@earendil-works/pi-ai@0.99.2`.

Once this package is published to npm:

```sh
pi install npm:@donvitocodes/pi-agent-council
```

Or, after pushing this repository to `donvitocodes/pi-agent-council` on GitHub:

```sh
pi install git:github.com/donvitocodes/pi-agent-council
```

For the source checkout before publishing:

```sh
pi install /absolute/path/to/pi-agent-council
# Try just the extension for one invocation:
pi -e /absolute/path/to/pi-agent-council/index.ts
```

Restart Pi or run `/reload` after installing. The TypeScript entrypoint loads through Pi; no build step is required. Pi supplies its own packages through host module mapping. They are peers, not bundled dependencies.

## Usage

1. Authenticate your desired providers using Pi's `/login` or your existing provider configuration. Subscription access depends on what Pi and that provider support.
2. Bring relevant code, requirements, and diffs into the current session. The council receives text already present in the session; it does not read the repository itself.
3. Run `/council <question>`. Both advisors start independently and in parallel. Progress and individual failures appear in the UI.
4. Read the report in the transcript. It includes each opinion plus **Agreement**, **Disagreement**, **Key assumptions**, and **Decision-changing evidence**. No votes or winner are computed.
5. Continue with a message such as “Check those assumptions against the code and recommend a next step.” The report is already in the current session context. Adding it does not start an automatic agent turn or authorize edits.

Use `/council-cancel` to stop a running council. Another council request is rejected while one is running. Reload, shutdown, session replacement, and tree navigation cancel pending work. If Pi is currently running a turn, the command waits for it to finish before taking its snapshot; this wait can also be cancelled.

## Configuration

Optional files, in precedence order:

- `$PI_CODING_AGENT_DIR/council.json` (normally `~/.pi/agent/council.json`).
- `.pi/council.json` in the working directory, when Pi trusts the project. Project properties override global properties; a `members` array replaces the whole array.
- Set `PI_COUNCIL_CONFIG=/absolute/path/council.json` to use a single explicit file instead of both defaults. Relative paths resolve from the working directory.

Copy `council.example.json` into one of those locations and edit it. The two default selectors intentionally omit providers. The resolver first matches exact IDs, then normalized IDs/display names, and chooses only a uniquely authenticated match. If multiple authenticated providers expose the same model, specify the exact provider:

```json
{
  "members": [
    { "label": "GPT-6.1 Sol", "provider": "YOUR_PI_PROVIDER_ID", "model": "EXACT_GPT_MODEL_ID" },
    { "label": "Claude Opus 5.5", "provider": "YOUR_PI_PROVIDER_ID", "model": "EXACT_CLAUDE_MODEL_ID" }
  ],
  "timeoutMs": 120000,
  "maxContextChars": 48000,
  "maxOutputTokens": 4096
}
```

Replace the placeholders with IDs shown by `/model` or `pi --list-models`. Models registered by other extensions or in Pi's `models.json` also work. Use distinct models; duplicate resolved provider/model pairs are rejected. Missing models or credentials are reported per member rather than replaced. There are no council-specific API keys or direct provider clients.

Configure 2–8 members. The timeout applies to each advisor and separately to synthesis. Context is bounded to 48,000 characters by default; the oldest text is omitted with a visible marker. A character budget is approximate, not a tokenizer-aware guarantee; lower it for models with small context windows.

## How it works

- Pi's canonical session projection resolves the active branch, compaction summaries, and context edits. A single text snapshot includes user/assistant text, tool calls/results, and custom report content. System instructions, hidden thinking, and image pixels are omitted.
- Both advisors receive identical prompt, context, and timestamp data, with isolated request IDs and **no tools**. They return validated JSON: recommendation, reasoning, risks, assumptions, alternative, and self-reported confidence.
- Calls use `ctx.modelRegistry.streamSimple(...).result()`. Pi owns provider routing, configured credentials, OAuth refresh, and request headers. No workers, child processes, file mutations, or tool execution occur in council members.
- After two or more valid opinions, a separate read-only call compares them using the current Pi model (or the first successful advisor if the current model is unavailable). This model sees the question and finished opinions, not an extra repository snapshot. The report names the synthesizer; its comparisons should be checked against the original opinions.
- Invalid JSON, truncation, missing authentication, timeouts, and provider failures remain visible. Partial opinions survive. With fewer than two valid opinions, no agreement or disagreement is claimed. If synthesis fails, the report preserves the opinions and lists their assumptions without inventing a comparison. An all-failed run still adds a failure report to the session.
- `pi.sendMessage({ customType: "agent-council-report", display: true, ... }, { triggerTurn: false })` persists the report in session context and displays it. If another turn has begun, Pi appends it at the end of that turn to preserve message ordering.

Council calls send the selected text snapshot to the configured model providers and consume their normal usage/quota. Up to two advisors plus one synthesis call run by default. Nested usage is retained in report details; slash-command calls do not contribute to Pi's normal agent/tool usage totals. Successful requests are not retried automatically, and malformed JSON is not repaired with another paid call.

The optional `council` skill supplies decision guidance. It is available as `/skill:council` and disables automatic model invocation. Disable it via `pi config`, or select only the extension in Pi settings:

```json
{
  "packages": [{ "source": "npm:@donvitocodes/pi-agent-council", "skills": [] }]
}
```

## Development and publishing

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm publish --access public
```

Publishing requires ownership/access to the `@donvitocodes` npm scope. This source artifact has not been published or pushed. For Git installation, push the repository contents and optionally tag `v0.1.0`, then use `git:github.com/donvitocodes/pi-agent-council@v0.1.0`.

Tests use fake model streams to verify parallel independent requests, matching inputs, authenticated/ambiguous resolution, partial failure, invalid output, cancellation, timeout, synthesis fallback, read-only requests, report injection, and Pi's actual TypeScript extension loader. No provider credentials are needed for validation. A real authenticated provider round trip must be checked in your Pi installation.

## API references

- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Pi packages and host-provided dependencies](https://pi.dev/docs/latest/packages)
- [Official nested model-call example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/summarize.ts)
- [Extension API declarations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)

MIT license.
