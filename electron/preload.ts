import { contextBridge, ipcRenderer } from 'electron';
import {
  AppBootstrapData,
  ConfigStorageState,
  DiscoveredServiceCandidate,
  LogBatchEvent,
  LogClearedEvent,
  LogLine,
  ServiceConfig,
  ServiceRuntimeState,
  ServiceSnapshot,
  WorkspaceSwitchResult
} from '../shared/types';

export interface MultiServiceConsoleApi {
  bootstrap: () => Promise<AppBootstrapData>;
  switchToGlobal: () => Promise<WorkspaceSwitchResult>;
  openWorkspace: (folderPath?: string) => Promise<WorkspaceSwitchResult | null>;
  saveCopyToWorkspace: () => Promise<WorkspaceSwitchResult | null>;
  removeRecentWorkspace: (folderPath: string) => Promise<ConfigStorageState>;
  getLogs: (serviceId: string) => Promise<LogLine[]>;
  upsertService: (
    input: Partial<ServiceConfig> & {
      name: string;
      command: string;
      cwd: string;
    }
  ) => Promise<ServiceSnapshot>;
  deleteService: (serviceId: string) => Promise<void>;
  reorderService: (
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ) => Promise<ServiceSnapshot[]>;
  startService: (serviceId: string) => Promise<ServiceRuntimeState | null>;
  stopService: (serviceId: string, force?: boolean) => Promise<void>;
  restartService: (serviceId: string) => Promise<void>;
  clearLogs: (serviceId: string) => Promise<void>;
  startGroup: (groupName: string) => Promise<void>;
  stopGroup: (groupName: string) => Promise<void>;
  startAll: () => Promise<void>;
  stopAll: (force?: boolean) => Promise<void>;
  killPort: (port: number) => Promise<{ killedPids: number[] }>;
  openPopout: (serviceId: string, serviceName?: string) => Promise<void>;
  showInExplorer: (
    folderPath: string
  ) => Promise<{ ok: boolean; error?: string }>;
  openTerminal: (
    folderPath: string
  ) => Promise<{ ok: boolean; error?: string }>;
  pickFolder: () => Promise<string | null>;
  scanFolder: (folderPath: string) => Promise<DiscoveredServiceCandidate[]>;
  importMany: (
    configs: ServiceConfig[],
    replaceAll?: boolean
  ) => Promise<ServiceSnapshot[]>;
  exportConfigs: () => Promise<boolean>;
  importConfigs: () => Promise<ServiceSnapshot[] | null>;
  saveLogText: (defaultName: string, content: string) => Promise<boolean>;
  writeClipboard: (text: string) => Promise<void>;
  setThemeSource: (source: 'system' | 'light' | 'dark') => Promise<void>;
  onLogBatch: (callback: (event: LogBatchEvent) => void) => () => void;
  onLogCleared: (callback: (event: LogClearedEvent) => void) => () => void;
  onRuntimeUpdate: (
    callback: (runtime: ServiceRuntimeState) => void
  ) => () => void;
  onSnapshotsUpdate: (
    callback: (snapshots: ServiceSnapshot[]) => void
  ) => () => void;
  onStorageUpdate: (callback: (storage: ConfigStorageState) => void) => () => void;
  onAppError: (callback: (message: string) => void) => () => void;
}

const api: MultiServiceConsoleApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  switchToGlobal: () => ipcRenderer.invoke('storage:switchToGlobal'),
  openWorkspace: (folderPath) =>
    ipcRenderer.invoke('storage:openWorkspace', folderPath),
  saveCopyToWorkspace: () => ipcRenderer.invoke('storage:saveCopyToWorkspace'),
  removeRecentWorkspace: (folderPath) =>
    ipcRenderer.invoke('storage:removeRecent', folderPath),
  getLogs: (serviceId) => ipcRenderer.invoke('process:getLogs', serviceId),
  upsertService: (input) => ipcRenderer.invoke('process:upsert', input),
  deleteService: (serviceId) => ipcRenderer.invoke('process:delete', serviceId),
  reorderService: (draggedId, targetId, position) =>
    ipcRenderer.invoke('process:reorder', draggedId, targetId, position),
  startService: (serviceId) => ipcRenderer.invoke('process:start', serviceId),
  stopService: (serviceId, force) =>
    ipcRenderer.invoke('process:stop', serviceId, force),
  restartService: (serviceId) =>
    ipcRenderer.invoke('process:restart', serviceId),
  clearLogs: (serviceId) => ipcRenderer.invoke('process:clearLogs', serviceId),
  startGroup: (groupName) =>
    ipcRenderer.invoke('process:startGroup', groupName),
  stopGroup: (groupName) => ipcRenderer.invoke('process:stopGroup', groupName),
  startAll: () => ipcRenderer.invoke('process:startAll'),
  stopAll: (force) => ipcRenderer.invoke('process:stopAll', force),
  killPort: (port) => ipcRenderer.invoke('process:killPort', port),
  openPopout: (serviceId, serviceName) =>
    ipcRenderer.invoke('window:openPopout', serviceId, serviceName),
  showInExplorer: (folderPath) =>
    ipcRenderer.invoke('shell:showInExplorer', folderPath),
  openTerminal: (folderPath) =>
    ipcRenderer.invoke('shell:openTerminal', folderPath),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  scanFolder: (folderPath) =>
    ipcRenderer.invoke('workspace:scanFolder', folderPath),
  importMany: (configs, replaceAll) =>
    ipcRenderer.invoke('process:importMany', configs, replaceAll),
  exportConfigs: () => ipcRenderer.invoke('dialog:exportConfigs'),
  importConfigs: () => ipcRenderer.invoke('dialog:importConfigs'),
  saveLogText: (defaultName, content) =>
    ipcRenderer.invoke('dialog:saveLogText', defaultName, content),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  setThemeSource: (source) => ipcRenderer.invoke('theme:setSource', source),

  onLogBatch: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, data: LogBatchEvent) =>
      callback(data);
    ipcRenderer.on('process:logBatch', handler);
    return () => ipcRenderer.removeListener('process:logBatch', handler);
  },
  onLogCleared: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, data: LogClearedEvent) =>
      callback(data);
    ipcRenderer.on('process:logCleared', handler);
    return () => ipcRenderer.removeListener('process:logCleared', handler);
  },
  onRuntimeUpdate: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: ServiceRuntimeState
    ) => callback(data);
    ipcRenderer.on('process:runtime', handler);
    return () => ipcRenderer.removeListener('process:runtime', handler);
  },
  onSnapshotsUpdate: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: ServiceSnapshot[]
    ) => callback(data);
    ipcRenderer.on('process:snapshots', handler);
    return () => ipcRenderer.removeListener('process:snapshots', handler);
  },
  onStorageUpdate: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: ConfigStorageState
    ) => callback(data);
    ipcRenderer.on('process:storage', handler);
    return () => ipcRenderer.removeListener('process:storage', handler);
  },
  onAppError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, message: string) =>
      callback(message);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.removeListener('app:error', handler);
  }
};

contextBridge.exposeInMainWorld('serviceConsole', api);
