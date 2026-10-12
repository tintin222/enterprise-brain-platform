import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { Link } from 'react-router';
import { brain, type Entity } from '../api.ts';
import { ErrorLine } from '../App.tsx';

/** What a document entity shows besides its text: the file, the extraction state and the flags (FR-5). */
export function DocumentPanel({ entity, onChange }: { entity: Entity; onChange: () => void }) {
  const intl = useIntl();
  const [error, setError] = useState<unknown>();
  const data = entity.data;
  const extracted = (data.extracted as { status?: string; method?: string; chars?: number; reason?: string } | undefined) ?? {};
  const status = extracted.status ?? 'pending';
  const flag = (key: 'useAsContext' | 'confidential' | 'noAi') => Boolean(data[key]);
  const toggle = async (key: 'useAsContext' | 'confidential' | 'noAi') => {
    try {
      await brain.setDocumentFlags(entity.id, { [key]: !flag(key) });
      onChange();
    } catch (reason) {
      setError(reason);
    }
  };
  const extractAgain = async () => {
    try {
      await brain.extractDocument(entity.id);
      onChange();
    } catch (reason) {
      setError(reason);
    }
  };
  const size = typeof data.size === 'number' ? Math.max(1, Math.round(data.size / 1024)) : undefined;
  return (
    <section className="card">
      <h2>
        <FormattedMessage id="document.file" />
      </h2>
      <ErrorLine error={error} />
      <p>
        <a href={brain.documentFileUrl(entity.id)}>
          <FormattedMessage id="document.download" />
        </a>{' '}
        <span className="muted">
          {typeof data.name === 'string' ? data.name : ''} · {typeof data.mediaType === 'string' ? data.mediaType : ''}
          {size !== undefined && <> · {intl.formatMessage({ id: 'document.size' }, { size })}</>}
        </span>
        {typeof data.artifact === 'string' && data.artifact && (
          <span className="badge">
            <FormattedMessage id={`artifact.${data.artifact}`} defaultMessage={data.artifact} />
          </span>
        )}
      </p>
      <p className="muted">
        <FormattedMessage id="document.extraction" />:{' '}
        <FormattedMessage id={`document.extraction.${status}`} values={{ method: extracted.method ?? '', chars: extracted.chars ?? 0, reason: extracted.reason ?? '' }} />{' '}
        <button type="button" className="secondary" onClick={() => void extractAgain()}>
          <FormattedMessage id="document.extractAgain" />
        </button>
      </p>
      {typeof data.attachedTo === 'string' && (
        <p className="muted">
          <FormattedMessage id="document.attachedTo" /> <Link to={`/entities/${data.attachedTo}`}>{typeof data.attachedType === 'string' ? intl.formatMessage({ id: `type.${data.attachedType}`, defaultMessage: data.attachedType }) : data.attachedTo}</Link>
        </p>
      )}
      <p>
        <strong>
          <FormattedMessage id="document.flags" />
        </strong>
      </p>
      <p>
        <label className="check">
          <input type="checkbox" checked={flag('useAsContext')} onChange={() => void toggle('useAsContext')} /> <FormattedMessage id="upload.useAsContext" />
        </label>
        <br />
        <label className="check">
          <input type="checkbox" checked={flag('confidential')} onChange={() => void toggle('confidential')} /> <FormattedMessage id="upload.confidential" />
        </label>
        <br />
        <label className="check">
          <input type="checkbox" checked={flag('noAi')} onChange={() => void toggle('noAi')} /> <FormattedMessage id="upload.noAi" />
        </label>
      </p>
      <p className="muted">
        <FormattedMessage id="document.versions" />
      </p>
    </section>
  );
}
