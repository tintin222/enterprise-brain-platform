import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link } from 'react-router';
import { brain, type Entity } from '../api.ts';
import { ErrorLine, useAsync } from '../App.tsx';
import { UploadForm } from './UploadForm.tsx';

type Env = { name: string; url?: string; notes?: string };
const INVENTORY = ['screens', 'modules', 'knownIssues', 'painPoints'] as const;

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const lines = (value: string): string[] => value.split('\n').map((item) => item.trim()).filter(Boolean);

/** A system's own panels (FR-3): facts and owners, environments, repositories, inventory, artifacts, integrations, containers. */
export function SystemPanel({ entity, onChange }: { entity: Entity; onChange: () => void }) {
  const intl = useIntl();
  const view = useAsync(() => brain.system(entity.id), [entity.id, entity.version]);
  const people = useAsync(() => brain.people({ limit: '500' }), []);
  const containers = useAsync(() => brain.containers({ status: 'active' }), []);
  const systems = useAsync(() => brain.systems({}), []);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [envs, setEnvs] = useState<Env[]>([]);
  const [integration, setIntegration] = useState({ toSystemId: '', protocol: '', payload: '' });
  const [useIn, setUseIn] = useState('');
  const [error, setError] = useState<unknown>();
  const data = entity.data;
  const inventory = (data.inventory ?? {}) as Record<string, unknown>;
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      onChange();
      view.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const startEdit = () => {
    setForm({
      description: typeof data.description === 'string' ? data.description : '',
      stack: list(data.stack).join(', '),
      deployment: typeof data.deployment === 'string' ? data.deployment : '',
      repositories: list(data.repositories).join('\n'),
      businessOwnerId: typeof data.businessOwnerId === 'string' ? data.businessOwnerId : '',
      technicalOwnerId: typeof data.technicalOwnerId === 'string' ? data.technicalOwnerId : '',
      ...Object.fromEntries(INVENTORY.map((key) => [key, list(inventory[key]).join('\n')])),
    });
    setEnvs(Array.isArray(data.environments) ? (data.environments as Env[]) : []);
    setEditing(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await brain.updateSystem(entity.id, {
        description: form.description ?? '',
        stack: (form.stack ?? '').split(',').map((item) => item.trim()).filter(Boolean),
        deployment: form.deployment ?? '',
        repositories: lines(form.repositories ?? ''),
        businessOwnerId: form.businessOwnerId || undefined,
        technicalOwnerId: form.technicalOwnerId || undefined,
        environments: envs.filter((env) => env.name.trim()),
        inventory: Object.fromEntries(INVENTORY.map((key) => [key, lines(form[key] ?? '')])),
      });
      setEditing(false);
    });
  };
  const personName = (id: unknown): string => (typeof id === 'string' ? (people.data?.people.find((person) => person.id === id)?.title ?? id) : '—');
  return (
    <>
      <section className="card">
        <h2>
          <FormattedMessage id="type.system" />
        </h2>
        <ErrorLine error={error ?? view.error} />
        {!editing && (
          <dl>
            <div>
              <dt>
                <FormattedMessage id="system.description" />
              </dt>
              <dd>{typeof data.description === 'string' && data.description ? data.description : '—'}</dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="system.owners" />
              </dt>
              <dd>
                <FormattedMessage id="system.businessOwner" />: {personName(data.businessOwnerId)} · <FormattedMessage id="system.technicalOwner" />: {personName(data.technicalOwnerId)}
              </dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="system.stack" />
              </dt>
              <dd>{list(data.stack).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="system.deployment" />
              </dt>
              <dd>{typeof data.deployment === 'string' && data.deployment ? data.deployment : '—'}</dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="system.environments" />
              </dt>
              <dd>
                {(Array.isArray(data.environments) ? (data.environments as Env[]) : []).map((env) => (
                  <div key={env.name}>
                    <span className="badge">{env.name}</span> {env.url ? <a href={env.url}>{env.url}</a> : ''} <span className="muted">{env.notes ?? ''}</span>
                  </div>
                ))}
              </dd>
            </div>
            <div>
              <dt>
                <FormattedMessage id="system.repositories" />
              </dt>
              <dd>{list(data.repositories).join(', ') || '—'}</dd>
            </div>
            {INVENTORY.map((key) => (
              <div key={key}>
                <dt>
                  <FormattedMessage id={`system.inventory.${key}`} />
                </dt>
                <dd>{list(inventory[key]).join('; ') || '—'}</dd>
              </div>
            ))}
            {!entity.archivedAt && (
              <dd>
                <button type="button" className="secondary" onClick={startEdit}>
                  <FormattedMessage id="system.edit" />
                </button>
              </dd>
            )}
          </dl>
        )}
        {editing && (
          <form className="inline" onSubmit={save}>
            <label style={{ gridColumn: '1 / -1' }}>
              <FormattedMessage id="system.description" />
              <textarea rows={3} value={form.description ?? ''} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>
            <label>
              <FormattedMessage id="system.businessOwner" />
              <select value={form.businessOwnerId ?? ''} onChange={(event) => setForm({ ...form, businessOwnerId: event.target.value })}>
                <option value="">—</option>
                {people.data?.people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <FormattedMessage id="system.technicalOwner" />
              <select value={form.technicalOwnerId ?? ''} onChange={(event) => setForm({ ...form, technicalOwnerId: event.target.value })}>
                <option value="">—</option>
                {people.data?.people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <FormattedMessage id="systems.form.stack" />
              <input type="text" value={form.stack ?? ''} onChange={(event) => setForm({ ...form, stack: event.target.value })} />
            </label>
            <label>
              <FormattedMessage id="system.deployment" />
              <input type="text" value={form.deployment ?? ''} onChange={(event) => setForm({ ...form, deployment: event.target.value })} />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <FormattedMessage id="system.repositories" />
              <textarea rows={2} value={form.repositories ?? ''} onChange={(event) => setForm({ ...form, repositories: event.target.value })} />
            </label>
            <div style={{ gridColumn: '1 / -1' }}>
              <strong>
                <FormattedMessage id="system.environments" />
              </strong>
              {envs.map((env, n) => (
                <div key={n}>
                  <input type="text" placeholder={intl.formatMessage({ id: 'system.environment.name' })} value={env.name} onChange={(event) => setEnvs(envs.map((item, i) => (i === n ? { ...item, name: event.target.value } : item)))} />{' '}
                  <input type="text" placeholder={intl.formatMessage({ id: 'system.environment.url' })} value={env.url ?? ''} onChange={(event) => setEnvs(envs.map((item, i) => (i === n ? { ...item, url: event.target.value } : item)))} />{' '}
                  <input type="text" placeholder={intl.formatMessage({ id: 'system.environment.notes' })} value={env.notes ?? ''} onChange={(event) => setEnvs(envs.map((item, i) => (i === n ? { ...item, notes: event.target.value } : item)))} />
                </div>
              ))}
              <button type="button" className="secondary" onClick={() => setEnvs([...envs, { name: '' }])}>
                <FormattedMessage id="system.environment.add" />
              </button>
            </div>
            {INVENTORY.map((key) => (
              <label key={key} style={{ gridColumn: '1 / -1' }}>
                <FormattedMessage id={`system.inventory.${key}`} />
                <textarea rows={2} value={form[key] ?? ''} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
              </label>
            ))}
            <button type="submit">
              <FormattedMessage id="system.save" />
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              <FormattedMessage id="system.cancel" />
            </button>
          </form>
        )}
      </section>
      <section className="card">
        <h2>
          <FormattedMessage id="system.artifacts" />
        </h2>
        {view.data?.artifacts.length === 0 && (
          <p className="muted">
            <FormattedMessage id="system.artifacts.empty" />
          </p>
        )}
        <ul className="plain">
          {view.data?.artifacts.map((artifact) => (
            <li key={artifact.id}>
              {typeof artifact.data.artifact === 'string' && (
                <span className="badge">
                  <FormattedMessage id={`artifact.${artifact.data.artifact}`} defaultMessage={artifact.data.artifact} />
                </span>
              )}
              <Link to={`/entities/${artifact.id}`}>{artifact.title}</Link>
              {artifact.data.structure !== undefined && (
                <span className="muted">
                  {' '}
                  · <FormattedMessage id="system.structure" />
                </span>
              )}
            </li>
          ))}
        </ul>
        {!entity.archivedAt && <UploadForm attachTo={entity.id} artifacts onDone={() => view.reload()} />}
      </section>
      <section className="card">
        <h2>
          <FormattedMessage id="system.integrations" />
        </h2>
        {view.data?.integrations.length === 0 && (
          <p className="muted">
            <FormattedMessage id="system.integrations.empty" />
          </p>
        )}
        <ul className="plain">
          {view.data?.integrations.map((item) => (
            <li key={item.link.id}>
              <FormattedMessage id={`system.integration.${item.direction}`} /> <Link to={`/entities/${item.other.id}`}>{item.other.title}</Link>
              <span className="muted">
                {' '}
                · {typeof item.link.data.protocol === 'string' ? item.link.data.protocol : ''} {typeof item.link.data.payload === 'string' ? item.link.data.payload : ''}
              </span>
            </li>
          ))}
        </ul>
        <form
          className="inline"
          onSubmit={(event) => {
            event.preventDefault();
            if (integration.toSystemId) void run(() => brain.addIntegration(entity.id, integration).then(() => setIntegration({ toSystemId: '', protocol: '', payload: '' })));
          }}
        >
          <label>
            <FormattedMessage id="system.integration.to" />
            <select value={integration.toSystemId} onChange={(event) => setIntegration({ ...integration, toSystemId: event.target.value })}>
              <option value="">—</option>
              {systems.data?.systems
                .filter((system) => system.id !== entity.id)
                .map((system) => (
                  <option key={system.id} value={system.id}>
                    {system.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <FormattedMessage id="system.integration.protocol" />
            <input type="text" value={integration.protocol} onChange={(event) => setIntegration({ ...integration, protocol: event.target.value })} />
          </label>
          <label>
            <FormattedMessage id="system.integration.payload" />
            <input type="text" value={integration.payload} onChange={(event) => setIntegration({ ...integration, payload: event.target.value })} />
          </label>
          <button type="submit">
            <FormattedMessage id="system.integration.add" />
          </button>
        </form>
      </section>
      <section className="card">
        <h2>
          <FormattedMessage id="system.containers" />
        </h2>
        <ul className="plain">
          {view.data?.containers.map((container) => (
            <li key={container.id}>
              <span className="badge kind">
                <FormattedMessage id={`containers.kind.${container.kind}`} />
              </span>
              <Link to={`/containers/${container.id}`}>{container.title}</Link>
            </li>
          ))}
        </ul>
        <form
          className="inline"
          onSubmit={(event) => {
            event.preventDefault();
            if (useIn) void run(() => brain.linkSystem(entity.id, useIn).then(() => setUseIn('')));
          }}
        >
          <label>
            <FormattedMessage id="system.containers.add" />
            <select value={useIn} onChange={(event) => setUseIn(event.target.value)}>
              <option value="">—</option>
              {containers.data?.containers
                .filter((container) => container.kind !== 'general')
                .map((container) => (
                  <option key={container.id} value={container.id}>
                    {container.title}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit">
            <FormattedMessage id="system.containers.add" />
          </button>
        </form>
      </section>
    </>
  );
}
