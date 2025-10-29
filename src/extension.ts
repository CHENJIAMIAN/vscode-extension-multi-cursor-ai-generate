import * as vscode from 'vscode';
import { createOutputChannelLogger, Logger } from './log/logger';
import { mergeConfig, type ConfigSchema } from './config/schema';
import { getEffectiveConfig, getSecret, setSecret, onDidChangeConfigurationSection } from './config/index';
import { TokenBucketPool } from './net/rateLimiter';
import type { RateLimiterMetrics, ServerRateLimitHint } from './net/rateLimiter';
import { HttpClient } from './net/httpClient';
import { StatusBarController } from './ui/status';
import { registerGenerateCommand } from './commands/generate';
import { registerSyncModelsCommand } from './commands/syncModels';

// 全局单例容器
let logger: Logger;
let statusBar: StatusBarController;
let rateLimiter: TokenBucketPool;
let httpClient: HttpClient;
let outputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  // OutputChannel 与 Logger
  outputChannel = vscode.window.createOutputChannel('Multi Cursor AI');
  context.subscriptions.push(outputChannel);
  const initialLogLevel = vscode.workspace.getConfiguration('multiCursorAI').get('logLevel', 'info' as const);
  logger = createOutputChannelLogger(initialLogLevel, 'Multi Cursor AI');

  logger.info('扩展激活中...');

  // 加载配置与密钥
  const cfg = await getOrInitConfig(context);
  logger.debug('配置加载完成', cfg);

  // 状态栏
  statusBar = new StatusBarController(() => {
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:your-publisher.multi-cursor-ai-generate');
  });
  statusBar.update({
    concurrency: 0,
    rpm: cfg.maxRequestsPerMinute,
    queued: 0,
  });
  context.subscriptions.push(statusBar);

  // RateLimiter 与 HttpClient
  rateLimiter = new TokenBucketPool({
    maxConcurrency: cfg.maxConcurrency,
    maxPerMinute: cfg.maxRequestsPerMinute,
    dynamicProbe: cfg.dynamicLimitProbe,
    onMetrics: (m: RateLimiterMetrics) => {
      statusBar.update({
        concurrency: m.running,
        rpm: m.currentRpmLimit,
        queued: m.queued,
      });
    },
    onWarn: (msg: string) => logger.warn(msg),
    onInfo: (msg: string) => logger.info(msg),
    onDebug: (msg: string) => logger.debug(msg),
  });

  httpClient = new HttpClient({
    baseUrl: cfg.baseUrl,
    apiKey: await getSecret(context.secrets, cfg) ?? '',
    authScheme: cfg.authScheme,
    timeoutMs: cfg.timeoutMs,
    proxy: cfg.proxy,
    rejectUnauthorized: cfg.rejectUnauthorized,
    requestPath: cfg.requestPath,
    modelsPath: cfg.modelsPath,
    httpMaxConnections: Math.max(1, Math.min(cfg.httpMaxConnections, cfg.maxConcurrency)),
    useStreaming: cfg.useStreaming,
    logger,
    onRateLimitHint: (hint: ServerRateLimitHint) => {
      // 来自响应头的速率提示，回传给限流器动态调整
      rateLimiter.applyServerHint(hint);
    },
  });

  // 命令注册
  context.subscriptions.push(
    registerGenerateCommand({
      context,
      logger,
      httpClient,
      rateLimiter,
      statusBar,
    }),
    registerSyncModelsCommand({
      context,
      logger,
      httpClient,
    }),
  );

  // 配置变更监听
  context.subscriptions.push(
    onDidChangeConfigurationSection('multiCursorAI', async () => {
      try {
        const newCfg = await getOrInitConfig(context);
        logger.info('配置已更新，正在应用新的并发与限流参数...');
        rateLimiter.updateLimits({
          maxConcurrency: newCfg.maxConcurrency,
          maxPerMinute: newCfg.maxRequestsPerMinute,
        });
        httpClient.updateOptions({
          baseUrl: newCfg.baseUrl,
          apiKey: await getSecret(context.secrets, newCfg) ?? '',
          authScheme: newCfg.authScheme,
          timeoutMs: newCfg.timeoutMs,
          proxy: newCfg.proxy,
          rejectUnauthorized: newCfg.rejectUnauthorized,
          requestPath: newCfg.requestPath,
          modelsPath: newCfg.modelsPath,
          httpMaxConnections: Math.max(1, Math.min(newCfg.httpMaxConnections, newCfg.maxConcurrency)),
          useStreaming: newCfg.useStreaming,
        });
        statusBar.update({ rpm: newCfg.maxRequestsPerMinute });
      } catch (e) {
        logger.error('应用配置更新失败', e);
      }
    })
  );

  logger.info('扩展激活完成');
}

export async function deactivate() {
  try {
    await httpClient?.dispose();
  } catch {
    // ignore
  }
}

/**
 * 读取用户配置，应用默认值，并初始化/读取 API Key：
 * - 优先 SecretStorage
 * - 若为空，则尝试从环境变量注入并保存到 SecretStorage
 */
async function getOrInitConfig(context: vscode.ExtensionContext): Promise<ConfigSchema> {
  // 从 workspace 配置整合
  const effective = getEffectiveConfig();
  // 尝试读取 SecretStorage
  let apiKey = await getSecret(context.secrets, effective);

  // 若不存在 Secret，则尝试从环境变量读取并持久化（可选）
  if (!apiKey) {
    const envVar = effective.apiKeyEnvVar;
    const envVal = process.env[envVar];
    if (envVal && envVal.trim()) {
      await setSecret(context.secrets, effective, envVal.trim());
      apiKey = envVal.trim();
      logger.info(`已从环境变量 ${envVar} 读取 API Key 并保存至 SecretStorage。`);
    } else {
      logger.warn('未检测到 API Key。部分功能将不可用，请通过命令面板设置或在设置中配置。');
    }
  }

  // 简单提示 URL/path 合法性
  if (!effective.baseUrl?.startsWith('http')) {
    logger.warn(`baseUrl 看起来不是有效的 URL: ${effective.baseUrl}`);
  }

  return effective;
}