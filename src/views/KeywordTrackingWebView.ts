import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { ReportService } from '../services/ReportService';

export class KeywordTrackingWebView {
  public static readonly viewType = 'gitArchaeologist.keywordTracking';

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private stateService: StateService,
    private reportService: ReportService,
    private workspaceRoot: string
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getInitialHtml();

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        webviewView.webview.postMessage({ command: 'init' });
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'searchKeyword':
          await this.performSearch(msg.keyword, msg.filePath, webviewView);
          break;
        case 'openCommit':
          await vscode.commands.executeCommand('gitArchaeologist.openCommit', msg.commitHash);
          break;
        case 'goToFile':
          await this.goToFile(msg.filePath, msg.line);
          break;
        case 'showFileHistory':
          await vscode.commands.executeCommand('gitArchaeologist.showFileHistory', msg.filePath);
          break;
      }
    });
  }

  private async performSearch(keyword: string, filePath: string | undefined, webviewView: vscode.WebviewView): Promise<void> {
    try {
      if (!keyword.trim()) {
        webviewView.webview.html = this.getResultsHtml(keyword, filePath || '', [], []);
        return;
      }

      webviewView.webview.postMessage({ command: 'showLoading' });

      const [commits, occurrences] = await Promise.all([
        this.gitService.searchCommitsByKeyword(keyword, filePath || undefined),
        this.gitService.searchInHistory(keyword, filePath || undefined)
      ]);

      webviewView.webview.html = this.getResultsHtml(keyword, filePath || '', commits, occurrences);
    } catch (err) {
      webviewView.webview.postMessage({
        command: 'showError',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async goToFile(filePath: string, line?: number): Promise<void> {
    try {
      const fullPath = require('path').join(this.workspaceRoot, filePath);
      const doc = await vscode.workspace.openTextDocument(fullPath);
      const editor = await vscode.window.showTextDocument(doc);
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      vscode.window.showWarningMessage(`无法打开文件: ${filePath}`);
    }
  }

  private getInitialHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    padding: 16px;
    font-size: 13px;
    color: var(--vscode-editor-foreground, #333);
    background: var(--vscode-editor-background, #fff);
    line-height: 1.5;
  }
  h1 { font-size: 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .search-box {
    background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
    border: 1px solid var(--vscode-panel-border, #ddd);
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 16px;
  }
  .form-group { margin-bottom: 10px; }
  .form-group label {
    display: block; font-size: 11px; margin-bottom: 4px;
    color: var(--vscode-descriptionForeground, #888); text-transform: uppercase;
  }
  .form-group input {
    width: 100%; padding: 6px 10px; font-size: 13px;
    border: 1px solid var(--vscode-panel-border, #ccc); border-radius: 4px;
    background: var(--vscode-input-background, #fff);
    color: var(--vscode-input-foreground, #333);
  }
  .search-btn {
    padding: 6px 16px; font-size: 13px; cursor: pointer;
    background: var(--vscode-button-background, #0078d4); color: white;
    border: none; border-radius: 4px;
  }
  .tip-box {
    padding: 10px 14px;
    background: var(--vscode-textBlockQuote-background, #f8f8f8);
    border-left: 3px solid var(--vscode-textLink-activeForeground, #0078d4);
    border-radius: 0 4px 4px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #666);
  }
  .tip-box ul { margin-left: 18px; margin-top: 6px; }
  .tip-box li { margin: 3px 0; }
  .loading, .error-box { padding: 20px; text-align: center; display: none; }
  .loading.show, .error-box.show { display: block; }
  .loading { color: #888; }
  .spinner { font-size: 28px; animation: spin 1s linear infinite; display: inline-block; margin-bottom: 10px; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .error-box { color: #f44; }
</style>
</head>
<body>
  <h1>🔎 关键词追踪</h1>

  <div class="search-box">
    <div class="form-group">
      <label>搜索关键词 *</label>
      <input type="text" id="keyword" placeholder="输入要追踪的关键词 (如: TODO, legacy, bugfix)" />
    </div>
    <div class="form-group">
      <label>限定文件路径 (可选)</label>
      <input type="text" id="filePath" placeholder="留空则搜索所有文件，如: src/ / *.ts" />
    </div>
    <button class="search-btn" onclick="doSearch()">🔍 开始追踪</button>
  </div>

  <div class="tip-box">
    💡 <strong>使用技巧</strong>
    <ul>
      <li>查找遗留代码: <code>TODO</code>, <code>FIXME</code>, <code>HACK</code>, <code>LEGACY</code></li>
      <li>查找关键变更: <code>deprecated</code>, <code>breaking change</code>, <code>security</code></li>
      <li>查找特定功能实现: 函数名、类名、接口名</li>
      <li>追踪配置变更: 特定配置键名、环境变量名</li>
    </ul>
  </div>

  <div class="loading" id="loading">
    <div class="spinner">⏳</div>
    <div>正在历史记录中搜索关键词...</div>
  </div>

  <div class="error-box" id="error">
    <div style="font-size:36px">❌</div>
    <div id="errorMsg"></div>
    <button style="margin-top:10px;padding:6px 12px" onclick="hideError()">关闭</button>
  </div>

  <div id="resultsArea"></div>

<script>
  const vs = acquireVsCodeApi();
  document.getElementById('keyword').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });
  function doSearch() {
    const kw = document.getElementById('keyword').value.trim();
    const fp = document.getElementById('filePath').value.trim() || undefined;
    if (!kw) {
      alert('请输入要搜索的关键词');
      return;
    }
    document.getElementById('loading').classList.add('show');
    document.getElementById('resultsArea').innerHTML = '';
    vs.postMessage({ command: 'searchKeyword', keyword: kw, filePath: fp });
  }
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'showLoading') {
      document.getElementById('loading').classList.add('show');
    }
    if (msg.command === 'showError') {
      document.getElementById('loading').classList.remove('show');
      document.getElementById('errorMsg').textContent = msg.message;
      document.getElementById('error').classList.add('show');
    }
  });
  function hideError() { document.getElementById('error').classList.remove('show'); }
  function openCommit(h) { vs.postMessage({ command: 'openCommit', commitHash: h }); }
  function goToFile(p, l) { vs.postMessage({ command: 'goToFile', filePath: p, line: l }); }
  function showHistory(p) { vs.postMessage({ command: 'showFileHistory', filePath: p }); }
</script>
</body>
</html>`;
  }

  private getResultsHtml(keyword: string, filePath: string, commits: any[], occurrences: any[]): string {
    const fileOccurrences = new Map<string, number>();
    for (const o of occurrences) {
      fileOccurrences.set(o.filePath, (fileOccurrences.get(o.filePath) || 0) + 1);
    }
    const topFiles = Array.from(fileOccurrences.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const authorOccurrences = new Map<string, number>();
    const commitMap = new Map(commits.map(c => [c.hash, c]));
    for (const o of occurrences) {
      const c = commitMap.get(o.commitHash);
      if (c) {
        authorOccurrences.set(c.authorName, (authorOccurrences.get(c.authorName) || 0) + 1);
      }
    }
    const topAuthors = Array.from(authorOccurrences.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const kwRegex = new RegExp(`(${this.escapeRegex(keyword)})`, 'gi');

    return this.getInitialHtml().replace(
      '</body>',
      `<div style="margin-top:16px">
        <h2 style="font-size:14px;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid var(--vscode-panel-border,#ddd)">
          📊 追踪结果: <span style="color:var(--vscode-textLink-activeForeground,#0078d4)">${this.escapeHtml(keyword)}</span>
        </h2>

        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:16px">
          <div style="padding:12px;text-align:center;background:var(--vscode-editor-inactiveSelectionBackground,#f5f5f5);border-radius:6px;border:1px solid var(--vscode-panel-border,#ddd)">
            <div style="font-size:24px;font-weight:700;color:var(--vscode-textLink-activeForeground,#0078d4)">${commits.length}</div>
            <div style="font-size:10px;text-transform:uppercase;color:#888;margin-top:4px">涉及提交</div>
          </div>
          <div style="padding:12px;text-align:center;background:var(--vscode-editor-inactiveSelectionBackground,#f5f5f5);border-radius:6px;border:1px solid var(--vscode-panel-border,#ddd)">
            <div style="font-size:24px;font-weight:700;color:#2ea043">${occurrences.length}</div>
            <div style="font-size:10px;text-transform:uppercase;color:#888;margin-top:4px">出现次数</div>
          </div>
          <div style="padding:12px;text-align:center;background:var(--vscode-editor-inactiveSelectionBackground,#f5f5f5);border-radius:6px;border:1px solid var(--vscode-panel-border,#ddd)">
            <div style="font-size:24px;font-weight:700;color:#8957e5">${fileOccurrences.size}</div>
            <div style="font-size:10px;text-transform:uppercase;color:#888;margin-top:4px">涉及文件</div>
          </div>
          <div style="padding:12px;text-align:center;background:var(--vscode-editor-inactiveSelectionBackground,#f5f5f5);border-radius:6px;border:1px solid var(--vscode-panel-border,#ddd)">
            <div style="font-size:24px;font-weight:700;color:#da3633">${authorOccurrences.size}</div>
            <div style="font-size:10px;text-transform:uppercase;color:#888;margin-top:4px">涉及作者</div>
          </div>
        </div>

        ${topFiles.length > 0 ? `
          <div style="margin-bottom:16px;padding:14px;background:var(--vscode-editor-inactiveSelectionBackground,#f5f5f5);border-radius:6px;border:1px solid var(--vscode-panel-border,#ddd)">
            <h3 style="font-size:12px;color:#666;margin-bottom:8px">📁 涉及文件 TOP 10</h3>
            ${topFiles.map(([f, c]) => {
              const pct = (c / occurrences.length * 100).toFixed(0);
              return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
                <div style="flex:1;min-width:0">
                  <div style="font-family:monospace;font-size:11px;cursor:pointer;color:var(--vscode-textLink-activeForeground,#0078d4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="showHistory('${this.escapeJs(f)}')" title="${this.escapeHtml(f)}">${this.escapeHtml(f)}</div>
                  <div style="height:6px;background:#eee;border-radius:3px;margin-top:2px"><div style="height:100%;width:${pct}%;background:var(--vscode-textLink-activeForeground,#0078d4);border-radius:3px"></div></div>
                </div>
                <div style="font-weight:600;font-size:12px;width:40px;text-align:right">${c}</div>
              </div>`;
            }).join('')}
          </div>
        ` : ''}

        ${topAuthors.length > 0 ? `
          <div style="margin-bottom:16px;padding:14px;background:var(--vscode-editor-inactiveSelectionBackground,#f5f5f5);border-radius:6px;border:1px solid var(--vscode-panel-border,#ddd)">
            <h3 style="font-size:12px;color:#666;margin-bottom:8px">👥 涉及作者</h3>
            ${topAuthors.map(([a, c]) => {
              const max = Math.max(...topAuthors.map(x => x[1]));
              const pct = (c / max * 100).toFixed(0);
              return `<div style="display:flex;align-items:center;gap:10px;margin:4px 0">
                <div style="width:100px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeHtml(a)}</div>
                <div style="flex:1;height:14px;background:#eee;border-radius:3px"><div style="height:100%;width:${pct}%;background:#8957e5;border-radius:3px"></div></div>
                <div style="font-weight:600;font-size:12px;width:40px;text-align:right">${c}</div>
              </div>`;
            }).join('')}
          </div>
        ` : ''}

        ${commits.length > 0 ? `
          <h3 style="font-size:13px;margin:16px 0 10px">📜 相关提交 (${commits.length})</h3>
          <div style="max-height:300px;overflow-y:auto;border:1px solid var(--vscode-panel-border,#ddd);border-radius:6px">
            ${commits.slice(0, 100).map(c => `
              <div style="padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border,#eee);cursor:pointer" onclick="openCommit('${c.hash}')"
                onmouseover="this.style.background='var(--vscode-list-hoverBackground,#f0f7ff)'"
                onmouseout="this.style.background=''">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
                  <span style="font-family:monospace;font-size:11px;color:var(--vscode-textLink-activeForeground,#0078d4);font-weight:600">${c.shortHash}</span>
                  <span style="font-size:11px;color:#888">${this.formatShortDate(c.date)}</span>
                  <span style="font-size:11px">👤 ${this.escapeHtml(c.authorName)}</span>
                </div>
                <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeHtml(c.message).replace(kwRegex, '<mark style="background:#fff4a3;padding:0 2px;border-radius:2px">$1</mark>')}</div>
              </div>
            `).join('')}
          </div>
          ${commits.length > 100 ? `<p style="text-align:center;color:#888;font-size:11px;margin-top:8px">仅显示前 100 条提交，共 ${commits.length} 条</p>` : ''}
        ` : ''}

        ${occurrences.length > 0 ? `
          <h3 style="font-size:13px;margin:20px 0 10px">🔍 代码中出现位置 (${occurrences.length})</h3>
          <div style="max-height:400px;overflow-y:auto;border:1px solid var(--vscode-panel-border,#ddd);border-radius:6px">
            ${occurrences.slice(0, 200).map(o => {
              const commit = commitMap.get(o.commitHash);
              return `<div style="padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border,#eee)">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                  <span style="font-family:monospace;font-size:11px;background:var(--vscode-textBlockQuote-background,#f5f5f5);padding:1px 6px;border-radius:3px;cursor:pointer;color:var(--vscode-textLink-activeForeground,#0078d4)" onclick="openCommit('${o.commitHash}')">${commit?.shortHash || o.commitHash.substring(0,7)}</span>
                  <span style="font-family:monospace;font-size:11px;cursor:pointer;color:var(--vscode-textLink-activeForeground,#0078d4)" onclick="goToFile('${this.escapeJs(o.filePath)}', ${o.line})">${this.escapeHtml(o.filePath)}:${o.line}</span>
                  <span style="font-size:10px;color:#888">${commit ? `${this.escapeHtml(commit.authorName)} · ${this.formatShortDate(commit.date)}` : ''}</span>
                </div>
                <div style="font-family:Consolas,monospace;font-size:11px;background:var(--vscode-editor-inactiveSelectionBackground,#f8f8f8);padding:4px 8px;border-radius:3px;overflow-x:auto">
                  <span style="color:#999;margin-right:8px">${o.line}</span>${this.escapeHtml(o.content).replace(kwRegex, '<mark style="background:#fff4a3;padding:0 2px;border-radius:2px">$1</mark>')}
                </div>
              </div>`;
            }).join('')}
          </div>
          ${occurrences.length > 200 ? `<p style="text-align:center;color:#888;font-size:11px;margin-top:8px">仅显示前 200 处出现位置，共 ${occurrences.length} 处</p>` : ''}
        ` : ''}

        ${commits.length === 0 && occurrences.length === 0 ? `
          <div style="padding:40px;text-align:center;color:#888">
            <div style="font-size:48px;margin-bottom:10px">🔍</div>
            <p>未找到包含 "${this.escapeHtml(keyword)}" 的提交或代码。</p>
            <p style="font-size:12px;margin-top:6px">试试其他关键词？</p>
          </div>
        ` : ''}
      </div>
    </body>`
    );
  }

  private escapeHtml(str: string): string {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private escapeJs(str: string): string {
    return str.replace(/'/g, "\\'").replace(/\n/g, '\\n');
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private formatShortDate(dateStr: string): string {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    } catch {
      return dateStr.substring(5, 10);
    }
  }
}
