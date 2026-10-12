import { useState, type FormEvent } from 'react';
import { FormattedMessage } from 'react-intl';
import { Link, useNavigate } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync } from '../App.tsx';

export function SystemsPage() {
  const navigate = useNavigate();
  const list = useAsync(() => brain.systems({}), []);
  const [form, setForm] = useState({ title: '', description: '', stack: '', deployment: '' });
  const [error, setError] = useState<unknown>();
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const { system } = await brain.createSystem({ title: form.title.trim(), description: form.description.trim(), stack: form.stack.split(',').map((item) => item.trim()).filter(Boolean), deployment: form.deployment.trim() });
      void navigate(`/entities/${system.id}`);
    } catch (reason) {
      setError(reason);
    }
  };
  return (
    <>
      <h1>
        <FormattedMessage id="systems.title" />
      </h1>
      <p className="muted">
        <FormattedMessage id="systems.hint" />
      </p>
      <ErrorLine error={error ?? list.error} />
      <div className="grid">
        <section className="card">
          <ul className="plain">
            {list.data?.systems.map((system) => (
              <li key={system.id}>
                <Link to={`/entities/${system.id}`}>{system.title}</Link>
                {Array.isArray(system.data.stack) && system.data.stack.length > 0 && <span className="muted"> · {(system.data.stack as string[]).join(', ')}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>
            <FormattedMessage id="systems.new" />
          </h2>
          <form className="inline" onSubmit={(event) => void create(event)}>
            <label>
              <FormattedMessage id="systems.form.title" />
              <input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="systems.form.stack" />
              <input type="text" value={form.stack} onChange={(event) => setForm({ ...form, stack: event.target.value })} />
            </label>
            <label>
              <FormattedMessage id="systems.form.deployment" />
              <input type="text" value={form.deployment} onChange={(event) => setForm({ ...form, deployment: event.target.value })} />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <FormattedMessage id="systems.form.description" />
              <textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </label>
            <button type="submit">
              <FormattedMessage id="systems.form.create" />
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
