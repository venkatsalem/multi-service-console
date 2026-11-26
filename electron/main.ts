import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  IpcMainInvokeEvent,
  nativeTheme,
  screen,
  session,
  shell
} from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { ServiceConfig } from '../shared/types';
import { writeFileAtomic } from './fsUtils';
import { ProcessManager } from './processManager';
import { scanFolderForServices } from './workspaceScanner';

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

const popoutWindows = new Map<string, BrowserWindow>();
const windowPopoutServiceMap = new Map<number, string>();
let mainWindow: BrowserWindow | null = null;
let processManager: ProcessManager;
let isQuitting = false;

// The renderer can run arbitrary shell commands through IPC, so only our own
// pages may load in app windows or call IPC handlers.
const RENDERER_INDEX_PATH = path.join(__dirname, '../../dist/index.html');
const trustedOrigins = new Set<string>();

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'file:') {
      return (
        path.resolve(fileURLToPath(url)).toLowerCase() ===
        path.resolve(RENDERER_INDEX_PATH).toLowerCase()
      );
    }
    return trustedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(frame && frame.parent === null && isTrustedRendererUrl(frame.url));
}

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

function handle(channel: string, listener: IpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error(`Blocked IPC call to "${channel}" from an untrusted page`);
    }
    return listener(event, ...args);
  });
}

function isExistingDirectory(folderPath: unknown): folderPath is string {
  if (typeof folderPath !== 'string' || !folderPath) return false;
  try {
    return fs.statSync(folderPath).isDirectory();
  } catch {
    return false;
  }
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  const defaults: WindowState = { width: 1480, height: 920 };
  try {
    const raw = fs.readFileSync(getWindowStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const width =
      typeof parsed.width === 'number' && parsed.width >= 640
        ? Math.round(parsed.width)
        : defaults.width;
    const height =
      typeof parsed.height === 'number' && parsed.height >= 480
        ? Math.round(parsed.height)
        : defaults.height;
    const isMaximized = Boolean(parsed.isMaximized);

    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      const displays = screen.getAllDisplays();
      const visibleOnAnyDisplay = displays.some((d) => {
        const b = d.workArea;
        return (
          parsed.x! < b.x + b.width - 80 &&
          parsed.x! + width > b.x + 80 &&
          parsed.y! < b.y + b.height - 80 &&
          parsed.y! + height > b.y + 40
        );
      });
      if (visibleOnAnyDisplay) {
        return {
          width,
          height,
          x: Math.round(parsed.x),
          y: Math.round(parsed.y),
          isMaximized
        };
      }
    }

    return { width, height, isMaximized };
  } catch {
    return defaults;
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized
    };
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    // Ignore persistence failure
  }
}

function isLocalPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(150);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function loadRenderer(
  win: BrowserWindow,
  popoutServiceId?: string
): Promise<void> {
  const explicitUrl = process.env.VITE_DEV_SERVER_URL;
  const query = popoutServiceId
    ? `?popoutServiceId=${encodeURIComponent(popoutServiceId)}`
    : '';

  if (explicitUrl) {
    trustedOrigins.add(new URL(explicitUrl).origin);
    await win.loadURL(`${explicitUrl}${query}`);
    return;
  }

  if (!app.isPackaged && (await isLocalPortOpen(5174))) {
    trustedOrigins.add('http://localhost:5174');
    await win.loadURL(`http://localhost:5174${query}`);
    return;
  }

  await win.loadFile(RENDERER_INDEX_PATH, {
    query: popoutServiceId ? { popoutServiceId } : undefined
  });
}

function getAppIconPath(): string | undefined {
  const file =
    process.platform === 'win32'
      ? path.join(__dirname, '../../assets/icon.ico')
      : path.join(__dirname, '../../assets/icon.png');
  return fs.existsSync(file) ? file : undefined;
}

