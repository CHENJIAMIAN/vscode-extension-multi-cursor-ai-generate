import * as vscode from 'vscode';
import type { Logger } from '../log/logger';
import type { HttpClient } from '../net/httpClient';
import { syncModels as syncRegistry } from '../model/modelRegistry';

interface SyncModelsDeps {
  context: vscode.ExtensionContext;
  logger: Logger;
  httpClient: HttpClient;
}

export function registerSyncModelsCommand(deps: SyncModelsDeps): vscode.Disposable {
  const { logger, httpClient } = deps;

  const cmd = vscode.commands.registerCommand('multiCursorAI.syncModels', async () => {
    const controller = new AbortController();
    const pick = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t('Start Sync'), description: vscode.l10n.t('Fetch model list from remote and update settings') },
        { label: vscode.l10n.t('Cancel'), description: vscode.l10n.t('Do nothing') },
      ],
      { placeHolder: vscode.l10n.t('Model Sync'), ignoreFocusOut: true }
    );
    if (!pick || pick.label !== vscode.l10n.t('Start Sync')) {
      return;
    }

    try {
      const models = await vscode.window.withProgress<string[]>(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Syncing model list…'),
          cancellable: true,
        },
        async (_progress, token) => {
          const onAbort = () => controller.abort();
          token.onCancellationRequested(onAbort);
          try {
            return await syncRegistry({ httpClient, logger }, controller.signal);
          } finally {
            token.onCancellationRequested(onAbort).dispose();
          }
        }
      );

      if (models && models.length > 0) {
        const picked = await vscode.window.showQuickPick(models, {
          title: vscode.l10n.t('Sync successful ({0}) - Select a model as reference', models.length),
          canPickMany: false,
          ignoreFocusOut: true,
        });
        if (picked) {
          await vscode.workspace.getConfiguration('multiCursorAI').update('modelDefault', picked, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(vscode.l10n.t('Default model set to: {0}', picked));
        }
      }
    } catch (err: any) {
      if (err?.message === 'aborted') {
        vscode.window.showInformationMessage(vscode.l10n.t('Model sync cancelled.'));
        return;
      }
      logger.error(vscode.l10n.t('Model sync execution failed'), err);
      vscode.window.showErrorMessage(vscode.l10n.t('Model sync failed: {0}', err?.message || String(err)));
    }
  });

  return cmd;
}