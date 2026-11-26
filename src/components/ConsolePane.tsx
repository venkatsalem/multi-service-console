import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Lock,
  Play,
  RotateCw,
  Search,
  Skull,
  Square,
  Trash2,
  Unlock,
  WrapText,
  X
} from 'lucide-react';
import { LogLine, ServiceSnapshot } from '../../shared/types';

interface ConsolePaneProps {
  snapshot: ServiceSnapshot | null;
  logs: LogLine[];
  isPopout?: boolean;
  onStart: (id: string) => void;
  onStop: (id: string, force?: boolean) => void;
  onRestart: (id: string) => void;
  onClear: (id: string) => void;
  onPopout?: (id: string, name: string) => void;
  onKillPort: (port: number) => void;
  onCopyText: (text: string, label: string) => void;
  onSaveLog: (serviceName: string, content: string) => void;
}

type LevelFilter = 'all' | 'errors' | 'warn_err';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDuration(startedAt: number | null, now: number): string {
  if (!startedAt) return '';
  const totalSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function buildSearchRegex(
  query: string,
  caseSensitive: boolean,
  useRegex: boolean
): RegExp | null {
  if (!query) return null;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    if (useRegex) {
      return new RegExp(query, flags);
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, flags);
  } catch {
    return null;
  }
}