function createMainWindow(): BrowserWindow {
  const saved = loadWindowState();
  const icon = getAppIconPath();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: 960,
    minHeight: 600,
    icon,
    title: 'Multi-Service Console',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191c' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (saved.isMaximized) {
    win.maximize();
  }

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 250);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);

  win.on('close', (e) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveWindowState(win);
    if (isQuitting) return;

    const running = processManager.getRunningCount();
    if (running > 0) {
      e.preventDefault();
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          buttons: ['Stop All & Quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          title: 'Processes Still Running',
          message: `${running} service process${running === 1 ? ' is' : 'es are'} still running.`,
          detail:
            'Closing Multi-Service Console will stop all running child process trees before exiting.'
        })
        .then(async (res) => {
          if (res.response === 0) {
            isQuitting = true;
            await processManager.stopAll(true);
            for (const popWin of popoutWindows.values()) {
              if (!popWin.isDestroyed()) popWin.destroy();
            }
            if (!win.isDestroyed()) win.destroy();
            app.quit();
          }
        });
    } else {
      for (const popWin of popoutWindows.values()) {
        if (!popWin.isDestroyed()) popWin.close();
      }
    }
  });

  win.on('closed', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (mainWindow === win) mainWindow = null;
  });

  void loadRenderer(win);
  mainWindow = win;
  return win;
}

