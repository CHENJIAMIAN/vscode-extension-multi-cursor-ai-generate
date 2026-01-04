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
 * - 使用全局锚点追踪器，确保多个并发任务的锚点位置能随文档变化而更新。
 */
export class StreamInserter {
  private static queues = new Map<string, Promise<void>>();

  // 全局锚点追踪器：跟踪同一文档上所有活跃的 StreamInserter
  // 当一个 inserter 完成插入后，其他处于更后位置的 inserter 需要更新其锚点偏移
  private static anchorTrackers = new Map<string, Set<StreamInserter>>();

  private readonly editor: vscode.TextEditor;
  private readonly doc: vscode.TextDocument;
  private readonly mode: InsertMode;
  private readonly preSeparator: string;
  private readonly postSeparator: string;
  private readonly trimResult: boolean;

  private anchor: vscode.Position;
  private initialAnchor: vscode.Position; // 初始锚点位置（用于恢复）
  private originalRange: vscode.Range | undefined; // replace 模式下的原始范围
  private inserted = false; // 是否已经插入过（用于首次插入 preSeparator）
  private disposed = false;
  private totalInsertedLength = 0; // 跟踪已插入的总字符数

  // 用于标识此 inserter 的原始起始位置（用于和其他 inserter 比较）
  private originalStartLine: number;
  private originalStartChar: number;

  constructor(spec: SelectionTaskSpec) {
    this.editor = spec.editor;
    this.doc = spec.editor.document;
    this.mode = spec.mode;
    this.preSeparator = spec.preSeparator ?? '';
    this.postSeparator = spec.postSeparator ?? '';
    this.trimResult = !!spec.trimResult;
    this.originalRange = spec.range;

    // 计算锚点：append 用 range.end；replace 用 range.start 并清空原范围
    if (this.mode === 'replace') {
      this.anchor = spec.range.start;
    } else {
      this.anchor = spec.range.end;
    }
    this.initialAnchor = this.anchor;

    // 记录原始起始位置（用于锚点偏移调整）
    this.originalStartLine = this.anchor.line;
    this.originalStartChar = this.anchor.character;

    // 注册到全局锚点追踪器
    const key = this.doc.uri.toString();
    if (!StreamInserter.anchorTrackers.has(key)) {
      StreamInserter.anchorTrackers.set(key, new Set());
    }
    StreamInserter.anchorTrackers.get(key)!.add(this);
  }

  /**
   * 当其他 inserter 插入文本后，调整此 inserter 的锚点位置
   * @param sourceOriginalLine 触发源的原始起始行
   * @param sourceOriginalChar 触发源的原始起始列
   * @param insertedLines 插入的行数增量（多行时 > 0）
   */
  public adjustAnchorOffset(sourceOriginalLine: number, sourceOriginalChar: number, insertedLines: number): void {
    if (this.disposed) return;

    // 只有当本 inserter 逻辑上位于触发源之后时，才需要调整
    // (即：原始位置在触发源的原始位置之后)
    const isAfter = (this.originalStartLine > sourceOriginalLine) ||
      (this.originalStartLine === sourceOriginalLine && this.originalStartChar > sourceOriginalChar);

    if (isAfter) {
      // 插入位置在本 inserter 之前的行，需要偏移行号
      this.anchor = new vscode.Position(
        this.anchor.line + insertedLines,
        this.anchor.character
      );
      this.initialAnchor = new vscode.Position(
        this.initialAnchor.line + insertedLines,
        this.initialAnchor.character
      );
      // 同时也要更新 originalRange，否则后续的 replace (在 start 中执行) 会删除错误的位置
      if (this.originalRange) {
        this.originalRange = new vscode.Range(
          this.originalRange.start.translate(insertedLines, 0),
          this.originalRange.end.translate(insertedLines, 0)
        );
      }
    }
  }

