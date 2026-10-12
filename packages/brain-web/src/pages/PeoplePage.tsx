import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync } from '../App.tsx';

export function PeoplePage() {
  const intl = useIntl();
  const [filter, setFilter] = useState<'all' | 'internal' | 'external'>('all');
  const [q, setQ] = useState('');
  const people = useAsync(() => brain.people({ ...(filter === 'all' ? {} : { external: filter === 'external' ? 'true' : 'false' }), ...(q ? { q } : {}) }), [filter, q]);
  const [form, setForm] = useState({ name: '', emails: '', organisation: '', role: '', notes: '' });
  const [error, setError] = useState<unknown>();
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await brain.createExternalContact({
        name: form.name.trim(),
        emails: form.emails.split(',').map((item) => item.trim()).filter(Boolean),
        organisation: form.organisation.trim() || undefined,
        role: form.role.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      setForm({ name: '', emails: '', organisation: '', role: '', notes: '' });
      people.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  return (
    <>
      <h1>
        <FormattedMessage id="people.title" />
      </h1>
      <p className="muted">
        <FormattedMessage id="people.hint" />
      </p>
      <ErrorLine error={people.error ?? error} />
      <div className="grid">
        <section className="card">
          <form className="inline" onSubmit={(event) => event.preventDefault()}>
            <label>
              <FormattedMessage id="search.title" />
              <input type="search" value={q} onChange={(event) => setQ(event.target.value)} />
            </label>
            <label>
              <FormattedMessage id="people.filter.all" />
              <select value={filter} onChange={(event) => setFilter(event.target.value as 'all' | 'internal' | 'external')}>
                <option value="all">{intl.formatMessage({ id: 'people.filter.all' })}</option>
                <option value="internal">{intl.formatMessage({ id: 'people.filter.internal' })}</option>
                <option value="external">{intl.formatMessage({ id: 'people.filter.external' })}</option>
              </select>
            </label>
          </form>
          <ul className="plain">
            {people.data?.people.map((person) => (
              <li key={person.id}>
                <Link to={`/people/${person.id}`}>{person.title}</Link>
                {typeof person.data.role === 'string' && person.data.role && <span className="muted"> · {person.data.role}</span>}
                {typeof person.data.organisation === 'string' && person.data.organisation && <span className="muted"> · {person.data.organisation}</span>}
                {Boolean(person.data.external) && (
                  <span className="badge">
                    <FormattedMessage id="people.external" />
                  </span>
                )}
                {person.status === 'inactive' && (
                  <span className="badge">
                    <FormattedMessage id="people.inactive" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>
            <FormattedMessage id="people.newExternal" />
          </h2>
          <form className="inline" onSubmit={(event) => void create(event)}>
            <label>
              <FormattedMessage id="people.form.name" />
              <input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="people.form.emails" />
              <input type="text" value={form.emails} onChange={(event) => setForm({ ...form, emails: event.target.value })} />
            </label>
            <label>
              <FormattedMessage id="people.form.organisation" />
              <input type="text" value={form.organisation} onChange={(event) => setForm({ ...form, organisation: event.target.value })} maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="people.form.role" />
              <input type="text" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} maxLength={120} />
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <FormattedMessage id="people.form.notes" />
              <textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
            </label>
            <button type="submit">
              <FormattedMessage id="people.form.create" />
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
