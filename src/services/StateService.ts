import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PluginState, FilterOptions, DateRange } from '../models/types';

export class StateService {
  private context: vscode.ExtensionContext;
  private workspaceRoot: string;
  private cacheDir: string;
  private config: vscode.WorkspaceConfiguration;

  private state: PluginState;

  constructor(context: vscode.ExtensionContext, workspaceRoot: string) {
    this.context = context;
    this.workspaceRoot = workspaceRoot;
    this.config = vscode.workspace.getConfiguration('gitArchaeologist');
    this.cacheDir = path.join(workspaceRoot, this.config.get('dataCachePath', '.git-archaeologist'));

    this.state = this.loadState();
  }

  private loadState(): PluginState {
    const defaultBranch = this.config.get('defaultBranch', 'main');
    const maxCommits = this.config.get('maxCommits', 500);

    const defaultState: PluginState = {
      currentBranch: defaultBranch,
      filterOptions: {
        branch: defaultBranch,
        authors: [],
        maxCommits
      },
      favorites: new Map(),
      notes: new Map(),
      defectLinks: new Map(),
      selectedCommits: []
    };

    const persisted = this.context.workspaceState.get<{
      currentBranch: string;
      filterOptions: FilterOptions;
      favorites: [string, boolean][];
      notes: [string, string][];
      defectLinks: [string, string[]][];
      selectedCommits: string[];
    }>('gitArchaeologist.state');

    if (persisted) {
      return {
        currentBranch: persisted.currentBranch,
        filterOptions: persisted.filterOptions,
        favorites: new Map(persisted.favorites),
        notes: new Map(persisted.notes),
        defectLinks: new Map(persisted.defectLinks),
        selectedCommits: persisted.selectedCommits
      };
    }

    return defaultState;
  }

  saveState(): void {
    this.context.workspaceState.update('gitArchaeologist.state', {
      currentBranch: this.state.currentBranch,
      filterOptions: this.state.filterOptions,
      favorites: Array.from(this.state.favorites.entries()),
      notes: Array.from(this.state.notes.entries()),
      defectLinks: Array.from(this.state.defectLinks.entries()),
      selectedCommits: this.state.selectedCommits
    });
  }

  getState(): PluginState {
    return { ...this.state };
  }

  getCurrentBranch(): string {
    return this.state.currentBranch;
  }

  setCurrentBranch(branch: string): void {
    this.state.currentBranch = branch;
    this.state.filterOptions.branch = branch;
    this.saveState();
  }

  getFilterOptions(): FilterOptions {
    return { ...this.state.filterOptions };
  }

  setFilterOptions(options: Partial<FilterOptions>): void {
    this.state.filterOptions = { ...this.state.filterOptions, ...options };
    this.saveState();
  }

  setDateRange(range: DateRange): void {
    this.state.filterOptions.dateRange = range;
    this.saveState();
  }

  getDateRange(): DateRange | undefined {
    return this.state.filterOptions.dateRange;
  }

  setAuthors(authors: string[]): void {
    this.state.filterOptions.authors = authors;
    this.saveState();
  }

  getAuthors(): string[] {
    return [...this.state.filterOptions.authors];
  }

  setSearchTerm(term: string): void {
    this.state.filterOptions.searchTerm = term;
    this.saveState();
  }

  getSearchTerm(): string | undefined {
    return this.state.filterOptions.searchTerm;
  }

  isFavorite(commitHash: string): boolean {
    return this.state.favorites.get(commitHash) || false;
  }

  toggleFavorite(commitHash: string): boolean {
    const current = this.isFavorite(commitHash);
    this.state.favorites.set(commitHash, !current);
    this.saveState();
    return !current;
  }

  getFavorites(): string[] {
    return Array.from(this.state.favorites.entries())
      .filter(([_, v]) => v)
      .map(([k]) => k);
  }

  getNote(commitHash: string): string | undefined {
    return this.state.notes.get(commitHash);
  }

  setNote(commitHash: string, note: string): void {
    this.state.notes.set(commitHash, note);
    this.saveState();
  }

  clearNote(commitHash: string): void {
    this.state.notes.delete(commitHash);
    this.saveState();
  }

  getDefectIds(commitHash: string): string[] {
    return this.state.defectLinks.get(commitHash) || [];
  }

  addDefectId(commitHash: string, defectId: string): void {
    const existing = this.getDefectIds(commitHash);
    if (!existing.includes(defectId)) {
      existing.push(defectId);
      this.state.defectLinks.set(commitHash, existing);
      this.saveState();
    }
  }

  removeDefectId(commitHash: string, defectId: string): void {
    const existing = this.getDefectIds(commitHash).filter(id => id !== defectId);
    if (existing.length > 0) {
      this.state.defectLinks.set(commitHash, existing);
    } else {
      this.state.defectLinks.delete(commitHash);
    }
    this.saveState();
  }

  isSelected(commitHash: string): boolean {
    return this.state.selectedCommits.includes(commitHash);
  }

  toggleSelected(commitHash: string): void {
    const idx = this.state.selectedCommits.indexOf(commitHash);
    if (idx >= 0) {
      this.state.selectedCommits.splice(idx, 1);
    } else {
      this.state.selectedCommits.push(commitHash);
    }
    this.saveState();
  }

  clearSelected(): void {
    this.state.selectedCommits = [];
    this.saveState();
  }

  getSelectedCommits(): string[] {
    return [...this.state.selectedCommits];
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  exportCache(fileName: string, data: unknown): void {
    this.ensureCacheDir();
    const filePath = path.join(this.cacheDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  importCache<T>(fileName: string): T | null {
    const filePath = path.join(this.cacheDir, fileName);
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
      } catch {
        return null;
      }
    }
    return null;
  }

  getConfigDefectPattern(): RegExp {
    const pattern = this.config.get('defectPattern', '#(\\d+)');
    return new RegExp(pattern, 'g');
  }

  getConfigDefectUrlTemplate(): string {
    return this.config.get('defectUrlTemplate', '');
  }

  getConfigHotFileThreshold(): number {
    return this.config.get('hotFileThreshold', 10);
  }

  clearAll(): void {
    this.state = {
      currentBranch: this.config.get('defaultBranch', 'main'),
      filterOptions: {
        branch: this.config.get('defaultBranch', 'main'),
        authors: [],
        maxCommits: this.config.get('maxCommits', 500)
      },
      favorites: new Map(),
      notes: new Map(),
      defectLinks: new Map(),
      selectedCommits: []
    };
    this.saveState();
  }
}
