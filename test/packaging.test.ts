import { expect } from 'chai';
import { execFileSync } from 'child_process';
import path from 'path';

function listVsixFiles(): string[] {
  const repoRoot = process.cwd();
  const vsceCli = path.join(repoRoot, 'node_modules', 'vsce', 'vsce');
  const output = execFileSync(process.execPath, [vsceCli, 'ls'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('('));
}

describe('VSIX packaging', () => {
  it('应包含扩展运行时代码与 undici 依赖', function () {
    this.timeout(30000);

    const files = listVsixFiles();

    expect(files).to.include('dist/src/extension.js');
    expect(files).to.include('dist/src/net/httpClient.js');
    expect(files).to.include('node_modules/undici/package.json');
  });
});
