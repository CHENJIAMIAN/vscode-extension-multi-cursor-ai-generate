# Changelog

所有显著更改都会记录在此文件中。

## 0.2.5 - 2026-07-28

- 补齐状态栏、进度计数和默认提示模板的英文与简体中文国际化。
- 修复模板在截断前未先清理首尾空行的问题。
- 修复令牌桶测试覆盖初始突发后的节流行为，并清理全仓 lint 问题。

## 0.2.4

- fix: 修复 VSIX 发布包缺少运行时依赖 `undici`，导致扩展激活失败和命令无法注册的问题。
- test: 增加 VSIX 发布清单回归测试，确保运行时代码与生产依赖被打入发布包。

## 0.2.3

- l10n: Localization support (Chinese/English)
- feat: Expose configuration options to commands
- fix: Fix concurrent AI response ordering bugs
- fix: Remove default max tokens to respect server defaults

## 0.1.0

初始版本，核心能力：
- 多光标/多选区并发生成与插入，命令：[package.json](package.json) 中 multiCursorAI.generate 与 multiCursorAI.syncModels
- 模板渲染与上下文变量：[src/prompt/template.render()](src/prompt/template.ts:1)
- 并发池 + 令牌桶限流与动态调整：[src/net/rateLimiter.TokenBucketPool](src/net/rateLimiter.ts:1)
- 指数退避 + 抖动重试：[src/net/backoff.exponentialJitter()](src/net/backoff.ts:1)
- HTTP 客户端（undici Pool + Keep-Alive + SSE）：[src/net/httpClient.HttpClient](src/net/httpClient.ts:1)
- 流式/非流式插入：[src/edit/insert.applyInsertions()](src/edit/insert.ts:1)，[src/edit/insert.StreamInserter](src/edit/insert.ts:1)
- 状态栏吞吐与可取消进度：[src/ui/status.StatusBarController](src/ui/status.ts:1)，[src/ui/progress.withCancellableProgress()](src/ui/progress.ts:1)
- SecretStorage 与环境变量 Key 管理：[src/config/index.getEffectiveConfig()](src/config/index.ts:1)
- 单元测试（mocha + chai + ts-node）：[test/backoff.test.ts](test/backoff.test.ts:1)，[test/rateLimiter.test.ts](test/rateLimiter.test.ts:1)，[test/template.test.ts](test/template.test.ts:1)
