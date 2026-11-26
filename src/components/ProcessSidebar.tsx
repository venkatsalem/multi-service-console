import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  FolderOpen,
  Play,
  RotateCw,
  Search,
  Square,
  Trash2,
  X
} from 'lucide-react';
import { ServiceConfig, ServiceSnapshot } from '../../shared/types';

interface ProcessSidebarProps {
  services: ServiceSnapshot[];
  selectedServiceId: string | null;
  onSelectService: (id: string) => void;
  onStartService: (id: string) => void;
  onStopService: (id: string) => void;
  onRestartService: (id: string) => void;
  onEditService: (config: ServiceConfig) => void;
  onDeleteService: (id: string) => void;
  onStartGroup: (group: string) => void;
  onStopGroup: (group: string) => void;
  onCopyText: (text: string, label: string) => void;
}

type SidebarFilter = 'all' | 'running' | 'errors';

export const ProcessSidebar: React.FC<ProcessSidebarProps> = ({
  services,
  selectedServiceId,
  onSelectService,
  onStartService,
  onStopService,
  onRestartService,
  onEditService,
  onDeleteService,
  onStartGroup,
  onStopGroup,
  onCopyText
}) => {
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<SidebarFilter>('all');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );

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

  return (
    <aside className="sidebar">
      <div className="sidebar-controls">
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
                  items.map(({ config, runtime }) => {
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

                    return (
                      <div
                        key={config.id}
                        className={`service-card ${isSelected ? 'selected' : ''} status-${runtime.status}`}
                        onClick={() => onSelectService(config.id)}
                      >
                        <div className="service-card-top">
                          <div className="service-title-wrap">
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
                                className="icon-btn-xs action-start"
                                title="Start process"
                                onClick={() => onStartService(config.id)}
                              >
                                <Play size={13} />
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="icon-btn-xs action-stop"
                                  title="Stop process"
                                  onClick={() => onStopService(config.id)}
                                >
                                  <Square size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn-xs"
                                  title="Restart process"
                                  onClick={() => onRestartService(config.id)}
                                >
                                  <RotateCw size={12} />
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              className="icon-btn-xs"
                              title="Edit process"
                              onClick={() => onEditService(config)}
                            >
                              <Edit3 size={12} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn-xs action-delete"
                              title="Delete process"
                              onClick={() => onDeleteService(config.id)}
                            >
                              <Trash2 size={12} />
                            </button>
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
    </aside>
  );
};
