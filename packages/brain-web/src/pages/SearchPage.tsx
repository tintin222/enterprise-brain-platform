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
  const search = useAsync(() => (q ? brain.search({ q, ...(type ? { type } : {}), ...(container ? { container } : {}) }) : Promise.resolve(undefined)), [q, type, container]);
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
      <form className="inline card" onSubmit={(event) => event.preventDefault()}>
        <label>
          <FormattedMessage id="search.filter.type" />
          <select value={type} onChange={(event) => set('type', event.target.value)}>
            <option value="">{intl.formatMessage({ id: 'search.filter.any' })}</option>
            {TYPES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {intl.formatMessage({ id: `type.${candidate}` })}
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
