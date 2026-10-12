import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useParams } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync, useMe, when } from '../App.tsx';

const NEW_TYPES = ['decision', 'requirement', 'task', 'system', 'person', 'document', 'agent_note'];

export function ContainerPage() {
  const intl = useIntl();
  const me = useMe();
  const { id = '' } = useParams();
  const detail = useAsync(() => brain.container(id), [id]);
  const entities = useAsync(() => brain.containerEntities(id, { limit: '200' }), [id]);
  const [type, setType] = useState('decision');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>();
  const container = detail.data?.container;
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await brain.createEntity({ type, title: title.trim(), containerId: id, text });
      setTitle('');
      setText('');
      entities.reload();
      detail.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const archive = async () => {
    try {
      await brain.archiveContainer(id);
      detail.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const conversations = entities.data?.entities.filter((entity) => entity.type === 'conversation') ?? [];
  const others = entities.data?.entities.filter((entity) => entity.type !== 'conversation') ?? [];
  return (
    <>
      <ErrorLine error={detail.error ?? entities.error ?? error} />
      {container && (
        <>
          <h1>
            <span className="badge kind">
              <FormattedMessage id={`containers.kind.${container.kind}`} />
            </span>
            {container.title}
          </h1>
          {container.status === 'archived' && (
            <p className="muted">
              <FormattedMessage id="container.archived" />
            </p>
          )}
          <div className="grid">
            <section className="card">
              <h2>
                <FormattedMessage id="container.channels" />
              </h2>
              {detail.data?.channels.length === 0 && (
                <p className="muted">
                  <FormattedMessage id="container.noChannels" />
                </p>
              )}
              <ul className="plain">
                {detail.data?.channels.map((channel) => (
                  <li key={channel.mmChannelId}>
                    <span className="badge">{channel.role}</span>
                    <code>{channel.mmChannelId}</code>
                    {me && (
                      <>
                        {' · '}
                        <a href={`${me.chatUrl}/_redirect/channels/${channel.mmChannelId}`} target="_blank" rel="noreferrer">
                          <FormattedMessage id="container.openInChat" />
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {container.kind !== 'general' && container.status === 'active' && (
                <p>
                  <button className="danger" type="button" onClick={() => void archive()}>
                    <FormattedMessage id="container.archive" />
                  </button>
                </p>
              )}
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="container.newEntity" />
              </h2>
              <form className="inline" onSubmit={(event) => void create(event)}>
                <label>
                  <FormattedMessage id="container.form.type" />
                  <select value={type} onChange={(event) => setType(event.target.value)}>
                    {NEW_TYPES.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {intl.formatMessage({ id: `type.${candidate}` })}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <FormattedMessage id="container.form.title" />
                  <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={500} />
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  <FormattedMessage id="container.form.text" />
                  <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
                </label>
                <button type="submit">
                  <FormattedMessage id="container.form.create" />
                </button>
              </form>
            </section>
          </div>
          <section className="card">
            <h2>
              <FormattedMessage id="container.entities" /> <span className="muted">({others.length})</span>
            </h2>
            <ul className="plain">
              {others.map((entity) => (
                <li key={entity.id}>
                  <span className="badge">
                    <FormattedMessage id={`type.${entity.type}`} />
                  </span>
                  <Link to={`/entities/${entity.id}`}>{entity.title}</Link>
                  <span className="muted"> · {entity.status} · {when(entity.updatedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>
              <FormattedMessage id="container.conversations" /> <span className="muted">({conversations.length})</span>
            </h2>
            <ul className="plain">
              {conversations.map((entity) => (
                <li key={entity.id}>
                  <Link to={`/entities/${entity.id}`}>{entity.title}</Link>
                  <span className="muted"> · {typeof entity.data.channel_name === 'string' ? entity.data.channel_name : ''} · {when(entity.updatedAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
