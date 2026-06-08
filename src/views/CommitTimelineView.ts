import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { ReportService } from '../services/ReportService';
import { GitCommit } from '../models/types';

export class CommitTimelineProvider implements vscode.TreeDataProvider<TimelineItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TimelineItem | undefined | null | void> = new vscode.EventEmitter<TimelineItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TimelineItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private commits: GitCommit[] = [];
  private groupedCommits: Map<string, GitCommit[]> = new Map();

  constructor(
    private gitService: GitService,
    private stateService: StateService,
    private reportService: ReportService
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadCommits(): Promise<void> {
    const options = this.stateService.getFilterOptions();
    this.commits = await this.gitService.getCommits(options);
    this.groupCommitsByDate();

    for (const commit of this.commits) {
      const messageDefects = this.reportService.extractDefectsFromMessage(commit.message, commit.body);
      const existingDefects = this.stateService.getDefectIds(commit.hash);
      for (const d of messageDefects) {
        if (!existingDefects.includes(d)) {
          this.stateService.addDefectId(commit.hash, d);
        }
      }
    }

    this.refresh();
  }

  private groupCommitsByDate(): void {
    this.groupedCommits.clear();
    for (const commit of this.commits) {
      const date = commit.date.substring(0, 10);
      if (!this.groupedCommits.has(date)) {
        this.groupedCommits.set(date, []);
      }
      this.groupedCommits.get(date)!.push(commit);
    }
  }

  getTreeItem(element: TimelineItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TimelineItem): Thenable<TimelineItem[]> {
    if (!element) {
      const dates = Array.from(this.groupedCommits.keys()).sort((a, b) => b.localeCompare(a));
      return Promise.resolve(dates.map(date => {
        const dateCommits = this.groupedCommits.get(date) || [];
        return new DateGroupItem(date, dateCommits.length);
      }));
    }

    if (element instanceof DateGroupItem) {
      const dateCommits = this.groupedCommits.get(element.date) || [];
      return Promise.resolve(dateCommits.map(commit => new CommitItem(commit, this.stateService, this.reportService)));
    }

    if (element instanceof CommitItem && element.commit.files.length > 0) {
      return Promise.resolve(element.commit.files.map(f => new FileChangeItem(f, element.commit.hash)));
    }

    return Promise.resolve([]);
  }

  getCommits(): GitCommit[] {
    return this.commits;
  }

  getCommitByHash(hash: string): GitCommit | undefined {
    return this.commits.find(c => c.hash === hash || c.shortHash === hash);
  }
}

export class TimelineItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}

export class DateGroupItem extends TimelineItem {
  constructor(
    public readonly date: string,
    public readonly commitCount: number
  ) {
    super(`${date} (${commitCount} 提交)`, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = `${date} - ${commitCount} 次提交`;
    this.description = `${commitCount} 提交`;
    this.contextValue = 'dateGroup';
  }
}

export class CommitItem extends TimelineItem {
  public readonly commit: GitCommit;

