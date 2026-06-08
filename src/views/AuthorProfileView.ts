import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { GitAuthor } from '../models/types';

export class AuthorProfileProvider implements vscode.TreeDataProvider<AuthorItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<AuthorItem | undefined | null | void> = new vscode.EventEmitter<AuthorItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<AuthorItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private authors: (GitAuthor & { avatar?: string })[] = [];
  private totalCommits: number = 0;

  constructor(
    private gitService: GitService,
    private stateService: StateService
  ) {
    this.stateService.onDidChangeBranch(async () => {
      try { await this.loadData(); } catch {}
    });
    this.stateService.onDidChangeFilter(async () => {
      try { await this.loadData(); } catch {}
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadData(): Promise<void> {
    const basicAuthors = await this.gitService.getAllAuthors();
    this.totalCommits = basicAuthors.reduce((s, a) => s + a.commitCount, 0);

    const fullAuthors: (GitAuthor & { avatar?: string })[] = [];
    for (const basic of basicAuthors) {
      try {
        const stats = await this.gitService.getAuthorStats(basic.name);
        fullAuthors.push({
          name: basic.name,
          email: basic.email,
          commitCount: basic.commitCount,
          firstCommitDate: stats.firstCommitDate,
          lastCommitDate: stats.lastCommitDate,
          filesTouched: stats.filesTouched.slice(0, 20),
          linesAdded: stats.linesAdded,
          linesDeleted: stats.linesDeleted
        });
      } catch {
        fullAuthors.push({
          name: basic.name,
          email: basic.email,
          commitCount: basic.commitCount,
          filesTouched: [],
          linesAdded: 0,
          linesDeleted: 0
        });
      }
    }

    this.authors = fullAuthors;
    this.refresh();
  }

  getTreeItem(element: AuthorItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AuthorItem): Thenable<AuthorItem[]> {
    if (!element) {
      const summaryItem = new AuthorSummaryItem(this.authors.length, this.totalCommits);
      const topAuthors = this.authors.slice(0, 50);
      return Promise.resolve([summaryItem, ...topAuthors.map(a => new AuthorProfileItem(a, this.totalCommits))]);
    }

    if (element instanceof AuthorProfileItem) {
      const author = element.author;
      const children: AuthorItem[] = [];

      children.push(new AuthorStatItem('提交次数', `${author.commitCount}`));
      children.push(new AuthorStatItem('贡献占比', `${((author.commitCount / this.totalCommits) * 100).toFixed(1)}%`));
      children.push(new AuthorStatItem('首次提交', author.firstCommitDate || '未知'));
      children.push(new AuthorStatItem('最近提交', author.lastCommitDate || '未知'));
      children.push(new AuthorStatItem('新增行数', `+${author.linesAdded.toLocaleString()}`));
      children.push(new AuthorStatItem('删除行数', `-${author.linesDeleted.toLocaleString()}`));
      children.push(new AuthorStatItem('接触文件', `${author.filesTouched.length} 个`));

      if (author.filesTouched.length > 0) {
        children.push(new AuthorFilesItem(author.filesTouched.slice(0, 10)));
      }

      return Promise.resolve(children);
    }

    if (element instanceof AuthorFilesItem) {
      return Promise.resolve(element.files.map(f => new AuthorFileItem(f)));
    }

    return Promise.resolve([]);
  }

  getAuthors(): GitAuthor[] {
    return this.authors;
  }
}

export class AuthorItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}

export class AuthorSummaryItem extends AuthorItem {
  constructor(
    public readonly authorCount: number,
    public readonly totalCommits: number
  ) {
    super(`📊 统计概览: ${authorCount} 位作者, ${totalCommits.toLocaleString()} 次提交`,
      vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'authorSummary';
    this.tooltip = `仓库共有 ${authorCount} 位作者贡献了 ${totalCommits.toLocaleString()} 次提交`;
  }
}

export class AuthorProfileItem extends AuthorItem {
  public readonly author: GitAuthor;

  constructor(
    author: GitAuthor,
    totalCommits: number
  ) {
    const pct = totalCommits > 0 ? ((author.commitCount / totalCommits) * 100).toFixed(1) : '0';
    const initial = author.name.charAt(0).toUpperCase();
    const label = `${initial} ${author.name} (${author.commitCount} 提交, ${pct}%)`;

    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    this.author = author;
    this.tooltip = this.buildTooltip(author, totalCommits);
    this.contextValue = 'authorProfile';
    this.description = author.email;
  }

  private buildTooltip(author: GitAuthor, total: number): string {
    const pct = total > 0 ? ((author.commitCount / total) * 100).toFixed(2) : '0';
    const lines: string[] = [];
    lines.push(`作者: ${author.name}`);
    lines.push(`邮箱: ${author.email}`);
    lines.push('');
    lines.push(`提交次数: ${author.commitCount} (${pct}%)`);
    lines.push(`新增行数: +${author.linesAdded.toLocaleString()}`);
    lines.push(`删除行数: -${author.linesDeleted.toLocaleString()}`);
    lines.push(`净行数: +${(author.linesAdded - author.linesDeleted).toLocaleString()}`);
    lines.push('');
    lines.push(`首次提交: ${author.firstCommitDate || '未知'}`);
    lines.push(`最近提交: ${author.lastCommitDate || '未知'}`);
    lines.push(`接触文件数: ${author.filesTouched.length}`);
    return lines.join('\n');
  }
}

export class AuthorStatItem extends AuthorItem {
  constructor(
    public readonly statName: string,
    public readonly statValue: string
  ) {
    super(`${statName}: ${statValue}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'authorStat';
    this.tooltip = `${statName} = ${statValue}`;
  }
}

export class AuthorFilesItem extends AuthorItem {
  constructor(
    public readonly files: string[]
  ) {
    super(`📁 参与的文件 (${files.length}个)`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'authorFiles';
    this.tooltip = '展开查看作者参与修改的文件';
  }
}

export class AuthorFileItem extends AuthorItem {
  constructor(
    public readonly filePath: string
  ) {
    const parts = filePath.split(/[\\/]/);
    const fileName = parts.pop() || filePath;
    const dirPath = parts.join('/');

    super(`📄 ${fileName}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = 'authorFile';
    this.tooltip = filePath;
    this.description = dirPath;
    this.command = {
      command: 'gitArchaeologist.showFileHistory',
      title: '查看文件历史',
      arguments: [filePath]
    };
  }
}
