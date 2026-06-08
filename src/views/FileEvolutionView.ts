import * as vscode from 'vscode';
import { GitService } from '../services/GitService';
import { StateService } from '../services/StateService';
import { HotFile, DeletedFile, GitFileChange } from '../models/types';

export class FileEvolutionProvider implements vscode.TreeDataProvider<FileEvolutionItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<FileEvolutionItem | undefined | null | void> = new vscode.EventEmitter<FileEvolutionItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<FileEvolutionItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private hotFiles: HotFile[] = [];
  private deletedFiles: DeletedFile[] = [];
  private hotFileThreshold: number;
  private displayMode: 'all' | 'hot' | 'deleted' = 'all';

  constructor(
    private gitService: GitService,
    private stateService: StateService
  ) {
    this.hotFileThreshold = stateService.getConfigHotFileThreshold();
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
    this.hotFiles = await this.gitService.getHotFiles(100);
    this.deletedFiles = await this.gitService.getDeletedFiles();
    this.refresh();
  }

  setDisplayMode(mode: 'all' | 'hot' | 'deleted'): void {
    this.displayMode = mode;
    this.refresh();
  }

  getHotFiles(): HotFile[] {
    return this.hotFiles;
  }

  getDeletedFiles(): DeletedFile[] {
    return this.deletedFiles;
  }

  getTreeItem(element: FileEvolutionItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FileEvolutionItem): Thenable<FileEvolutionItem[]> {
    if (!element) {
      const children: FileEvolutionItem[] = [];

      if (this.displayMode === 'all' || this.displayMode === 'hot') {
        const hotThresholdFiles = this.hotFiles.filter(f => f.changeCount >= this.hotFileThreshold);
        const normalFiles = this.hotFiles.filter(f => f.changeCount < this.hotFileThreshold);

        if (hotThresholdFiles.length > 0) {
          children.push(new FileCategoryItem('hot', `🔥 高频修改文件 (≥${this.hotFileThreshold}次, ${hotThresholdFiles.length}个)`, hotThresholdFiles.length));
        }

        if (normalFiles.length > 0 && this.displayMode === 'all') {
          children.push(new FileCategoryItem('normal', `📁 常规文件 (${normalFiles.length}个)`, normalFiles.length));
        }
      }

      if (this.displayMode === 'all' || this.displayMode === 'deleted') {
        if (this.deletedFiles.length > 0) {
          children.push(new FileCategoryItem('deleted', `🗑️ 已删除文件 (${this.deletedFiles.length}个)`, this.deletedFiles.length));
        }
      }

      return Promise.resolve(children);
    }

    if (element instanceof FileCategoryItem) {
      if (element.category === 'hot' || element.category === 'normal') {
        const threshold = element.category === 'hot' ? this.hotFileThreshold : 0;
        const maxCount = element.category === 'hot' ? Infinity : this.hotFileThreshold;
        const files = this.hotFiles.filter(f => {
          if (element.category === 'hot') return f.changeCount >= threshold;
          return f.changeCount < maxCount;
        });
        return Promise.resolve(files.map(f => new HotFileItem(f)));
      }

      if (element.category === 'deleted') {
        return Promise.resolve(this.deletedFiles.slice(0, 200).map(f => new DeletedFileItem(f)));
      }
    }

    return Promise.resolve([]);
  }
}

export class FileEvolutionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
  }
}

export class FileCategoryItem extends FileEvolutionItem {
  constructor(
    public readonly category: 'hot' | 'normal' | 'deleted',
    label: string,
    count: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = `category_${category}`;
    this.tooltip = `${label}`;
    this.description = `${count}`;
  }
}

export class HotFileItem extends FileEvolutionItem {
  constructor(
    public readonly hotFile: HotFile
  ) {
    const isHot = hotFile.changeCount >= 10;
    const icon = hotFile.changeCount >= 50 ? '🔥🔥🔥' :
      hotFile.changeCount >= 20 ? '🔥🔥' :
        hotFile.changeCount >= 10 ? '🔥' : '📄';

    const parts = hotFile.filePath.split(/[\\/]/);
    const fileName = parts.pop() || hotFile.filePath;
    const dirPath = parts.join('/');

    const label = `${icon} ${fileName} (${hotFile.changeCount}次)`;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.tooltip = this.buildTooltip(hotFile, dirPath);
    this.contextValue = isHot ? 'hotFile' : 'file';
    this.description = dirPath;
    this.command = {
      command: 'gitArchaeologist.showFileHistory',
      title: '查看文件历史',
      arguments: [hotFile.filePath]
    };
    this.resourceUri = vscode.Uri.file(hotFile.filePath);
  }

  private buildTooltip(hf: HotFile, dir: string): string {
    const lines: string[] = [];
    lines.push(`文件: ${hf.filePath}`);
    lines.push(`目录: ${dir}`);
    lines.push(`修改次数: ${hf.changeCount}`);
    lines.push(`参与作者: ${hf.authors.join(', ') || '未知'}`);
    lines.push(`最近修改: ${hf.lastModified}`);
    return lines.join('\n');
  }
}

export class DeletedFileItem extends FileEvolutionItem {
  constructor(
    public readonly deletedFile: DeletedFile
  ) {
    const parts = deletedFile.filePath.split(/[\\/]/);
    const fileName = parts.pop() || deletedFile.filePath;
    const dirPath = parts.join('/');

    super(`🗑️ ${fileName}`, vscode.TreeItemCollapsibleState.None);

    this.tooltip = this.buildTooltip(deletedFile, dirPath);
    this.contextValue = 'deletedFile';
    this.description = dirPath;
    this.command = {
      command: 'gitArchaeologist.viewDeletedFile',
      title: '查看被删文件片段',
      arguments: [this]
    };
  }

  private buildTooltip(df: DeletedFile, dir: string): string {
    const lines: string[] = [];
    lines.push(`文件: ${df.filePath}`);
    lines.push(`目录: ${dir}`);
    lines.push(`删除时间: ${df.deletedDate}`);
    lines.push(`删除者: ${df.deletedBy}`);
    lines.push(`删除提交: ${df.deletedInCommit.substring(0, 7)}`);
    return lines.join('\n');
  }
}
