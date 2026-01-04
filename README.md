[English](./README.md) | [中文](./README.zh-CN.md)

# Multi Cursor AI Generate

Concurrent text generation and insertion in VS Code for multi-cursor/multi-selection using OpenAI-style endpoints. Supports rate limiting and concurrency control, exponential backoff retries, SSE streaming insertion, cancellation, status bar throughput display, log panel, SecretStorage API Key management, default environment variable reading, model list synchronization, etc.

- Extension Entry: [src/extension.activate()](src/extension.ts)
- Main Command: [src/commands/generate.registerGenerateCommand()](src/commands/generate.ts)
- Model Sync: [src/commands/syncModels.registerSyncModelsCommand()](src/commands/syncModels.ts)
- HTTP Client (undici + Pool + SSE): [src/net/httpClient.HttpClient](src/net/httpClient.ts)
- Rate Limiter (Concurrency Pool + Token Bucket): [src/net/rateLimiter.TokenBucketPool](src/net/rateLimiter.ts)
- Backoff Retry: [src/net/backoff.exponentialJitter()](src/net/backoff.ts)
- Template Rendering: [src/prompt/template.render()](src/prompt/template.ts)
- Edit Insertion: [src/edit/insert.applyInsertions()](src/edit/insert.ts)
- Configuration Schema: [src/config/schema.ts](src/config/schema.ts)
- Logging and Status Bar: [src/log/logger.ts](src/log/logger.ts), [src/ui/status.ts](src/ui/status.ts), [src/ui/progress.ts](src/ui/progress.ts)

## Installation

1) Install dependencies in the workspace root
- Node 18+ recommended
- `vsce` installation required for packaging (optional)

```bash
npm i
```

2) Enter VS Code Debugging
- Open this repository, press F5 to launch with "Extension Development Host"
- Or package as VSIX and install manually, see below

## Configuration

All configurations are declared in `contributes.configuration` of [package.json](package.json) and defined with types and default values in [src/config/schema.ts](src/config/schema.ts). Common items:

- API Basics
  - multiCursorAI.baseUrl: OpenAI-style API base URL (Default: https://api.openai.com)
  - multiCursorAI.apiKeySecretId: ID for storing the Key in SecretStorage (Default: "multiCursorAI.apiKey")
  - multiCursorAI.apiKeyEnvVar: Default environment variable to read Key from (Default: "OPENAI_API_KEY")
  - multiCursorAI.authScheme: Authentication scheme (Default: "Bearer")
  - multiCursorAI.modelsPath: Model list path (Default: "/v1/models")
  - multiCursorAI.requestPath: Request path (Default: "/v1/chat/completions")
  - multiCursorAI.useStreaming: Enable SSE streaming (Default: true)
  - multiCursorAI.timeoutMs: HTTP timeout, default 60000
  - multiCursorAI.proxy: Proxy address (e.g., http://127.0.0.1:7890)
  - multiCursorAI.rejectUnauthorized: TLS verification (Default: true)

- Request Parameters
  - multiCursorAI.modelDefault: Default model name
  - multiCursorAI.modelList: Optional model list
  - multiCursorAI.temperature: Temperature (0~2)
  - multiCursorAI.maxTokens: Max return tokens
  - multiCursorAI.requestBodyMode: "auto" | "chat" | "completions"
  - multiCursorAI.reasoningEffort: "none" | "low" | "medium" | "high" (Default: "medium")
  - multiCursorAI.disableReasoning: Disable reasoning for models that support it (Default: false)
  - multiCursorAI.singleLineOutput: Force output to be single line (Default: false)
  - multiCursorAI.promptHistoryLimit: Max history items for prompt selection (Default: 100)

- Rate Limiting / Retry
  - multiCursorAI.maxConcurrency: Max concurrency (Default: 30)
  - multiCursorAI.httpMaxConnections: Connection pool size (Suggested to align with concurrency)
  - multiCursorAI.maxRequestsPerMinute: Requests per minute limit (Token Bucket)
  - multiCursorAI.dynamicLimitProbe: Dynamic rate limit probing (Default: true)
  - multiCursorAI.maxRetries: Max retry attempts (Default: 8)
  - multiCursorAI.baseBackoffMs: Base backoff milliseconds (Default: 500)
  - multiCursorAI.maxBackoffMs: Max backoff milliseconds (Default: 60000)

- Text Insertion
  - multiCursorAI.insertMode: "append" | "replace" (Default: "append")
  - multiCursorAI.preSeparator: Separator before inserted content
  - multiCursorAI.postSeparator: Separator after inserted content
  - multiCursorAI.trimResult: Whether to trim the result

- Template / Context
  - multiCursorAI.promptTemplate: Template, must include `{userPrompt}` and `{selection}`
  - multiCursorAI.systemPromptEnabled: Whether to send global instructions as system prompt
  - multiCursorAI.globalPrependInstruction: Global prepend instruction
  - multiCursorAI.contextVars.includeFileName / includeLanguageId / includeRelativePath / includeNow

- Logging
  - multiCursorAI.logLevel: "error" | "warn" | "info" | "debug" | "trace"

Configuration reading logic can be found in [src/config/index.getEffectiveConfig()](src/config/index.ts). It defaults to reading the API Key from SecretStorage; if empty, it attempts to inject from environment variables and save it.

## Shortcuts and Commands

- Generate: multiCursorAI.generate
  - Windows/Linux: Ctrl+Alt+P
  - macOS: Ctrl+Option+P
- Sync Models: multiCursorAI.syncModels
- Set API Key: multiCursorAI.setApiKey
- Clear API Key: multiCursorAI.clearApiKey
- Toggle Streaming: multiCursorAI.toggleUseStreaming
- Set Temperature: multiCursorAI.setTemperature
- Set Pre-Separator: multiCursorAI.setPreSeparator
- Toggle Trim Result: multiCursorAI.toggleTrimResult
- Set Log Level: multiCursorAI.setLogLevel
- Set Reasoning Effort: multiCursorAI.setReasoningEffort
- Toggle Disable Reasoning: multiCursorAI.toggleDisableReasoning
- Toggle Single Line Output: multiCursorAI.toggleSingleLineOutput

Search "Multi Cursor AI" in the Command Palette.

## Usage

1) Select multiple text segments in the editor, or use multiple cursors (processes entire line if no selection; skips empty lines).
2) Press the shortcut key or run the command "Multi Cursor AI: Generate".
3) Enter the prompt (a request is constructed independently for each selection).
4) Select a model (defaults to the last selection; maintain `modelList` in settings).
5) View status bar throughput (concurrency, per-minute quota, queue count) and log panel output.
6) Supports progress notification and cancellation; cancellation stops in-flight and queued tasks.

