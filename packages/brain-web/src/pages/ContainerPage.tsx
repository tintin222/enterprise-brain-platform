import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useParams } from 'react-router';
import { brain, type EntitySummary, type Milestone } from '../api.ts';
import { ErrorLine, useAsync, useMe, when } from '../App.tsx';

const NEW_TYPES = ['decision', 'requirement', 'task', 'system', 'document', 'agent_note'];
const ROLES = ['member', 'sponsor', 'product_owner', 'end_user', 'developer', 'fde', 'reviewer', 'contact'];

function EntityList({ items, empty }: { items: EntitySummary[]; empty: string }) {
  if (items.length === 0)
    return (
      <p className="muted">
        <FormattedMessage id={empty} />
      </p>
    );
  return (
    <ul className="plain">
      {items.map((entity) => (
        <li key={entity.id}>
          <Link to={`/entities/${entity.id}`}>{entity.title}</Link>
          <span className="muted"> · {entity.status} · {when(entity.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ContainerPage() {
  const intl = useIntl();
  const me = useMe();
  const { id = '' } = useParams();
  const home = useAsync(() => brain.home(id), [id]);
  const people = useAsync(() => brain.people({ limit: '500' }), []);
  const [type, setType] = useState('decision');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [member, setMember] = useState({ personId: '', role: 'member' });
  const [milestones, setMilestones] = useState<Milestone[] | undefined>();
  const [error, setError] = useState<unknown>();
  const data = home.data;
  const container = data?.container;
  const isProject = container?.kind === 'project';
  const field = (key: string): string => (container && typeof container.data[key] === 'string' ? (container.data[key]) : '');

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      home.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await brain.createEntity({ type, title: title.trim(), containerId: id, text });
      setTitle('');
      setText('');
    });
  };
  const addMember = (event: FormEvent) => {
    event.preventDefault();
    if (member.personId) void run(() => brain.addMember(id, member));
  };
  const timeline = milestones ?? data?.milestones ?? [];
  const saveTimeline = () => void run(() => brain.setTimeline(id, timeline).then(() => setMilestones(undefined)));

  return (
    <>
      <ErrorLine error={home.error ?? error} />
      {container && data && (
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
          {data.stale && (
            <p className="error">
              <FormattedMessage id="home.stale" />
            </p>
          )}
          <div className="grid">
            <section className="card">
              <h2>
                <FormattedMessage id="home.summary" />
              </h2>
              <dl>
                {data.owner && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.owner" />
                    </dt>
                    <dd>
                      <Link to={`/people/${data.owner.id}`}>{data.owner.title}</Link>
                    </dd>
                  </div>
                )}
                {isProject && field('client') && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.client" />
                    </dt>
                    <dd>{field('client')}</dd>
                  </div>
                )}
                {isProject && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.stage" />
                    </dt>
                    <dd>{field('stage') ? intl.formatMessage({ id: `stage.${field('stage')}`, defaultMessage: field('stage') }) : '—'}</dd>
                  </div>
                )}
                {field('goal') && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.goal" />
                    </dt>
                    <dd>{field('goal')}</dd>
                  </div>
                )}
                {field('scope') && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.scope" />
                    </dt>
                    <dd>{field('scope')}</dd>
                  </div>
                )}
                {!isProject && field('organisation') && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.organisation" />
                    </dt>
                    <dd>{field('organisation')}</dd>
                  </div>
                )}
                {!isProject && field('description') && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.description" />
                    </dt>
                    <dd>{field('description')}</dd>
                  </div>
                )}
                {data.spawnedFrom && (
                  <div>
                    <dt>
                      <FormattedMessage id="home.spawnedFrom" />
                    </dt>
                    <dd>
                      <Link to={`/containers/${data.spawnedFrom.id}`}>{data.spawnedFrom.title}</Link>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>
                    <FormattedMessage id="home.channels" />
                  </dt>
                  <dd>
                    {data.channels.length === 0 && (
                      <span className="muted">
                        <FormattedMessage id="container.noChannels" />
                      </span>
                    )}
                    {data.channels.map((channel) => (
                      <span key={channel.mmChannelId}>
                        <span className="badge">
                          <FormattedMessage id={`channelRole.${channel.role}`} />
                        </span>
                        {me && (
                          <a href={`${me.chatUrl}/_redirect/channels/${channel.mmChannelId}`} target="_blank" rel="noreferrer">
                            <FormattedMessage id="container.openInChat" />
                          </a>
                        )}{' '}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
              {container.kind !== 'general' && container.status === 'active' && (
                <p>
                  <button className="danger" type="button" onClick={() => void run(() => brain.archiveContainer(id))}>
                    <FormattedMessage id="container.archive" />
                  </button>
                </p>
              )}
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="home.people" />
              </h2>
              {data.people.length === 0 && (
                <p className="muted">
                  <FormattedMessage id="members.empty" />
                </p>
              )}
              <ul className="plain">
                {data.people.map((item) => (
                  <li key={item.person.id}>
                    <span className="badge">
                      <FormattedMessage id={`role.${item.role}`} defaultMessage={item.role} />
                    </span>
                    <Link to={`/people/${item.person.id}`}>{item.person.title}</Link>{' '}
                    <button type="button" className="secondary" onClick={() => void run(() => brain.removeMember(id, item.person.id))}>
                      <FormattedMessage id="members.remove" />
                    </button>
                  </li>
                ))}
              </ul>
              {container.kind !== 'general' && (
                <form className="inline" onSubmit={addMember}>
                  <label>
                    <FormattedMessage id="members.person" />
                    <select value={member.personId} onChange={(event) => setMember({ ...member, personId: event.target.value })} required>
                      <option value="">—</option>
                      {people.data?.people.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <FormattedMessage id="members.role" />
                    <select value={member.role} onChange={(event) => setMember({ ...member, role: event.target.value })}>
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {intl.formatMessage({ id: `role.${role}` })}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit">
                    <FormattedMessage id="members.add" />
                  </button>
                </form>
              )}
            </section>
            {isProject && (
              <section className="card">
                <h2>
                  <FormattedMessage id="home.timeline" />
                </h2>
                {timeline.length === 0 && (
                  <p className="muted">
                    <FormattedMessage id="home.timeline.empty" />
                  </p>
                )}
                <ul className="plain">
                  {timeline.map((milestone, n) => (
                    <li key={`${milestone.date}-${n}`}>
                      <input type="date" value={milestone.date} onChange={(event) => setMilestones(timeline.map((item, i) => (i === n ? { ...item, date: event.target.value } : item)))} />{' '}
                      <input type="text" value={milestone.title} onChange={(event) => setMilestones(timeline.map((item, i) => (i === n ? { ...item, title: event.target.value } : item)))} />{' '}
                      <select value={milestone.kind} onChange={(event) => setMilestones(timeline.map((item, i) => (i === n ? { ...item, kind: event.target.value as 'milestone' | 'phase' } : item)))}>
                        <option value="milestone">{intl.formatMessage({ id: 'milestone.milestone' })}</option>
                        <option value="phase">{intl.formatMessage({ id: 'milestone.phase' })}</option>
                      </select>{' '}
                      <label className="check">
                        <input type="checkbox" checked={Boolean(milestone.done)} onChange={(event) => setMilestones(timeline.map((item, i) => (i === n ? { ...item, done: event.target.checked } : item)))} /> <FormattedMessage id="home.timeline.done" />
                      </label>{' '}
                      <button type="button" className="secondary" onClick={() => setMilestones(timeline.filter((_, i) => i !== n))}>
                        <FormattedMessage id="home.timeline.remove" />
                      </button>
                    </li>
                  ))}
                </ul>
                <p>
                  <button type="button" className="secondary" onClick={() => setMilestones([...timeline, { title: '', date: new Date().toISOString().slice(0, 10), kind: 'milestone' }])}>
                    <FormattedMessage id="home.timeline.add" />
                  </button>{' '}
                  {milestones && (
                    <button type="button" onClick={saveTimeline}>
                      <FormattedMessage id="home.timeline.save" />
                    </button>
                  )}
                </p>
              </section>
            )}
            <section className="card">
              <h2>
                <FormattedMessage id="home.systems" />
              </h2>
              <EntityList items={data.systems} empty="home.empty" />
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="home.requirements" /> <span className="muted">(<FormattedMessage id="home.openCount" values={{ count: data.requirements.open }} />)</span>
              </h2>
              <EntityList items={data.requirements.recent} empty="home.phase2" />
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="home.tasks" /> <span className="muted">(<FormattedMessage id="home.openCount" values={{ count: data.tasks.open }} />)</span>
              </h2>
              <EntityList items={data.tasks.recent} empty="home.empty" />
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="home.decisions" />
              </h2>
              <EntityList items={data.decisions} empty="home.phase2" />
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="home.documents" />
              </h2>
              <EntityList items={data.documents} empty="home.empty" />
            </section>
            <section className="card">
              <h2>
                <FormattedMessage id="home.conversations" />
              </h2>
              <EntityList items={data.conversations} empty="home.empty" />
            </section>
            {isProject && (
              <section className="card">
                <h2>
                  <FormattedMessage id="home.package" />
                </h2>
                <p className="muted">
                  <FormattedMessage id="home.phase3" />
                </p>
              </section>
            )}
            <section className="card">
              <h2>
                <FormattedMessage id="container.newEntity" />
              </h2>
              <form className="inline" onSubmit={create}>
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
        </>
      )}
    </>
  );
}
