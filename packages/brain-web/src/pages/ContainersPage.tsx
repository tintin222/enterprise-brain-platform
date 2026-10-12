import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync, when } from '../App.tsx';

export function ContainersPage() {
  const intl = useIntl();
  const list = useAsync(() => brain.containers({}), []);
  const [kind, setKind] = useState<'project' | 'topic'>('project');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<unknown>();
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await brain.createContainer({ kind, title: title.trim() });
      setTitle('');
      list.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  return (
    <>
      <h1>
        <FormattedMessage id="containers.title" />
      </h1>
      <form className="inline card" onSubmit={(event) => void create(event)}>
        <label>
          <FormattedMessage id="containers.form.kind" />
          <select value={kind} onChange={(event) => setKind(event.target.value as 'project' | 'topic')}>
            <option value="project">{intl.formatMessage({ id: 'containers.kind.project' })}</option>
            <option value="topic">{intl.formatMessage({ id: 'containers.kind.topic' })}</option>
          </select>
        </label>
        <label>
          <FormattedMessage id="containers.form.title" />
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required minLength={1} maxLength={200} />
        </label>
        <button type="submit">
          <FormattedMessage id="containers.form.create" />
        </button>
      </form>
      <ErrorLine error={error ?? list.error} />
      <ul className="plain">
        {list.data?.containers.map((container) => (
          <li key={container.id}>
            <span className="badge kind">
              <FormattedMessage id={`containers.kind.${container.kind}`} />
            </span>
            <Link to={`/containers/${container.id}`}>{container.title}</Link>
            <span className="muted">
              {' '}
              · <FormattedMessage id={`containers.status.${container.status}`} /> · {when(container.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
