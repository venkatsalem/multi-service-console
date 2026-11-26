import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  GripVertical,
  Play,
  Plus,
  RotateCw,
  Search,
  Settings,
  Square,
  Terminal,
  X
} from 'lucide-react';
import { ServiceConfig, ServiceSnapshot } from '../../shared/types';

interface ProcessSidebarProps {
  services: ServiceSnapshot[];
  selectedServiceId: string | null;
  onOpenSettings: () => void;
  onAddService: () => void;
  onScanWorkspace: () => void;
  onSelectService: (id: string) => void;
  onStartService: (id: string) => void;
  onStopService: (id: string, force?: boolean) => void;
  onRestartService: (id: string) => void;
  onEditService: (config: ServiceConfig) => void;
  onPopoutService: (id: string, name: string) => void;
  onShowInExplorer: (cwd: string) => void;
  onOpenTerminal: (cwd: string) => void;
  onReorderService: (
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ) => void;
  onStartGroup: (group: string) => void;
  onStopGroup: (group: string) => void;
  onCopyText: (text: string, label: string) => void;
}

type SidebarFilter = 'all' | 'running' | 'errors';

interface ContextMenuState {
  x: number;
  y: number;
  snapshot: ServiceSnapshot;
}

export const ProcessSidebar: React.FC<ProcessSidebarProps> = ({
  services,
  selectedServiceId,
  onOpenSettings,
  onAddService,
  onScanWorkspace,
  onSelectService,
  onStartService,
  onStopService,
  onRestartService,
  onEditService,
  onPopoutService,
  onShowInExplorer,
  onOpenTerminal,
  onReorderService,
  onStartGroup,
  onStopGroup,
  onCopyText
}) => {
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<SidebarFilter>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: 'before' | 'after';
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<string, ServiceSnapshot[]>();

    for (const snap of services) {
      const { config, runtime } = snap;
      const isRunning =
        runtime.status === 'running' ||
        runtime.status === 'starting' ||
        runtime.status === 'stopping';

      if (filterMode === 'running' && !isRunning) continue;
      if (
        filterMode === 'errors' &&
        runtime.errorCount === 0 &&
        runtime.status !== 'crashed'
      ) {
        continue;
      }

      if (q) {
        const matches =
          config.name.toLowerCase().includes(q) ||
          config.group.toLowerCase().includes(q) ||
          config.command.toLowerCase().includes(q) ||
          config.type.toLowerCase().includes(q) ||
          String(runtime.pid ?? '').includes(q) ||
          runtime.detectedPorts.some((p) => String(p).includes(q));
        if (!matches) continue;
      }

      const list = groups.get(config.group) ?? [];
      list.push(snap);
      groups.set(config.group, list);
    }

    return Array.from(groups.entries());
  }, [services, query, filterMode]);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const openContextMenu = (e: React.MouseEvent, snap: ServiceSnapshot) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 210;
    const menuHeight = 260;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x, y, snapshot: snap });
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id);
    setContextMenu(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position: 'before' | 'after' =
      e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    setDropTarget((prev) =>
      prev && prev.id === targetId && prev.position === position
        ? prev
        : { id: targetId, position }
    );
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = draggedId || e.dataTransfer.getData('text/plain');
    const pos = dropTarget?.id === targetId ? dropTarget.position : 'before';
    setDraggedId(null);
    setDropTarget(null);
    if (sourceId && sourceId !== targetId) {
      onReorderService(sourceId, targetId, pos);
    }
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDropTarget(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-controls">
        <div className="sidebar-top-actions">
          <button
            type="button"
            className="btn btn-primary sidebar-action-btn"
            onClick={onAddService}
          >
            <Plus size={14} />
            Add Process
          </button>
          <button
            type="button"
            className="btn btn-secondary sidebar-action-btn"
            onClick={onScanWorkspace}
            title="Scan a folder for Maven, Gradle, Node.js, or Docker Compose services"
          >
            <FolderSearch size={14} />
            Scan Folder
          </button>
        </div>

        <div className="sidebar-search-box">
          <Search size={13} className="search-icon" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter services, commands, PID, port..."
          />
          {query && (
            <button
              type="button"
              className="icon-btn-xs"
              onClick={() => setQuery('')}
              title="Clear filter"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="sidebar-filter-tabs">
          <button
            type="button"
            className={`filter-chip ${filterMode === 'all' ? 'active' : ''}`}
            onClick={() => setFilterMode('all')}
          >
            All ({services.length})
          </button>
          <button
            type="button"
            className={`filter-chip ${filterMode === 'running' ? 'active' : ''}`}
            onClick={() => setFilterMode('running')}
          >
            Running (
            {
              services.filter(
                (s) =>
                  s.runtime.status === 'running' ||
                  s.runtime.status === 'starting'
              ).length
            }
            )
          </button>
          <button
            type="button"
            className={`filter-chip ${filterMode === 'errors' ? 'active' : ''}`}
            onClick={() => setFilterMode('errors')}
          >
            Errors (
            {
              services.filter(
                (s) =>
                  s.runtime.errorCount > 0 || s.runtime.status === 'crashed'
              ).length
            }
            )
          </button>
        </div>
      </div>

      <div className="sidebar-list">
        {grouped.length === 0 ? (
          <div className="sidebar-empty">
            {services.length === 0 ? (
              <>
                <FolderOpen size={26} className="muted-icon" />
                <p>No processes configured yet.</p>
                <p className="muted-hint">
                  Click <strong>+ Add Process</strong> or{' '}
                  <strong>Scan Folder</strong> in the top bar to get started.
                </p>
              </>
            ) : (
              <p className="muted-hint">No processes match the current filter.</p>
            )}
          </div>
        ) : (
          grouped.map(([groupName, items]) => {
            const isCollapsed = collapsedGroups.has(groupName);
            const runningInGroup = items.filter(
              (s) =>
                s.runtime.status === 'running' ||
                s.runtime.status === 'starting'
            ).length;

            return (
              <div key={groupName} className="service-group">
                <div className="group-header">
                  <button
                    type="button"
                    className="group-toggle"
                    onClick={() => toggleGroup(groupName)}
                  >
                    {isCollapsed ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                    <span className="group-title">{groupName}</span>
                    <span className="group-count">
                      {runningInGroup}/{items.length}
                    </span>
                  </button>
                  <div className="group-actions">
                    <button
                      type="button"
                      className="icon-btn-xs action-start"
                      title={`Start all in ${groupName}`}
                      onClick={() => onStartGroup(groupName)}
                    >
                      <Play size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn-xs action-stop"
                      title={`Stop all in ${groupName}`}
                      onClick={() => onStopGroup(groupName)}
                    >
                      <Square size={11} />
                    </button>
                  </div>
                </div>

                {!isCollapsed &&
                  items.map((snap) => {
                    const { config, runtime } = snap;
                    const isSelected = config.id === selectedServiceId;
                    const isRunning =
                      runtime.status === 'running' ||
                      runtime.status === 'starting';
                    const isStopping = runtime.status === 'stopping';
                    const displayPorts =
                      runtime.detectedPorts.length > 0
                        ? runtime.detectedPorts
                        : config.ports ?? [];
                    const primaryPid =
                      runtime.childPids.length > 0
                        ? runtime.childPids[runtime.childPids.length - 1]
                        : runtime.pid;

                    const isDragging = draggedId === config.id;
                    const dropClass =
                      dropTarget?.id === config.id
                        ? dropTarget.position === 'before'
                          ? 'drop-before'
                          : 'drop-after'
                        : '';

                    return (
                      <div
                        key={config.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, config.id)}
                        onDragOver={(e) => handleDragOver(e, config.id)}
                        onDrop={(e) => handleDrop(e, config.id)}
                        onDragEnd={handleDragEnd}
                        onContextMenu={(e) => openContextMenu(e, snap)}
                        className={`service-card ${isSelected ? 'selected' : ''} status-${runtime.status} ${isDragging ? 'dragging' : ''} ${dropClass}`}
                        onClick={() => onSelectService(config.id)}
                        title="Drag to reorder · Right-click to edit"
                      >
                        <div className="service-card-top">
                          <div className="service-title-wrap">
                            <span
                              className="drag-handle"
                              title="Drag to reorder"
                            >
                              <GripVertical size={13} />
                            </span>
                            <span
                              className={`status-dot dot-${runtime.status}`}
                              title={runtime.status}
                            />
                            <span className="service-name" title={config.name}>
                              {config.name}
                            </span>
                          </div>
                          <span className={`type-badge type-${config.type}`}>
                            {config.type}
                          </span>
                        </div>

                        <div
                          className="service-cmd-preview mono-text"
                          title={`${config.command}\nDir: ${config.cwd}`}
                        >
                          {config.command}
                        </div>

                        <div className="service-card-bottom">
                          <div className="service-meta-pills">
                            {primaryPid !== null && (
                              <button
                                type="button"
                                className="pid-pill"
                                title={`Click to copy PID ${primaryPid}${runtime.pid && primaryPid !== runtime.pid ? ` (shell PID ${runtime.pid})` : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onCopyText(
                                    String(primaryPid),
                                    `PID ${primaryPid}`
                                  );
                                }}
                              >
                                <Copy size={10} />
                                PID {primaryPid}
                              </button>
                            )}
                            {displayPorts.slice(0, 2).map((port) => (
                              <span
                                key={port}
                                className={`port-pill ${runtime.detectedPorts.includes(port) ? 'live' : ''}`}
                                title={
                                  runtime.detectedPorts.includes(port)
                                    ? `Listening on port ${port}`
                                    : `Configured port ${port}`
                                }
                              >
                                :{port}
                              </span>
                            ))}
                            {runtime.errorCount > 0 && (
                              <span
                                className="err-count-pill"
                                title={`${runtime.errorCount} error block(s)`}
                              >
                                <AlertCircle size={10} />
                                {runtime.errorCount}
                              </span>
                            )}
                          </div>

                          <div
                            className="service-row-actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {!isRunning && !isStopping ? (
                              <button
                                type="button"
                                className="row-run-btn is-start"
                                title="Start process"
                                onClick={() => onStartService(config.id)}
                              >
                                <Play size={15} fill="currentColor" />
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="row-restart-btn"
                                  title="Restart process"
                                  onClick={() => onRestartService(config.id)}
                                >
                                  <RotateCw size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="row-run-btn is-stop"
                                  title={
                                    isStopping
                                      ? 'Force stop process tree'
                                      : 'Stop process'
                                  }
                                  onClick={() =>
                                    onStopService(config.id, isStopping)
                                  }
                                >
                                  <Square size={13} fill="currentColor" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const cfg = contextMenu.snapshot.config;
              setContextMenu(null);
              onEditService(cfg);
            }}
          >
            <Edit3 size={14} />
            <span>Edit Process...</span>
          </button>

          <div className="context-menu-divider" />

          {contextMenu.snapshot.runtime.status !== 'running' &&
          contextMenu.snapshot.runtime.status !== 'starting' &&
          contextMenu.snapshot.runtime.status !== 'stopping' ? (
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                const id = contextMenu.snapshot.config.id;
                setContextMenu(null);
                onStartService(id);
              }}
            >
              <Play size={14} />
              <span>Start Process</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const id = contextMenu.snapshot.config.id;
                  setContextMenu(null);
                  onStopService(id);
                }}
              >
                <Square size={14} />
                <span>Stop Process</span>
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const id = contextMenu.snapshot.config.id;
                  setContextMenu(null);
                  onRestartService(id);
                }}
              >
                <RotateCw size={14} />
                <span>Restart Process</span>
              </button>
            </>
          )}

          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const { id, name } = contextMenu.snapshot.config;
              setContextMenu(null);
              onPopoutService(id, name);
            }}
          >
            <ExternalLink size={14} />
            <span>Pop Out Console</span>
          </button>

          <div className="context-menu-divider" />

          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const cwd = contextMenu.snapshot.config.cwd;
              setContextMenu(null);
              onShowInExplorer(cwd);
            }}
          >
            <FolderOpen size={14} />
            <span>Show in Explorer</span>
          </button>

          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              const cwd = contextMenu.snapshot.config.cwd;
              setContextMenu(null);
              onOpenTerminal(cwd);
            }}
          >
            <Terminal size={14} />
            <span>Open Terminal</span>
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn btn-secondary sidebar-settings-btn"
          onClick={onOpenSettings}
          title="Open Settings"
        >
          <Settings size={14} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
};
