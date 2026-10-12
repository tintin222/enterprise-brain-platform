import { FormattedMessage } from 'react-intl';
import { Link } from 'react-router';
import { brain } from '../api.ts';
import { ErrorLine, useAsync, when } from '../App.tsx';

export function HomePage() {
  const recent = useAsync(() => brain.entities({ limit: '20' }), []);
  const containers = useAsync(() => brain.containers({ status: 'active' }), []);
  return (
    <>
      <p className="muted">
        <FormattedMessage id="search.hint" />
      </p>
      <div className="grid">
        <section className="card">
          <h2>
            <FormattedMessage id="home.containers" />
          </h2>
          <ErrorLine error={containers.error} />
          <ul className="plain">
            {containers.data?.containers.map((container) => (
              <li key={container.id}>
                <span className="badge kind">
                  <FormattedMessage id={`containers.kind.${container.kind}`} />
                </span>
                <Link to={`/containers/${container.id}`}>{container.title}</Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>
            <FormattedMessage id="home.recent" />
          </h2>
          <ErrorLine error={recent.error} />
          {recent.data && recent.data.entities.length === 0 && (
            <p className="muted">
              <FormattedMessage id="home.empty" />
            </p>
          )}
          <ul className="plain">
            {recent.data?.entities.map((entity) => (
              <li key={entity.id}>
                <span className="badge">
                  <FormattedMessage id={`type.${entity.type}`} />
                </span>
                <Link to={`/entities/${entity.id}`}>{entity.title}</Link>
                <div className="muted">{when(entity.updatedAt)}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
