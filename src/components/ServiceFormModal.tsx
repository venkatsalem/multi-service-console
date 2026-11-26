import React, { useEffect, useState } from 'react';
import { FolderOpen, Trash2, X } from 'lucide-react';
import { ServiceConfig, ServiceType } from '../../shared/types';

interface ServiceFormModalProps {
  initial?: ServiceConfig | null;
  defaultCwd?: string;
  existingGroups: string[];
  onClose: () => void;
  onDelete?: (id: string) => Promise<void> | void;
  onSave: (
    data: Partial<ServiceConfig> & {
      name: string;
      command: string;
      cwd: string;
    }
  ) => Promise<void>;
}

const SERVICE_TYPES: Array<{ value: ServiceType; label: string }> = [
  { value: 'java', label: 'Java / Spring Boot' },
  { value: 'node', label: 'Node.js / Frontend' },
  { value: 'kafka', label: 'Kafka / Messaging' },
  { value: 'docker', label: 'Docker / Compose' },
  { value: 'python', label: 'Python' },
  { value: 'shell', label: 'Shell / Custom' }
];

function parseEnvText(text: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key) result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function formatEnvText(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export const ServiceFormModal: React.FC<ServiceFormModalProps> = ({
  initial,
  defaultCwd = '',
  existingGroups,
  onClose,
  onDelete,
  onSave
}) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [group, setGroup] = useState(initial?.group ?? 'Default');
  const [type, setType] = useState<ServiceType>(initial?.type ?? 'java');
  const [cwd, setCwd] = useState(initial?.cwd ?? defaultCwd);
  const [command, setCommand] = useState(initial?.command ?? '');
  const [portsText, setPortsText] = useState(
    initial?.ports ? initial.ports.join(', ') : ''
  );
  const [readyPattern, setReadyPattern] = useState(
    initial?.readyPattern ?? ''
  );
  const [startupDelayMs, setStartupDelayMs] = useState(
    initial?.startupDelayMs !== undefined ? String(initial.startupDelayMs) : ''
  );
  const [envText, setEnvText] = useState(formatEnvText(initial?.env));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleBrowseFolder = async () => {
    const picked = await window.serviceConsole.pickFolder();
    if (picked) setCwd(picked);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !command.trim() || !cwd.trim()) {
      setError('Name, Working Directory, and Command are required.');
      return;
    }

    const ports = portsText
      .split(/[,\s]+/)
      .map((p) => Number.parseInt(p.trim(), 10))
      .filter((p) => Number.isFinite(p) && p > 0 && p < 65536);

    const delayNum = Number.parseInt(startupDelayMs.trim(), 10);

    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...(initial?.id ? { id: initial.id } : {}),
        name: name.trim(),
        group: group.trim() || 'Default',
        type,
        cwd: cwd.trim(),
        command: command.trim(),
        ports: ports.length > 0 ? ports : undefined,
        readyPattern: readyPattern.trim() || undefined,
        startupDelayMs:
          Number.isFinite(delayNum) && delayNum > 0 ? delayNum : undefined,
        env: parseEnvText(envText)
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{initial ? 'Edit Process' : 'Add Process'}</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {error && <div className="form-error">{error}</div>}

          <div className="form-grid-2">
            <label className="form-field">
              <span>Service Name *</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. order-service"
                autoFocus
              />
            </label>

            <label className="form-field">
              <span>Project / Group</span>
              <input
                type="text"
                list="existing-groups-datalist"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="e.g. E-Commerce Stack"
              />
              <datalist id="existing-groups-datalist">
                {existingGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </label>
          </div>

          <div className="form-grid-2">
            <label className="form-field">
              <span>Runtime Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ServiceType)}
              >
                {SERVICE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span>Expected Port(s) (optional)</span>
              <input
                type="text"
                value={portsText}
                onChange={(e) => setPortsText(e.target.value)}
                placeholder="e.g. 8080, 8443"
              />
            </label>
          </div>

          <label className="form-field">
            <span>Working Directory *</span>
            <div className="input-with-btn">
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="D:\Projects\order-service"
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleBrowseFolder()}
              >
                <FolderOpen size={14} />
                Browse
              </button>
            </div>
          </label>

          <label className="form-field">
            <span>Command * (multiple lines auto-chain with &amp;&amp;)</span>
            <textarea
              rows={5}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={'mvn compile\nmvn spring-boot:run'}
              className="mono-input command-textarea"
            />
          </label>

          <label className="form-field">
            <span>Environment Variables (KEY=VALUE per line, optional)</span>
            <textarea
              rows={3}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'SPRING_PROFILES_ACTIVE=local\nSERVER_PORT=8081'}
              className="mono-input"
            />
          </label>

          <div className="form-grid-2">
            <label className="form-field">
              <span>Ready Log Regex (optional)</span>
              <input
                type="text"
                value={readyPattern}
                onChange={(e) => setReadyPattern(e.target.value)}
                placeholder="e.g. Started .*Application in"
                className="mono-input"
              />
            </label>

            <label className="form-field">
              <span>Group Start Delay (ms)</span>
              <input
                type="number"
                min={0}
                step={500}
                value={startupDelayMs}
                onChange={(e) => setStartupDelayMs(e.target.value)}
                placeholder="e.g. 2000"
              />
            </label>
          </div>

          <div className="modal-footer modal-footer-split">
            <div>
              {initial && onDelete && (
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      const deleted = await Promise.resolve(
                        onDelete(initial.id)
                      );
                      void deleted;
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  Delete Process
                </button>
              )}
            </div>
            <div className="modal-footer-right">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
              >
                {saving
                  ? 'Saving...'
                  : initial
                    ? 'Save Changes'
                    : 'Add Process'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
