# Pi Agent Council

A Pi extension.

Get independent, read-only model advice inside Pi.

```text
/council Should we refactor this service before adding retries?
```

Advisors run in parallel. Reports include each opinion, agreements, disagreements, assumptions, and evidence needed to decide.

## Install

Requirements:

- Node.js **22.19+**.
- Pi **0.99.2**, or a compatible version with `modelRegistry.streamSimple`.

From GitHub:

```sh
pi install git:github.com/donvito/pi-agent-council
```

From a local checkout:

```sh
pi install /absolute/path/to/pi-agent-council
```

Once published to npm:

```sh
pi install npm:@donvitocodes/pi-agent-council
```

Restart Pi or run `/reload`. No build step is needed.

## Usage

1. Authenticate providers with `/login` or your existing Pi configuration.
2. Add relevant code, requirements, and diffs to the session.
3. Run `/council <question>`.
4. Ask Pi to check assumptions or act on the report.

| Command | Action |
|---|---|
| `/council <question>` | Consult advisors. One run at a time. |
| `/council-view` | Open the latest report on the current branch. |
| `/council-cancel` | Stop the current run. |
| `/skill:council` | Get optional decision guidance. Disable via `pi config`. |

### Viewer controls

Wide terminals show two advisors side by side. Narrow terminals stack them.

| Key | Action |
|---|---|
| Left / Right | Switch advisor pairs. |
| Up / Down, Page Up / Page Down | Scroll. |
| Home / End | Jump to the top / bottom. |
| Escape | Close. |

Reopening a report makes no model calls.

### What to expect

- Advisors receive session text and tool results. They cannot read files or run tools.
- Calls send text to configured providers and consume their usage/quota.
- Context defaults to 48,000 characters. Older text is trimmed.
- Reports preserve successful opinions and show failures.
- Usage shows tokens, reported cost, duration, and totals. Costs may differ from billing; missing usage is marked.
- Reports stay in session context without starting an automatic agent turn.

## Configuration

Default advisors:

- **GPT-6.1 Sol**: `gpt-6.1-sol`.
- **Claude Opus 5.5**: `claude-opus-5-5`.
- **GPT-6 Astra**: `gpt-6-astra`.

Models must be available and authenticated in Pi. Unavailable models are never silently replaced.

Copy [council.example.json](council.example.json) to a configuration location:

| Scope | Location |
|---|---|
| Global | `$PI_CODING_AGENT_DIR/council.json`, normally `~/.pi/agent/council.json` |
| Trusted project | `.pi/council.json` |
| Explicit file | Set `PI_COUNCIL_CONFIG=/absolute/path/council.json` |

Project properties override global properties. A project `members` array replaces the whole array.

An explicit file replaces both default locations.

To customize:

1. Choose **2–8 distinct models**.
2. Find model IDs with `/model` or `pi --list-models`.
3. Edit `members` in your configuration file.
4. Add `"provider": "YOUR_PI_PROVIDER_ID"` if multiple authenticated providers offer the same model.

The example also includes `timeoutMs`, `maxContextChars`, and `maxOutputTokens`.

Pi manages credentials. No council-specific API keys are needed.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Checks use fake model streams. No provider credentials are needed.

[Apache 2.0 license](LICENSE).
