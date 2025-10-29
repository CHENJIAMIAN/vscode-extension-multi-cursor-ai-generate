import * as vscode from 'vscode';
import { mergeConfig, type ConfigSchema } from './schema';

/**
 * 从 VS Code 配置读取 multiCursorAI.*，并与默认值合并，返回强类型配置
 */
export function getEffectiveConfig(): ConfigSchema {
  const s = vscode.workspace.getConfiguration('multiCursorAI');

  const partial = {
    // API
    baseUrl: s.get<string>('baseUrl'),
    apiKeySecretId: s.get<string>('apiKeySecretId'),
    apiKeyEnvVar: s.get<string>('apiKeyEnvVar'),
    authScheme: s.get<string>('authScheme'),
    modelDefault: s.get<string>('modelDefault'),
    modelList: s.get<string[]>('modelList'),
    modelsPath: s.get<string>('modelsPath'),
    requestPath: s.get<string>('requestPath'),
    useStreaming: s.get<boolean>('useStreaming'),
    timeoutMs: s.get<number>('timeoutMs'),
    proxy: s.get<string>('proxy'),
    rejectUnauthorized: s.get<boolean>('rejectUnauthorized'),

    // 请求参数
    temperature: s.get<number>('temperature'),
    maxTokens: s.get<number>('maxTokens'),
    requestBodyMode: s.get<'auto' | 'chat' | 'completions'>('requestBodyMode'),

    // 流控
    maxConcurrency: s.get<number>('maxConcurrency'),
    httpMaxConnections: s.get<number>('httpMaxConnections'),
    maxRequestsPerMinute: s.get<number>('maxRequestsPerMinute'),
    dynamicLimitProbe: s.get<boolean>('dynamicLimitProbe'),
    maxRetries: s.get<number>('maxRetries'),
    baseBackoffMs: s.get<number>('baseBackoffMs'),
    maxBackoffMs: s.get<number>('maxBackoffMs'),

    // 文本插入
    insertMode: s.get<'append' | 'replace'>('insertMode'),
    preSeparator: s.get<string>('preSeparator'),
    postSeparator: s.get<string>('postSeparator'),
    trimResult: s.get<boolean>('trimResult'),

    // 提示模板
    promptTemplate: s.get<string>('promptTemplate'),
    systemPromptEnabled: s.get<boolean>('systemPromptEnabled'),
    globalPrependInstruction: s.get<string>('globalPrependInstruction'),
    contextVars: {
      includeFileName: s.get<boolean>('contextVars.includeFileName'),
      includeLanguageId: s.get<boolean>('contextVars.includeLanguageId'),
      includeRelativePath: s.get<boolean>('contextVars.includeRelativePath'),
      includeNow: s.get<boolean>('contextVars.includeNow'),
    },

    // 历史/UI
    promptHistoryLimit: s.get<number>('promptHistoryLimit'),

    // 日志
    logLevel: s.get<'error' | 'warn' | 'info' | 'debug' | 'trace'>('logLevel'),
  };

  return mergeConfig(partial as Partial<ConfigSchema>);
}

/**
 * 读取 SecretStorage 中的 API Key
 */
export async function getSecret(storage: vscode.SecretStorage, cfg: ConfigSchema): Promise<string | undefined> {
  const val = await storage.get(cfg.apiKeySecretId);
  if (val && val.trim()) {
    return val.trim();
  }
  return undefined;
}

/**
 * 保存 API Key 至 SecretStorage
 */
export async function setSecret(storage: vscode.SecretStorage, cfg: ConfigSchema, apiKey: string): Promise<void> {
  await storage.store(cfg.apiKeySecretId, apiKey);
}

/**
 * 监听指定配置段的变化
 */
export function onDidChangeConfigurationSection(section: string, handler: () => void): vscode.Disposable {
  const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(section)) {
      handler();
    }
  });
  return disposable;
}