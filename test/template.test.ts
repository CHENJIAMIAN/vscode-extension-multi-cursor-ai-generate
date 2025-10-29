import { expect } from 'chai';
import { render, collectContextVars, __test__ } from '../src/prompt/template';

describe('template.render()', () => {
  it('应替换 {userPrompt} 与 {selection} 占位符并生成 messages 与 promptText', () => {
    const out = render({
      template: '用户意图:{userPrompt}\n文本:\n{selection}\n文件:{fileName}\n语言:{languageId}\n路径:{relativePath}\n时间:{now}',
      userPrompt: '重构为函数',
      selection: 'const x = 1;',
      systemPromptEnabled: false,
      globalPrependInstruction: '',
      context: {
        fileName: 'a.ts',
        languageId: 'typescript',
        relativePath: 'src/a.ts',
        now: '2020-01-01T00:00:00.000Z',
      },
      trimSelection: true,
      maxSelectionChars: 1000,
    });

    expect(out.messages).to.have.length(1);
    expect(out.messages[0].role).to.equal('user');
    const body = out.messages[0].content;
    expect(body).to.include('重构为函数');
    expect(body).to.include('const x = 1;');
    expect(body).to.include('a.ts');
    expect(out.promptText).to.be.a('string').and.to.have.length.greaterThan(0);
  });

  it('systemPromptEnabled=true 时应将全局指令作为 system 消息', () => {
    const out = render({
      template: '用户意图:{userPrompt}\n{selection}',
      userPrompt: '整理注释',
      selection: '/* a */',
      systemPromptEnabled: true,
      globalPrependInstruction: '你是代码风格助手',
      context: {},
      trimSelection: true,
    });

    expect(out.messages).to.have.length(2);
    expect(out.messages[0].role).to.equal('system');
    expect(out.messages[0].content).to.include('代码风格助手');
    expect(out.messages[1].role).to.equal('user');
  });

  it('应当去除 selection 首尾空行并支持截断', () => {
    const selection = '\n\n line1 \n line2 \n\n';
    const out = render({
      template: 'S:{selection}',
      userPrompt: 'noop',
      selection,
      systemPromptEnabled: false,
      globalPrependInstruction: '',
      context: {},
      trimSelection: true,
      maxSelectionChars: 5,
    });
    expect(out.messages[0].content).to.match(/S:/);
    // 由于 maxSelectionChars 截断为 5 字符
    // 先 trimBlankLines => "line1 \n line2" 然后 limit => "line1"
    expect(out.messages[0].content).to.include('line1');
  });

  it('globalPrependInstruction 在非 system 模式下应拼到用户内容前部', () => {
    const out = render({
      template: 'User:{userPrompt}\nSel:{selection}',
      userPrompt: 'A',
      selection: 'B',
      systemPromptEnabled: false,
      globalPrependInstruction: 'GLOBAL',
      context: {},
      trimSelection: false,
    });
    expect(out.messages[0].content.startsWith('GLOBAL')).to.equal(true);
  });
});

describe('template.collectContextVars()', () => {
  it('在缺少文档时仅返回 now', () => {
    const v = collectContextVars(undefined);
    expect(v.now).to.be.a('string');
  });

  it('应当从 doc 中推断 fileName/languageId/relativePath', () => {
    const v = collectContextVars({
      fileName: 'C:\\project\\src\\file.ts',
      languageId: 'typescript',
      uri: { toString: () => 'file:///C:/project/src/file.ts', path: '/C:/project/src/file.ts' },
    });
    expect(v.fileName).to.equal('file.ts');
    expect(v.languageId).to.equal('typescript');
    expect(v.relativePath).to.be.a('string');
  });
});

describe('template internals', () => {
  it('trimBlankLines 应移除首尾空行', () => {
    const s = __test__.trimBlankLines('\n\nA\nB\n\n');
    expect(s).to.equal('A\nB');
  });

  it('limitLength 应按上限截断', () => {
    expect(__test__.limitLength('abcdef', 3)).to.equal('abc');
  });

  it('joinMessagesAsPrompt 应串联角色与内容', () => {
    const p = __test__.joinMessagesAsPrompt([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
    expect(p).to.include('[system]');
    expect(p).to.include('[user]');
  });
});