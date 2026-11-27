import React, { useEffect, useMemo, useState } from 'react';
import { Play, X } from 'lucide-react';
import { ServiceSnapshot } from '../../shared/types';

interface BatchStartModalProps {
  services: ServiceSnapshot[];
  onStartSelected: (serviceIds: string[]) => Promise<void>;
  onClose: () => void;
}

const EXCLUDED_STORAGE_KEY = 'msc.excludedStartAllIds';

function loadExcludedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXCLUDED_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((x): x is string => typeof x === 'string'));
      }
    }
  } catch {
    // ignore malformed storage
  }
  return new Set();
}

export const BatchStartModal: React.FC<BatchStartModalProps> = ({
  services,
  onStartSelected,
  onClose
}) => {
  const [excludedIds, setExcludedIds] = useState<Set<string>>(() =>
    loadExcludedIds()
  );
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    localStorage.setItem(EXCLUDED_STORAGE_KEY, JSON.stringify([...excludedIds]));
  }, [excludedIds]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isStarting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isStarting, onClose]);

  const selectedServices = useMemo(
    () => services.filter((s) => !excludedIds.has(s.config.id)),
    [services, excludedIds]
  );

  const stoppedServices = useMemo(
    () =>
      services.filter(
        (s) =>
          s.runtime.status !== 'running' &&
          s.runtime.status !== 'starting' &&
          s.runtime.status !== 'stopping'
      ),
    [services]
  );

  const toggleService = (id: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      for (const s of services) next.delete(s.config.id);
      return next;
    });
  };

  const selectNone = () => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      for (const s of services) next.add(s.config.id);
      return next;
    });
  };

  const selectStoppedOnly = () => {
    const stoppedSet = new Set(stoppedServices.map((s) => s.config.id));
    setExcludedIds((prev) => {
      const next = new Set(prev);
      for (const s of services) {
        if (stoppedSet.has(s.config.id)) next.delete(s.config.id);
        else next.add(s.config.id);
      }
      return next;
    });
  };

  const handleStart = async () => {
    if (selectedServices.length === 0) return;
    setIsStarting(true);
    try {
      await onStartSelected(selectedServices.map((s) => s.config.id));
      onClose();
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!isStarting) onClose();
      }}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Start Selected Services</h3>
          <button
            type="button"
            className="icon-btn"
            disabled={isStarting}
            onClick={onClose}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="batch-select-header">
            <span className="modal-hint">
              {selectedServices.length} of {services.length} service(s) selected
              (exclusions are remembered)
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={isStarting}
                onClick={selectAll}
              >
                All
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                disabled={isStarting}
                onClick={selectNone}
              >
                None
              </button>
              {stoppedServices.length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={isStarting}
                  onClick={selectStoppedOnly}
                >
                  Stopped ({stoppedServices.length})
                </button>
              )}
            </div>
          </div>

          <div className="batch-service-list">
            {services.map((snap) => {
              const checked = !excludedIds.has(snap.config.id);
              const isRunning =
                snap.runtime.status === 'running' ||
                snap.runtime.status === 'starting';
              return (
                <label
                  key={snap.config.id}
                  className={`batch-service-row ${checked ? '' : 'excluded'}`}
                >
                  <input
                    type="checkbox"
                    disabled={isStarting}
                    checked={checked}
                    onChange={() => toggleService(snap.config.id)}
                  />
                  <span className="batch-service-name">{snap.config.name}</span>
                  <span className="summary-pill">{snap.config.group}</span>
                  <span style={{ flex: 1 }} />
                  <span
                    className={`summary-pill ${isRunning ? 'pill-running' : ''}`}
                  >
                    {snap.runtime.status}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="modal-footer modal-footer-split">
            <span className="modal-hint">
              Running services are skipped cleanly
            </span>
            <div className="modal-footer-right">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={isStarting}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={isStarting || selectedServices.length === 0}
                onClick={() => void handleStart()}
              >
                <Play size={13} />
                {isStarting
                  ? 'Starting...'
                  : `Start Selected (${selectedServices.length})`}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
