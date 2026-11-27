import React, { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { ServiceSnapshot } from '../../shared/types';

interface ConfirmActionModalProps {
  title: string;
  description: string;
  confirmLabel: string;
  runningServices: ServiceSnapshot[];
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmActionModal: React.FC<ConfirmActionModalProps> = ({
  title,
  description,
  confirmLabel,
  runningServices,
  onConfirm,
  onCancel
}) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={18} style={{ color: 'var(--red)' }} />
            <h3>{title}</h3>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onCancel}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <p className="modal-hint">{description}</p>

          {runningServices.length > 0 && (
            <div className="confirm-service-list">
              {runningServices.map((s) => (
                <div key={s.config.id} className="confirm-service-item">
                  <strong>{s.config.name}</strong>
                  <span className="summary-pill">
                    {s.runtime.status}
                    {s.runtime.pid ? ` · PID ${s.runtime.pid}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger-outline"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
