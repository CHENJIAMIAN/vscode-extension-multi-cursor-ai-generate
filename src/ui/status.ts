import * as vscode from 'vscode';

export interface StatusMetrics {
  concurrency?: number;
  rpm?: number;
  queued?: number;
}

export class StatusBarController {
  private item: vscode.StatusBarItem;
  private openSettings?: () => void;

  private concurrency = 0;
  private rpm = 0;
  private queued = 0;

  constructor(onOpenSettings?: () => void) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.openSettings = onOpenSettings;
    this.item.name = 'Multi Cursor AI';
    this.item.command = 'multiCursorAI.openSettingsInternal';
    this.updateText();
    this.item.tooltip = new vscode.MarkdownString('Multi Cursor AI\n\n- 显示并发/限额/队列\n- 点击打开扩展设置');
    this.item.show();

    // 内部命令
    const disposable = vscode.commands.registerCommand('multiCursorAI.openSettingsInternal', () => {
      this.openSettings?.();
    });
    // 由扩展入口收集 subscriptions
    // 这里无法访问 context，只能暴露 dispose 以便外部释放
    // 因此我们将 disposable 存到 item 的 "accessibilityInformation" 里作为弱引用以便统一释放
    (this.item as any).__disposable = disposable;
  }

  public update(m: StatusMetrics) {
    if (typeof m.concurrency === 'number') this.concurrency = m.concurrency;
    if (typeof m.rpm === 'number') this.rpm = m.rpm;
    if (typeof m.queued === 'number') this.queued = m.queued;
    this.updateText();
  }

  private updateText() {
    const parts = [
      `$(symbol-event) AI`,
      `$(run) ${this.concurrency}`,
      `$(clock) ${this.rpm}`,
      `$(repo-pull) ${this.queued}`,
    ];
    this.item.text = parts.join('  ');
  }

  public dispose() {
    try {
      const d: vscode.Disposable | undefined = (this.item as any).__disposable;
      d?.dispose();
    } catch {
      // ignore
    }
    this.item.dispose();
  }
}