function openPopoutWindow(serviceId: string, serviceName?: string): void {
  const existing = popoutWindows.get(serviceId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 760,
    minHeight: 500,
    icon: getAppIconPath(),
    title: serviceName
      ? `${serviceName} — Console`
      : 'Service Console — Popout',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191c' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const webContentsId = win.webContents.id;
  windowPopoutServiceMap.set(webContentsId, serviceId);
  popoutWindows.set(serviceId, win);

  win.on('closed', () => {
    popoutWindows.delete(serviceId);
    windowPopoutServiceMap.delete(webContentsId);
  });

  void loadRenderer(win, serviceId);
}

function registerIpcHandlers(): void {
  handle('app:bootstrap', (event) => {
    const popoutServiceId =
      windowPopoutServiceMap.get(event.sender.id) ?? null;
    return {
      services: processManager.getSnapshots(),
      popoutServiceId,
      storage: processManager.getStorageState()
    };
  });

  handle('storage:switchToGlobal', () =>
    processManager.switchToGlobal()
  );

  handle(
    'storage:openWorkspace',
    async (event, folderPath?: string) => {
      let target = folderPath;
      if (!target) {
        const parent = BrowserWindow.fromWebContents(event.sender);
        const options: Electron.OpenDialogOptions = {
          properties: ['openDirectory'],
          title: 'Open Workspace Folder (multi-service-console.json)'
        };
        const result = parent
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) return null;
        target = result.filePaths[0];
      }
      return processManager.openWorkspace(target);
    }
  );

  handle('storage:saveCopyToWorkspace', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder to Save Services Into'
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return processManager.saveCopyToWorkspace(result.filePaths[0]);
  });

  handle('storage:removeRecent', (_e, folderPath: string) =>
    processManager.removeRecentWorkspace(folderPath)
  );

  handle('process:getLogs', (_e, serviceId: string) =>
    processManager.getLogs(serviceId)
  );

  handle(
    'process:upsert',
    (
      _e,
      input: Partial<ServiceConfig> & {
        name: string;
        command: string;
        cwd: string;
      }
    ) => processManager.upsertService(input)
  );

  handle('process:delete', (_e, serviceId: string) =>
    processManager.deleteService(serviceId)
  );

  handle(
    'process:reorder',
    (
      _e,
      draggedId: string,
      targetId: string,
      position: 'before' | 'after'
    ) => processManager.reorderService(draggedId, targetId, position)
  );

  handle('process:start', (_e, serviceId: string) =>
    processManager.startService(serviceId)
  );

  handle('process:stop', (_e, serviceId: string, force?: boolean) =>
    processManager.stopService(serviceId, Boolean(force))
  );

  handle('process:restart', (_e, serviceId: string) =>
    processManager.restartService(serviceId)
  );

  handle('process:clearLogs', (_e, serviceId: string) =>
    processManager.clearLogs(serviceId)
  );

  handle('process:startGroup', (_e, groupName: string) =>
    processManager.startGroup(groupName)
  );

  handle('process:stopGroup', (_e, groupName: string) =>
    processManager.stopGroup(groupName)
  );

  handle('process:startAll', () => processManager.startAll());

  handle('process:stopAll', (_e, force?: boolean) =>
    processManager.stopAll(Boolean(force))
  );

  handle('process:killPort', (_e, port: number) =>
    processManager.killPort(port)
  );

  handle(
    'window:openPopout',
    (_e, serviceId: string, serviceName?: string) => {
      openPopoutWindow(serviceId, serviceName);
    }
  );

  handle(
    'shell:showInExplorer',
    async (_e, folderPath: string): Promise<{ ok: boolean; error?: string }> => {
      // shell.openPath runs files, so only ever hand it a directory.
      if (!isExistingDirectory(folderPath)) {
        return {
          ok: false,
          error: `Working directory does not exist: ${folderPath}`
        };
      }
      const err = await shell.openPath(folderPath);
      return err ? { ok: false, error: err } : { ok: true };
    }
  );

  handle(
    'shell:openTerminal',
    async (_e, folderPath: string): Promise<{ ok: boolean; error?: string }> => {
      if (!isExistingDirectory(folderPath)) {
        return {
          ok: false,
          error: `Working directory does not exist: ${folderPath}`
        };
      }

      if (process.platform === 'win32') {
        return new Promise((resolve) => {
          const wt = spawn('wt.exe', ['-d', folderPath], {
            cwd: folderPath,
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          });

          let settled = false;
          wt.once('spawn', () => {
            if (settled) return;
            settled = true;
            wt.unref();
            resolve({ ok: true });
          });

          wt.once('error', () => {
            if (settled) return;
            settled = true;
            try {
              const fallback = spawn(
                'cmd.exe',
                ['/c', 'start', '""', 'cmd.exe'],
                {
                  cwd: folderPath,
                  detached: true,
                  stdio: 'ignore',
                  windowsHide: false
                }
              );
              fallback.unref();
              resolve({ ok: true });
            } catch (err) {
              resolve({
                ok: false,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          });
        });
      }

      return { ok: false, error: 'Unsupported platform for terminal launch' };
    }
  );

  handle('dialog:pickFolder', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: 'Select Folder'
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle('workspace:scanFolder', async (_e, folderPath: string) => {
    return scanFolderForServices(folderPath);
  });

  handle(
    'process:importMany',
    (_e, configs: ServiceConfig[], replaceAll?: boolean) => {
      return processManager.importConfigs(configs, Boolean(replaceAll));
    }
  );

  handle('dialog:exportConfigs', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      title: 'Export Service Configurations',
      defaultPath: 'multi-service-console.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    };
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    // Store paths relative to the export file's folder, which is what import resolves against.
    const data = processManager.exportConfigs(path.dirname(result.filePath));
    writeFileAtomic(result.filePath, JSON.stringify(data, null, 2));
    return true;
  });

  handle('dialog:importConfigs', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: 'Import Service Configurations',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw) as
      | ServiceConfig[]
      | { services?: ServiceConfig[] };
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.services)
        ? parsed.services
        : null;
    if (!list) {
      throw new Error(
        'Selected JSON file is not a valid service configuration.'
      );
    }
    const baseDir = path.dirname(result.filePaths[0]);
    const resolvedList = list.map((item) => ({
      ...item,
      cwd:
        item.cwd && !path.isAbsolute(item.cwd)
          ? path.resolve(baseDir, item.cwd)
          : item.cwd
    }));
    return processManager.importConfigs(resolvedList, false);
  });

  handle(
    'dialog:saveLogText',
    async (event, defaultName: string, content: string) => {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.SaveDialogOptions = {
        title: 'Save Console Log',
        defaultPath: defaultName,
        filters: [
          { name: 'Log Files', extensions: ['log', 'txt'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      fs.writeFileSync(result.filePath, content, 'utf8');
      return true;
    }
  );

  handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(text);
  });

  handle(
    'theme:setSource',
    (_e, source: 'system' | 'light' | 'dark') => {
      nativeTheme.themeSource = source;
    }
  );
}

function getCliWorkspaceRoot(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    try {
      const candidate = path.resolve(arg);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore invalid path arg
    }
  }
  return null;
}

// Keep every window on our own pages: no popups, no navigating away (including
// files dropped onto the window), and no embedded webviews.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(() => {
  // The UI needs no camera, notifications, geolocation, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  );
  processManager = new ProcessManager(getCliWorkspaceRoot());
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  processManager?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