Insertion Modes
- Non-streaming: Batch applies from back to front after all results return to avoid offset issues (supports append/replace).
- Streaming: Incremental insertion when the endpoint supports SSE, reducing flicker; cancellation stops insertion immediately.

Implementation References:
- Generate Command: [src/commands/generate.registerGenerateCommand()](src/commands/generate.ts)
- Insertion Logic: [src/edit/insert.applyInsertions()](src/edit/insert.ts), [src/edit/insert.StreamInserter](src/edit/insert.ts)

## Endpoint Compatibility

- Default compatibility with OpenAI style `/v1/chat/completions` and `/v1/completions`.
- Automatically maps based on `multiCursorAI.requestBodyMode` and `requestPath`:
  - chat: body includes `messages`
  - completions: body includes `prompt`
- SSE Streaming: `Content-Type` must be `text/event-stream`, parsing JSON in `data:` lines.
- HTTP Client implementation in [src/net/httpClient.HttpClient](src/net/httpClient.ts).

## Rate Limiting and Retry

- Rate Limiter: [src/net/rateLimiter.TokenBucketPool](src/net/rateLimiter.ts)
  - Max concurrency + per-minute token bucket
  - Dynamic Probing: Automatically adjusts based on response headers (`Retry-After`, `x-ratelimit-*`)
  - `cancelAll` supports global queue cancellation
- Retry: Exponential Backoff + Jitter
  - Algorithm implementation: [src/net/backoff.exponentialJitter()](src/net/backoff.ts)

## Logging and Status Bar

- OutputChannel Logging: [src/log/logger.Logger](src/log/logger.ts)
- Status Bar Throughput Display: [src/ui/status.StatusBarController](src/ui/status.ts)
- Progress Notification (Cancellable): [src/ui/progress.withCancellableProgress()](src/ui/progress.ts)

## Security Recommendations

- API Key is stored in SecretStorage; Key identifier is configurable (`multiCursorAI.apiKeySecretId`).
- If injected from environment variables (`multiCursorAI.apiKeyEnvVar`), it is automatically saved to SecretStorage on first activation.
- Logs do not output plain text Keys by default; avoid enabling overly detailed logs in public environments if troubleshooting.

## FAQ

- 429/Rate Limiting: Built-in backoff retry and dynamic rate limiting. You can lower concurrency or increase the limit. See [src/net/rateLimiter.ts](src/net/rateLimiter.ts).
- Proxy: Set `multiCursorAI.proxy`, e.g., `http://127.0.0.1:7890`.
- TLS Verification: Self-signed certificates can set `multiCursorAI.rejectUnauthorized` to `false` (Unsafe).
- Read-only files or Unsaved: Edit failure prompts provided; saving files first is recommended.
- Output Format Exception/Noise: Enable `multiCursorAI.trimResult` or set `pre`/`post` separators.
- Installation Errors (Type Definitions/Missing Modules):
  - First launch might show TS type missing prompts (vscode/undici, etc.), retry after running `npm i`.
  - Ensure `devDependencies` are installed before running tests.

## Running Tests

Uses mocha + chai + ts-node. Core tests cover backoff/rate limiting/template rendering:

```bash
npm test
```

Test Files:
- Backoff Retry: [test/backoff.test.ts](test/backoff.test.ts)
- Rate Limiter Pool: [test/rateLimiter.test.ts](test/rateLimiter.test.ts)
- Template Rendering: [test/template.test.ts](test/template.test.ts)

## Packaging and Publishing
- Auto Publish

```bash
# First
npm run compile
# Then
npx vsce publish --skip-duplicate -p "vscode personal access token to Visual Studio Code"
```

- Package VSIX (requires vsce installation):

```bash
npm run package
```

- Publish (requires configuration of publish token and publisher):

```bash
npm run publish
```

VSIX size control see [.vscodeignore](.vscodeignore), only includes [dist](dist) and necessary documentation.

## License

- MIT, see [LICENSE](LICENSE)