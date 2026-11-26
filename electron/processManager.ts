import { BrowserWindow, app } from 'electron';
import { ChildProcess, execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  ConfigStorageState,
  LogBatchEvent,
  LogLine,
  ServiceConfig,
  ServiceRuntimeState,
  ServiceSnapshot,
  WorkspaceSwitchResult
} from '../shared/types';
import {
  classifyLogLevel,
  isStackTraceContinuation,
  parseAnsiLine
} from './ansiParser';
import { backupUnreadableFile, writeFileAtomic } from './fsUtils';

const MAX_LOG_LINES = 25_000;
// Trim the log buffer in chunks so we don't shift a 25k-element array on every line.
const LOG_TRIM_CHUNK = 1_000;
const BATCH_FLUSH_MS = 60;
const PROCESS_POLL_MS = 3000;
const PROCESS_TABLE_TIMEOUT_MS = 8000;
const WORKSPACE_CONFIG_FILENAME = 'multi-service-console.json';
const MAX_RECENT_WORKSPACES = 10;
const PROCESS_TABLE_PS =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';

let nextGlobalLineSeq = 1;

interface ProcessTable {
  childrenByParent: Map<number, number[]>;
  parentOf: Map<number, number>;
}

interface AppSettingsFile {
  mode: 'global' | 'workspace';
  workspaceRoot: string | null;
  recentWorkspaces: string[];
}

interface StoredConfigFileObject {
  version?: number;
  services?: ServiceConfig[];
}

interface ManagedService {
  config: ServiceConfig;
  runtime: ServiceRuntimeState;
  child: ChildProcess | null;
  logs: LogLine[];
  nextLineId: number;
  nextErrorBlockId: number;
  activeErrorBlockId: number | null;
  lastErrorAt: number;
  pendingBatch: LogLine[];
  stopRequested: boolean;
  readyRegex: RegExp | null;
  killTimer: NodeJS.Timeout | null;
}

function createInitialRuntime(serviceId: string): ServiceRuntimeState {
  return {
    serviceId,
    status: 'stopped',
    pid: null,
    childPids: [],
    detectedPorts: [],
    startedAt: null,
    stoppedAt: null,
    exitCode: null,
    errorCount: 0,
    warnCount: 0,
    lineCount: 0
  };
}

function compileReadyRegex(pattern?: string): RegExp | null {
  if (!pattern || !pattern.trim()) return null;
  try {
    return new RegExp(pattern.trim(), 'i');
  } catch {
    return null;
  }
}

function createManagedService(config: ServiceConfig): ManagedService {
  return {
    config,
    runtime: createInitialRuntime(config.id),
    child: null,
    logs: [],
    nextLineId: 1,
    nextErrorBlockId: 1,
    activeErrorBlockId: null,
    lastErrorAt: 0,
    pendingBatch: [],
    stopRequested: false,
    readyRegex: compileReadyRegex(config.readyPattern),
    killTimer: null
  };
}

/** Express absCwd relative to baseDir when it lives inside it; otherwise keep it absolute. */
function relativizeCwd(absCwd: string, baseDir: string): string {
  const rel = path.relative(baseDir, absCwd);
  if (!rel) return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `./${rel.replace(/\\/g, '/')}`;
  }
  return absCwd;
}

function collectDescendants(table: ProcessTable, rootPid: number): number[] {
  const descendants: number[] = [];
  const queue = [rootPid];
  const visited = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const kid of table.childrenByParent.get(current) ?? []) {
      if (!visited.has(kid)) {
        visited.add(kid);
        descendants.push(kid);
        queue.push(kid);
      }
    }
  }
  return descendants;
}

export class ProcessManager {
  private services = new Map<string, ManagedService>();
  private flushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private configSaveBlocked = false;
  private globalConfigPath: string;
  private settingsPath: string;
  private storageState: ConfigStorageState;

  constructor(initialWorkspaceRoot?: string | null) {
    const userDataDir = app.getPath('userData');
    this.globalConfigPath = path.join(userDataDir, 'services.json');
    this.settingsPath = path.join(userDataDir, 'settings.json');
    this.storageState = this.resolveInitialStorageState(initialWorkspaceRoot);
    this.loadConfigs();
    this.flushTimer = setInterval(() => this.flushAllBatches(), BATCH_FLUSH_MS);
    this.pollTimer = setInterval(
      () => void this.refreshProcessTreeAndPorts(),
      PROCESS_POLL_MS
    );
  }

