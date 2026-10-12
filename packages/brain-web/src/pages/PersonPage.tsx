import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useParams } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync, useMe } from '../App.tsx';

const FIELDS = ['role', 'organisation', 'workingHours', 'preferredChannel'] as const;
const TAG_FIELDS = ['expertise', 'responsibilities'] as const;

function tags(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function PersonPage() {
  const intl = useIntl();
  const me = useMe();
  const { id = '' } = useParams();
  const detail = useAsync(() => brain.person(id), [id]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>();
  const person = detail.data?.person;
  const external = Boolean(person?.data.external);
  const mayEdit = Boolean(person && (external || me?.principal.isAdmin || me?.principal.personId === person.id));
  const startEditing = () => {
    if (!person) return;
    const next: Record<string, string> = {};
    for (const field of FIELDS) next[field] = typeof person.data[field] === 'string' ? (person.data[field]) : '';
    for (const field of TAG_FIELDS) next[field] = tags(person.data[field]).join(', ');
    next.name = person.title;
    next.emails = tags(person.data.emails).join(', ');
    next.notes = typeof person.data.notes === 'string' ? person.data.notes : '';
    setForm(next);
    setEditing(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const body: Record<string, unknown> = {};
      for (const field of FIELDS) body[field] = form[field] ?? '';
      for (const field of TAG_FIELDS) body[field] = (form[field] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      if (external) {
        body.name = form.name;
        body.emails = (form.emails ?? '').split(',').map((item) => item.trim()).filter(Boolean);
        body.notes = form.notes ?? '';
      }
      await brain.updateProfile(id, body);
      setEditing(false);
      detail.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const decide = async (n: number, decision: 'confirm' | 'dismiss') => {
    try {
      await brain.decideSuggestion(id, n, decision);
      detail.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const knows = useAsync(() => (person ? brain.search({ q: person.title, limit: '10' }) : Promise.resolve(undefined)), [person?.id]);
  return (
    <>
      <ErrorLine error={detail.error ?? error} />
      {person && (
        <>
          <h1>
            <span className="badge kind">
              <FormattedMessage id="type.person" />
            </span>
            {person.title}
            {external && (
              <span className="badge">
                <FormattedMessage id="people.external" />
              </span>
            )}
          </h1>
          <div className="grid">
            <section className="card">
              <h2>
                <FormattedMessage id="person.profile" />
              </h2>
              {!editing && (
                <dl>
                  {!external && typeof person.data.username === 'string' && (
                    <>
                      <dt>
                        <FormattedMessage id="person.username" />
                      </dt>
                      <dd>@{person.data.username}</dd>
                    </>
                  )}
                  {FIELDS.map((field) => (
                    <div key={field}>
                      <dt>
                        <FormattedMessage id={`person.${field}`} />
                      </dt>
                      <dd>{typeof person.data[field] === 'string' && person.data[field] ? (person.data[field]) : <span className="muted">{intl.formatMessage({ id: 'person.empty' })}</span>}</dd>
                    </div>
                  ))}
                  {TAG_FIELDS.map((field) => (
                    <div key={field}>
                      <dt>
                        <FormattedMessage id={`person.${field}`} />
                      </dt>
                      <dd>
                        {tags(person.data[field]).length === 0 && <span className="muted">{intl.formatMessage({ id: 'person.empty' })}</span>}
                        {tags(person.data[field]).map((tag) => (
                          <span key={tag} className="badge">
                            {tag}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                  {external && (
                    <div>
                      <dt>
                        <FormattedMessage id="person.emails" />
                      </dt>
                      <dd>{tags(person.data.emails).join(', ') || <span className="muted">{intl.formatMessage({ id: 'person.empty' })}</span>}</dd>
                    </div>
                  )}
                  {mayEdit && (
                    <dd>
                      <button type="button" className="secondary" onClick={startEditing}>
                        <FormattedMessage id="person.edit" />
                      </button>
                    </dd>
                  )}
                </dl>
              )}
              {editing && (
                <form className="inline" onSubmit={(event) => void save(event)}>
                  {external && (
                    <>
                      <label>
                        <FormattedMessage id="people.form.name" />
                        <input type="text" value={form.name ?? ''} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
                      </label>
                      <label>
                        <FormattedMessage id="person.emails" />
                        <input type="text" value={form.emails ?? ''} onChange={(event) => setForm({ ...form, emails: event.target.value })} />
                      </label>
                    </>
                  )}
                  {FIELDS.map((field) => (
                    <label key={field}>
                      <FormattedMessage id={`person.${field}`} />
                      <input type="text" value={form[field] ?? ''} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
                    </label>
                  ))}
                  {TAG_FIELDS.map((field) => (
                    <label key={field}>
                      <FormattedMessage id={`person.${field}`} /> <span className="muted">({intl.formatMessage({ id: 'person.tagsHint' })})</span>
                      <input type="text" value={form[field] ?? ''} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />
                    </label>
                  ))}
                  {external && (
                    <label style={{ gridColumn: '1 / -1' }}>
                      <FormattedMessage id="people.form.notes" />
                      <textarea rows={3} value={form.notes ?? ''} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
                    </label>
                  )}
                  <button type="submit">
                    <FormattedMessage id="person.save" />
                  </button>
                  <button type="button" className="secondary" onClick={() => setEditing(false)}>
                    <FormattedMessage id="person.cancel" />
                  </button>
                </form>
              )}
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="person.memberships" />
              </h2>
              {detail.data?.memberships.length === 0 && (
                <p className="muted">
                  <FormattedMessage id="person.noMemberships" />
                </p>
              )}
              <ul className="plain">
                {detail.data?.memberships.map((membership) => (
                  <li key={membership.containerId}>
                    <span className="badge">
                      <FormattedMessage id={`role.${membership.role}`} />
                    </span>
                    <Link to={`/containers/${membership.containerId}`}>{membership.title}</Link>
                    <span className="muted"> · {intl.formatMessage({ id: `containers.kind.${membership.kind}` })}</span>
                  </li>
                ))}
              </ul>
              {detail.data && detail.data.suggestions.length > 0 && (
                <>
                  <h2>
                    <FormattedMessage id="person.suggestions" />
                  </h2>
                  <ul className="plain">
                    {detail.data.suggestions.map((suggestion, n) => (
                      <li key={`${suggestion.kind}-${suggestion.value}`}>
                        <span className="badge">{suggestion.kind}</span> {suggestion.value}
                        {suggestion.reason && <span className="muted"> · {suggestion.reason}</span>}{' '}
                        {mayEdit && (
                          <>
                            <button type="button" onClick={() => void decide(n, 'confirm')}>
                              <FormattedMessage id="person.confirm" />
                            </button>{' '}
                            <button type="button" className="secondary" onClick={() => void decide(n, 'dismiss')}>
                              <FormattedMessage id="person.dismiss" />
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          </div>
          <section className="card">
            <h2>
              <FormattedMessage id="person.knows" />
            </h2>
            <ul className="plain">
              {knows.data?.results
                .filter((result) => result.entityId !== person.id)
                .map((result) => (
                  <li key={result.chunkId}>
                    <span className="badge">
                      <FormattedMessage id={`type.${result.entityType}`} />
                    </span>
                    <Link to={`/entities/${result.entityId}`}>{result.title}</Link>
                  </li>
                ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