  /**
   * 启动：在 replace 模式下先清空原范围；如有 preSeparator 则先插入
   */
  public async start(): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(async () => {
      // 使用最新的 originalRange（可能已被其他并发任务推移）
      if (this.mode === 'replace' && this.originalRange) {
        // 计算要删除的行数，用于调整其他 inserter 的锚点
        const rangeToDelete = this.originalRange;
        const deletedLines = rangeToDelete.end.line - rangeToDelete.start.line;

        await this.editor.edit((eb: vscode.TextEditorEdit) => eb.delete(rangeToDelete), { undoStopBefore: false, undoStopAfter: false });

        // 通知其他 inserter 减少锚点偏移（被删除的行数）
        if (deletedLines > 0) {
          this.notifyOtherInsertersForDelete(deletedLines);
        }
      }
      if (this.preSeparator) {
        await this.editor.edit((eb: vscode.TextEditorEdit) => eb.insert(this.anchor, this.preSeparator), {
          undoStopBefore: false,
          undoStopAfter: false,
        });
        // 更新锚点偏移并跟踪插入长度
        this.updateAnchor(this.preSeparator);
        this.totalInsertedLength += this.preSeparator.length;
        this.inserted = true;
      }
    });
  }

  /**
   * 通知其他 inserter 减少锚点偏移（用于删除操作）
   */
  /**
   * 通知其他 inserter 减少锚点偏移（用于删除操作）
   */
  private notifyOtherInsertersForDelete(deletedLines: number): void {
    const key = this.doc.uri.toString();
    const trackers = StreamInserter.anchorTrackers.get(key);
    if (!trackers) return;

    for (const other of trackers) {
      if (other !== this && !other.disposed) {
        // 传递 sourceOriginalLine/Char 让 other 判断是否在自己之后
        // 但注意：对于 delete，操作的是 "originalRange"，其逻辑位置即 this.originalStartLine
        // 实际上 notifyOtherInserters 逻辑通用，只是方向相反 (deletedLines 是正数，但在 adjust 中我们需要处理负偏移? 
        // 或者简单复用 adjustAnchorOffset 传负数？)
        // 为了清晰，这里手动处理，逻辑应该与 adjust 类似：只有逻辑在此之后的才受影响。

        const isAfter = (other.originalStartLine > this.originalStartLine) ||
          (other.originalStartLine === this.originalStartLine && other.originalStartChar > this.originalStartChar);

        if (isAfter) {
          const shift = -deletedLines;
          other.anchor = new vscode.Position(
            Math.max(0, other.anchor.line + shift),
            other.anchor.character
          );
          other.initialAnchor = new vscode.Position(
            Math.max(0, other.initialAnchor.line + shift),
            other.initialAnchor.character
          );
          if (other.originalRange) {
            other.originalRange = new vscode.Range(
              other.originalRange.start.translate(shift, 0),
              other.originalRange.end.translate(shift, 0)
            );
          }
        }
      }
    }
  }

  public async appendDelta(delta: string): Promise<void> {
    if (this.disposed) return;
    if (!delta) return;
    const text = this.trimResult ? delta : delta; // 流式不做 trim，避免破坏格式；最终 finish 时不额外处理
    await this.enqueue(async () => {
      await this.editor.edit((eb: vscode.TextEditorEdit) => eb.insert(this.anchor, text), { undoStopBefore: false, undoStopAfter: false });
      this.updateAnchor(text);
      this.totalInsertedLength += text.length;
      this.inserted = true;
    });
  }

  private updateAnchor(text: string) {
    const lines = text.split(/\r\n|\r|\n/);
    const insertedAtLine = this.anchor.line;
    const insertedLines = lines.length - 1; // 插入的新行数

    if (lines.length === 1) {
      this.anchor = this.anchor.translate(0, text.length);
    } else {
      // 多行：line 增加，char 重置为最后一行长度
      // 注意：vscode 编辑器中插入后，下一行其实是从 0 开始计数的（如果不仅是单纯移动而是插入）
      // 当我们在某点插入多行文本，该点之后的内容会被推到后面。
      // 新的锚点应该位于插入文本的末尾。
      const endLine = this.anchor.line + lines.length - 1;
      const endChar = lines[lines.length - 1].length;
      this.anchor = new vscode.Position(endLine, endChar);
    }

    // 通知其他 inserter 更新锚点偏移（仅当插入了多行时）
    if (insertedLines > 0) {
      this.notifyOtherInserters(insertedLines);
    }
  }

  /**
   * 通知同一文档上的其他 inserter 调整锚点
   */
  private notifyOtherInserters(insertedLines: number): void {
    const key = this.doc.uri.toString();
    const trackers = StreamInserter.anchorTrackers.get(key);
    if (!trackers) return;

    for (const other of trackers) {
      if (other !== this && !other.disposed) {
        other.adjustAnchorOffset(this.originalStartLine, this.originalStartChar, insertedLines);
      }
    }
  }

  public async finish(): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(async () => {
      if (this.postSeparator && this.inserted) {
        await this.editor.edit((eb: vscode.TextEditorEdit) => eb.insert(this.anchor, this.postSeparator), {
          undoStopBefore: false,
          undoStopAfter: false,
        });
        this.updateAnchor(this.postSeparator);
      }
    });
  }

  public dispose() {
    this.disposed = true;

    // 从全局锚点追踪器中移除
    const key = this.doc.uri.toString();
    const trackers = StreamInserter.anchorTrackers.get(key);
    if (trackers) {
      trackers.delete(this);
      // 如果该文档的追踪器已空，清理 Map 条目
      if (trackers.size === 0) {
        StreamInserter.anchorTrackers.delete(key);
      }
    }
  }

  /**
   * 恢复原始内容：当 AI 返回空内容时，删除已插入的所有内容并恢复原始文本
   */
  public async restoreOriginal(originalText: string): Promise<void> {
    await this.enqueue(async () => {
      // 计算需要删除的范围：从初始锚点到当前锚点
      const deleteRange = new vscode.Range(this.initialAnchor, this.anchor);

      await this.editor.edit((eb: vscode.TextEditorEdit) => {
        // 删除已插入的所有内容（包括 preSeparator 和任何流式内容）
        if (this.totalInsertedLength > 0) {
          eb.delete(deleteRange);
        }
        // 在初始锚点位置插入原始文本
        eb.insert(this.initialAnchor, originalText);
      }, { undoStopBefore: false, undoStopAfter: true });
    });
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