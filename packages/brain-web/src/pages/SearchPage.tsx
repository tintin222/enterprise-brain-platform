import { FormattedMessage, useIntl } from 'react-intl';
import { Link, useSearchParams } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync } from '../App.tsx';

const TYPES = ['conversation', 'decision', 'requirement', 'task', 'system', 'person', 'document', 'meeting', 'agent_note'];

export function SearchPage() {
  const intl = useIntl();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const container = params.get('container') ?? '';
  const containers = useAsync(() => brain.containers({}), []);
  const view = params.get('view') ?? 'results';
  const search = useAsync(() => (q && view === 'results' ? brain.search({ q, ...(type ? { type } : {}), ...(container ? { container } : {}) }) : Promise.resolve(undefined)), [q, type, container, view]);
  const who = useAsync(() => (q && view === 'people' ? brain.whoKnows(q) : Promise.resolve(undefined)), [q, view]);
  const titles = new Map(containers.data?.containers.map((item) => [item.id, item.title]) ?? []);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <h1>
        <FormattedMessage id="search.title" />
      </h1>
      <p className="tabs">
        <button type="button" className={view === 'results' ? '' : 'secondary'} onClick={() => set('view', '')}>
          <FormattedMessage id="search.tab.results" />
        </button>
        <button type="button" className={view === 'people' ? '' : 'secondary'} onClick={() => set('view', 'people')}>
          <FormattedMessage id="search.tab.people" />
        </button>
      </p>
      {view === 'people' && (
        <>
          <ErrorLine error={who.error} />
          {who.data && (
            <>
              <p className="muted">
                <FormattedMessage id="search.whoKnows" values={{ count: who.data.people.length, query: q }} />
              </p>
              <ul className="plain">
                {who.data.people.map((hit) => (
                  <li key={hit.person.id} className="card">
                    <Link to={`/people/${hit.person.id}`}>
                      <strong>{hit.person.title}</strong>
                    </Link>
                    {typeof hit.person.data.role === 'string' && hit.person.data.role && <span className="muted"> · {hit.person.data.role}</span>}
                    <ul className="plain">
                      {hit.evidence.map((item) => (
                        <li key={item.entityId} className="muted">
                          <FormattedMessage id={`search.why.${item.why.split(' ')[0] === 'profile' ? 'profile' : 'evidence'}`} values={{ why: item.why }} /> <Link to={`/entities/${item.entityId}`}>{item.title}</Link>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <form className="inline card" onSubmit={(event) => event.preventDefault()} hidden={view === 'people'}>
        <label>
          <FormattedMessage id="search.filter.type" />
          <select value={type} onChange={(event) => set('type', event.target.value)}>
            <option value="">{intl.formatMessage({ id: 'search.filter.any' })}</option>
            {TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {intl.formatMessage({ id: `type.${candidate}` })}
                {search.data?.facets.types[candidate] ? ` (${search.data.facets.types[candidate]})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          <FormattedMessage id="search.filter.container" />
          <select value={container} onChange={(event) => set('container', event.target.value)}>
            <option value="">{intl.formatMessage({ id: 'search.filter.any' })}</option>
            {containers.data?.containers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
                {search.data?.facets.containers[item.id] ? ` (${search.data.facets.containers[item.id]})` : ''}
              </option>
            ))}
          </select>
        </label>
      </form>
      <ErrorLine error={search.error} />
      {search.data && (
        <>
          <p className="muted">
            <FormattedMessage id="search.results" values={{ count: search.data.results.length, query: q }} /> · <FormattedMessage id={search.data.semantic ? 'search.semantic' : 'search.keywordOnly'} /> · {search.data.tookMs} ms
          </p>
          <ul className="plain">
            {search.data.results.map((result) => (
              <li key={result.chunkId} className="card">
                <span className="badge">
                  <FormattedMessage id={`type.${result.entityType}`} />
                </span>
                <Link to={`/entities/${result.entityId}`}>{result.title}</Link>
                <span className="muted"> · {titles.get(result.containerId) ?? result.containerId}</span>
                <p className="snippet">{result.snippet}</p>
                <p className="muted">
                  {result.matched.map((how) => intl.formatMessage({ id: `search.matched.${how}` })).join(', ')}
                  {result.citation.kind === 'post' && result.citation.url && (
                    <>
                      {' · '}
                      <a href={result.citation.url} target="_blank" rel="noreferrer">
                        <FormattedMessage id="search.openPost" />
                      </a>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
