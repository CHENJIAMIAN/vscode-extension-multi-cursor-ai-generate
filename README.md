# Multi Cursor AI Generate

在 VS Code 中对多光标/多选区并发调用 OpenAI 风格端点进行文本生成与插入。支持限流与并发控制、指数退避重试、SSE 流式插入、可取消、状态栏吞吐显示、日志面板、SecretStorage 管理 API Key、环境变量默认读取、模型列表同步等。

- 扩展入口：[src/extension.activate()](src/extension.ts:1)
- 主命令：[src/commands/generate.registerGenerateCommand()](src/commands/generate.ts:1)
- 模型同步：[src/commands/syncModels.registerSyncModelsCommand()](src/commands/syncModels.ts:1)
- HTTP 客户端（undici + Pool + SSE）：[src/net/httpClient.HttpClient](src/net/httpClient.ts:1)
- 限流（并发池 + 令牌桶）：[src/net/rateLimiter.TokenBucketPool](src/net/rateLimiter.ts:1)
- 退避重试：[src/net/backoff.exponentialJitter()](src/net/backoff.ts:1)
- 模板渲染：[src/prompt/template.render()](src/prompt/template.ts:1)
- 编辑插入：[src/edit/insert.applyInsertions()](src/edit/insert.ts:1)
- 配置 Schema：[src/config/schema.ts](src/config/schema.ts:1)
- 日志与状态栏：[src/log/logger.ts](src/log/logger.ts:1), [src/ui/status.ts](src/ui/status.ts:1), [src/ui/progress.ts](src/ui/progress.ts:1)

## 安装

1) 在工作区根目录执行安装依赖
- Node 18+ 推荐
- 需要安装 vsce 来打包（可选）

```bash
npm i
```

2) 进入 VS Code 调试
- 打开本仓库，按 F5 以 “Extension Development Host” 启动
- 或打包 VSIX 后手动安装，见下文

## 配置

所有配置均在 [package.json](package.json) 的 contributes.configuration 中声明，并在 [src/config/schema.ts](src/config/schema.ts:1) 定义了类型与默认值。常用项：

- API 基础
  - multiCursorAI.baseUrl: OpenAI 风格 API 基础 URL（默认 https://api.openai.com）
  - multiCursorAI.apiKeySecretId: SecretStorage 中保存 Key 的 ID（默认 "multiCursorAI.apiKey"）
  - multiCursorAI.apiKeyEnvVar: 默认从环境变量读取 Key（默认 "OPENAI_API_KEY"）
  - multiCursorAI.authScheme: 鉴权方案（默认 "Bearer"）
  - multiCursorAI.modelsPath: 模型列表路径（默认 "/v1/models"）
  - multiCursorAI.requestPath: 请求路径（默认 "/v1/chat/completions"）
  - multiCursorAI.useStreaming: 启用 SSE 流式（默认 true）
  - multiCursorAI.timeoutMs: HTTP 超时，默认 60000
  - multiCursorAI.proxy: 代理地址（如 http://127.0.0.1:7890）
  - multiCursorAI.rejectUnauthorized: TLS 校验（默认 true）

- 请求参数
  - multiCursorAI.modelDefault: 默认模型名
  - multiCursorAI.modelList: 可选模型列表
  - multiCursorAI.temperature: 温度（0~2）
  - multiCursorAI.maxTokens: 最大返回 tokens
  - multiCursorAI.requestBodyMode: "auto" | "chat" | "completions"

- 流控/重试
  - multiCursorAI.maxConcurrency: 最大并发（默认 30）
  - multiCursorAI.httpMaxConnections: 连接池连接数（建议与并发对齐）
  - multiCursorAI.maxRequestsPerMinute: 每分钟上限（令牌桶）
  - multiCursorAI.dynamicLimitProbe: 动态限流探测（默认 true）
  - multiCursorAI.maxRetries: 最大重试次数（默认 8）
  - multiCursorAI.baseBackoffMs: 退避基础毫秒（默认 500）
  - multiCursorAI.maxBackoffMs: 退避最大毫秒（默认 60000）

- 文本插入
  - multiCursorAI.insertMode: "append" | "replace"（默认 "append"）
  - multiCursorAI.preSeparator: 插入内容前的分隔
  - multiCursorAI.postSeparator: 插入内容后的分隔
  - multiCursorAI.trimResult: 是否 trim 结果

- 模板/上下文
  - multiCursorAI.promptTemplate: 模板，至少包含 {userPrompt} 与 {selection}
  - multiCursorAI.systemPromptEnabled: 是否作为 system 发送全局指令
  - multiCursorAI.globalPrependInstruction: 全局前置指令
  - multiCursorAI.contextVars.includeFileName / includeLanguageId / includeRelativePath / includeNow

- 日志
  - multiCursorAI.logLevel: "error" | "warn" | "info" | "debug" | "trace"

