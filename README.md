# @donvitocodes/pi-agent-council

Get independent, read-only model advice inside Pi:

```text
/council Should we refactor this service before adding retries?
```

Advisors run in parallel. The report preserves each opinion and summarizes agreement, disagreement, assumptions, and decision-changing evidence.

## Install

Requires Node.js **22.19+** and Pi **0.99.2** or a compatible version exposing `modelRegistry.streamSimple`.

From GitHub:

```sh
pi install git:github.com/donvito/pi-agent-council
```

From a source checkout:

```sh
pi install /absolute/path/to/pi-agent-council
```

Once published to npm:

```sh
pi install npm:@donvitocodes/pi-agent-council
```

Restart Pi or run `/reload`. No build step is required.

## Usage

1. Authenticate your providers with Pi's `/login` or existing provider configuration.
2. Bring relevant code, requirements, and diffs into the session. Advisors see session text and tool results; they cannot read files or run tools.
3. Run `/council <question>`, then ask Pi to check the report's assumptions or act on its recommendations.

Use `/council-view` to open the latest report on the current branch in a scrollable comparison overlay. Wide terminals show advisor pairs side by side; narrow terminals stack them. Left/right switches pairs, up/down or Page Up/Down scrolls, Home/End jumps, and Escape closes. Reopening makes no model calls.

Reports include tokens, reported cost, and duration per call, plus totals. Missing usage is marked; reported costs may differ from billing.

Use `/council-cancel` to stop a run. Only one council can run at a time. Reports stay in session context without starting an automatic agent turn.

Council calls send session text to your configured providers and consume their normal usage/quota. Context is limited to 48,000 characters by default, with the oldest text omitted. Failures remain visible and successful opinions are preserved.

## Configuration

Default advisors: **GPT-6.1 Sol** (`gpt-6.1-sol`) and **Claude Opus 5.5** (`claude-opus-5-5`). They must be available and authenticated in your Pi model catalog; unavailable models are never silently replaced.

Copy [council.example.json](council.example.json) to:

- `$PI_CODING_AGENT_DIR/council.json` (normally `~/.pi/agent/council.json`) for global settings.
- `.pi/council.json` for a trusted project. Project properties override global properties; `members` replaces the entire array.

Alternatively, set `PI_COUNCIL_CONFIG=/absolute/path/council.json` to use only that file.

```json
{
  "members": [
    { "label": "GPT-6.1 Sol", "model": "gpt-6.1-sol" },
    { "label": "Claude Opus 5.5", "model": "claude-opus-5-5" }
  ],
  "timeoutMs": 120000,
  "maxContextChars": 48000,
  "maxOutputTokens": 4096
}
```

Configure 2–8 distinct models using IDs from `/model` or `pi --list-models`. Add `"provider": "YOUR_PI_PROVIDER_ID"` to a member if multiple authenticated providers offer the same model. Pi manages credentials; no council-specific API keys are needed.

The optional `/skill:council` provides decision guidance and can be disabled via `pi config`.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Checks use fake model streams and require no provider credentials.

[Apache 2.0 license](LICENSE).
