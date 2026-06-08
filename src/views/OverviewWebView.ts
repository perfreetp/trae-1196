import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { ReportService } from '../services/ReportService';

export class OverviewWebView {
  public static readonly viewType = 'gitArchaeologist.overview';

  constructor(
    private context: vscode.ExtensionContext,
    private gitService: GitService,
    private stateService: StateService,
    private reportService: ReportService,
    private workspaceRoot: string
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: []
    };

    webviewView.webview.html = this.getLoadingHtml();

    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        await this.updateView(webviewView);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg, webviewView);
    });

    await this.updateView(webviewView);
  }

  private async handleMessage(msg: any, webviewView: vscode.WebviewView): Promise<void> {
    switch (msg.command) {
      case 'refresh':
        await this.updateView(webviewView);
        break;
      case 'selectBranch':
        await vscode.commands.executeCommand('gitArchaeologist.selectBranch');
        break;
      case 'showHotFiles':
        await vscode.commands.executeCommand('gitArchaeologist.showHotFiles');
        break;
      case 'openTimeline':
        await vscode.commands.executeCommand('workbench.view.extension.gitArchaeologist');
        break;
    }
  }

  private async updateView(webviewView: vscode.WebviewView): Promise<void> {
    try {
      const repoInfo = await this.gitService.getRepositoryInfo();
      const branches = await this.gitService.getBranches();
      const authors = await this.gitService.getAllAuthors();
      const hotFiles = await this.gitService.getHotFiles(10);
      const options = this.stateService.getFilterOptions();
      const commits = await this.gitService.getCommits(options);

      const topAuthors = authors.slice(0, 5);
      const totalAdded = commits.reduce((s, c) => s + (c.stats?.totalAdditions || 0), 0);
      const totalDeleted = commits.reduce((s, c) => s + (c.stats?.totalDeletions || 0), 0);
      const totalFilesTouched = new Set(commits.flatMap(c => c.files.map(f => f.filePath))).size;

      const weeklyData = this.computeWeeklyActivity(commits);

      webviewView.webview.html = this.getHtml({
        repoInfo,
        branches: branches.filter(b => !b.isRemote).slice(0, 10),
        currentBranch: options.branch,
        authors: authors.length,
        totalCommits: commits.length,
        totalAdded,
        totalDeleted,
        totalFilesTouched,
        topAuthors,
        hotFiles,
        weeklyData,
        dateRange: options.dateRange,
        selectedAuthors: options.authors,
        searchTerm: options.searchTerm
      });
    } catch (err) {
      webviewView.webview.html = this.getErrorHtml(err instanceof Error ? err.message : String(err));
    }
  }

  private computeWeeklyActivity(commits: any[]): { week: string; count: number }[] {
    const weekMap = new Map<string, number>();

    for (const c of commits) {
      const date = new Date(c.date);
      const year = date.getFullYear();
      const onejan = new Date(year, 0, 1);
      const weekNum = Math.ceil((((date.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
      const weekKey = `${year}-W${String(weekNum).padStart(2, '0')}`;
      weekMap.set(weekKey, (weekMap.get(weekKey) || 0) + 1);
    }

    return Array.from(weekMap.entries())
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-26);
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { font-family: sans-serif; padding: 40px; text-align: center; color: #888; }
      .spinner { font-size: 48px; animation: spin 1s linear infinite; display: inline-block; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    </style></head><body><div class="spinner">⏳</div><p>正在加载仓库概览...</p></body></html>`;
  }

  private getErrorHtml(error: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body { font-family: sans-serif; padding: 40px; color: #f44; }
      .error-box { background: rgba(255,68,68,0.1); border: 1px solid #f44; padding: 20px; border-radius: 6px; }
      button { margin-top: 10px; padding: 6px 12px; background: #0078d4; color: white; border: none; border-radius: 4px; cursor: pointer; }
    </style></head><body>
      <h2>❌ 加载失败</h2>
      <div class="error-box"><pre>${error}</pre></div>
      <p>请确保当前工作区是一个有效的 Git 仓库。</p>
      <button onclick="vscode.postMessage({command:'refresh'})">重试</button>
    </body></html>`;
  }

  private getHtml(data: any): string {
    const maxWeekCount = Math.max(...data.weeklyData.map((w: any) => w.count), 1);
    const maxAuthorCommits = Math.max(...data.topAuthors.map((a: any) => a.commitCount), 1);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  h1 { font-size: 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 14px; margin: 20px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-panel-border, #ddd); color: var(--vscode-descriptionForeground, #666); }
  h3 { font-size: 13px; margin: 12px 0 8px; }

  .header {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;
  }
  .refresh-btn {
    padding: 4px 10px; background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, white); border: none; border-radius: 4px;
    cursor: pointer; font-size: 12px;
  }

  .repo-card {
    background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
    border: 1px solid var(--vscode-panel-border, #ddd);
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 16px;
  }
  .repo-name { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
  .repo-meta { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; font-size: 12px; color: var(--vscode-descriptionForeground, #666); }
  .meta-item { display: flex; flex-direction: column; }
  .meta-label { font-size: 11px; text-transform: uppercase; opacity: 0.7; }
  .meta-value { font-weight: 500; color: var(--vscode-editor-foreground, #333); }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }
  .stat-card {
    background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
    border: 1px solid var(--vscode-panel-border, #ddd);
    border-radius: 6px;
    padding: 12px;
    text-align: center;
  }
  .stat-value { font-size: 22px; font-weight: 700; color: var(--vscode-textLink-activeForeground, #0078d4); }
  .stat-label { font-size: 11px; color: var(--vscode-descriptionForeground, #666); margin-top: 4px; text-transform: uppercase; }
  .stat-value.add { color: #2ea043; }
  .stat-value.del { color: #da3633; }

  .filters-box {
    background: var(--vscode-textBlockQuote-background, #f8f8f8);
    border-left: 3px solid var(--vscode-textLink-activeForeground, #0078d4);
    padding: 10px 14px;
    border-radius: 0 4px 4px 0;
    margin-bottom: 16px;
    font-size: 12px;
  }
  .filter-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .chip {
    background: var(--vscode-badge-background, #ccc);
    color: var(--vscode-badge-foreground, #333);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
  }

  .chart-container {
    background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
    border: 1px solid var(--vscode-panel-border, #ddd);
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 16px;
  }
  .bars { display: flex; align-items: flex-end; height: 120px; gap: 2px; padding-top: 20px; }
  .bar {
    flex: 1;
    background: var(--vscode-textLink-activeForeground, #0078d4);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    position: relative;
    transition: background 0.2s;
    cursor: pointer;
  }
  .bar:hover { background: var(--vscode-textLink-foreground, #005a9e); }
  .bar:hover::after {
    content: attr(data-count);
    position: absolute;
    top: -20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-editorWidget-background, #333);
    color: var(--vscode-editorWidget-foreground, #fff);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 11px;
    white-space: nowrap;
    z-index: 10;
  }

  .author-bars { display: flex; flex-direction: column; gap: 8px; }
  .author-bar {
    display: flex; align-items: center; gap: 10px;
  }
  .author-name {
    width: 120px;
    font-size: 12px;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }
  .author-progress {
    flex: 1;
    height: 18px;
    background: var(--vscode-panel-border, #eee);
    border-radius: 3px;
    overflow: hidden;
    position: relative;
  }
  .author-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--vscode-textLink-activeForeground, #0078d4), var(--vscode-textLink-foreground, #005a9e));
    border-radius: 3px;
  }
  .author-count {
    width: 60px;
    font-size: 12px;
    text-align: right;
    font-weight: 600;
    color: var(--vscode-editor-foreground, #333);
  }

  .hot-file-list { display: flex; flex-direction: column; gap: 6px; }
  .hot-file-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    background: var(--vscode-editor-inactiveSelectionBackground, #f5f5f5);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .hot-file-item:hover { background: var(--vscode-list-hoverBackground, #e8e8e8); }
  .hot-file-path { font-family: 'Cascadia Code', Consolas, monospace; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hot-file-meta { display: flex; align-items: center; gap: 10px; font-size: 11px; }
  .hot-file-count { font-weight: 600; }
  .flame { color: #e74c3c; }

  .action-btn {
    padding: 4px 10px;
    background: var(--vscode-button-secondaryBackground, #f0f0f0);
    color: var(--vscode-button-secondaryForeground, #333);
    border: 1px solid var(--vscode-panel-border, #ccc);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    margin-top: 10px;
  }
  .action-btn.primary { background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, white); border-color: var(--vscode-button-background, #0078d4); }
  .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
</head>
<body>
  <div class="header">
    <h1>🏛️ 仓库总览</h1>
    <button class="refresh-btn" onclick="refresh()">🔄 刷新</button>
  </div>

  <div class="repo-card">
    <div class="repo-name">📦 ${data.repoInfo.name}</div>
    <div class="repo-meta">
      <div class="meta-item"><span class="meta-label">当前分支</span><span class="meta-value">🌿 ${data.currentBranch}</span></div>
      <div class="meta-item"><span class="meta-label">提交总数</span><span class="meta-value">${data.repoInfo.totalCommits.toLocaleString()}</span></div>
      <div class="meta-item"><span class="meta-label">贡献者</span><span class="meta-value">👥 ${data.authors}</span></div>
      <div class="meta-item"><span class="meta-label">首次提交</span><span class="meta-value">${this.formatDate(data.repoInfo.firstCommitDate)}</span></div>
      <div class="meta-item"><span class="meta-label">最近提交</span><span class="meta-value">${this.formatDate(data.repoInfo.lastCommitDate)}</span></div>
      <div class="meta-item"><span class="meta-label">项目路径</span><span class="meta-value" style="font-family:monospace;font-size:11px">${data.repoInfo.rootPath}</span></div>
    </div>
  </div>

  <div class="filters-box">
    <strong>当前筛选:</strong>
    <div class="filter-row">
      <span class="chip">🌿 ${data.currentBranch}</span>
      ${data.dateRange ? `<span class="chip">📅 ${data.dateRange.start || '开始'} ~ ${data.dateRange.end || '今天'}</span>` : ''}
      ${data.selectedAuthors.map((a: string) => `<span class="chip">👤 ${a}</span>`).join('')}
      ${data.searchTerm ? `<span class="chip">🔍 "${data.searchTerm}"</span>` : ''}
    </div>
  </div>

  <h2>📊 筛选范围统计</h2>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-value">${data.totalCommits.toLocaleString()}</div><div class="stat-label">提交数</div></div>
    <div class="stat-card"><div class="stat-value add">+${data.totalAdded.toLocaleString()}</div><div class="stat-label">新增行</div></div>
    <div class="stat-card"><div class="stat-value del">-${data.totalDeleted.toLocaleString()}</div><div class="stat-label">删除行</div></div>
    <div class="stat-card"><div class="stat-value">${data.totalFilesTouched.toLocaleString()}</div><div class="stat-label">涉及文件</div></div>
    <div class="stat-card"><div class="stat-value">${data.authors}</div><div class="stat-label">作者数</div></div>
    <div class="stat-card"><div class="stat-value">${data.branches.length}</div><div class="stat-label">本地分支</div></div>
  </div>

  <h2>📈 提交活动 (最近 ${data.weeklyData.length} 周)</h2>
  <div class="chart-container">
    <div class="bars">
      ${data.weeklyData.map((w: any) => `
        <div class="bar" data-count="${w.count}" style="height: ${(w.count / maxWeekCount) * 100}%" title="${w.week}: ${w.count}次提交"></div>
      `).join('')}
    </div>
  </div>

  <h2>👥 作者贡献 TOP 5</h2>
  <div class="chart-container">
    <div class="author-bars">
      ${data.topAuthors.map((a: any) => `
        <div class="author-bar">
          <div class="author-name" title="${a.email}">${a.name}</div>
          <div class="author-progress"><div class="author-progress-fill" style="width: ${(a.commitCount / maxAuthorCommits) * 100}%"></div></div>
          <div class="author-count">${a.commitCount}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <h2>🔥 高频修改文件 TOP 10</h2>
  <div class="hot-file-list">
    ${data.hotFiles.map((hf: any, idx: number) => `
      <div class="hot-file-item" onclick="showFileHistory('${hf.filePath.replace(/'/g, "\\'")}')" title="${hf.filePath}">
        <span class="hot-file-path">${idx + 1}. ${hf.filePath}</span>
        <span class="hot-file-meta">
          <span>${hf.authors.length}人</span>
          <span class="hot-file-count"><span class="flame">🔥</span> ${hf.changeCount}</span>
        </span>
      </div>
    `).join('')}
  </div>

  <div class="action-row">
    <button class="action-btn primary" onclick="openTimeline()">📜 查看完整时间线</button>
    <button class="action-btn" onclick="selectBranch()">🌿 切换分支</button>
    <button class="action-btn" onclick="showHotFiles()">🔥 全部高频文件</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  function refresh() { vscode.postMessage({ command: 'refresh' }); }
  function selectBranch() { vscode.postMessage({ command: 'selectBranch' }); }
  function showHotFiles() { vscode.postMessage({ command: 'showHotFiles' }); }
  function openTimeline() { vscode.postMessage({ command: 'openTimeline' }); }
  function showFileHistory(path) {
    vscode.postMessage({ command: 'showFileHistory', filePath: path });
  }
</script>
</body>
</html>`;
  }

  private formatDate(dateStr: string): string {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch {
      return dateStr;
    }
  }
}
