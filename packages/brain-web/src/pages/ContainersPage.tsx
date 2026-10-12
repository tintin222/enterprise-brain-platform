import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useNavigate } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync, when } from '../App.tsx';

const STAGES = ['discovery', 'analysis', 'build', 'rollout', 'live', 'closed'];

export function ContainersPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const list = useAsync(() => brain.containers({}), []);
  const channels = useAsync(() => brain.myChannels(), []);
  const [error, setError] = useState<unknown>();
  const [project, setProject] = useState({ title: '', client: '', goal: '', stage: 'discovery', channels: true, private: false, fromTopic: '' });
  const [topic, setTopic] = useState({ title: '', kind: 'internal', organisation: '', description: '', channel: 'new', private: false });
  const topics = list.data?.containers.filter((container) => container.kind === 'topic' && container.status === 'active') ?? [];

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const body = { title: project.title.trim(), client: project.client.trim(), goal: project.goal.trim(), stage: project.stage, channels: project.channels, private: project.private };
      const { container } = project.fromTopic ? await brain.spawnProject(project.fromTopic, body) : await brain.createProject(body);
      void navigate(`/containers/${container.id}`);
    } catch (reason) {
      setError(reason);
    }
  };
  const createTopic = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const channel = topic.channel === 'new' ? { create: true, private: topic.private } : { mmChannelId: topic.channel };
      const { container } = await brain.createTopic({ title: topic.title.trim(), kind: topic.kind, organisation: topic.organisation.trim(), description: topic.description.trim(), channel });
      void navigate(`/containers/${container.id}`);
    } catch (reason) {
      setError(reason);
    }
  };

  return (
    <>
      <h1>
        <FormattedMessage id="containers.title" />
      </h1>
      <ErrorLine error={error ?? list.error} />
      <div className="grid">
        <section className="card">
          <h2>
            <FormattedMessage id="containers.newProject" />
          </h2>
          <form className="inline" onSubmit={(event) => void createProject(event)}>
            <label>
              <FormattedMessage id="containers.form.title" />
              <input type="text" value={project.title} onChange={(event) => setProject({ ...project, title: event.target.value })} required maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="containers.form.client" />
              <input type="text" value={project.client} onChange={(event) => setProject({ ...project, client: event.target.value })} maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="containers.form.stage" />
              <select value={project.stage} onChange={(event) => setProject({ ...project, stage: event.target.value })}>
                {STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {intl.formatMessage({ id: `stage.${stage}` })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <FormattedMessage id="containers.form.fromTopic" />
              <select value={project.fromTopic} onChange={(event) => setProject({ ...project, fromTopic: event.target.value })}>
                <option value="">{intl.formatMessage({ id: 'containers.form.none' })}</option>
                {topics.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <FormattedMessage id="containers.form.goal" />
              <textarea rows={3} value={project.goal} onChange={(event) => setProject({ ...project, goal: event.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={project.channels} onChange={(event) => setProject({ ...project, channels: event.target.checked })} /> <FormattedMessage id="containers.form.channels" />
            </label>
            <label className="check">
              <input type="checkbox" checked={project.private} onChange={(event) => setProject({ ...project, private: event.target.checked })} disabled={!project.channels} /> <FormattedMessage id="containers.form.private" />
            </label>
            <button type="submit">
              <FormattedMessage id="containers.form.createProject" />
            </button>
          </form>
        </section>
        <section className="card">
          <h2>
            <FormattedMessage id="containers.newTopic" />
          </h2>
          <form className="inline" onSubmit={(event) => void createTopic(event)}>
            <label>
              <FormattedMessage id="containers.form.title" />
              <input type="text" value={topic.title} onChange={(event) => setTopic({ ...topic, title: event.target.value })} required maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="containers.form.topicKind" />
              <select value={topic.kind} onChange={(event) => setTopic({ ...topic, kind: event.target.value })}>
                <option value="internal">{intl.formatMessage({ id: 'topicKind.internal' })}</option>
                <option value="external">{intl.formatMessage({ id: 'topicKind.external' })}</option>
              </select>
            </label>
            <label>
              <FormattedMessage id="containers.form.organisation" />
              <input type="text" value={topic.organisation} onChange={(event) => setTopic({ ...topic, organisation: event.target.value })} maxLength={200} />
            </label>
            <label>
              <FormattedMessage id="containers.form.channel" />
              <select value={topic.channel} onChange={(event) => setTopic({ ...topic, channel: event.target.value })}>
                <option value="new">{intl.formatMessage({ id: 'containers.form.newChannel' })}</option>
                {channels.data?.channels.map((channel) => (
                  <option key={channel.id} value={channel.id} disabled={channel.containerId !== null}>
                    {channel.display_name}
                    {channel.containerId ? ` (${intl.formatMessage({ id: 'containers.form.channelTaken' })})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              <FormattedMessage id="containers.form.description" />
              <textarea rows={3} value={topic.description} onChange={(event) => setTopic({ ...topic, description: event.target.value })} />
            </label>
            {topic.channel === 'new' && (
              <label className="check">
                <input type="checkbox" checked={topic.private} onChange={(event) => setTopic({ ...topic, private: event.target.checked })} /> <FormattedMessage id="containers.form.private" />
              </label>
            )}
            <button type="submit">
              <FormattedMessage id="containers.form.createTopic" />
            </button>
          </form>
        </section>
      </div>
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
