import React, { useEffect, useState } from 'react';
import { FolderSearch, Plus, X } from 'lucide-react';
import {
  DiscoveredServiceCandidate,
  ServiceConfig
} from '../../shared/types';

interface ScanWorkspaceModalProps {
  onClose: () => void;
  onImport: (configs: ServiceConfig[]) => Promise<void>;
}

export const ScanWorkspaceModal: React.FC<ScanWorkspaceModalProps> = ({
  onClose,
  onImport
}) => {
  const [folder, setFolder] = useState('');
  const [scanning, setScanning] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveredServiceCandidate[]>(
    []
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupOverride, setGroupOverride] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handlePickAndScan = async () => {
    const picked = await window.serviceConsole.pickFolder();
    if (!picked) return;
    setFolder(picked);
    setScanning(true);
    try {
      const found = await window.serviceConsole.scanFolder(picked);
      setCandidates(found);
      setSelected(new Set(found.map((c) => c.tempId)));
      if (found.length > 0 && !groupOverride) {
        setGroupOverride(found[0].group);
      }
    } finally {
      setScanning(false);
    }
  };

  const toggleItem = (tempId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tempId)) next.delete(tempId);
      else next.add(tempId);
      return next;
    });
  };

  const handleImport = async () => {
    const chosen = candidates.filter((c) => selected.has(c.tempId));
    if (chosen.length === 0) return;

    setImporting(true);
    try {
      const configs: ServiceConfig[] = chosen.map((c, idx) => ({
        id: '',
        name: c.name,
        group: groupOverride.trim() || c.group,
        type: c.type,
        command: c.command,
        cwd: c.cwd,
        ports: c.ports,
        order: idx
      }));
      await onImport(configs);
      onClose();
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-card-wide"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Scan Workspace for Services</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-hint">
            Pick a project root folder to auto-discover Maven, Gradle, Node.js,
            Docker Compose, and Django commands.
          </p>

          <div className="input-with-btn">
            <input
              type="text"
              readOnly
              value={folder}
              placeholder="No folder selected..."
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handlePickAndScan()}
              disabled={scanning}
            >
              <FolderSearch size={14} />
              {scanning ? 'Scanning...' : 'Choose Folder & Scan'}
            </button>
          </div>

          {candidates.length > 0 && (
            <>
              <label className="form-field">
                <span>Import into Project / Group</span>
                <input
                  type="text"
                  value={groupOverride}
                  onChange={(e) => setGroupOverride(e.target.value)}
                  placeholder="Project group name"
                />
              </label>

              <div className="scan-list-header">
                <span>
                  Discovered {candidates.length} command
                  {candidates.length === 1 ? '' : 's'} ({selected.size}{' '}
                  selected)
                </span>
                <div className="scan-list-actions">
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() =>
                      setSelected(new Set(candidates.map((c) => c.tempId)))
                    }
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="scan-list">
                {candidates.map((c) => (
                  <label key={c.tempId} className="scan-item">
                    <input
                      type="checkbox"
                      checked={selected.has(c.tempId)}
                      onChange={() => toggleItem(c.tempId)}
                    />
                    <div className="scan-item-info">
                      <div className="scan-item-top">
                        <strong>{c.name}</strong>
                        <span className={`type-badge type-${c.type}`}>
                          {c.type}
                        </span>
                        {c.ports && c.ports.length > 0 && (
                          <span className="port-pill">:{c.ports[0]}</span>
                        )}
                      </div>
                      <div className="scan-item-cmd mono-text">{c.command}</div>
                      <div className="scan-item-cwd">{c.cwd}</div>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {folder && !scanning && candidates.length === 0 && (
            <div className="empty-inline">
              No recognizable `package.json`, `pom.xml`, `build.gradle`, or
              `docker-compose.yml` commands found within 3 levels.
            </div>
          )}

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={selected.size === 0 || importing}
              onClick={() => void handleImport()}
            >
              <Plus size={14} />
              {importing
                ? 'Importing...'
                : `Import ${selected.size} Service${selected.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