配置读取逻辑见 [src/config/index.getEffectiveConfig()](src/config/index.ts:1)，默认会从 SecretStorage 读取 API Key，若为空则尝试从环境变量注入并保存。

## 快捷键与命令

- 生成：multiCursorAI.generate
  - Windows/Linux: Ctrl+Alt+P
  - macOS: Ctrl+Option+P
- 同步模型：multiCursorAI.syncModels

可在命令面板中搜索 “Multi Cursor AI”。

## 使用方式

1) 在编辑器中多选几段文本，或用多光标（无选区时按整行处理，空行会自动跳过）。
2) 按快捷键或运行命令 “Multi Cursor AI: Generate”。
3) 输入提示词（每个选区会独立构造请求）。
4) 选择模型（默认使用上次选择，可在设置中维护 modelList）。
5) 查看状态栏吞吐（并发、每分钟限额、排队数）与日志面板输出。
6) 支持进度通知与取消；取消会中止在途与排队任务。

插入模式
- 非流式：等所有结果返回后，按位置从后往前批量应用，避免偏移（append/replace 均支持）。
- 流式：端点支持 SSE 时，增量插入，减少闪烁；取消会立即停止插入。

实现参考：
- 生成命令：[src/commands/generate.registerGenerateCommand()](src/commands/generate.ts:1)
- 插入逻辑：[src/edit/insert.applyInsertions()](src/edit/insert.ts:1), [src/edit/insert.StreamInserter](src/edit/insert.ts:1)

## 端点兼容性

- 默认兼容 OpenAI 风格 /v1/chat/completions 和 /v1/completions。
- 根据 multiCursorAI.requestBodyMode 与 requestPath 自动映射：
  - chat: body 包含 messages
  - completions: body 包含 prompt
- SSE 流式：Content-Type 必须为 text/event-stream，解析 data: 行中的 JSON。
- HTTP 客户端实现见 [src/net/httpClient.HttpClient](src/net/httpClient.ts:1)。

## 限流与重试

- 限流器：[src/net/rateLimiter.TokenBucketPool](src/net/rateLimiter.ts:1)
  - 最大并发 + 每分钟令牌桶
  - 动态探测：基于响应头（Retry-After、x-ratelimit-*）自动调整
  - cancelAll 支持全局取消队列任务
- 重试：指数退避 + 抖动
  - 算法实现：[src/net/backoff.exponentialJitter()](src/net/backoff.ts:1)

## 日志与状态栏

- OutputChannel 日志：[src/log/logger.Logger](src/log/logger.ts:1)
- 状态栏吞吐显示：[src/ui/status.StatusBarController](src/ui/status.ts:1)
- 进度通知（可取消）：[src/ui/progress.withCancellableProgress()](src/ui/progress.ts:1)

## 安全建议

- API Key 存储于 SecretStorage，Key 标识可配置（multiCursorAI.apiKeySecretId）。
- 若从环境变量注入（multiCursorAI.apiKeyEnvVar），首次激活会自动保存到 SecretStorage。
- 日志默认不输出明文 Key；如需排查请注意不要在公共环境中开启过于详细的日志。

## 常见问题（FAQ）

- 429/限流：已内置退避重试与动态限流，可降低并发或提高限额。详见 [src/net/rateLimiter.ts](src/net/rateLimiter.ts:1)。
- 代理：设置 multiCursorAI.proxy，例如 http://127.0.0.1:7890。
- TLS 校验：自签名证书可将 multiCursorAI.rejectUnauthorized 设为 false（不安全）。
- 只读文件或未保存：编辑失败会给出提示，建议先保存文件。
- 输出格式异常/噪声：可开启 multiCursorAI.trimResult 或设置 pre/post 分隔符。
- 安装报错类型定义/模块缺失：
  - 首次打开可能看到 TS 类型缺失提示（vscode/undici 等），执行 `npm i` 后重试。
  - 运行测试前请确保 devDependencies 安装完成。

## 运行测试

使用 mocha + chai + ts-node，核心测试覆盖退避/限流/模板渲染：

```bash
npm test
```

测试文件：
- 退避重试：[test/backoff.test.ts](test/backoff.test.ts:1)
- 限流池：[test/rateLimiter.test.ts](test/rateLimiter.test.ts:1)
- 模板渲染：[test/template.test.ts](test/template.test.ts:1)

## 打包与发布
- 自动发布

```bash
# 先
npm run compile
# 再
npx vsce publish --skip-duplicate -p "vscode personal access token to Visual Studio Code"
```

- 打包 VSIX（需要安装 vsce）：

```bash
npm run package
```

- 发布（需要配置发布令牌与 publisher）：

```bash
npm run publish
```

VSIX 体积控制见 [.vscodeignore](.vscodeignore)，只包含 [dist](dist) 与必要文档。

## 许可证

- MIT，见 [LICENSE](LICENSE)