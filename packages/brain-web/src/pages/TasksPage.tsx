import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useParams } from 'react-router';
import { brain, type EntitySummary } from '../api.ts';
import { ErrorLine, useAsync, useMe } from '../App.tsx';

const STATES = ['open', 'in_progress', 'done', 'dismissed'] as const;
const PRIORITIES = ['low', 'normal', 'high'] as const;

const field = (task: EntitySummary, key: string): string => (typeof task.data[key] === 'string' ? (task.data[key]) : '');
const today = (): string => new Date().toISOString().slice(0, 10);

function TaskCard({ task, people, onChange }: { task: EntitySummary; people: Map<string, string>; onChange: () => void }) {
  const intl = useIntl();
  const state = field(task, 'state') || 'open';
  const due = field(task, 'dueAt').slice(0, 10);
  const overdue = due && due < today() && (state === 'open' || state === 'in_progress');
  const proposal = task.data.proposal as { state?: string; by?: string } | null | undefined;
  const move = (next: string) => void brain.updateTask(task.id, { state: next }).then(onChange);
  const decide = (decision: 'accept' | 'dismiss') => void brain.decideTask(task.id, decision).then(onChange);
  return (
    <li className={`card task ${overdue ? 'overdue' : ''}`}>
      <Link to={`/entities/${task.id}`}>
        <strong>{task.title}</strong>
      </Link>
      <p className="muted">
        {field(task, 'assigneeId') && <>{people.get(field(task, 'assigneeId')) ?? intl.formatMessage({ id: 'tasks.someone' })} · </>}
        {due && <>{intl.formatMessage({ id: overdue ? 'tasks.overdue' : 'tasks.due' }, { date: due })} · </>}
        <FormattedMessage id={`priority.${field(task, 'priority') || 'normal'}`} />
        {proposal?.state === 'proposed' && (
          <>
            {' · '}
            <span className="badge">
              <FormattedMessage id="tasks.proposed" values={{ by: proposal.by ?? '' }} />
            </span>
          </>
        )}
      </p>
      <p className="actions">
        {proposal?.state === 'proposed' ? (
          <>
            <button type="button" onClick={() => decide('accept')}>
              <FormattedMessage id="tasks.accept" />
            </button>{' '}
            <button type="button" className="secondary" onClick={() => decide('dismiss')}>
              <FormattedMessage id="tasks.dismiss" />
            </button>
          </>
        ) : (
          <>
            {state === 'open' && (
              <button type="button" className="secondary" onClick={() => move('in_progress')}>
                <FormattedMessage id="tasks.start" />
              </button>
            )}
            {(state === 'open' || state === 'in_progress') && (
              <>
                {' '}
                <button type="button" onClick={() => move('done')}>
                  <FormattedMessage id="tasks.done" />
                </button>
              </>
            )}
            {(state === 'done' || state === 'dismissed') && (
              <button type="button" className="secondary" onClick={() => move('open')}>
                <FormattedMessage id="tasks.reopen" />
              </button>
            )}
          </>
        )}
      </p>
    </li>
  );
}

/** "My tasks" (no container) or a container's list and board (FR-11.1). */
export function TasksPage() {
  const intl = useIntl();
  const me = useMe();
  const { id } = useParams();
  const containerId = id ?? '';
  const [view, setView] = useState<'list' | 'board'>('list');
  const [includeClosed, setIncludeClosed] = useState(false);
  const tasks = useAsync(() => (containerId ? brain.containerTasks(containerId) : brain.myTasks(includeClosed)), [containerId, includeClosed]);
  const people = useAsync(() => brain.people({ limit: '500' }), []);
  const container = useAsync(() => (containerId ? brain.container(containerId) : Promise.resolve(undefined)), [containerId]);
  const names = new Map(people.data?.people.map((person) => [person.id, person.title]) ?? []);
  const [form, setForm] = useState({ title: '', assigneeId: '', dueAt: '', priority: 'normal' });
  const [error, setError] = useState<unknown>();
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await brain.createTask({ title: form.title.trim(), containerId: containerId || undefined, assigneeId: form.assigneeId || me?.principal.personId, dueAt: form.dueAt || undefined, priority: form.priority });
      setForm({ title: '', assigneeId: '', dueAt: '', priority: 'normal' });
      tasks.reload();
    } catch (reason) {
      setError(reason);
    }
  };
  const list = tasks.data?.tasks ?? [];
  const visible = containerId && !includeClosed ? list.filter((task) => field(task, 'state') === 'open' || field(task, 'state') === 'in_progress' || (task.data.proposal as { state?: string } | null)?.state === 'proposed') : list;
  return (
    <>
      <h1>{containerId ? intl.formatMessage({ id: 'tasks.of' }, { title: container.data?.container.title ?? '' }) : intl.formatMessage({ id: 'tasks.mine' })}</h1>
      {containerId && (
        <p className="muted">
          <Link to={`/containers/${containerId}`}>
            <FormattedMessage id="tasks.backToHome" />
          </Link>
        </p>
      )}
      <ErrorLine error={tasks.error ?? error} />
      <section className="card">
        <form className="inline" onSubmit={(event) => void create(event)}>
          <label style={{ gridColumn: '1 / -1' }}>
            <FormattedMessage id="tasks.form.title" />
            <input type="text" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={500} placeholder={intl.formatMessage({ id: 'tasks.form.placeholder' })} />
          </label>
          <label>
            <FormattedMessage id="tasks.form.assignee" />
            <select value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })}>
              <option value="">{intl.formatMessage({ id: 'tasks.form.me' })}</option>
              {people.data?.people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <FormattedMessage id="tasks.form.due" />
            <input type="date" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} />
          </label>
          <label>
            <FormattedMessage id="tasks.form.priority" />
            <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {intl.formatMessage({ id: `priority.${priority}` })}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">
            <FormattedMessage id="tasks.form.create" />
          </button>
        </form>
      </section>
      <p className="tabs">
        <button type="button" className={view === 'list' ? '' : 'secondary'} onClick={() => setView('list')}>
          <FormattedMessage id="tasks.view.list" />
        </button>
        <button type="button" className={view === 'board' ? '' : 'secondary'} onClick={() => setView('board')}>
          <FormattedMessage id="tasks.view.board" />
        </button>
        <label className="check">
          <input type="checkbox" checked={includeClosed} onChange={(event) => setIncludeClosed(event.target.checked)} /> <FormattedMessage id="tasks.includeClosed" />
        </label>
      </p>
      {visible.length === 0 && (
        <p className="muted">
          <FormattedMessage id="tasks.empty" />
        </p>
      )}
      {view === 'list' && (
        <ul className="plain">
          {visible.map((task) => (
            <TaskCard key={task.id} task={task} people={names} onChange={() => tasks.reload()} />
          ))}
        </ul>
      )}
      {view === 'board' && (
        <div className="board">
          {STATES.map((state) => (
            <div key={state} className="column">
              <h2>
                <FormattedMessage id={`taskState.${state}`} />
              </h2>
              <ul className="plain">
                {list
                  .filter((task) => (field(task, 'state') || 'open') === state)
                  .map((task) => (
                    <TaskCard key={task.id} task={task} people={names} onChange={() => tasks.reload()} />
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