export const ConsolePane: React.FC<ConsolePaneProps> = ({
  snapshot,
  logs,
  isPopout = false,
  onStart,
  onStop,
  onRestart,
  onClear,
  onPopout,
  onKillPort,
  onCopyText,
  onSaveLog
}) => {
  const [scrollLocked, setScrollLocked] = useState(false);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [grepFilterOnly, setGrepFilterOnly] = useState(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selectedText: string;
    selectedLines: string[];
    clickedLine: LogLine | null;
  } | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const lastLogCountRef = useRef(0);

  const serviceId = snapshot?.config.id ?? null;

  // Live uptime ticker while process is active
  useEffect(() => {
    const status = snapshot?.runtime.status;
    if (status !== 'running' && status !== 'starting') return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [snapshot?.runtime.status]);

  // Reset scroll pause when switching services
  useEffect(() => {
    setUserScrolledUp(false);
    setScrollLocked(false);
    setActiveMatchIdx(0);
    setContextMenu(null);
    lastLogCountRef.current = 0;
  }, [serviceId]);

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

  // Ctrl+F / Cmd+F opens & focuses search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const searchRegex = useMemo(
    () => buildSearchRegex(searchQuery, caseSensitive, useRegex),
    [searchQuery, caseSensitive, useRegex]
  );

  const searchInvalid = Boolean(searchQuery && useRegex && !searchRegex);

  const filteredLogs = useMemo(() => {
    return logs.filter((line) => {
      if (levelFilter === 'errors') {
        if (line.level !== 'error' && line.errorBlockId === undefined) {
          return false;
        }
      } else if (levelFilter === 'warn_err') {
        if (
          line.level !== 'error' &&
          line.level !== 'warn' &&
          line.errorBlockId === undefined
        ) {
          return false;
        }
      }

      if (grepFilterOnly && searchRegex) {
        searchRegex.lastIndex = 0;
        if (!searchRegex.test(line.raw)) return false;
      }

      return true;
    });
  }, [logs, levelFilter, grepFilterOnly, searchRegex]);

  // Indices within filteredLogs that match searchQuery
  const matchRowIndices = useMemo(() => {
    if (!searchRegex) return [];
    const indices: number[] = [];
    for (let i = 0; i < filteredLogs.length; i += 1) {
      searchRegex.lastIndex = 0;
      if (searchRegex.test(filteredLogs[i].raw)) {
        indices.push(i);
      }
    }
    return indices;
  }, [filteredLogs, searchRegex]);

  // Indices within filteredLogs that start an error block
  const errorStartIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < filteredLogs.length; i += 1) {
      if (filteredLogs[i].isErrorStart) indices.push(i);
    }
    return indices;
  }, [filteredLogs]);

  // Clamp activeMatchIdx
  useEffect(() => {
    if (matchRowIndices.length === 0) {
      setActiveMatchIdx(0);
    } else if (activeMatchIdx >= matchRowIndices.length) {
      setActiveMatchIdx(0);
    }
  }, [matchRowIndices.length, activeMatchIdx]);

  const virtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 21,
    overscan: 24
  });

  const isAutoFollow = !scrollLocked && !userScrolledUp;

  // Auto-scroll to bottom when new lines arrive and auto-follow is active
  useEffect(() => {
    if (!isAutoFollow) {
      lastLogCountRef.current = filteredLogs.length;
      return;
    }
    if (filteredLogs.length > 0) {
      virtualizer.scrollToIndex(filteredLogs.length - 1, { align: 'end' });
    }
    lastLogCountRef.current = filteredLogs.length;
  }, [filteredLogs.length, isAutoFollow, virtualizer]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 36) {
      setUserScrolledUp(true);
    } else {
      setUserScrolledUp(false);
    }
  }, []);

  const resumeAutoScroll = () => {
    setScrollLocked(false);
    setUserScrolledUp(false);
    if (filteredLogs.length > 0) {
      virtualizer.scrollToIndex(filteredLogs.length - 1, { align: 'end' });
    }
  };

  const jumpToMatch = (direction: 1 | -1) => {
    if (matchRowIndices.length === 0) return;
    setScrollLocked(true);
    const nextIdx =
      (activeMatchIdx + direction + matchRowIndices.length) %
      matchRowIndices.length;
    setActiveMatchIdx(nextIdx);
    const rowIndex = matchRowIndices[nextIdx];
    virtualizer.scrollToIndex(rowIndex, { align: 'center' });
  };

  const jumpToError = (direction: 1 | -1) => {
    if (errorStartIndices.length === 0) return;
    setScrollLocked(true);
    const virtualItems = virtualizer.getVirtualItems();
    const currentCenter =
      virtualItems.length > 0
        ? virtualItems[Math.floor(virtualItems.length / 2)].index
        : 0;

    let targetRow = errorStartIndices[0];
    if (direction === 1) {
      const found = errorStartIndices.find((idx) => idx > currentCenter);
      targetRow = found ?? errorStartIndices[0];
    } else {
      const reversed = [...errorStartIndices].reverse();
      const found = reversed.find((idx) => idx < currentCenter);
      targetRow = found ?? errorStartIndices[errorStartIndices.length - 1];
    }
    virtualizer.scrollToIndex(targetRow, { align: 'center' });
  };

  const markCopied = (key: string) => {
    setCopiedId(key);
    setTimeout(() => {
      setCopiedId((cur) => (cur === key ? null : cur));
    }, 1500);
  };

  const copyErrorBlock = (blockId: number) => {
    const blockLines = logs
      .filter((l) => l.errorBlockId === blockId)
      .map((l) => l.raw);
    if (blockLines.length === 0) return;
    onCopyText(blockLines.join('\n'), 'Error stack trace');
    markCopied(`block-${blockId}`);
  };

  const copyLastError = () => {
    const errorBlocks = new Map<number, string[]>();
    let lastBlockId: number | null = null;
    for (const line of logs) {
      if (line.errorBlockId !== undefined) {
        const arr = errorBlocks.get(line.errorBlockId) ?? [];
        arr.push(line.raw);
        errorBlocks.set(line.errorBlockId, arr);
        lastBlockId = line.errorBlockId;
      }
    }
    if (lastBlockId === null) {
      const errLines = logs.filter((l) => l.level === 'error').map((l) => l.raw);
      if (errLines.length === 0) return;
      onCopyText(errLines.slice(-20).join('\n'), 'Last error');
      return;
    }
    const text = (errorBlocks.get(lastBlockId) ?? []).join('\n');
    onCopyText(text, 'Last error block');
    markCopied('last-err');
  };

  const copyAllErrors = () => {
    const blocks: string[] = [];
    let currentBlockId: number | null = null;
    let currentLines: string[] = [];

    for (const line of logs) {
      if (line.errorBlockId !== undefined) {
        if (currentBlockId !== line.errorBlockId) {
          if (currentLines.length > 0) blocks.push(currentLines.join('\n'));
          currentBlockId = line.errorBlockId;
          currentLines = [line.raw];
        } else {
          currentLines.push(line.raw);
        }
      } else if (line.level === 'error') {
        if (currentLines.length > 0) {
          blocks.push(currentLines.join('\n'));
          currentLines = [];
          currentBlockId = null;
        }
        blocks.push(line.raw);
      }
    }
    if (currentLines.length > 0) blocks.push(currentLines.join('\n'));

    if (blocks.length === 0) return;
    onCopyText(blocks.join('\n\n---\n\n'), 'All errors');
    markCopied('all-err');
  };

  const copyAllVisible = () => {
    if (filteredLogs.length === 0) return;
    onCopyText(
      filteredLogs.map((l) => l.raw).join('\n'),
      `${filteredLogs.length} log lines`
    );
    markCopied('all-log');
  };

  if (!snapshot) {
    return (
      <main className="console-empty">
        <div className="console-empty-card">
          <h2>Select a Process</h2>
          <p>
            Choose a service from the left sidebar to start, stop, monitor PIDs
            and ports, and inspect live console logs.
          </p>
        </div>
      </main>
    );
  }

  const { config, runtime } = snapshot;
  const isActive =
    runtime.status === 'running' || runtime.status === 'starting';
  const isStopping = runtime.status === 'stopping';
  const activeMatchRow =
    matchRowIndices.length > 0 ? matchRowIndices[activeMatchIdx] : -1;

  const allPids = [
    ...(runtime.pid ? [runtime.pid] : []),
    ...runtime.childPids.filter((p) => p !== runtime.pid)
  ];
  const displayPorts =
    runtime.detectedPorts.length > 0
      ? runtime.detectedPorts
      : config.ports ?? [];

  return (
    <main className="console-pane">
      {/* Header Bar */}
      <div className="console-header">
        <div className="console-title-group">
          <div className="console-title-row">
            <span className={`status-dot dot-${runtime.status}`} />
            <h2 className="console-service-name">{config.name}</h2>
            <span className={`status-badge badge-${runtime.status}`}>
              {runtime.status.toUpperCase()}
            </span>
            <span className={`type-badge type-${config.type}`}>
              {config.type}
            </span>
          </div>

          <div className="console-meta-row">
            <span className="mono-text meta-cmd" title={config.command}>
              {config.command}
            </span>
            <span className="meta-sep">·</span>
            <span className="meta-cwd" title={config.cwd}>
              {config.cwd}
            </span>
          </div>
        </div>

        <div className="console-actions">
          {allPids.length > 0 && (
            <button
              type="button"
              className="meta-chip clickable"
              title={`Shell PID: ${runtime.pid ?? 'none'}\nChild PIDs: ${runtime.childPids.join(', ') || 'none'}\nClick to copy`}
              onClick={() =>
                onCopyText(
                  String(allPids[allPids.length - 1]),
                  `PID ${allPids[allPids.length - 1]}`
                )
              }
            >
              <Copy size={11} />
              PID {allPids[allPids.length - 1]}
              {allPids.length > 1 ? ` (+${allPids.length - 1})` : ''}
            </button>
          )}

          {displayPorts.map((port) => {
            const isLive = runtime.detectedPorts.includes(port);
            return (
              <div key={port} className="port-chip-group">
                <span
                  className={`meta-chip ${isLive ? 'port-live' : ''}`}
                  title={
                    isLive
                      ? `Listening on port ${port}`
                      : `Configured port ${port}`
                  }
                >
                  :{port}
                </span>
                <button
                  type="button"
                  className="icon-btn-xs port-kill-btn"
                  title={`Kill any process listening on port ${port}`}
                  onClick={() => onKillPort(port)}
                >
                  <Skull size={11} />
                </button>
              </div>
            );
          })}

          {isActive && runtime.startedAt && (
            <span className="meta-chip" title="Process uptime">
              <Clock size={11} />
              {formatDuration(runtime.startedAt, nowTick)}
            </span>
          )}

          <div className="btn-group">
            {!isActive && !isStopping ? (
              <button
                type="button"
                className="btn btn-start"
                onClick={() => onStart(config.id)}
              >
                <Play size={14} />
                Start
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn-stop"
                  onClick={() => onStop(config.id, isStopping)}
                  title={
                    isStopping
                      ? 'Force kill process tree (taskkill /T /F)'
                      : 'Stop process tree'
                  }
                >
                  <Square size={13} />
                  {isStopping ? 'Force Kill' : 'Stop'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => onRestart(config.id)}
                  title="Restart process"
                >
                  <RotateCw size={14} />
                  Restart
                </button>
              </>
            )}

            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onClear(config.id)}
              title="Clear console output"
            >
              <Trash2 size={14} />
              Clear
            </button>

            {!isPopout && onPopout && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onPopout(config.id, config.name)}
                title="Open console in a separate larger window"
              >
                <ExternalLink size={14} />
                Pop Out
              </button>
            )}
          </div>
        </div>
      </div>

      {/* IntelliJ Console Toolbar */}
      <div className="console-toolbar">
        <div className="toolbar-left">
          <button
            type="button"
            className={`tool-btn ${!scrollLocked ? 'active' : 'locked'}`}
            onClick={() => {
              if (scrollLocked) resumeAutoScroll();
              else setScrollLocked(true);
            }}
            title={
              scrollLocked
                ? 'Scroll is locked — click to resume auto-scrolling'
                : 'Auto-scrolling to latest output — click to lock scroll'
            }
          >
            {scrollLocked ? <Lock size={13} /> : <Unlock size={13} />}
            {scrollLocked ? 'Scroll Locked' : 'Auto-Scroll'}
          </button>

          <button
            type="button"
            className={`tool-btn ${wrapLines ? 'active' : ''}`}
            onClick={() => setWrapLines((w) => !w)}
            title="Toggle soft line wrapping"
          >
            <WrapText size={13} />
            Wrap
          </button>

          <button
            type="button"
            className={`tool-btn ${showTimestamps ? 'active' : ''}`}
            onClick={() => setShowTimestamps((t) => !t)}
            title="Show/hide timestamps"
          >
            <Clock size={13} />
            Time
          </button>

          <div className="toolbar-divider" />

          <button
            type="button"
            className={`tool-btn ${levelFilter === 'all' ? 'active' : ''}`}
            onClick={() => setLevelFilter('all')}
          >
            All ({logs.length})
          </button>
          <button
            type="button"
            className={`tool-btn ${levelFilter === 'errors' ? 'active-err' : ''}`}
            onClick={() => setLevelFilter('errors')}
          >
            Errors ({runtime.errorCount})
          </button>
          <button
            type="button"
            className={`tool-btn ${levelFilter === 'warn_err' ? 'active-warn' : ''}`}
            onClick={() => setLevelFilter('warn_err')}
          >
            Warn+Err ({runtime.warnCount + runtime.errorCount})
          </button>
        </div>

        <div className="toolbar-right">
          {errorStartIndices.length > 0 && (
            <div className="error-nav-group">
              <button
                type="button"
                className="tool-btn"
                onClick={() => jumpToError(-1)}
                title="Jump to previous error"
              >
                <ArrowUp size={13} />
                Prev Err
              </button>
              <button
                type="button"
                className="tool-btn"
                onClick={() => jumpToError(1)}
                title="Jump to next error"
              >
                <ArrowDown size={13} />
                Next Err
              </button>
            </div>
          )}

          <button
            type="button"
            className="tool-btn"
            disabled={runtime.errorCount === 0}
            onClick={copyLastError}
            title="Copy the most recent error and its stack trace"
          >
            {copiedId === 'last-err' ? (
              <Check size={13} />
            ) : (
              <AlertTriangle size={13} />
            )}
            Copy Last Error
          </button>

          <button
            type="button"
            className="tool-btn"
            disabled={runtime.errorCount === 0}
            onClick={copyAllErrors}
            title="Copy all error blocks in this console"
          >
            {copiedId === 'all-err' ? <Check size={13} /> : <Copy size={13} />}
            Copy Errors
          </button>

          <button
            type="button"
            className="tool-btn"
            disabled={filteredLogs.length === 0}
            onClick={copyAllVisible}
            title="Copy visible console lines"
          >
            {copiedId === 'all-log' ? <Check size={13} /> : <Copy size={13} />}
            Copy Log
          </button>

          <button
            type="button"
            className="tool-btn"
            disabled={logs.length === 0}
            onClick={() =>
              onSaveLog(config.name, logs.map((l) => l.raw).join('\n'))
            }
            title="Export full log to a file"
          >
            <Download size={13} />
            Save
          </button>

          <button
            type="button"
            className={`tool-btn ${searchOpen ? 'active' : ''}`}
            onClick={() => {
              setSearchOpen((open) => {
                const next = !open;
                if (next) {
                  requestAnimationFrame(() => searchInputRef.current?.focus());
                }
                return next;
              });
            }}
            title="Find in console (Ctrl+F)"
          >
            <Search size={13} />
            Find
          </button>
        </div>
      </div>

      {/* Find / Grep Bar */}
      {searchOpen && (
        <div className="console-search-bar">
          <div className={`search-input-wrap ${searchInvalid ? 'invalid' : ''}`}>
            <Search size={13} className="search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setActiveMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpToMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  setSearchOpen(false);
                }
              }}
              placeholder="Search console logs (Enter = next, Shift+Enter = prev)..."
            />
            {searchQuery && (
              <button
                type="button"
                className="icon-btn-xs"
                onClick={() => setSearchQuery('')}
              >
                <X size={12} />
              </button>
            )}
          </div>

          <button
            type="button"
            className={`tool-btn ${caseSensitive ? 'active' : ''}`}
            onClick={() => setCaseSensitive((c) => !c)}
            title="Match Case"
          >
            Aa
          </button>

          <button
            type="button"
            className={`tool-btn ${useRegex ? 'active' : ''}`}
            onClick={() => setUseRegex((r) => !r)}
            title="Regular Expression"
          >
            .*
          </button>

          <button
            type="button"
            className={`tool-btn ${grepFilterOnly ? 'active' : ''}`}
            onClick={() => setGrepFilterOnly((g) => !g)}
            title="Grep mode: show only matching lines"
          >
            <Filter size={12} />
            Filter Only
          </button>

          <span className="match-counter">
            {searchInvalid
              ? 'Invalid regex'
              : searchQuery
                ? `${matchRowIndices.length === 0 ? 0 : activeMatchIdx + 1} / ${matchRowIndices.length}`
                : '0 matches'}
          </span>

          <button
            type="button"
            className="icon-btn-xs"
            disabled={matchRowIndices.length === 0}
            onClick={() => jumpToMatch(-1)}
            title="Previous match (Shift+Enter)"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            className="icon-btn-xs"
            disabled={matchRowIndices.length === 0}
            onClick={() => jumpToMatch(1)}
            title="Next match (Enter)"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className="icon-btn-xs"
            onClick={() => setSearchOpen(false)}
            title="Close Find bar (Esc)"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Console Log Viewport */}
      <div className="console-viewport-wrap">
        <div
          ref={scrollContainerRef}
          className={`console-viewport ${wrapLines ? 'wrap-on' : 'wrap-off'}`}
          onScroll={handleScroll}
          onContextMenu={(e) => {
            e.preventDefault();
            const sel = window.getSelection();
            const selectedText = sel?.toString() ?? '';
            const rowEl = (e.target as HTMLElement | null)?.closest(
              '[data-index]'
            );
            const rowIdx = rowEl
              ? Number.parseInt(rowEl.getAttribute('data-index') ?? '', 10)
              : Number.NaN;
            const clickedLine =
              Number.isFinite(rowIdx) && filteredLogs[rowIdx]
                ? filteredLogs[rowIdx]
                : null;

            let selectedLines: string[] = clickedLine ? [clickedLine.raw] : [];
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
              const range = sel.getRangeAt(0);
              const getRowIndexFromNode = (node: Node): number | null => {
                const el =
                  node instanceof Element ? node : node.parentElement;
                const row = el?.closest('[data-index]');
                if (!row) return null;
                const idx = Number.parseInt(
                  row.getAttribute('data-index') ?? '',
                  10
                );
                return Number.isFinite(idx) ? idx : null;
              };
              const startIdx = getRowIndexFromNode(range.startContainer);
              const endIdx = getRowIndexFromNode(range.endContainer);
              if (startIdx !== null && endIdx !== null) {
                const minIdx = Math.max(0, Math.min(startIdx, endIdx));
                const maxIdx = Math.min(
                  filteredLogs.length - 1,
                  Math.max(startIdx, endIdx)
                );
                selectedLines = filteredLogs
                  .slice(minIdx, maxIdx + 1)
                  .map((l) => l.raw);
              }
            }

            const menuWidth = 220;
            const menuHeight = 220;
            const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
            const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
            setContextMenu({
              x,
              y,
              selectedText,
              selectedLines,
              clickedLine
            });
          }}
        >
          {filteredLogs.length === 0 ? (
            <div className="console-placeholder">
              {logs.length === 0
                ? 'No console output yet. Click Start to launch this process.'
                : 'No lines match the current filter.'}
            </div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative'
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const line = filteredLogs[virtualRow.index];
                const isActiveMatch = virtualRow.index === activeMatchRow;
                return (
                  <div
                    key={line.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: wrapLines ? '100%' : 'max-content',
                      minWidth: '100%',
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    className={`log-row level-${line.level} ${isActiveMatch ? 'active-match-row' : ''}`}
                  >
                    <span className="log-line-num" data-line={line.id} />
                    {showTimestamps && (
                      <span
                        className="log-time"
                        data-time={formatTime(line.timestamp)}
                      />
                    )}
                    <span className="log-content">
                      {renderHighlightedSpans(line, searchRegex)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {!isAutoFollow && filteredLogs.length > 0 && (
          <button
            type="button"
            className="jump-bottom-pill"
            onClick={resumeAutoScroll}
          >
            <ArrowDownToLine size={13} />
            {scrollLocked ? 'Scroll Locked — Resume' : 'Jump to Bottom'}
          </button>
        )}

        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="context-menu"
            style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="context-menu-item"
              disabled={!contextMenu.selectedText}
              onClick={() => {
                const text = contextMenu.selectedText;
                setContextMenu(null);
                if (text) onCopyText(text, 'selected text');
              }}
            >
              <Copy size={14} />
              <span className="context-menu-label">Copy</span>
              <span className="context-menu-shortcut">Ctrl+C</span>
            </button>

            {contextMenu.selectedLines.length > 0 && (
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const lines = contextMenu.selectedLines;
                  setContextMenu(null);
                  onCopyText(
                    lines.join('\n'),
                    lines.length === 1 ? 'line' : `${lines.length} lines`
                  );
                }}
              >
                <Copy size={14} />
                <span className="context-menu-label">
                  {contextMenu.selectedLines.length > 1
                    ? `Copy Lines (${contextMenu.selectedLines.length})`
                    : 'Copy Lines'}
                </span>
              </button>
            )}

            {contextMenu.clickedLine?.errorBlockId !== undefined && (
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  const blockId = contextMenu.clickedLine!.errorBlockId!;
                  setContextMenu(null);
                  copyErrorBlock(blockId);
                }}
              >
                <AlertTriangle size={14} />
                <span className="context-menu-label">Copy Error Block</span>
              </button>
            )}

            <div className="context-menu-divider" />

            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null);
                setSearchOpen(true);
                requestAnimationFrame(() => {
                  searchInputRef.current?.focus();
                  searchInputRef.current?.select();
                });
              }}
            >
              <Search size={14} />
              <span className="context-menu-label">Find in Console</span>
              <span className="context-menu-shortcut">Ctrl+F</span>
            </button>

            <button
              type="button"
              className="context-menu-item"
              disabled={logs.length === 0}
              onClick={() => {
                setContextMenu(null);
                onClear(config.id);
              }}
            >
              <Trash2 size={14} />
              <span className="context-menu-label">Clear Console</span>
            </button>
          </div>
        )}
      </div>
    </main>
  );
};

function renderHighlightedSpans(
  line: LogLine,
  searchRegex: RegExp | null
): React.ReactNode {
  if (!searchRegex) {
    return line.spans.map((span, idx) => (
      <span
        key={idx}
        style={{
          color: span.fg,
          backgroundColor: span.bg,
          fontWeight: span.bold ? 600 : undefined,
          opacity: span.dim ? 0.72 : undefined
        }}
      >
        {span.text}
      </span>
    ));
  }

  // Highlight matches across raw text while preserving readability
  const text = line.raw;
  const parts: React.ReactNode[] = [];
  searchRegex.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let guard = 0;

  while ((match = searchRegex.exec(text)) !== null && guard < 100) {
    guard += 1;
    if (match[0].length === 0) {
      searchRegex.lastIndex += 1;
      continue;
    }
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <mark key={`${match.index}-${guard}`} className="log-search-hit">
        {match[0]}
      </mark>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}
