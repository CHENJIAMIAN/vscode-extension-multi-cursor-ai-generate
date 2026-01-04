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
      vscode.window.showWarningMessage(vscode.l10n.t('Model sync completed, but no models were retrieved.'));
      return [];
    }
    const sorted = [...new Set(models)].sort();
    await vscode.workspace
      .getConfiguration('multiCursorAI')
      .update('modelList', sorted, vscode.ConfigurationTarget.Global);
    logger.info(vscode.l10n.t('Models synced successfully, {0} in total.', sorted.length));
    return sorted;
  } catch (err: any) {
    logger.error(vscode.l10n.t('Model sync failed'), err);
    const msg = err?.message || String(err);
    vscode.window.showErrorMessage(vscode.l10n.t('Model sync failed: {0}', msg));
    throw err;
  }
}

/** QuickPick 展示模型（供命令或 UI 使用） */
export async function pickModel(models?: string[]): Promise<string | undefined> {
  const list = models && models.length > 0 ? models : getEffectiveConfig().modelList;
  if (!list || list.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No models configured, please run "Multi Cursor AI: Sync Models" first.'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(list, {
    placeHolder: vscode.l10n.t('Select Model'),
    canPickMany: false,
    ignoreFocusOut: true,
  });
  return picked ?? undefined;
}