  private resolveInitialStorageState(
    initialWorkspaceRoot?: string | null
  ): ConfigStorageState {
    const settings = this.loadSettings();
    let mode: 'global' | 'workspace' = settings.mode;
    let workspaceRoot = settings.workspaceRoot;
    let recentWorkspaces = settings.recentWorkspaces;

    if (initialWorkspaceRoot && fs.existsSync(initialWorkspaceRoot)) {
      const normalized = path.resolve(initialWorkspaceRoot);
      mode = 'workspace';
      workspaceRoot = normalized;
      recentWorkspaces = this.mergeRecentWorkspaces(recentWorkspaces, normalized);
    } else if (
      mode === 'workspace' &&
      (!workspaceRoot || !fs.existsSync(workspaceRoot))
    ) {
      mode = 'global';
      workspaceRoot = null;
    }

    const state: ConfigStorageState = {
      mode,
      workspaceRoot,
      configFilePath:
        mode === 'workspace' && workspaceRoot
          ? path.join(workspaceRoot, WORKSPACE_CONFIG_FILENAME)
          : this.globalConfigPath,
      recentWorkspaces,
      loadWarning: null
    };
    this.saveSettings(state);
    return state;
  }

  private loadSettings(): AppSettingsFile {
    try {
      if (!fs.existsSync(this.settingsPath)) {
        return { mode: 'global', workspaceRoot: null, recentWorkspaces: [] };
      }
      const parsed = JSON.parse(
        fs.readFileSync(this.settingsPath, 'utf8')
      ) as Partial<AppSettingsFile>;
      const mode = parsed.mode === 'workspace' ? 'workspace' : 'global';
      const workspaceRoot =
        typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.trim()
          ? path.resolve(parsed.workspaceRoot)
          : null;
      const recentWorkspaces = Array.isArray(parsed.recentWorkspaces)
        ? parsed.recentWorkspaces
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => path.resolve(p))
        : [];
      return { mode, workspaceRoot, recentWorkspaces };
    } catch {
      return { mode: 'global', workspaceRoot: null, recentWorkspaces: [] };
    }
  }

  private saveSettings(state: ConfigStorageState): void {
    try {
      const payload: AppSettingsFile = {
        mode: state.mode,
        workspaceRoot: state.workspaceRoot,
        recentWorkspaces: state.recentWorkspaces
      };
      writeFileAtomic(this.settingsPath, JSON.stringify(payload, null, 2));
    } catch {
      // Ignore settings write failure
    }
  }

  private mergeRecentWorkspaces(list: string[], root: string): string[] {
    const resolved = path.resolve(root);
    const filtered = list.filter(
      (item) => item.toLowerCase() !== resolved.toLowerCase()
    );
    return [resolved, ...filtered].slice(0, MAX_RECENT_WORKSPACES);
  }

  private resolveLoadedCwd(rawCwd: string): string {
    const trimmed = rawCwd.trim();
    if (
      this.storageState.mode === 'workspace' &&
      this.storageState.workspaceRoot &&
      !path.isAbsolute(trimmed)
    ) {
      return path.resolve(this.storageState.workspaceRoot, trimmed);
    }
    return trimmed;
  }

  private serializeSavedCwd(absCwd: string): string {
    if (
      this.storageState.mode !== 'workspace' ||
      !this.storageState.workspaceRoot
    ) {
      return absCwd;
    }
    return relativizeCwd(absCwd, this.storageState.workspaceRoot);
  }

  private parseConfigArray(raw: string): ServiceConfig[] {
    const parsed = JSON.parse(raw) as ServiceConfig[] | StoredConfigFileObject;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.services)) {
      return parsed.services;
    }
    throw new Error('expected an array of services or { "services": [...] }');
  }

  private loadConfigs(): void {
    this.services.clear();
    this.storageState.loadWarning = null;
    this.configSaveBlocked = false;
    const filePath = this.storageState.configFilePath;
    if (!fs.existsSync(filePath)) {
      return;
    }

    let list: ServiceConfig[];
    try {
      list = this.parseConfigArray(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      // Never silently start empty: the next save would overwrite the user's file.
      const reason = err instanceof Error ? err.message : String(err);
      const backupPath = backupUnreadableFile(filePath);
      this.configSaveBlocked = backupPath === null;
      this.storageState.loadWarning = backupPath
        ? `Could not read ${filePath} (${reason}). A copy was saved to ${backupPath}.`
        : `Could not read ${filePath} (${reason}). Fix the file before making changes, or they will overwrite it.`;
      return;
    }

    for (const rawCfg of list) {
      if (
        !rawCfg ||
        typeof rawCfg.id !== 'string' ||
        typeof rawCfg.name !== 'string' ||
        typeof rawCfg.command !== 'string' ||
        typeof rawCfg.cwd !== 'string'
      ) {
        continue;
      }
      const cfg: ServiceConfig = {
        ...rawCfg,
        cwd: this.resolveLoadedCwd(rawCfg.cwd)
      };
      this.services.set(cfg.id, createManagedService(cfg));
    }
  }

  private saveConfigs(): void {
    if (this.configSaveBlocked) {
      this.broadcast(
        'app:error',
        'Changes were not saved: the config file could not be read and no backup of it could be made.'
      );
      return;
    }

    // Map order is the display order; keep `order` in step with it so start order matches.
    let index = 0;
    for (const svc of this.services.values()) {
      svc.config = { ...svc.config, order: index };
      index += 1;
    }

    const configs = Array.from(this.services.values()).map((s) => ({
      ...s.config,
      cwd: this.serializeSavedCwd(s.config.cwd)
    }));
    try {
      const content =
        this.storageState.mode === 'workspace'
          ? JSON.stringify({ version: 1, services: configs }, null, 2)
          : JSON.stringify(configs, null, 2);
      writeFileAtomic(this.storageState.configFilePath, content);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.broadcast(
        'app:error',
        `Could not save ${this.storageState.configFilePath}: ${reason}`
      );
    }
  }

  public getStorageState(): ConfigStorageState {
    return {
      ...this.storageState,
      recentWorkspaces: [...this.storageState.recentWorkspaces]
    };
  }

  public async switchToGlobal(): Promise<WorkspaceSwitchResult> {
    if (this.getRunningCount() > 0) {
      await this.stopAll(false);
    }
    this.storageState = {
      mode: 'global',
      workspaceRoot: null,
      configFilePath: this.globalConfigPath,
      recentWorkspaces: this.storageState.recentWorkspaces,
      loadWarning: null
    };
    this.saveSettings(this.storageState);
    this.loadConfigs();
    this.broadcastConfigsChanged();
    this.broadcastStorageChanged();
    return {
      storage: this.getStorageState(),
      services: this.getSnapshots(),
      createdNewFile: false
    };
  }

  public async openWorkspace(
    folderPath: string
  ): Promise<WorkspaceSwitchResult> {
    const resolvedRoot = path.resolve(folderPath);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`Workspace folder does not exist: ${resolvedRoot}`);
    }
    if (this.getRunningCount() > 0) {
      await this.stopAll(false);
    }

    const configFilePath = path.join(resolvedRoot, WORKSPACE_CONFIG_FILENAME);
    const createdNewFile = !fs.existsSync(configFilePath);

    this.storageState = {
      mode: 'workspace',
      workspaceRoot: resolvedRoot,
      configFilePath,
      recentWorkspaces: this.mergeRecentWorkspaces(
        this.storageState.recentWorkspaces,
        resolvedRoot
      ),
      loadWarning: null
    };
    this.saveSettings(this.storageState);

    if (createdNewFile) {
      this.services.clear();
      this.configSaveBlocked = false;
      this.saveConfigs();
    } else {
      this.loadConfigs();
    }

    this.broadcastConfigsChanged();
    this.broadcastStorageChanged();
    return {
      storage: this.getStorageState(),
      services: this.getSnapshots(),
      createdNewFile
    };
  }

  public async saveCopyToWorkspace(
    folderPath: string
  ): Promise<WorkspaceSwitchResult> {
    const resolvedRoot = path.resolve(folderPath);
    if (!fs.existsSync(resolvedRoot)) {
      throw new Error(`Workspace folder does not exist: ${resolvedRoot}`);
    }
    const currentServices = Array.from(this.services.values()).map((s) => ({
      ...s.config
    }));

    if (this.getRunningCount() > 0) {
      await this.stopAll(false);
    }

    const configFilePath = path.join(resolvedRoot, WORKSPACE_CONFIG_FILENAME);
    this.storageState = {
      mode: 'workspace',
      workspaceRoot: resolvedRoot,
      configFilePath,
      recentWorkspaces: this.mergeRecentWorkspaces(
        this.storageState.recentWorkspaces,
        resolvedRoot
      ),
      loadWarning: null
    };
    this.saveSettings(this.storageState);

    this.services.clear();
    for (const cfg of currentServices) {
      this.services.set(cfg.id, createManagedService(cfg));
    }
    // The user explicitly chose to write this folder's config, so overwriting is intended.
    this.configSaveBlocked = false;
    this.saveConfigs();

    this.broadcastConfigsChanged();
    this.broadcastStorageChanged();
    return {
      storage: this.getStorageState(),
      services: this.getSnapshots(),
      createdNewFile: false
    };
  }

  public removeRecentWorkspace(folderPath: string): ConfigStorageState {
    const resolved = path.resolve(folderPath);
    this.storageState = {
      ...this.storageState,
      recentWorkspaces: this.storageState.recentWorkspaces.filter(
        (p) => p.toLowerCase() !== resolved.toLowerCase()
      )
    };
    this.saveSettings(this.storageState);
    this.broadcastStorageChanged();
    return this.getStorageState();
  }

  public dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public getSnapshots(): ServiceSnapshot[] {
    return Array.from(this.services.values()).map((s) => ({
      config: { ...s.config },
      runtime: { ...s.runtime }
    }));
  }

  public getLogs(serviceId: string): LogLine[] {
    const svc = this.services.get(serviceId);
    if (!svc) return [];
    return svc.logs.slice(-MAX_LOG_LINES);
  }

  public getRunningCount(): number {
    let count = 0;
    for (const svc of this.services.values()) {
      if (
        svc.runtime.status === 'running' ||
        svc.runtime.status === 'starting' ||
        svc.runtime.status === 'stopping'
      ) {
        count += 1;
      }
    }
    return count;
  }

  public upsertService(input: Partial<ServiceConfig> & { name: string; command: string; cwd: string }): ServiceSnapshot {
    const id = input.id && this.services.has(input.id) ? input.id : crypto.randomUUID();
    const existing = this.services.get(id);

    const config: ServiceConfig = {
      id,
      name: input.name.trim(),
      group: (input.group || 'Default').trim(),
      type: input.type || 'shell',
      command: input.command.trim(),
      cwd: input.cwd.trim(),
      env: input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
      ports: input.ports && input.ports.length > 0 ? input.ports : undefined,
      readyPattern: input.readyPattern?.trim() || undefined,
      startupDelayMs: input.startupDelayMs ?? undefined,
      autoScrollDefault: input.autoScrollDefault ?? true,
      order: input.order ?? existing?.config.order ?? this.services.size
    };

    if (existing) {
      existing.config = config;
      existing.readyRegex = compileReadyRegex(config.readyPattern);
      this.saveConfigs();
      this.broadcastRuntime(existing.runtime);
      this.broadcastConfigsChanged();
      return { config: { ...existing.config }, runtime: { ...existing.runtime } };
    }

    const managed = createManagedService(config);
    this.services.set(id, managed);
    this.saveConfigs();
    this.broadcastConfigsChanged();
    return { config: { ...managed.config }, runtime: { ...managed.runtime } };
  }

  public async deleteService(serviceId: string): Promise<void> {
    const svc = this.services.get(serviceId);
    if (!svc) return;
    if (svc.child) {
      await this.stopService(serviceId, true);
    }
    this.services.delete(serviceId);
    this.saveConfigs();
    this.broadcastConfigsChanged();
  }

  public reorderService(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): ServiceSnapshot[] {
    if (draggedId === targetId) return this.getSnapshots();
    const entries = Array.from(this.services.entries());
    const fromIndex = entries.findIndex(([id]) => id === draggedId);
    const targetInitialIndex = entries.findIndex(([id]) => id === targetId);
    if (fromIndex === -1 || targetInitialIndex === -1) {
      return this.getSnapshots();
    }

    const [draggedEntry] = entries.splice(fromIndex, 1);
    const targetNewIndex = entries.findIndex(([id]) => id === targetId);
    if (targetNewIndex === -1) return this.getSnapshots();

    const targetGroup = entries[targetNewIndex][1].config.group;
    draggedEntry[1].config = {
      ...draggedEntry[1].config,
      group: targetGroup
    };

    const insertIndex =
      position === 'before' ? targetNewIndex : targetNewIndex + 1;
    entries.splice(insertIndex, 0, draggedEntry);

    this.services = new Map(
      entries.map(([id, managed], idx) => {
        managed.config = { ...managed.config, order: idx };
        return [id, managed];
      })
    );

    this.saveConfigs();
    this.broadcastConfigsChanged();
    return this.getSnapshots();
  }

  public importConfigs(configs: ServiceConfig[], replaceAll = false): ServiceSnapshot[] {
    if (replaceAll) {
      for (const [id, svc] of this.services) {
        if (!svc.child) {
          this.services.delete(id);
        }
      }
    }

    for (const rawCfg of configs) {
      if (
        !rawCfg ||
        typeof rawCfg.name !== 'string' ||
        typeof rawCfg.command !== 'string' ||
        typeof rawCfg.cwd !== 'string' ||
        !rawCfg.name.trim() ||
        !rawCfg.command.trim() ||
        !rawCfg.cwd.trim()
      ) {
        continue;
      }
      const ports = Array.isArray(rawCfg.ports)
        ? rawCfg.ports.filter(
            (p): p is number => Number.isInteger(p) && p > 0 && p < 65536
          )
        : undefined;
      const env =
        rawCfg.env && typeof rawCfg.env === 'object' && !Array.isArray(rawCfg.env)
          ? Object.fromEntries(
              Object.entries(rawCfg.env).map(([k, v]) => [k, String(v)])
            )
          : undefined;
      this.upsertService({
        ...rawCfg,
        ports,
        env,
        group: typeof rawCfg.group === 'string' ? rawCfg.group : undefined,
        readyPattern:
          typeof rawCfg.readyPattern === 'string' ? rawCfg.readyPattern : undefined,
        startupDelayMs:
          typeof rawCfg.startupDelayMs === 'number' ? rawCfg.startupDelayMs : undefined,
        // Imported entries are appended in file order, after existing services.
        order: undefined,
        id: replaceAll ? rawCfg.id : undefined
      });
    }
    return this.getSnapshots();
  }

  /**
   * @param baseDir Directory the export file is written to. Working directories inside it
   * are stored relative to it (matching how import resolves them); others stay absolute.
   */
  public exportConfigs(
    baseDir: string
  ): { version: number; services: ServiceConfig[] } | ServiceConfig[] {
    const list = Array.from(this.services.values()).map((s) => ({
      ...s.config,
      cwd: relativizeCwd(s.config.cwd, baseDir)
    }));
    return this.storageState.mode === 'workspace'
      ? { version: 1, services: list }
      : list;
  }

  public clearLogs(serviceId: string): void {
    const svc = this.services.get(serviceId);
    if (!svc) return;
    svc.logs = [];
    svc.pendingBatch = [];
    svc.activeErrorBlockId = null;
    svc.runtime.errorCount = 0;
    svc.runtime.warnCount = 0;
    svc.runtime.lineCount = 0;
    this.broadcast('process:logCleared', { serviceId });
    this.broadcastRuntime(svc.runtime);
  }

  public startService(serviceId: string): ServiceRuntimeState | null {
    const svc = this.services.get(serviceId);
    if (!svc) return null;

    if (
      svc.child &&
      (svc.runtime.status === 'running' || svc.runtime.status === 'starting')
    ) {
      return { ...svc.runtime };
    }

    const { config } = svc;
    if (!fs.existsSync(config.cwd)) {
      svc.runtime.status = 'crashed';
      svc.runtime.exitCode = -1;
      this.appendSystemLine(
        svc,
        `[multi-service-console] Working directory does not exist: ${config.cwd}`,
        true
      );
      this.broadcastRuntime(svc.runtime);
      return { ...svc.runtime };
    }

    svc.stopRequested = false;
    if (svc.killTimer) {
      clearTimeout(svc.killTimer);
      svc.killTimer = null;
    }

    svc.runtime.status = config.readyPattern ? 'starting' : 'running';
    svc.runtime.startedAt = Date.now();
    svc.runtime.stoppedAt = null;
    svc.runtime.exitCode = null;
    svc.runtime.childPids = [];
    svc.runtime.detectedPorts = [];

    const resolvedCommand = normalizeShellCommand(config.command);

    this.appendSystemLine(
      svc,
      `[multi-service-console] Starting "${config.name}" in ${config.cwd}\n> ${resolvedCommand}`
    );

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: '1',
      ...(config.env ?? {})
    };

    const child = spawn(resolvedCommand, [], {
      cwd: config.cwd,
      env: mergedEnv,
      shell: true,
      windowsHide: true
    });

    svc.child = child;
    svc.runtime.pid = child.pid ?? null;
    this.broadcastRuntime(svc.runtime);

    this.attachStream(svc, child.stdout, 'stdout');
    this.attachStream(svc, child.stderr, 'stderr');

    child.on('error', (err) => {
      if (svc.child !== child) return;
      this.appendSystemLine(
        svc,
        `[multi-service-console] Spawn error: ${err.message}`,
        true
      );
      svc.runtime.status = 'crashed';
      svc.runtime.pid = null;
      svc.runtime.childPids = [];
      svc.runtime.detectedPorts = [];
      svc.runtime.stoppedAt = Date.now();
      svc.child = null;
      this.broadcastRuntime(svc.runtime);
    });

    child.on('close', (code, signal) => {
      if (svc.child !== child) return;
      this.finalizeChildExit(svc, code, signal);
    });

    // Trigger an early PID/port probe 1.2s after launch
    setTimeout(() => {
      void this.refreshProcessTreeAndPorts();
    }, 1200);

    return { ...svc.runtime };
  }

  private finalizeChildExit(
    svc: ManagedService,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (svc.killTimer) {
      clearTimeout(svc.killTimer);
      svc.killTimer = null;
    }
    const wasStoppedByUser = svc.stopRequested;
    svc.child = null;
    svc.runtime.pid = null;
    svc.runtime.childPids = [];
    svc.runtime.detectedPorts = [];
    svc.runtime.stoppedAt = Date.now();
    svc.runtime.exitCode = code ?? (wasStoppedByUser ? 0 : -1);
    svc.runtime.status =
      wasStoppedByUser || code === 0 ? 'stopped' : 'crashed';

    this.appendSystemLine(
      svc,
      `[multi-service-console] Process exited (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`,
      svc.runtime.status === 'crashed'
    );
    this.flushBatch(svc);
    this.broadcastRuntime(svc.runtime);
  }

  public async stopService(serviceId: string, force = false): Promise<void> {
    const svc = this.services.get(serviceId);
    if (!svc) return;

    const childRef = svc.child;
    const rootPid = childRef?.pid ?? svc.runtime.pid;
    if (!childRef && !rootPid && svc.runtime.childPids.length === 0) {
      if (svc.runtime.status !== 'stopped') {
        svc.runtime.status = 'stopped';
        this.broadcastRuntime(svc.runtime);
      }
      return;
    }

    svc.stopRequested = true;
    svc.runtime.status = 'stopping';
    this.appendSystemLine(
      svc,
      `[multi-service-console] Stopping process${rootPid ? ` (PID ${rootPid})` : ''}${force ? ' [force]' : ''}...`
    );
    this.broadcastRuntime(svc.runtime);

    if (process.platform === 'win32') {
      // The root shell PID is safe to kill while Node still holds its handle.
      const rootAlive = Boolean(
        childRef && childRef.exitCode === null && childRef.signalCode === null
      );
      const knownPids = new Set<number>(
        svc.runtime.childPids.filter((p) => p > 0)
      );
      if (rootPid && rootPid > 0) knownPids.add(rootPid);
      const ports = [...svc.runtime.detectedPorts];

      // Kill the root tree immediately while taking a fresh process snapshot in parallel.
      const [table, portsByPid] = await Promise.all([
        this.getProcessTable(),
        ports.length > 0 ? this.getListeningPortsByPid() : Promise.resolve(null),
        rootAlive && rootPid
          ? execCommand('taskkill', ['/PID', String(rootPid), '/T', '/F'], 4000)
          : Promise.resolve(null)
      ]);

      // Clean up orphans (e.g. a grandchild whose parent already exited). Remembered child
      // PIDs can be up to one poll old, so only kill a PID if the fresh snapshot shows its
      // parent is in our tree — a reused PID belonging to something unrelated will not be.
      // Without a snapshot we only kill the root tree above.
      const extraPids = new Set<number>();
      if (table) {
        const tree = new Set<number>(knownPids);
        if (rootPid && rootPid > 0) {
          for (const pid of collectDescendants(table, rootPid)) tree.add(pid);
        }
        const isInTree = (pid: number) => {
          const parent = table.parentOf.get(pid);
          return parent !== undefined && tree.has(parent);
        };
        for (const pid of tree) {
          if (pid !== rootPid && table.parentOf.has(pid) && isInTree(pid)) {
            extraPids.add(pid);
          }
        }
        if (portsByPid) {
          for (const [pid, pidPorts] of portsByPid) {
            if (pid !== rootPid && ports.some((p) => pidPorts.has(p)) && isInTree(pid)) {
              extraPids.add(pid);
            }
          }
        }
      }

      if (extraPids.size > 0) {
        await Promise.all(
          Array.from(extraPids).map((targetPid) =>
            execCommand('taskkill', ['/PID', String(targetPid), '/T', '/F'], 4000)
          )
        );
      }

      if (rootAlive && childRef) {
        try {
          childRef.kill('SIGKILL');
        } catch {
          // Already exited
        }
      }

      // Give Node a short moment to emit 'close'; if inherited stdio pipes stay open, destroy them
      if (childRef) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          childRef.once('close', finish);

          setTimeout(() => {
            try {
              childRef.stdout?.destroy();
              childRef.stderr?.destroy();
              childRef.stdin?.destroy();
            } catch {
              // Ignore stream destroy errors
            }
          }, 300);

          setTimeout(() => {
            if (svc.child === childRef) {
              this.finalizeChildExit(svc, 0, null);
            }
            finish();
          }, 900);
        });
      } else {
        svc.runtime.pid = null;
        svc.runtime.childPids = [];
        svc.runtime.detectedPorts = [];
        svc.runtime.stoppedAt = Date.now();
        svc.runtime.status = 'stopped';
        this.broadcastRuntime(svc.runtime);
      }
      return;
    }

    // POSIX fallback
    if (!childRef) {
      svc.runtime.status = 'stopped';
      this.broadcastRuntime(svc.runtime);
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      childRef.once('close', done);
      try {
        childRef.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // Ignore
      }
      svc.killTimer = setTimeout(() => {
        if (svc.child === childRef) {
          try {
            childRef.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
        setTimeout(() => {
          if (svc.child === childRef) {
            this.finalizeChildExit(svc, 0, 'SIGKILL');
          }
          done();
        }, 400);
      }, 2000);
    });
  }

  public async restartService(serviceId: string): Promise<void> {
    await this.stopService(serviceId, true);
    await new Promise((r) => setTimeout(r, 150));
    this.startService(serviceId);
  }

  /** Snapshot of all Windows processes, or null if it could not be taken (timeout, parse error). */
  private async getProcessTable(): Promise<ProcessTable | null> {
    if (process.platform !== 'win32') return null;
    const raw = await execCommand(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TABLE_PS],
      PROCESS_TABLE_TIMEOUT_MS
    );
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as
        | Array<{ ProcessId: number; ParentProcessId: number }>
        | { ProcessId: number; ParentProcessId: number };
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const childrenByParent = new Map<number, number[]>();
      const parentOf = new Map<number, number>();
      for (const item of list) {
        if (
          !item ||
          typeof item.ProcessId !== 'number' ||
          typeof item.ParentProcessId !== 'number'
        ) {
          continue;
        }
        parentOf.set(item.ProcessId, item.ParentProcessId);
        const arr = childrenByParent.get(item.ParentProcessId) ?? [];
        arr.push(item.ProcessId);
        childrenByParent.set(item.ParentProcessId, arr);
      }
      return parentOf.size > 0 ? { childrenByParent, parentOf } : null;
    } catch {
      return null;
    }
  }

  /** Listening TCP ports (IPv4 and IPv6) per PID, or null if netstat failed. */
  private async getListeningPortsByPid(): Promise<Map<number, Set<number>> | null> {
    if (process.platform !== 'win32') return null;
    const out = await execCommand('netstat', ['-ano']);
    if (out === null) return null;
    const portsByPid = new Map<number, Set<number>>();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || !parts[0].toUpperCase().startsWith('TCP')) continue;
      const localAddr = parts[1];
      const pid = Number.parseInt(parts[4], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const colonIdx = localAddr.lastIndexOf(':');
      if (colonIdx === -1) continue;
      const port = Number.parseInt(localAddr.slice(colonIdx + 1), 10);
      if (!Number.isFinite(port)) continue;
      const set = portsByPid.get(pid) ?? new Set<number>();
      set.add(port);
      portsByPid.set(pid, set);
    }
    return portsByPid;
  }

  public async startGroup(groupName: string): Promise<void> {
    // Map order is the order shown in the sidebar.
    const items = Array.from(this.services.values()).filter(
      (s) => s.config.group === groupName
    );

    for (const item of items) {
      this.startService(item.config.id);
      if (item.config.startupDelayMs && item.config.startupDelayMs > 0) {
        await new Promise((r) => setTimeout(r, item.config.startupDelayMs));
      }
    }
  }

  public async stopGroup(groupName: string): Promise<void> {
    const items = Array.from(this.services.values()).filter(
      (s) => s.config.group === groupName && s.child
    );
    await Promise.all(items.map((s) => this.stopService(s.config.id, false)));
  }

  public async startAll(): Promise<void> {
    // Map order is the order shown in the sidebar.
    const items = Array.from(this.services.values());
    for (const item of items) {
      this.startService(item.config.id);
      if (item.config.startupDelayMs && item.config.startupDelayMs > 0) {
        await new Promise((r) => setTimeout(r, item.config.startupDelayMs));
      }
    }
  }

  public async stopAll(force = false): Promise<void> {
    const items = Array.from(this.services.values()).filter((s) => s.child);
    await Promise.all(items.map((s) => this.stopService(s.config.id, force)));
  }

  public async killPort(port: number): Promise<{ killedPids: number[] }> {
    if (process.platform !== 'win32') return { killedPids: [] };
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { killedPids: [] };
    }
    const portsByPid = await this.getListeningPortsByPid();
    const pids = new Set<number>();
    for (const [pid, ports] of portsByPid ?? []) {
      // Never target the System process or this app itself.
      if (pid <= 4 || pid === process.pid) continue;
      if (ports.has(port)) pids.add(pid);
    }

    const killedPids: number[] = [];
    for (const pid of pids) {
      const result = await execCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
      if (result !== null) killedPids.push(pid);
    }
    return { killedPids };
  }

  private attachStream(
    svc: ManagedService,
    stream: NodeJS.ReadableStream | null,
    streamName: 'stdout' | 'stderr'
  ): void {
    if (!stream) return;
    let remainder = '';
    // Decode as a stream so multi-byte UTF-8 characters split across chunks stay intact.
    stream.setEncoding('utf8');

    stream.on('data', (chunk: string) => {
      const text = remainder + chunk;
      const parts = text.split(/\r\n|\n|\r/);
      remainder = parts.pop() ?? '';

      for (const line of parts) {
        if (line.length === 0) continue;
        this.ingestLine(svc, line, streamName);
      }
    });

    stream.on('end', () => {
      if (remainder.length > 0) {
        this.ingestLine(svc, remainder, streamName);
        remainder = '';
      }
    });
  }

  private appendSystemLine(
    svc: ManagedService,
    text: string,
    isError = false
  ): void {
    for (const part of text.split(/\r?\n/)) {
      this.ingestLine(svc, part, 'system', isError ? 'error' : 'system');
    }
  }

  private ingestLine(
    svc: ManagedService,
    rawInput: string,
    stream: 'stdout' | 'stderr' | 'system',
    forcedLevel?: LogLine['level']
  ): void {
    const now = Date.now();
    const parsed = parseAnsiLine(rawInput);
    const level = forcedLevel ?? classifyLogLevel(parsed.raw, stream);

    let isErrorStart = false;
    let errorBlockId: number | undefined;

    if (level === 'error') {
      const continuation =
        svc.activeErrorBlockId !== null &&
        now - svc.lastErrorAt < 1500 &&
        (isStackTraceContinuation(parsed.raw) || stream === 'stderr');

      if (continuation && svc.activeErrorBlockId !== null) {
        errorBlockId = svc.activeErrorBlockId;
      } else {
        isErrorStart = true;
        errorBlockId = svc.nextErrorBlockId++;
        svc.activeErrorBlockId = errorBlockId;
        svc.runtime.errorCount += 1;
      }
      svc.lastErrorAt = now;
    } else if (
      svc.activeErrorBlockId !== null &&
      now - svc.lastErrorAt < 1500 &&
      isStackTraceContinuation(parsed.raw)
    ) {
      errorBlockId = svc.activeErrorBlockId;
      svc.lastErrorAt = now;
    } else {
      svc.activeErrorBlockId = null;
    }

    if (level === 'warn') {
      svc.runtime.warnCount += 1;
    }

    if (
      svc.runtime.status === 'starting' &&
      svc.readyRegex &&
      svc.readyRegex.test(parsed.raw)
    ) {
      svc.runtime.status = 'running';
      this.broadcastRuntime(svc.runtime);
    }

    const line: LogLine = {
      id: svc.nextLineId++,
      seq: nextGlobalLineSeq++,
      serviceId: svc.config.id,
      timestamp: now,
      stream,
      level,
      raw: parsed.raw,
      spans: parsed.spans,
      ...(isErrorStart ? { isErrorStart: true } : {}),
      ...(errorBlockId !== undefined ? { errorBlockId } : {})
    };

    svc.logs.push(line);
    if (svc.logs.length > MAX_LOG_LINES + LOG_TRIM_CHUNK) {
      svc.logs.splice(0, svc.logs.length - MAX_LOG_LINES);
    }
    svc.runtime.lineCount = svc.logs.length;
    svc.pendingBatch.push(line);
  }

  private flushBatch(svc: ManagedService): void {
    if (svc.pendingBatch.length === 0) return;
    const lines = svc.pendingBatch;
    svc.pendingBatch = [];
    const payload: LogBatchEvent = {
      serviceId: svc.config.id,
      lines
    };
    this.broadcast('process:logBatch', payload);
    this.broadcastRuntime(svc.runtime);
  }

  private flushAllBatches(): void {
    for (const svc of this.services.values()) {
      if (svc.pendingBatch.length > 0) {
        this.flushBatch(svc);
      }
    }
  }

  private async refreshProcessTreeAndPorts(): Promise<void> {
    if (this.pollInFlight || process.platform !== 'win32') return;

    const activeServices = Array.from(this.services.values()).filter(
      (s) =>
        s.runtime.pid !== null &&
        (s.runtime.status === 'running' ||
          s.runtime.status === 'starting' ||
          s.runtime.status === 'stopping')
    );

    if (activeServices.length === 0) return;
    this.pollInFlight = true;

    try {
      const [table, portsByPid] = await Promise.all([
        this.getProcessTable(),
        this.getListeningPortsByPid()
      ]);

      for (const svc of activeServices) {
        if (svc.stopRequested || !svc.child) continue;
        const rootPid = svc.runtime.pid;
        if (!rootPid) continue;

        // If a snapshot failed (e.g. PowerShell timed out), keep the previous values
        // rather than treating the failure as "no children / no ports".
        const descendants = table
          ? collectDescendants(table, rootPid)
          : svc.runtime.childPids;

        let detectedPorts = svc.runtime.detectedPorts;
        if (portsByPid) {
          const portSet = new Set<number>();
          for (const pid of [rootPid, ...descendants]) {
            for (const port of portsByPid.get(pid) ?? []) portSet.add(port);
          }
          detectedPorts = Array.from(portSet).sort((a, b) => a - b);
        }

        const pidsChanged =
          descendants.join(',') !== svc.runtime.childPids.join(',');
        const portsChanged =
          detectedPorts.join(',') !== svc.runtime.detectedPorts.join(',');

        if (pidsChanged || portsChanged) {
          svc.runtime.childPids = descendants;
          svc.runtime.detectedPorts = detectedPorts;
          this.broadcastRuntime(svc.runtime);
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private broadcastRuntime(runtime: ServiceRuntimeState): void {
    this.broadcast('process:runtime', { ...runtime });
  }

  private broadcastConfigsChanged(): void {
    this.broadcast('process:snapshots', this.getSnapshots());
  }

  private broadcastStorageChanged(): void {
    this.broadcast('process:storage', this.getStorageState());
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }
}

export function normalizeShellCommand(command: string): string {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length <= 1) {
    return lines[0] ?? command.trim();
  }

  let combined = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0) {
      combined = line;
      continue;
    }

    if (combined.endsWith('^')) {
      combined = `${combined.slice(0, -1).trimEnd()} ${line}`;
    } else if (
      /(?:&&|\|\||[&;])$/.test(combined) ||
      /^(?:&&|\|\|)/.test(line)
    ) {
      combined = `${combined} ${line}`;
    } else {
      combined = `${combined} && ${line}`;
    }
  }
  return combined;
}

/** Run a command and resolve with its stdout, or null if it failed, timed out or exited non-zero. */
function execCommand(
  cmd: string,
  args: string[],
  timeoutMs = 2500
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? null : stdout || '');
      }
    );
  });
}
