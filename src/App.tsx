import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Globe,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Save,
  Settings,
  Square,
  Sun,
  Terminal,
  Upload,
  X
} from 'lucide-react';
import {
  ConfigStorageState,
  LogLine,
  ServiceConfig,
  ServiceSnapshot,
  WorkspaceSwitchResult
} from '../shared/types';
import { ConsolePane } from './components/ConsolePane';
import { ProcessSidebar } from './components/ProcessSidebar';
import { ScanWorkspaceModal } from './components/ScanWorkspaceModal';
import { ServiceFormModal } from './components/ServiceFormModal';
import { SettingsModal, ThemePreference } from './components/SettingsModal';
import {
  FontPreferences,
  loadFontPreferences,
  saveAndApplyFontPreferences
} from './utils/fontPreferences';

const MAX_RENDERER_LINES = 25_000;

interface ToastState {
  kind: 'success' | 'error';
  message: string;
}

export const App: React.FC = () => {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem('msc.themePreference');
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    return 'system';
  });
  const [systemIsDark, setSystemIsDark] = useState<boolean>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  const [services, setServices] = useState<ServiceSnapshot[]>([]);
  const [storage, setStorage] = useState<ConfigStorageState | null>(null);
  const [storageMenuOpen, setStorageMenuOpen] = useState(false);
  const [popoutServiceId, setPopoutServiceId] = useState<string | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(
    null
  );
  const [logsByService, setLogsByService] = useState<Record<string, LogLine[]>>(
    {}
  );

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem('msc.sidebarWidth'));
    return Number.isFinite(raw) && raw >= 240 && raw <= 560 ? raw : 340;
  });

  const [formModalState, setFormModalState] = useState<{
    open: boolean;
    editing: ServiceConfig | null;
  }>({ open: false, editing: null });
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [fontPreferences, setFontPreferences] = useState<FontPreferences>(() =>
    loadFontPreferences()
  );
  const [toast, setToast] = useState<ToastState | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const fetchedLogIdsRef = useRef<Set<string>>(new Set());
  const storageMenuRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback(
    (message: string, kind: ToastState['kind'] = 'success') => {
      setToast({ message, kind });
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
      }, 2800);
    },
    []
  );

  // Theme management
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const effectiveDark =
    themePreference === 'dark' ||
    (themePreference === 'system' && systemIsDark);

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-theme',
      effectiveDark ? 'dark' : 'light'
    );
    localStorage.setItem('msc.themePreference', themePreference);
    void window.serviceConsole.setThemeSource(themePreference);
  }, [effectiveDark, themePreference]);

  useLayoutEffect(() => {
    saveAndApplyFontPreferences(fontPreferences);
  }, [fontPreferences]);

  const handleChangeFonts = useCallback((next: FontPreferences) => {
    saveAndApplyFontPreferences(next);
    setFontPreferences(next);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'msc.fontPreferences') {
        const next = loadFontPreferences();
        setFontPreferences(next);
        saveAndApplyFontPreferences(next);
      } else if (
        e.key === 'msc.themePreference' &&
        (e.newValue === 'system' ||
          e.newValue === 'light' ||
          e.newValue === 'dark')
      ) {
        setThemePreference(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const cycleTheme = () => {
    setThemePreference((prev) =>
      prev === 'system' ? 'dark' : prev === 'dark' ? 'light' : 'system'
    );
  };

  // Bootstrap & live IPC subscriptions
  useEffect(() => {
    let mounted = true;

    void window.serviceConsole.bootstrap().then(async (data) => {
      if (!mounted) return;
      setServices(data.services);
      setStorage(data.storage);
      setPopoutServiceId(data.popoutServiceId);

      const initialId =
        data.popoutServiceId ?? data.services[0]?.config.id ?? null;
      setSelectedServiceId(initialId);

      if (initialId) {
        const initialLogs = await window.serviceConsole.getLogs(initialId);
        if (!mounted) return;
        fetchedLogIdsRef.current.add(initialId);
        setLogsByService((prev) => ({ ...prev, [initialId]: initialLogs }));
      }
    });

    const offSnapshots = window.serviceConsole.onSnapshotsUpdate((snapshots) => {
      setServices(snapshots);
      setSelectedServiceId((cur) => {
        if (cur && snapshots.some((s) => s.config.id === cur)) return cur;
        return snapshots[0]?.config.id ?? null;
      });
    });

    const offStorage = window.serviceConsole.onStorageUpdate((nextStorage) => {
      setStorage(nextStorage);
    });

    const offRuntime = window.serviceConsole.onRuntimeUpdate((runtime) => {
      setServices((prev) =>
        prev.map((s) =>
          s.config.id === runtime.serviceId ? { ...s, runtime } : s
        )
      );
    });

    const offLogBatch = window.serviceConsole.onLogBatch((batch) => {
      setLogsByService((prev) => {
        const existing = prev[batch.serviceId] ?? [];
        const combined = existing.concat(batch.lines);
        const trimmed =
          combined.length > MAX_RENDERER_LINES
            ? combined.slice(combined.length - MAX_RENDERER_LINES)
            : combined;
        return { ...prev, [batch.serviceId]: trimmed };
      });
    });

    const offCleared = window.serviceConsole.onLogCleared(({ serviceId }) => {
      setLogsByService((prev) => ({ ...prev, [serviceId]: [] }));
    });

    return () => {
      mounted = false;
      offSnapshots();
      offStorage();
      offRuntime();
      offLogBatch();
      offCleared();
    };
  }, []);

  // Close workspace dropdown when clicking outside
  useEffect(() => {
    if (!storageMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        storageMenuRef.current &&
        !storageMenuRef.current.contains(e.target as Node)
      ) {
        setStorageMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [storageMenuOpen]);

  // Load log history on demand when selecting a service
  const handleSelectService = useCallback(async (id: string) => {
    setSelectedServiceId(id);
    if (!fetchedLogIdsRef.current.has(id)) {
      fetchedLogIdsRef.current.add(id);
      const history = await window.serviceConsole.getLogs(id);
      setLogsByService((prev) => ({ ...prev, [id]: history }));
    }
  }, []);

  const handleCopyText = useCallback(
    async (text: string, label: string) => {
      await window.serviceConsole.writeClipboard(text);
      showToast(`Copied ${label} to clipboard`);
    },
    [showToast]
  );

  const handleSaveLog = useCallback(
    async (serviceName: string, content: string) => {
      const safe = serviceName.replace(/[^a-zA-Z0-9._-]+/g, '-');
      const saved = await window.serviceConsole.saveLogText(
        `${safe}.log`,
        content
      );
      if (saved) showToast(`Saved ${safe}.log`);
    },
    [showToast]
  );

  const handleKillPort = useCallback(
    async (port: number) => {
      const res = await window.serviceConsole.killPort(port);
      if (res.killedPids.length > 0) {
        showToast(
          `Killed PID ${res.killedPids.join(', ')} on port ${port}`
        );
      } else {
        showToast(`No listening process found on port ${port}`, 'error');
      }
    },
    [showToast]
  );

  const handleDeleteService = useCallback(
    async (id: string): Promise<boolean> => {
      const target = services.find((s) => s.config.id === id);
      if (!target) return false;
      if (
        !window.confirm(
          `Remove "${target.config.name}" from configured processes?`
        )
      ) {
        return false;
      }
      await window.serviceConsole.deleteService(id);
      fetchedLogIdsRef.current.delete(id);
      showToast(`Removed ${target.config.name}`);
      return true;
    },
    [services, showToast]
  );

  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(560, Math.max(240, startWidth + ev.clientX - startX));
      setSidebarWidth(next);
      localStorage.setItem('msc.sidebarWidth', String(next));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const activeServiceId = popoutServiceId ?? selectedServiceId;
  const activeSnapshot = useMemo(
    () => services.find((s) => s.config.id === activeServiceId) ?? null,
    [services, activeServiceId]
  );
  const activeLogs = activeServiceId
    ? logsByService[activeServiceId] ?? []
    : [];

  const existingGroups = useMemo(() => {
    const set = new Set<string>(['Default']);
    for (const s of services) {
      if (s.config.group) set.add(s.config.group);
    }
    return Array.from(set);
  }, [services]);

  const runningCount = useMemo(
    () =>
      services.filter(
        (s) =>
          s.runtime.status === 'running' || s.runtime.status === 'starting'
      ).length,
    [services]
  );

  const applySwitchResult = useCallback(
    (res: WorkspaceSwitchResult | null) => {
      if (!res) return;
      fetchedLogIdsRef.current.clear();
      setLogsByService({});
      setStorage(res.storage);
      setServices(res.services);
      setSelectedServiceId(res.services[0]?.config.id ?? null);
      setStorageMenuOpen(false);
      if (res.storage.mode === 'global') {
        showToast('Switched to Global profile');
      } else if (res.createdNewFile) {
        showToast(
          `Created workspace config at ${res.storage.configFilePath}`
        );
      } else {
        showToast(
          `Opened workspace (${res.services.length} service${res.services.length === 1 ? '' : 's'})`
        );
      }
    },
    [showToast]
  );

  const confirmSwitchIfRunning = useCallback(() => {
    if (runningCount === 0) return true;
    return window.confirm(
      `${runningCount} process${runningCount === 1 ? ' is' : 'es are'} currently running. Switching configs will stop them first. Continue?`
    );
  }, [runningCount]);

  const handleSwitchGlobal = async () => {
    if (!confirmSwitchIfRunning()) return;
    const res = await window.serviceConsole.switchToGlobal();
    applySwitchResult(res);
  };

  const handleOpenWorkspace = async (folderPath?: string) => {
    if (!confirmSwitchIfRunning()) return;
    try {
      const res = await window.serviceConsole.openWorkspace(folderPath);
      applySwitchResult(res);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to open workspace',
        'error'
      );
    }
  };

  const handleSaveCopyToWorkspace = async () => {
    if (!confirmSwitchIfRunning()) return;
    try {
      const res = await window.serviceConsole.saveCopyToWorkspace();
      applySwitchResult(res);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Failed to save workspace copy',
        'error'
      );
    }
  };

  const workspaceFolderLabel = storage?.workspaceRoot
    ? storage.workspaceRoot.split(/[/\\]/).filter(Boolean).pop() ||
      storage.workspaceRoot
    : null;

  const ThemeIcon =
    themePreference === 'system'
      ? Monitor
      : themePreference === 'dark'
        ? Moon
        : Sun;

  // Pop-out Dedicated Console Window Mode
  if (popoutServiceId) {
    return (
      <div className="app-shell">
        <header className="top-bar">
          <div className="top-bar-left">
            <div className="app-title">
              <Terminal size={16} className="app-logo-icon" />
              <span>Multi-Service Console</span>
              <span className="popout-badge">Pop-Out Window</span>
            </div>
          </div>
          <div className="top-bar-right">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={cycleTheme}
              title={`Theme: ${themePreference}`}
            >
              <ThemeIcon size={14} />
              {themePreference}
            </button>
          </div>
        </header>

        <div className="workspace-body">
          <ConsolePane
            snapshot={activeSnapshot}
            logs={activeLogs}
            isPopout
            consoleFont={fontPreferences.consoleFont}
            consoleFontSize={fontPreferences.consoleFontSize}
            onStart={(id) => void window.serviceConsole.startService(id)}
            onStop={(id, force) =>
              void window.serviceConsole.stopService(id, force)
            }
            onRestart={(id) => void window.serviceConsole.restartService(id)}
            onClear={(id) => void window.serviceConsole.clearLogs(id)}
            onKillPort={(port) => void handleKillPort(port)}
            onCopyText={(text, label) => void handleCopyText(text, label)}
            onSaveLog={(name, content) => void handleSaveLog(name, content)}
          />
        </div>

        {toast && (
          <div className={`toast toast-${toast.kind}`}>
            <span>{toast.message}</span>
            <button
              type="button"
              className="icon-btn-xs"
              onClick={() => setToast(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setSidebarOpen((o) => !o)}
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            {sidebarOpen ? (
              <PanelLeftClose size={16} />
            ) : (
              <PanelLeftOpen size={16} />
            )}
          </button>

          <div className="app-title">
            <Terminal size={16} className="app-logo-icon" />
            <span>Multi-Service Console</span>
          </div>

          <div className="storage-switcher" ref={storageMenuRef}>
            <button
              type="button"
              className={`storage-pill ${storage?.mode === 'workspace' ? 'is-workspace' : ''}`}
              onClick={() => setStorageMenuOpen((o) => !o)}
              title={
                storage
                  ? `Config file: ${storage.configFilePath}`
                  : 'Config storage'
              }
            >
              {storage?.mode === 'workspace' ? (
                <FolderOpen size={13} />
              ) : (
                <Globe size={13} />
              )}
              <span className="storage-pill-label">
                {storage?.mode === 'workspace'
                  ? `Workspace: ${workspaceFolderLabel}`
                  : 'Global Profile'}
              </span>
              <ChevronDown size={13} />
            </button>

            {storageMenuOpen && (
              <div className="storage-menu">
                <div className="storage-menu-section-title">Config Source</div>
                <button
                  type="button"
                  className={`storage-menu-item ${storage?.mode === 'global' ? 'active' : ''}`}
                  onClick={() => void handleSwitchGlobal()}
                >
                  <Globe size={14} />
                  <div className="storage-menu-item-text">
                    <span>Global Profile</span>
                    <small>User AppData (services.json)</small>
                  </div>
                  {storage?.mode === 'global' && <Check size={14} />}
                </button>

                <button
                  type="button"
                  className="storage-menu-item"
                  onClick={() => void handleOpenWorkspace()}
                >
                  <FolderOpen size={14} />
                  <div className="storage-menu-item-text">
                    <span>Open Workspace Folder...</span>
                    <small>Load or create multi-service-console.json</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="storage-menu-item"
                  disabled={services.length === 0}
                  onClick={() => void handleSaveCopyToWorkspace()}
                >
                  <Save size={14} />
                  <div className="storage-menu-item-text">
                    <span>Save Current List to Workspace...</span>
                    <small>Copy services with relative paths</small>
                  </div>
                </button>

                <div className="storage-menu-divider" />

                <button
                  type="button"
                  className="storage-menu-item"
                  onClick={async () => {
                    setStorageMenuOpen(false);
                    try {
                      const imported =
                        await window.serviceConsole.importConfigs();
                      if (imported) {
                        showToast('Imported service configurations');
                      }
                    } catch (err) {
                      showToast(
                        err instanceof Error ? err.message : 'Import failed',
                        'error'
                      );
                    }
                  }}
                >
                  <Upload size={14} />
                  <div className="storage-menu-item-text">
                    <span>Import JSON...</span>
                    <small>Add services from a JSON file</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="storage-menu-item"
                  disabled={services.length === 0}
                  onClick={async () => {
                    setStorageMenuOpen(false);
                    const ok = await window.serviceConsole.exportConfigs();
                    if (ok) showToast('Exported service configurations');
                  }}
                >
                  <Download size={14} />
                  <div className="storage-menu-item-text">
                    <span>Export JSON...</span>
                    <small>Save current service list to JSON</small>
                  </div>
                </button>

                <button
                  type="button"
                  className="storage-menu-item"
                  onClick={() => {
                    setStorageMenuOpen(false);
                    setSettingsModalOpen(true);
                  }}
                >
                  <Settings size={14} />
                  <div className="storage-menu-item-text">
                    <span>Settings...</span>
                    <small>Theme, UI &amp; console fonts</small>
                  </div>
                </button>

                {storage && storage.recentWorkspaces.length > 0 && (
                  <>
                    <div className="storage-menu-divider" />
                    <div className="storage-menu-section-title">
                      Recent Workspaces
                    </div>
                    {storage.recentWorkspaces.map((wsPath) => {
                      const isCurrent =
                        storage.mode === 'workspace' &&
                        storage.workspaceRoot?.toLowerCase() ===
                          wsPath.toLowerCase();
                      const label =
                        wsPath.split(/[/\\]/).filter(Boolean).pop() || wsPath;
                      return (
                        <div key={wsPath} className="storage-recent-row">
                          <button
                            type="button"
                            className={`storage-menu-item ${isCurrent ? 'active' : ''}`}
                            onClick={() => void handleOpenWorkspace(wsPath)}
                            title={wsPath}
                          >
                            <FolderOpen size={14} />
                            <div className="storage-menu-item-text">
                              <span>{label}</span>
                              <small>{wsPath}</small>
                            </div>
                            {isCurrent && <Check size={14} />}
                          </button>
                          <button
                            type="button"
                            className="icon-btn-xs"
                            title="Remove from recent workspaces"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const updated =
                                await window.serviceConsole.removeRecentWorkspace(
                                  wsPath
                                );
                              setStorage(updated);
                            }}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}

                {storage && (
                  <>
                    <div className="storage-menu-divider" />
                    <div className="storage-menu-path mono-text">
                      {storage.configFilePath}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <span className="summary-pill">
            {runningCount} Running · {services.length} Configured
          </span>
        </div>

        <div className="top-bar-right">
          <button
            type="button"
            className="btn btn-start-subtle"
            disabled={services.length === 0}
            onClick={() => void window.serviceConsole.startAll()}
            title="Start all configured processes"
          >
            <Play size={13} />
            Start All
          </button>

          <button
            type="button"
            className="btn btn-stop-subtle"
            disabled={runningCount === 0}
            onClick={() => void window.serviceConsole.stopAll(false)}
            title="Stop all running processes"
          >
            <Square size={12} />
            Stop All
          </button>
        </div>
      </header>

      <div className="workspace-body">
        {sidebarOpen && (
          <>
            <div
              className="sidebar-container"
              style={{ width: `${sidebarWidth}px` }}
            >
              <ProcessSidebar
                services={services}
                selectedServiceId={selectedServiceId}
                onOpenSettings={() => setSettingsModalOpen(true)}
                onAddService={() =>
                  setFormModalState({ open: true, editing: null })
                }
                onScanWorkspace={() => setScanModalOpen(true)}
                onSelectService={(id) => void handleSelectService(id)}
                onStartService={(id) =>
                  void window.serviceConsole.startService(id)
                }
                onStopService={(id, force) =>
                  void window.serviceConsole.stopService(id, force)
                }
                onRestartService={(id) =>
                  void window.serviceConsole.restartService(id)
                }
                onEditService={(cfg) =>
                  setFormModalState({ open: true, editing: cfg })
                }
                onPopoutService={(id, name) =>
                  void window.serviceConsole.openPopout(id, name)
                }
                onShowInExplorer={async (cwd) => {
                  const res = await window.serviceConsole.showInExplorer(cwd);
                  if (!res.ok) {
                    showToast(res.error || 'Failed to open Explorer', 'error');
                  }
                }}
                onOpenTerminal={async (cwd) => {
                  const res = await window.serviceConsole.openTerminal(cwd);
                  if (!res.ok) {
                    showToast(res.error || 'Failed to open Terminal', 'error');
                  }
                }}
                onReorderService={(draggedId, targetId, position) =>
                  void window.serviceConsole.reorderService(
                    draggedId,
                    targetId,
                    position
                  )
                }
                onStartGroup={(group) =>
                  void window.serviceConsole.startGroup(group)
                }
                onStopGroup={(group) =>
                  void window.serviceConsole.stopGroup(group)
                }
                onCopyText={(text, label) => void handleCopyText(text, label)}
              />
            </div>
            <div
              className="sidebar-resizer"
              onMouseDown={handleSidebarResizeStart}
              title="Drag to resize sidebar"
            />
          </>
        )}

        <ConsolePane
          snapshot={activeSnapshot}
          logs={activeLogs}
          consoleFont={fontPreferences.consoleFont}
          consoleFontSize={fontPreferences.consoleFontSize}
          onStart={(id) => void window.serviceConsole.startService(id)}
          onStop={(id, force) =>
            void window.serviceConsole.stopService(id, force)
          }
          onRestart={(id) => void window.serviceConsole.restartService(id)}
          onClear={(id) => void window.serviceConsole.clearLogs(id)}
          onPopout={(id, name) =>
            void window.serviceConsole.openPopout(id, name)
          }
          onKillPort={(port) => void handleKillPort(port)}
          onCopyText={(text, label) => void handleCopyText(text, label)}
          onSaveLog={(name, content) => void handleSaveLog(name, content)}
        />
      </div>

      {formModalState.open && (
        <ServiceFormModal
          initial={formModalState.editing}
          defaultCwd={storage?.workspaceRoot ?? ''}
          existingGroups={existingGroups}
          onClose={() => setFormModalState({ open: false, editing: null })}
          onDelete={async (id) => {
            const removed = await handleDeleteService(id);
            if (removed) {
              setFormModalState({ open: false, editing: null });
            }
          }}
          onSave={async (data) => {
            const snap = await window.serviceConsole.upsertService(data);
            setSelectedServiceId(snap.config.id);
            showToast(
              formModalState.editing
                ? `Updated ${snap.config.name}`
                : `Added ${snap.config.name}`
            );
          }}
        />
      )}

      {scanModalOpen && (
        <ScanWorkspaceModal
          onClose={() => setScanModalOpen(false)}
          onImport={async (configs) => {
            const updated = await window.serviceConsole.importMany(
              configs,
              false
            );
            if (!selectedServiceId && updated.length > 0) {
              setSelectedServiceId(updated[0].config.id);
            }
            showToast(`Imported ${configs.length} service(s)`);
          }}
        />
      )}

      {settingsModalOpen && (
        <SettingsModal
          themePreference={themePreference}
          onChangeTheme={setThemePreference}
          fontPreferences={fontPreferences}
          onChangeFonts={handleChangeFonts}
          onClose={() => {
            saveAndApplyFontPreferences(fontPreferences);
            setSettingsModalOpen(false);
          }}
        />
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="icon-btn-xs"
            onClick={() => setToast(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
};
