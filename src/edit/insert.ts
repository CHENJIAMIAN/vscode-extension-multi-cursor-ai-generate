import * as vscode from 'vscode';
import type { InsertMode } from '../config/schema';

export interface SelectionTaskSpec {
  editor: vscode.TextEditor;
  range: vscode.Range; // 原始选区（若为空且取整行，应已在外层转换为对应整行 Range）
  mode: InsertMode; // append | replace
  preSeparator: string;
  postSeparator: string;
  trimResult: boolean;
}

export interface InsertionResult {
  range: vscode.Range;
  mode: InsertMode;
  preSeparator: string;
  postSeparator: string;
  trimResult: boolean;
  text: string;
}

/**
 * 非流式：批量应用插入
 * - 为了避免位置偏移，按位置从后往前应用
 * - 同一文档使用一次 workspace.edit 以获得原子性
 */
export async function applyInsertions(results: InsertionResult[]): Promise<boolean> {
  if (results.length === 0) {
    return true;
  }

  // 按文档分组
  const groups = new Map<string, InsertionResult[]>();
  for (const r of results) {
    const doc = getDocFromRange(r.range);
    const key = doc?.uri.toString() ?? 'unknown';
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  // 逐文档处理
  let allOk = true;
  for (const [, arr] of groups) {
    // 按 range.start 逆序（后面的先应用）
    arr.sort((a, b) => {
      const pa = a.range.start;
      const pb = b.range.start;
      if (pa.line !== pb.line) return pb.line - pa.line;
      return pb.character - pa.character;
    });

    const doc = getDocFromRange(arr[0].range);
    if (!doc) {
      allOk = false;
      continue;
    }

    const editor = await findVisibleEditorForDocument(doc);
    const ok = await vscode.workspace.applyEdit(buildWorkspaceEdit(doc, arr, editor));
    allOk = allOk && ok;
  }

  return allOk;
}

function buildWorkspaceEdit(
  doc: vscode.TextDocument,
  arr: InsertionResult[],
  editor?: vscode.TextEditor
): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  for (const r of arr) {
    const targetDoc = getDocFromRange(r.range) ?? doc;
    const text = buildFinalText(r);
    if (r.mode === 'replace') {
      edit.replace(targetDoc.uri, r.range, text);
    } else {
      // append: 在 range.end 处插入
      edit.insert(targetDoc.uri, r.range.end, text);
    }
  }
  return edit;
}

function buildFinalText(r: InsertionResult): string {
  const core = r.trimResult ? (r.text ?? '').trim() : (r.text ?? '');
  return `${r.preSeparator ?? ''}${core}${r.postSeparator ?? ''}`;
}

function getDocFromRange(range: vscode.Range): vscode.TextDocument | undefined {
  // 无直接 API 从 Range 到 Document；需由可见编辑器查找匹配
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document && ed.selections) {
      if (ed.document.uri.scheme === 'file' || ed.document.uri.scheme === 'untitled' || ed.document.uri.scheme) {
        // 简单以 URI 匹配（范围对象自身无法携带文档信息，外层应该保证同一文档）
        return ed.document;
      }
    }
  }
  return vscode.window.activeTextEditor?.document;
}

async function findVisibleEditorForDocument(doc: vscode.TextDocument): Promise<vscode.TextEditor | undefined> {
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.toString() === doc.uri.toString()) {
      return ed;
    }
  }
  // 若不可见，尝试显示
  try {
    const ed = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
    return ed;
  } catch {
    return undefined;
  }
}

/**
 * 流式插入器：将增量文本追加到锚点位置，维护偏移，避免与其他任务冲突。
 * - 对同一文档通过队列串行应用文本变更。
 */
export class StreamInserter {
  private static queues = new Map<string, Promise<void>>();

  private readonly editor: vscode.TextEditor;
  private readonly doc: vscode.TextDocument;
  private readonly mode: InsertMode;
  private readonly preSeparator: string;
  private readonly postSeparator: string;
  private readonly trimResult: boolean;

  private anchor: vscode.Position;
  private inserted = false; // 是否已经插入过（用于首次插入 preSeparator）
  private disposed = false;

  constructor(spec: SelectionTaskSpec) {
    this.editor = spec.editor;
    this.doc = spec.editor.document;
    this.mode = spec.mode;
    this.preSeparator = spec.preSeparator ?? '';
    this.postSeparator = spec.postSeparator ?? '';
    this.trimResult = !!spec.trimResult;

    // 计算锚点：append 用 range.end；replace 用 range.start 并清空原范围
    if (this.mode === 'replace') {
      this.anchor = spec.range.start;
    } else {
      this.anchor = spec.range.end;
    }
  }

  /**
   * 启动：在 replace 模式下先清空原范围；如有 preSeparator 则先插入
   */
  public async start(initialRange?: vscode.Range): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(async () => {
      if (this.mode === 'replace' && initialRange) {
        await this.editor.edit((eb: vscode.TextEditorEdit) => eb.delete(initialRange), { undoStopBefore: false, undoStopAfter: false });
      }
      if (this.preSeparator) {
        await this.editor.edit((eb: vscode.TextEditorEdit) => eb.insert(this.anchor, this.preSeparator), {
          undoStopBefore: false,
          undoStopAfter: false,
        });
        // 更新锚点偏移
        this.anchor = this.anchor.translate(0, this.preSeparator.length); // 简化：按字符位移
        this.inserted = true;
      }
    });
  }

  public async appendDelta(delta: string): Promise<void> {
    if (this.disposed) return;
    if (!delta) return;
    const text = this.trimResult ? delta : delta; // 流式不做 trim，避免破坏格式；最终 finish 时不额外处理
    await this.enqueue(async () => {
      await this.editor.edit((eb: vscode.TextEditorEdit) => eb.insert(this.anchor, text), { undoStopBefore: false, undoStopAfter: false });
      this.anchor = this.anchor.translate(0, text.length);
      this.inserted = true;
    });
  }

  public async finish(): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(async () => {
      if (this.postSeparator && this.inserted) {
        await this.editor.edit((eb: vscode.TextEditorEdit) => eb.insert(this.anchor, this.postSeparator), {
          undoStopBefore: false,
          undoStopAfter: false,
        });
        this.anchor = this.anchor.translate(0, this.postSeparator.length);
      }
    });
  }

  public dispose() {
    this.disposed = true;
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    const key = this.doc.uri.toString();
    const prev = StreamInserter.queues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await task();
      } catch {
        // ignore single task failure
      }
    });
    StreamInserter.queues.set(key, next);
    await next;
  }
}