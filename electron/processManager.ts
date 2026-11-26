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

const MAX_LOG_LINES = 25_000;
const BATCH_FLUSH_MS = 60;
const PROCESS_POLL_MS = 3000;
const WORKSPACE_CONFIG_FILENAME = 'multi-service-console.json';
const MAX_RECENT_WORKSPACES = 10;

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

export class ProcessManager {
  private services = new Map<string, ManagedService>();
  private flushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
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
      recentWorkspaces
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
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      const payload: AppSettingsFile = {
        mode: state.mode,
        workspaceRoot: state.workspaceRoot,
        recentWorkspaces: state.recentWorkspaces
      };
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify(payload, null, 2),
        'utf8'
      );
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
    const rel = path.relative(this.storageState.workspaceRoot, absCwd);
    if (!rel) return '.';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `./${rel.replace(/\\/g, '/')}`;
    }
    return absCwd;
  }

  private parseConfigArray(raw: string): ServiceConfig[] {
    const parsed = JSON.parse(raw) as ServiceConfig[] | StoredConfigFileObject;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.services)) {
      return parsed.services;
    }
    return [];
  }

  private loadConfigs(): void {
    this.services.clear();
    try {
      if (!fs.existsSync(this.storageState.configFilePath)) {
        return;
      }
      const raw = fs.readFileSync(this.storageState.configFilePath, 'utf8');
      const list = this.parseConfigArray(raw);

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
        this.services.set(cfg.id, {
          config: cfg,
          runtime: createInitialRuntime(cfg.id),
          child: null,
          logs: [],
          nextLineId: 1,
          nextErrorBlockId: 1,
          activeErrorBlockId: null,
          lastErrorAt: 0,
          pendingBatch: [],
          stopRequested: false,
          readyRegex: compileReadyRegex(cfg.readyPattern),
          killTimer: null
        });
      }
    } catch {
      // Ignore corrupt config file on boot
    }
  }

  private saveConfigs(): void {
    const configs = Array.from(this.services.values()).map((s) => ({
      ...s.config,
      cwd: this.serializeSavedCwd(s.config.cwd)
    }));
    try {
      fs.mkdirSync(path.dirname(this.storageState.configFilePath), {
        recursive: true
      });
      const content =
        this.storageState.mode === 'workspace'
          ? JSON.stringify({ version: 1, services: configs }, null, 2)
          : JSON.stringify(configs, null, 2);
      fs.writeFileSync(this.storageState.configFilePath, content, 'utf8');
    } catch {
      // Ignore write failure
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
      recentWorkspaces: this.storageState.recentWorkspaces
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
      )
    };
    this.saveSettings(this.storageState);

    if (createdNewFile) {
      this.services.clear();
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
      )
    };
    this.saveSettings(this.storageState);

    this.services.clear();
    for (const cfg of currentServices) {
      this.services.set(cfg.id, {
        config: cfg,
        runtime: createInitialRuntime(cfg.id),
        child: null,
        logs: [],
        nextLineId: 1,
        nextErrorBlockId: 1,
        activeErrorBlockId: null,
        lastErrorAt: 0,
        pendingBatch: [],
        stopRequested: false,
        readyRegex: compileReadyRegex(cfg.readyPattern),
        killTimer: null
      });
    }
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
    return svc.logs.slice();
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

    const managed: ManagedService = {
      config,
      runtime: createInitialRuntime(id),
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

  public importConfigs(configs: ServiceConfig[], replaceAll = false): ServiceSnapshot[] {
    if (replaceAll) {
      for (const [id, svc] of this.services) {
        if (!svc.child) {
          this.services.delete(id);
        }
      }
    }

    for (const rawCfg of configs) {
      if (!rawCfg.name || !rawCfg.command || !rawCfg.cwd) continue;
      this.upsertService({
        ...rawCfg,
        id: replaceAll ? rawCfg.id : undefined
      });
    }
    return this.getSnapshots();
  }

  public exportConfigs(): { version: number; services: ServiceConfig[] } | ServiceConfig[] {
    const list = Array.from(this.services.values()).map((s) => ({
      ...s.config,
      cwd: this.serializeSavedCwd(s.config.cwd)
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

    this.appendSystemLine(
      svc,
      `[multi-service-console] Starting "${config.name}" in ${config.cwd}\n> ${config.command}`
    );

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: '1',
      ...(config.env ?? {})
    };

    const child = spawn(config.command, [], {
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
    });

    // Trigger an early PID/port probe 1.2s after launch
    setTimeout(() => {
      void this.refreshProcessTreeAndPorts();
    }, 1200);

    return { ...svc.runtime };
  }

  public async stopService(serviceId: string, force = false): Promise<void> {
    const svc = this.services.get(serviceId);
    if (!svc || !svc.child) return;

    const pid = svc.child.pid;
    svc.stopRequested = true;
    svc.runtime.status = 'stopping';
    this.appendSystemLine(
      svc,
      `[multi-service-console] Stopping process${pid ? ` (PID ${pid})` : ''}${force ? ' [force]' : ''}...`
    );
    this.broadcastRuntime(svc.runtime);

    if (!pid) {
      svc.child.kill('SIGKILL');
      return;
    }

    await new Promise<void>((resolve) => {
      const childRef = svc.child;
      if (!childRef) {
        resolve();
        return;
      }

      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      childRef.once('close', done);

      if (process.platform === 'win32') {
        const args = force
          ? ['/PID', String(pid), '/T', '/F']
          : ['/PID', String(pid), '/T'];
        execFile('taskkill', args, { windowsHide: true }, () => {
          // If graceful taskkill didn't close it within 2.5s, force kill the tree
          if (!force && svc.child === childRef) {
            svc.killTimer = setTimeout(() => {
              execFile(
                'taskkill',
                ['/PID', String(pid), '/T', '/F'],
                { windowsHide: true },
                () => done()
              );
            }, 2500);
          }
        });
        setTimeout(done, force ? 2000 : 4000);
      } else {
        try {
          childRef.kill(force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // Ignore
        }
        setTimeout(() => {
          if (svc.child === childRef) {
            try {
              childRef.kill('SIGKILL');
            } catch {
              // Ignore
            }
          }
          done();
        }, 2500);
      }
    });
  }

  public async restartService(serviceId: string): Promise<void> {
    await this.stopService(serviceId, false);
    this.startService(serviceId);
  }

  public async startGroup(groupName: string): Promise<void> {
    const items = Array.from(this.services.values())
      .filter((s) => s.config.group === groupName)
      .sort((a, b) => (a.config.order ?? 0) - (b.config.order ?? 0));

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
    const items = Array.from(this.services.values()).sort(
      (a, b) => (a.config.order ?? 0) - (b.config.order ?? 0)
    );
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
    const netstatOut = await execCommand('netstat', ['-ano', '-p', 'TCP']);
    const pids = new Set<number>();
    for (const line of netstatOut.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const localAddr = parts[1];
      const pid = Number.parseInt(parts[4], 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const colonIdx = localAddr.lastIndexOf(':');
      if (colonIdx === -1) continue;
      const addrPort = Number.parseInt(localAddr.slice(colonIdx + 1), 10);
      if (addrPort === port) {
        pids.add(pid);
      }
    }

    const killedPids: number[] = [];
    for (const pid of pids) {
      await execCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
      killedPids.push(pid);
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

    stream.on('data', (chunk: Buffer | string) => {
      const text = remainder + chunk.toString('utf8');
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
    if (svc.logs.length > MAX_LOG_LINES) {
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
      const [procRaw, netstatRaw] = await Promise.all([
        execCommand('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
        ]),
        execCommand('netstat', ['-ano', '-p', 'TCP'])
      ]);

      // Build parent -> children map
      const childrenByParent = new Map<number, number[]>();
      if (procRaw.trim()) {
        try {
          const parsed = JSON.parse(procRaw) as
            | Array<{ ProcessId: number; ParentProcessId: number }>
            | { ProcessId: number; ParentProcessId: number };
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list) {
            if (!item) continue;
            const arr = childrenByParent.get(item.ParentProcessId) ?? [];
            arr.push(item.ProcessId);
            childrenByParent.set(item.ParentProcessId, arr);
          }
        } catch {
          // Ignore parse glitch
        }
      }

      // Build pid -> listening ports map
      const portsByPid = new Map<number, Set<number>>();
      for (const line of netstatRaw.split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
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

      for (const svc of activeServices) {
        const rootPid = svc.runtime.pid;
        if (!rootPid) continue;

        const descendants: number[] = [];
        const queue = [rootPid];
        const visited = new Set<number>([rootPid]);

        while (queue.length > 0) {
          const current = queue.shift()!;
          const kids = childrenByParent.get(current) ?? [];
          for (const kid of kids) {
            if (!visited.has(kid)) {
              visited.add(kid);
              descendants.push(kid);
              queue.push(kid);
            }
          }
        }

        const portSet = new Set<number>();
        for (const pid of visited) {
          const p = portsByPid.get(pid);
          if (p) {
            for (const port of p) portSet.add(port);
          }
        }
        const detectedPorts = Array.from(portSet).sort((a, b) => a - b);

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

function execCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        resolve(stdout || '');
      }
    );
  });
}
