import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link, Outlet, useNavigate } from 'react-router';
import { ApiError, signOut, type Me } from './api.ts';

export const MeContext = createContext<Me | undefined>(undefined);

export function useMe(): Me | undefined {
  return useContext(MeContext);
}

function SearchBox() {
  const intl = useIntl();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (q.trim()) void navigate(`/search?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <form className="search" onSubmit={submit} role="search">
      <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder={intl.formatMessage({ id: 'search.placeholder' })} aria-label={intl.formatMessage({ id: 'search.title' })} />
      <button type="submit">
        <FormattedMessage id="search.button" />
      </button>
    </form>
  );
}

export function App() {
  const [me, setMe] = useState<Me | undefined>();
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    fetch('/api/v1/brain/me', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(async (response) => {
        if (response.status === 401) setSignedOut(true);
        else if (response.ok) setMe((await response.json()) as Me);
      })
      .catch(() => setSignedOut(true));
  }, []);

  if (signedOut) {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    return (
      <div className="signin">
        <img src="/mark.svg" alt="" width={64} height={64} />
        <h1>
          <FormattedMessage id="app.name" />
        </h1>
        <p className="muted">
          <FormattedMessage id="app.tagline" />
        </p>
        <a className="button" href={`/auth/login?redirect=${redirect}`}>
          <FormattedMessage id="nav.signIn" />
        </a>
      </div>
    );
  }

  return (
    <MeContext.Provider value={me}>
      <header className="top">
        <Link className="brand" to="/">
          <img src="/mark.svg" alt="" />
          <FormattedMessage id="app.name" />
        </Link>
        <nav>
          <Link to="/">
            <FormattedMessage id="nav.home" />
          </Link>
          <Link to="/containers">
            <FormattedMessage id="nav.containers" />
          </Link>
          <Link to="/people">
            <FormattedMessage id="nav.people" />
          </Link>
        </nav>
        <SearchBox />
        {me && (
          <span className="who">
            <FormattedMessage id="nav.signedInAs" values={{ username: me.principal.username ?? me.principal.userId }} />
            <button className="secondary" type="button" onClick={() => void signOut()}>
              <FormattedMessage id="nav.signOut" />
            </button>
          </span>
        )}
      </header>
      <main>
        <Outlet />
      </main>
    </MeContext.Provider>
  );
}

/** A short, consistent error line for pages. */
export function ErrorLine({ error }: { error: unknown }) {
  const intl = useIntl();
  if (!error) return null;
  if (error instanceof ApiError && error.status === 404) return <p className="error">{intl.formatMessage({ id: 'error.notFound' })}</p>;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
  return <p className="error">{intl.formatMessage({ id: 'error.generic' }, { message })}</p>;
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; reload: () => void } {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    load().then(
      (value) => {
        if (!cancelled) setData(value);
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((value) => value + 1) };
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString();
}
