export type ServiceType =
  | 'java'
  | 'node'
  | 'kafka'
  | 'docker'
  | 'python'
  | 'shell';

export type ServiceStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug' | 'system';

export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface LogLine {
  id: number;
  serviceId: string;
  timestamp: number;
  stream: 'stdout' | 'stderr' | 'system';
  level: LogLevel;
  raw: string;
  spans: AnsiSpan[];
  isErrorStart?: boolean;
  errorBlockId?: number;
}

export interface ServiceConfig {
  id: string;
  name: string;
  group: string;
  type: ServiceType;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  ports?: number[];
  readyPattern?: string;
  startupDelayMs?: number;
  autoScrollDefault?: boolean;
  order?: number;
}

export interface ServiceRuntimeState {
  serviceId: string;
  status: ServiceStatus;
  pid: number | null;
  childPids: number[];
  detectedPorts: number[];
  startedAt: number | null;
  stoppedAt: number | null;
  exitCode: number | null;
  errorCount: number;
  warnCount: number;
  lineCount: number;
}

export interface ServiceSnapshot {
  config: ServiceConfig;
  runtime: ServiceRuntimeState;
}

export interface DiscoveredServiceCandidate {
  tempId: string;
  name: string;
  group: string;
  type: ServiceType;
  command: string;
  cwd: string;
  ports?: number[];
  sourceFile: string;
}

export interface LogBatchEvent {
  serviceId: string;
  lines: LogLine[];
}

export interface LogClearedEvent {
  serviceId: string;
}

export interface ConfigStorageState {
  mode: 'global' | 'workspace';
  workspaceRoot: string | null;
  configFilePath: string;
  recentWorkspaces: string[];
}

export interface WorkspaceSwitchResult {
  storage: ConfigStorageState;
  services: ServiceSnapshot[];
  createdNewFile: boolean;
}

export interface AppBootstrapData {
  services: ServiceSnapshot[];
  popoutServiceId: string | null;
  storage: ConfigStorageState;
}
