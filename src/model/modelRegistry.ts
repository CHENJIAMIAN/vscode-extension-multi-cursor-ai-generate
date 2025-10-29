import * as vscode from 'vscode';
import type { HttpClient } from '../net/httpClient';
import { getEffectiveConfig } from '../config';
import type { Logger } from '../log/logger';

export interface ModelRegistryDeps {
  httpClient: HttpClient;
  logger: Logger;
}

/**
 * 同步模型列表：从 {baseUrl}{modelsPath} 拉取并更新配置 multiCursorAI.modelList（全局）
 * 返回模型数组
 */
export async function syncModels(deps: ModelRegistryDeps, signal?: AbortSignal): Promise<string[]> {
  const cfg = getEffectiveConfig();
  const { httpClient, logger } = deps;
  try {
    const models = await httpClient.getModels(signal);
    if (!models || models.length === 0) {
      vscode.window.showWarningMessage('模型同步完成，但未获取到任何模型。');
      return [];
    }
    const sorted = [...new Set(models)].sort();
    await vscode.workspace
      .getConfiguration('multiCursorAI')
      .update('modelList', sorted, vscode.ConfigurationTarget.Global);
    logger.info(`模型同步成功，共 ${sorted.length} 个。`);
    return sorted;
  } catch (err: any) {
    logger.error('模型同步失败', err);
    const msg = err?.message || String(err);
    vscode.window.showErrorMessage(`模型同步失败：${msg}`);
    throw err;
  }
}

/** QuickPick 展示模型（供命令或 UI 使用） */
export async function pickModel(models?: string[]): Promise<string | undefined> {
  const list = models && models.length > 0 ? models : getEffectiveConfig().modelList;
  if (!list || list.length === 0) {
    vscode.window.showInformationMessage('未配置可选模型，请先执行 “Multi Cursor AI: Sync Models”。');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(list, {
    placeHolder: '选择模型',
    canPickMany: false,
    ignoreFocusOut: true,
  });
  return picked ?? undefined;
}