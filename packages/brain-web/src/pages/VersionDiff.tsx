import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import { brain, type Diff, type Version } from '../api.ts';
import { ErrorLine } from '../App.tsx';

/** Pick two versions and see what changed between them (FR-3.6). */
export function VersionDiff({ entityId, versions }: { entityId: string; versions: Version[] }) {
  const numbers = versions.map((version) => version.version);
  const [from, setFrom] = useState(numbers[1] ?? numbers[0] ?? 1);
  const [to, setTo] = useState(numbers[0] ?? 1);
  const [diff, setDiff] = useState<Diff | undefined>();
  const [error, setError] = useState<unknown>();
  if (versions.length < 2) return null;
  const show = async () => {
    try {
      setDiff(await brain.diff(entityId, from, to));
    } catch (reason) {
      setError(reason);
    }
  };
  return (
    <div className="diff">
      <h3>
        <FormattedMessage id="diff.title" />
      </h3>
      <p>
        <label>
          <FormattedMessage id="diff.from" />{' '}
          <select value={from} onChange={(event) => setFrom(Number(event.target.value))}>
            {numbers.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          <FormattedMessage id="diff.to" />{' '}
          <select value={to} onChange={(event) => setTo(Number(event.target.value))}>
            {numbers.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="button" className="secondary" onClick={() => void show()}>
          <FormattedMessage id="diff.show" />
        </button>
      </p>
      <ErrorLine error={error} />
      {diff && (
        <>
          {diff.title && (
            <p>
              <FormattedMessage id="diff.titleChanged" values={{ before: diff.title.before, after: diff.title.after }} />
            </p>
          )}
          {!diff.title && diff.fields.length === 0 && !diff.text.changed && (
            <p className="muted">
              <FormattedMessage id="diff.noChange" />
            </p>
          )}
          {diff.fields.length > 0 && (
            <>
              <h4>
                <FormattedMessage id="diff.fields" />
              </h4>
              <ul className="plain">
                {diff.fields.map((change) => (
                  <li key={change.field}>
                    <code>{change.field}</code>: <span className="removed">{JSON.stringify(change.before)}</span> → <span className="added">{JSON.stringify(change.after)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {diff.text.changed && (
            <>
              <h4>
                <FormattedMessage id="diff.text" />
              </h4>
              {diff.text.hunks.map((hunk, n) => (
                <pre key={n} className="hunk">
                  {hunk.map((line, i) => (
                    <div key={i} className={line.kind}>
                      {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                      {line.text}
                    </div>
                  ))}
                </pre>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
