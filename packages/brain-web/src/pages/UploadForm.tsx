import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { brain } from '../api.ts';
import { ErrorLine } from '../App.tsx';

const ARTIFACTS = ['ddl', 'er_diagram', 'openapi', 'wsdl', 'postman', 'other'];

/** Upload a file to a container or an entity (FR-5.1); artifacts for systems (FR-3.2, FR-3.3). */
export function UploadForm({ attachTo, artifacts = false, onDone }: { attachTo: string; artifacts?: boolean; onDone: () => void }) {
  const intl = useIntl();
  const [file, setFile] = useState<File | undefined>();
  const [flags, setFlags] = useState({ useAsContext: false, confidential: false, noAi: false, artifact: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>();
  const [inputKey, setInputKey] = useState(0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      const fields: Record<string, string> = { attachTo, useAsContext: String(flags.useAsContext), confidential: String(flags.confidential), noAi: String(flags.noAi) };
      if (flags.artifact) fields.artifact = flags.artifact;
      const { document } = await brain.uploadDocument(file, fields);
      setMessage(intl.formatMessage({ id: 'upload.done' }, { name: document.title }));
      setFile(undefined);
      setInputKey((value) => value + 1);
      onDone();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline upload" onSubmit={(event) => void submit(event)}>
      <h3>
        <FormattedMessage id="upload.title" />
      </h3>
      <label style={{ gridColumn: '1 / -1' }}>
        <FormattedMessage id="upload.file" />
        <input key={inputKey} type="file" onChange={(event) => setFile(event.target.files?.[0])} required />
      </label>
      {artifacts && (
        <label>
          <FormattedMessage id="upload.artifact" />
          <select value={flags.artifact} onChange={(event) => setFlags({ ...flags, artifact: event.target.value })}>
            <option value="">{intl.formatMessage({ id: 'upload.artifact.none' })}</option>
            {ARTIFACTS.map((artifact) => (
              <option key={artifact} value={artifact}>
                {intl.formatMessage({ id: `artifact.${artifact}` })}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={flags.useAsContext} onChange={(event) => setFlags({ ...flags, useAsContext: event.target.checked })} /> <FormattedMessage id="upload.useAsContext" />
      </label>
      <label className="check">
        <input type="checkbox" checked={flags.confidential} onChange={(event) => setFlags({ ...flags, confidential: event.target.checked })} /> <FormattedMessage id="upload.confidential" />
      </label>
      <label className="check">
        <input type="checkbox" checked={flags.noAi} onChange={(event) => setFlags({ ...flags, noAi: event.target.checked })} /> <FormattedMessage id="upload.noAi" />
      </label>
      <button type="submit" disabled={busy || !file}>
        <FormattedMessage id={busy ? 'upload.uploading' : 'upload.button'} />
      </button>
      {message && <p className="muted">{message}</p>}
      <ErrorLine error={error} />
    </form>
  );
}
