/* 
  配置 Schema 与默认值
  - 与 package.json contributes.configuration 同步
  - 提供类型安全与默认值合并
*/

export type RequestBodyMode = 'auto' | 'chat' | 'completions';
export type InsertMode = 'append' | 'replace';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ContextVarsConfig {
  includeFileName: boolean;
  includeLanguageId: boolean;
  includeRelativePath: boolean;
  includeNow: boolean;
}

export interface ConfigSchema {
  // API
  baseUrl: string;
  apiKeySecretId: string;
  apiKeyEnvVar: string;
  authScheme: string;
  modelDefault: string;
  modelList: string[];
  modelsPath: string;
  requestPath: string;
  useStreaming: boolean;
  timeoutMs: number;
  proxy: string;
  rejectUnauthorized: boolean;

  // 请求参数
  temperature: number;
  maxTokens: number;
  requestBodyMode: RequestBodyMode;

  // 流控
  maxConcurrency: number;
  httpMaxConnections: number;
  maxRequestsPerMinute: number;
  dynamicLimitProbe: boolean;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;

  // 文本插入
  insertMode: InsertMode;
  preSeparator: string;
  postSeparator: string;
  trimResult: boolean;

  // 提示模板
  promptTemplate: string;
  systemPromptEnabled: boolean;
  globalPrependInstruction: string;
  contextVars: ContextVarsConfig;

  // 日志
  logLevel: LogLevel;
}

export const defaultConfig: ConfigSchema = {
  baseUrl: 'https://api.openai.com',
  apiKeySecretId: 'multiCursorAI.apiKey',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  authScheme: 'Bearer',
  modelDefault: 'gpt-4o-mini',
  modelList: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo'],
  modelsPath: '/v1/models',
  requestPath: '/v1/chat/completions',
  useStreaming: false,
  timeoutMs: 60000,
  proxy: '',
  rejectUnauthorized: true,

  temperature: 0.2,
  maxTokens: 1024,
  requestBodyMode: 'auto',

  maxConcurrency: 3,
  httpMaxConnections: 3,
  maxRequestsPerMinute: 60,
  dynamicLimitProbe: true,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 60000,

  insertMode: 'append',
  preSeparator: '',
  postSeparator: '',
  trimResult: true,

  promptTemplate:
    '请根据用户意图对所选文本进行处理。\n用户意图: {userPrompt}\n所选文本: \n\n{selection}',
  systemPromptEnabled: false,
  globalPrependInstruction: '',
  contextVars: {
    includeFileName: true,
    includeLanguageId: true,
    includeRelativePath: true,
    includeNow: true,
  },

  logLevel: 'info',
};

/**
 * 合并用户配置与默认值，并做基础类型校验与边界修正
 */
export function mergeConfig(partial: Partial<ConfigSchema>): ConfigSchema {
  const cfg: ConfigSchema = {
    ...defaultConfig,
    ...(partial ?? {}),
    contextVars: {
      ...defaultConfig.contextVars,
      ...(partial?.contextVars ?? {}),
    },
  };

  // 边界修正
  cfg.maxConcurrency = clampInt(cfg.maxConcurrency, 1, 256, defaultConfig.maxConcurrency);
  cfg.httpMaxConnections = clampInt(
    cfg.httpMaxConnections,
    1,
    256,
    Math.min(cfg.httpMaxConnections, cfg.maxConcurrency)
  );
  cfg.maxRequestsPerMinute = clampInt(cfg.maxRequestsPerMinute, 1, 120000, defaultConfig.maxRequestsPerMinute);
  cfg.maxRetries = clampInt(cfg.maxRetries, 0, 10, defaultConfig.maxRetries);
  cfg.baseBackoffMs = clampInt(cfg.baseBackoffMs, 50, 30000, defaultConfig.baseBackoffMs);
  cfg.maxBackoffMs = clampInt(cfg.maxBackoffMs, cfg.baseBackoffMs, 10 * 60 * 1000, defaultConfig.maxBackoffMs);
  cfg.temperature = clampNum(cfg.temperature, 0, 2, defaultConfig.temperature);
  cfg.maxTokens = clampInt(cfg.maxTokens, 1, 128000, defaultConfig.maxTokens);
  cfg.timeoutMs = clampInt(cfg.timeoutMs, 1000, 10 * 60 * 1000, defaultConfig.timeoutMs);

  // 规范化 URL 路径
  cfg.modelsPath = ensureLeadingSlash(cfg.modelsPath);
  cfg.requestPath = ensureLeadingSlash(cfg.requestPath);

  // 修剪分隔符
  cfg.preSeparator = cfg.preSeparator ?? '';
  cfg.postSeparator = cfg.postSeparator ?? '';

  // 日志等级兜底
  if (!['error', 'warn', 'info', 'debug', 'trace'].includes(cfg.logLevel)) {
    cfg.logLevel = defaultConfig.logLevel;
  }

  // 请求体模式
  if (!['auto', 'chat', 'completions'].includes(cfg.requestBodyMode)) {
    cfg.requestBodyMode = defaultConfig.requestBodyMode;
  }

  // 插入模式
  if (!['append', 'replace'].includes(cfg.insertMode)) {
    cfg.insertMode = defaultConfig.insertMode;
  }

  return cfg;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNum(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function ensureLeadingSlash(path: string): string {
  if (!path) {
    return '/';
  }
  return path.startsWith('/') ? path : `/${path}`;
}