import { useEffect, useId, useRef, useState, type ReactNode, type InputHTMLAttributes } from 'react';
import { executeLocalTool, hashFile } from '@domos/tool-core';
import { LIMITS, localInputSchemas, localResultSchemas, type LocalToolId, type LocalToolInput, type LocalToolOutput, type Notice, type ToolProgress, type HashFileOptions } from '@domos/contracts';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Input({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <Field label={label}><input {...props} autoComplete="off" spellCheck={false} /></Field>;
}
export function TextInput({ label, value, onChange, hint, maxLength = LIMITS.textBytes, compact = false }: { label: string; value: string; onChange: (value: string) => void; hint?: string; maxLength?: number; compact?: boolean }) {
  return <Field label={label} {...(hint ? { hint } : {})}><textarea className={compact ? 'compact-text' : ''} value={value} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} /></Field>;
}
export function Select<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: readonly T[] | readonly (readonly [T, string])[] }) {
  return <Field label={label}><select value={value} onChange={(event) => {
    const selected = options.find((option) => (typeof option === 'string' ? option : option[0]) === event.target.value);
    if (selected !== undefined) onChange(typeof selected === 'string' ? selected : selected[0]);
  }}>{options.map((option) => typeof option === 'string' ? <option key={option}>{option}</option> : <option key={option[0]} value={option[0]}>{option[1]}</option>)}</select></Field>;
}
export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return <section className="panel" aria-labelledby={id}><div className="panel-head"><h2 id={id}>{title}</h2></div>{children}</section>;
}
export function Empty({ text = 'Your result will appear here after you run the tool.' }: { text?: string }) {
  return <div className="empty"><span className="empty-symbol" aria-hidden="true">[ _ ]</span><span>{text}</span></div>;
}
export function Pairs({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return <dl className="pairs">{rows.map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function DataTable({ headers, rows, caption, className = '' }: { headers: readonly string[]; rows: readonly (readonly ReactNode[])[]; caption: string; className?: string }) {
  return <div className={`table-wrap ${className}`} tabIndex={0} role="region" aria-label={caption}><table><caption className="hint">{caption}</caption><thead><tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, col) => <td key={col}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
export function Download({ text, filename = 'domos-result.txt', mime = 'text/plain', label = 'Download' }: { text: string; filename?: string; mime?: string; label?: string }) {
  const [status, setStatus] = useState('');
  function save() {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
      const link = document.createElement('a'); link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove();
      setStatus('Download requested. Check your browser downloads.');
    } catch { setStatus('Download could not start. Copy the result manually instead.'); }
    finally { if (url) { const objectUrl = url; setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); } }
  }
  return <><button type="button" className="button" onClick={save}>{label}</button><span role="status" className="status">{status}</span></>;
}
export function Copy({ text, label = 'Copy result' }: { text: string; label?: string }) {
  const [status, setStatus] = useState('');
  return <><button className="button" type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus('Copied to clipboard.'); }
    catch { setStatus('Clipboard unavailable. Select and copy the visible result manually.'); }
  }}>{label}</button><span role="status" className="status">{status}</span></>;
}
export function TextResult({ text, filename }: { text: string; filename?: string }) {
  return <><pre className="result-text" tabIndex={0}>{text}</pre><div className="actions"><Copy text={text} /><Download text={text} {...(filename ? { filename } : {})} /></div></>;
}
export function ErrorBox({ message }: { message: string }) { return message ? <div role="alert" className="error">{message}</div> : null; }
export function useLocalTool<K extends LocalToolId>(id: K, parseOutput: (value: unknown) => LocalToolOutput<K>) {
  const [data, setData] = useState<LocalToolOutput<K> | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ToolProgress | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = () => { active.current?.abort(); active.current = null; };
    window.addEventListener('pagehide', stop);
    return () => { stop(); window.removeEventListener('pagehide', stop); };
  }, []);
  function clear() { active.current?.abort(); active.current = null; setData(null); setError(''); setNotices([]); setStatus('Cleared from this workspace.'); setBusy(false); setProgress(null); }
  function cancel() { active.current?.abort(); active.current = null; setBusy(false); setProgress(null); setStatus('Cancelled. No result retained for this run.'); }
  async function run(input: LocalToolInput<K>) {
    if (active.current) return;
    setError(''); setStatus('Validating input...'); setData(null); setFileData(null); setNotices([]); setProgress(null);
    const parsed = localInputSchemas[id].safeParse(input);
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('\n')); setStatus('Input needs attention.'); return; }
    const controller = new AbortController(); active.current = controller; setBusy(true); setStatus('Processing locally...');
    try {
      const result = await executeLocalTool(id, input, { signal: controller.signal, onProgress: (next) => { if (active.current === controller) setProgress(next); } });
      if (active.current !== controller) return;
      if (!localResultSchemas[id].safeParse(result).success) { setError('The local engine returned an invalid result. No output was accepted.'); setStatus('Engine response rejected.'); return; }
      if (result.kind === 'error') {
        setError(`${result.error.code}: ${result.error.message}${result.error.issues.map((issue) => `\n${issue.path.join('.')}${issue.line ? ` line ${issue.line}` : ''}${issue.column ? `:${issue.column}` : ''}: ${issue.message}`).join('')}`);
        setStatus('Run did not complete.');
      } else { setData(parseOutput(result.data)); setNotices(result.notices); setStatus('Complete. Processed in this browser.'); }
    } catch { if (active.current === controller) { setError('The local engine could not complete this operation. Check input limits or try again.'); setStatus('Operation failed.'); } }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  async function runFile(file: File, options: HashFileOptions) {
    if (active.current) return;
    setData(null); setFileData(null); setError(''); setNotices([]); setProgress(null);
    if (file.size > LIMITS.fileBytes) { setError('File exceeds the 250 MiB limit.'); return; }
    const controller = new AbortController(); active.current = controller; setBusy(true); setStatus('Hashing file locally...');
    try {
      const raw = await hashFile(file, options, { signal: controller.signal, onProgress: (next) => { if (active.current === controller) setProgress(next); } });
      if (active.current !== controller) return;
      const parsed = localResultSchemas[id].safeParse(raw);
      if (!parsed.success || id !== 'sha-checksums') { setError('Invalid checksum response.'); setStatus('Engine response rejected.'); return; }
      // The shared result setter is supplied only a result validated for this tool ID.
      if (raw.kind === 'error') { setError(`${raw.error.code}: ${raw.error.message}`); setStatus('File hashing did not complete.'); }
      else { setFileData(raw.data); setStatus('File hashing complete.'); }
    } catch { if (active.current === controller) { setError('File could not be read or hashed. No checksum was accepted.'); setStatus('File hashing failed.'); } }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  const [fileData, setFileData] = useState<LocalToolOutput<'sha-checksums'> | null>(null);
  return { data, fileData, notices, error, status, busy, progress, run, runFile, cancel, clear: () => { clear(); setFileData(null); } };
}
export function RunState({ state }: { state: { busy: boolean; error: string; status: string; notices: Notice[]; progress: ToolProgress | null } }) {
  return <><p className="status" role="status" aria-live="polite">{state.status}</p><ErrorBox message={state.error} />
    {state.progress && <div><progress aria-label="Tool progress" value={state.progress.completed} max={Math.max(1, state.progress.total)} /><p className="hint">{state.progress.phase}: {state.progress.completed.toLocaleString()} / {state.progress.total.toLocaleString()} {state.progress.unit}</p></div>}
    {state.notices.map((notice, index) => <div className={notice.level === 'warning' ? 'warning' : 'notice'} key={index}>{notice.code}: {notice.text}</div>)}</>;
}
export function RunButtons({ busy, cancel, clear, label = 'Run tool' }: { busy: boolean; cancel: () => void; clear: () => void; label?: string }) {
  return <div className="actions"><button className="button primary" type="submit" disabled={busy}>{busy ? 'Working...' : label}</button><button className="button" type="button" onClick={cancel} disabled={!busy}>Cancel</button><button className="button" type="button" onClick={clear}>Clear / reset</button></div>;
}