  constructor(
    commit: GitCommit,
    private stateService: StateService,
    private reportService: ReportService
  ) {
    const isFav = stateService.isFavorite(commit.hash);
    const defects = stateService.getDefectIds(commit.hash);
    const defectStr = defects.length > 0 ? ` [${defects.join(',')}]` : '';
    const favIcon = isFav ? '⭐ ' : '';

    const timeStr = commit.date.substring(11, 16);
    const stats = commit.stats;
    const statsStr = stats ? ` (+${stats.totalAdditions}/-${stats.totalDeletions} ${stats.totalFiles}f)` : '';

    super(`${favIcon}${commit.shortHash} ${timeStr} ${commit.authorName}: ${commit.message}${defectStr}${statsStr}`,
      commit.files.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    this.commit = commit;
    this.description = '';
    this.tooltip = this.buildTooltip(commit);
    this.contextValue = 'commit';
    this.command = {
      command: 'gitArchaeologist.openCommit',
      title: '查看提交详情',
      arguments: [commit.hash]
    };
    this.iconPath = this.getCategoryIcon(commit);
  }

  private buildTooltip(commit: GitCommit): string {
    const lines: string[] = [];
    lines.push(`Hash: ${commit.hash}`);
    lines.push(`作者: ${commit.authorName} <${commit.authorEmail}>`);
    lines.push(`日期: ${commit.date}`);
    lines.push('');
    lines.push(commit.message);
    if (commit.body) {
      lines.push('');
      lines.push(commit.body);
    }
    if (commit.stats) {
      lines.push('');
      lines.push(`统计: ${commit.stats.totalFiles} 个文件，+${commit.stats.totalAdditions} 行，-${commit.stats.totalDeletions} 行`);
    }

    const note = this.stateService.getNote(commit.hash);
    if (note) {
      lines.push('');
      lines.push(`备注: ${note}`);
    }

    const defects = this.stateService.getDefectIds(commit.hash);
    if (defects.length > 0) {
      lines.push('');
      lines.push(`关联缺陷: ${defects.join(', ')}`);
    }

    return lines.join('\n');
  }

  private getCategoryIcon(commit: GitCommit): vscode.ThemeIcon {
    const msg = (commit.message + ' ' + (commit.body || '')).toLowerCase();

    if (/\bfix\b|\bbug\b|修复|错误|\bissue\b/.test(msg)) {
      return new vscode.ThemeIcon('bug');
    }
    if (/\bfeat\b|feature|新增|添加|\badd\b|新功能|实现/.test(msg)) {
      return new vscode.ThemeIcon('sparkles');
    }
    if (/\brefactor\b|重构|重写|\brework\b/.test(msg)) {
      return new vscode.ThemeIcon('refresh');
    }
    if (/\bdocs?\b|文档|注释|comment|readme/.test(msg)) {
      return new vscode.ThemeIcon('book');
    }
    if (/\bchore\b|build|ci|升级|upgrade|依赖|merge|合并/.test(msg)) {
      return new vscode.ThemeIcon('gear');
    }

    return new vscode.ThemeIcon('git-commit');
  }
}

export class FileChangeItem extends TimelineItem {
  constructor(
    public readonly fileChange: { status: string; filePath: string; oldFilePath?: string; additions: number; deletions: number },
    public readonly commitHash: string
  ) {
    const statusIcon = fileChange.status === 'A' ? '[+]' :
      fileChange.status === 'D' ? '[-]' :
        fileChange.status === 'M' ? '[~]' :
          fileChange.status === 'R' ? '[→]' : '[?]';

    let label = `${statusIcon} ${fileChange.filePath}`;
    if (fileChange.status === 'R' && fileChange.oldFilePath) {
      label = `${statusIcon} ${fileChange.oldFilePath} → ${fileChange.filePath}`;
    }

    label += ` (+${fileChange.additions}/-${fileChange.deletions})`;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.tooltip = this.buildTooltip();
    this.contextValue = fileChange.status === 'D' ? 'deletedFile' : 'file';
    this.command = {
      command: 'gitArchaeologist.showFileHistory',
      title: '查看文件历史',
      arguments: [fileChange.filePath, commitHash]
    };
  }

  private buildTooltip(): string {
    const lines: string[] = [];
    lines.push(`状态: ${this.getStatusText()}`);
    lines.push(`路径: ${this.fileChange.filePath}`);
    if (this.fileChange.oldFilePath) {
      lines.push(`旧路径: ${this.fileChange.oldFilePath}`);
    }
    lines.push(`新增: ${this.fileChange.additions} 行`);
    lines.push(`删除: ${this.fileChange.deletions} 行`);
    return lines.join('\n');
  }

  private getStatusText(): string {
    switch (this.fileChange.status) {
      case 'A': return '新增 (Added)';
      case 'D': return '删除 (Deleted)';
      case 'M': return '修改 (Modified)';
      case 'R': return '重命名 (Renamed)';
      case 'C': return '复制 (Copied)';
      default: return `未知 (${this.fileChange.status})`;
    }
  }
}
