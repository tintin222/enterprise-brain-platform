import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useParams } from 'react-router';
import { brain, type Version } from '../api.ts';
import { ErrorLine, useAsync, when } from '../App.tsx';

/** Which fields differ between two versions (title, status, data keys, text). */
function changedFields(current: Version, previous: Version | undefined): string[] {
  if (!previous) return [];
  const changed: string[] = [];
  if (current.title !== previous.title) changed.push('title');
  if (current.status !== previous.status) changed.push('status');
  if (current.containerId !== previous.containerId) changed.push('container');
  if (current.visibility !== previous.visibility) changed.push('visibility');
  if (current.text !== previous.text) changed.push('text');
  for (const key of new Set([...Object.keys(current.data), ...Object.keys(previous.data)])) {
    if (JSON.stringify(current.data[key]) !== JSON.stringify(previous.data[key])) changed.push(`data.${key}`);
  }
  return changed;
}

export function EntityPage() {
  const intl = useIntl();
  const { id = '' } = useParams();
  const detail = useAsync(() => brain.entity(id), [id]);
  const versions = useAsync(() => brain.versions(id), [id]);
  const links = useAsync(() => brain.links(id), [id]);
  const backlinks = useAsync(() => brain.backlinks(id), [id]);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>();
  const entity = detail.data?.entity;
  const startEdit = () => {
    if (!entity) return;
    setTitle(entity.title);
    setText(entity.text);
    setEditing(true);
  };
  const save = async () => {
    try {
      await brain.updateEntity(id, { title: title.trim(), text });
      setEditing(false);
      detail.reload();
      versions.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const archive = async () => {
    try {
      await brain.archiveEntity(id);
      detail.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const sourceUrl = typeof entity?.data.source_url === 'string' ? entity.data.source_url : undefined;
  return (
    <>
      <ErrorLine error={detail.error ?? error} />
      {entity && detail.data && (
        <>
          <p className="muted">
            <FormattedMessage id="entity.container" />{' '}
            <Link to={`/containers/${detail.data.container.id}`}>{detail.data.container.title}</Link>
          </p>
          <h1>
            <span className="badge">
              <FormattedMessage id={`type.${entity.type}`} />
            </span>
            {editing ? <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} /> : entity.title}
          </h1>
          <p className="muted">
            <FormattedMessage id="entity.version" values={{ version: entity.version }} /> · <FormattedMessage id="entity.status" />: {entity.status} ·{' '}
            <FormattedMessage id="entity.updated" values={{ when: when(entity.updatedAt) }} /> · <FormattedMessage id="entity.created" values={{ when: when(entity.createdAt), who: entity.createdBy }} />
            {sourceUrl && (
              <>
                {' · '}
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  <FormattedMessage id="entity.source" />
                </a>
              </>
            )}
          </p>
          {entity.type !== 'conversation' && !entity.archivedAt && (
            <p>
              {editing ? (
                <>
                  <button type="button" onClick={() => void save()}>
                    <FormattedMessage id="entity.save" />
                  </button>{' '}
                  <button type="button" className="secondary" onClick={() => setEditing(false)}>
                    <FormattedMessage id="entity.cancel" />
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="secondary" onClick={startEdit}>
                    <FormattedMessage id="entity.edit" />
                  </button>{' '}
                  <button type="button" className="danger" onClick={() => void archive()}>
                    <FormattedMessage id="entity.archive" />
                  </button>
                </>
              )}
            </p>
          )}
          <div className="grid">
            <section className="card">
              <h2>
                <FormattedMessage id="entity.fields" />
              </h2>
              <dl className="fields">
                {Object.entries(entity.data).map(([key, value]) => (
                  <div key={key} style={{ display: 'contents' }}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="entity.links" />
              </h2>
              <ErrorLine error={links.error} />
              {links.data && links.data.outgoing.length + links.data.incoming.length === 0 && (
                <p className="muted">
                  <FormattedMessage id="entity.noLinks" />
                </p>
              )}
              <ul className="plain">
                {links.data?.outgoing.map((link) => (
                  <li key={link.id}>
                    <span className="badge">{link.kind}</span> → <Link to={`/entities/${link.toId}`}>{link.toId}</Link>
                  </li>
                ))}
                {links.data?.incoming.map((link) => (
                  <li key={link.id}>
                    <Link to={`/entities/${link.fromId}`}>{link.fromId}</Link> <span className="badge">{link.kind}</span> →
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <section className="card">
            <h2>
              <FormattedMessage id="entity.text" />
            </h2>
            {editing ? <textarea rows={12} value={text} onChange={(event) => setText(event.target.value)} /> : <pre className="text">{entity.text}</pre>}
          </section>
          <section className="card">
            <h2>
              <FormattedMessage id="entity.backlinks" />
            </h2>
            <ErrorLine error={backlinks.error} />
            {backlinks.data && backlinks.data.links.length + backlinks.data.mentions.length === 0 && (
              <p className="muted">
                <FormattedMessage id="entity.noBacklinks" />
              </p>
            )}
            <ul className="plain">
              {backlinks.data?.links.map((link) => (
                <li key={link.id}>
                  <Link to={`/entities/${link.fromId}`}>{link.fromId}</Link> <span className="badge">{link.kind}</span>
                </li>
              ))}
            </ul>
            {backlinks.data && backlinks.data.mentions.length > 0 && (
              <>
                <h3>
                  <FormattedMessage id="entity.mentions" />
                </h3>
                <ul className="plain">
                  {backlinks.data.mentions.map((mention) => (
                    <li key={mention.chunkId}>
                      <span className="badge">{intl.formatMessage({ id: `type.${mention.entityType}` })}</span>
                      <Link to={`/entities/${mention.entityId}`}>{mention.title}</Link>
                      <p className="snippet muted">{mention.snippet}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section className="card">
            <h2>
              <FormattedMessage id="entity.versions" />
            </h2>
            <ErrorLine error={versions.error} />
            <ul className="plain">
              {versions.data?.versions.map((version, index, all) => {
                const previous = all[index + 1];
                const changed = changedFields(version, previous);
                return (
                  <li key={version.version}>
                    {previous ? (
                      <FormattedMessage id="entity.versionLine" values={{ version: version.version, actor: version.actorId, kind: version.actorKind, when: when(version.createdAt), changed: changed.join(', ') || '—' }} />
                    ) : (
                      <FormattedMessage id="entity.versionInitial" values={{ actor: version.actorId, kind: version.actorKind, when: when(version.createdAt) }} />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
