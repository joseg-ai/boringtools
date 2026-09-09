import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LIMITS, type ApiResponse, type DnsOutcome, type DnsRecord, type DnsType, type DkimReport, type DmarcReport, type SpfReport, type ApiReply } from '@domos/contracts';
import { API_ORIGIN } from '../config';
import { RequestFailure, requestLive, SERVICE_ACTIVATION_ALLOWANCE_MS } from '../lib/api-client';
import { Check, DataTable, Download, Empty, ErrorBox, Input, Panel, Pairs, RunButtons, Select } from './ui';

function useLiveRequest<T>() {
  const [report, setReport] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const stop = () => { active.current?.abort(); active.current = null; };
    window.addEventListener('pagehide', stop);
    return () => { stop(); window.removeEventListener('pagehide', stop); };
  }, []);
  async function run(request: (signal: AbortSignal) => Promise<T>, timeout: number) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout + SERVICE_ACTIVATION_ALLOWANCE_MS);
    setBusy(true); setReport(null); setError(''); setStatus('Waking the diagnostics service if needed, then inspecting the submitted target...');
    try {
      const result = await request(controller.signal);
      if (active.current === controller) { setReport(result); setStatus('Response received. Review the report status and limitations below.'); }
    } catch (failure) {
      if (active.current !== controller) return;
      setError(timedOut ? 'Request deadline exceeded. The upstream inspection did not finish in time.' : failure instanceof RequestFailure ? failure.message : 'Could not reach the configured diagnostics API. Check connectivity or service availability; no result was accepted.');
      setStatus('Inspection failed.');
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  function cancel() { active.current?.abort(); active.current = null; setBusy(false); setStatus('Cancelled in this browser. The server may already have inspected the submitted target.'); }
  return { report, error, busy, status, run, cancel };
}
function Report<T>({ report, children }: { report: ApiReply<T> | null; children: (data: T) => ReactNode }) {
  return <Panel title="Inspection report">{report ? <>
    {report.kind === 'error' ? <ErrorBox message={`${report.error.code} / ${report.error.phase}: ${report.error.message}`} /> : <>
      {report.kind === 'partial' && <div role="alert" className="warning"><strong>PARTIAL RESULT</strong> / {report.error.code} / {report.error.phase}: {report.error.message}. Only the observations below were returned.</div>}
      {report.kind === 'result' && <p className="badge local">REPORT RECEIVED / OBSERVATIONS, NOT A GUARANTEE</p>}
      {children(report.data)}
    </>}
    {report.kind !== 'result' && report.error.retryAfterSeconds && <p className="hint">Retry after {report.error.retryAfterSeconds} seconds. No automatic retry is performed.</p>}
    {report.kind !== 'result' && report.error.issues?.map((issue, i) => <p className="hint" key={i}>{issue.path.join('.')}: {issue.message}</p>)}
    <details><summary>Observation metadata &amp; export</summary><Pairs rows={[['Observed at', new Date(report.meta.observedAt).toLocaleString(undefined, { timeZoneName: 'short' })], ['Elapsed', `${report.meta.elapsedMs} ms`], ['Request ID', report.meta.requestId], ['Policy version', report.meta.policyVersion]]} /><Download text={JSON.stringify(report, null, 2)} filename="domos-inspection.json" mime="application/json" /></details>
  </> : <Empty text="No live request has been made. Submit a target to inspect its public records or headers." />}</Panel>;
}
function LiveStatus({ state }: { state: { error: string; status: string } }) {
  return <><p className="status" role="status" aria-live="polite">{state.status}</p><ErrorBox message={state.error} /></>;
}
function LiveDisclosure() { return <p className="hint">Explicit submit sends this target to <code>{API_ORIGIN}</code>. The resolver or inspected server may observe the query. No cookies, automatic retries, or queries on load.</p>; }
function recordValue(record: DnsRecord) {
  switch (record.type) {
    case 'A': case 'AAAA': return record.address;
    case 'MX': return `${record.preference} ${record.exchange}`;
    case 'CNAME': case 'NS': case 'PTR': return record.target;
    case 'TXT': return record.chunks.join('');
    case 'SOA': return `Primary ${record.mname}\nResponsible ${record.rname}\nSerial ${record.serial}\nRefresh ${record.refresh}s / retry ${record.retry}s / expire ${record.expire}s\nMinimum ${record.minimum}s`;
  }
}
function DnsAnswers({ queries }: { queries: DnsOutcome[] }) {
  return <>{queries.map((query, index) => <section key={index}><h3>{query.type}</h3>{query.status === 'answer' ?
    <DataTable caption={`${query.type} answers`} headers={['Name', 'Type', 'TTL (seconds)', 'Value']} rows={query.records.map((record) => [record.name, record.type, record.ttl, <pre>{recordValue(record)}</pre>])} /> :
    query.status === 'negative' ? <p className="notice">{query.reason === 'NXDOMAIN' ? 'NXDOMAIN: name does not exist.' : 'NODATA: name exists but no records of this type were returned.'} DNS response code {query.rcode}.</p> :
      <ErrorBox message={`${query.error.code}: ${query.error.message} (rcode ${query.rcode ?? 'not available'})`} />}</section>)}</>;
}
export function DnsTool({ reset }: { reset: () => void }) {
  const state = useLiveRequest<ApiResponse<'dns'>>();
  const [name, setName] = useState('');
  const [types, setTypes] = useState<DnsType[]>(['A', 'AAAA', 'MX']);
  return <div className="panels"><Panel title="Public DNS lookup"><form onSubmit={(event) => { event.preventDefault(); void state.run((signal) => requestLive('dns', { name, types }, signal), LIMITS.dnsTimeoutMs); }}>
    <fieldset disabled={state.busy}><Input label="DNS name or IP for PTR" value={name} required maxLength={253} onChange={(event) => setName(event.target.value)} placeholder="example.com" />
      <fieldset><legend>DNS record types</legend><div className="form-grid">{(['A', 'AAAA', 'MX', 'CNAME', 'NS', 'TXT', 'SOA', 'PTR'] as const).map((type) => <Check key={type} label={type} checked={types.includes(type)} onChange={(checked) => setTypes(checked ? [...types, type] : types.filter((entry) => entry !== type))} />)}</div></fieldset>
      <button className="button" type="button" onClick={() => setName('example.com')}>Load example target (does not query)</button><LiveDisclosure /></fieldset>
    <RunButtons {...state} clear={reset} label="Query DNS" /><LiveStatus state={state} /></form></Panel>
    <Report report={state.report}>{(data) => <><Pairs rows={[['Name', data.name], ['Resolver', data.resolver]]} /><DnsAnswers queries={data.queries} /></>}</Report></div>;
}
function Policy({ title, policy }: { title: string; policy: SpfReport | DmarcReport | DkimReport }) {
  return <section><h3>{title} <span className="badge">{policy.status}</span></h3><p className="hint">{policy.owner ?? 'No selector supplied; DKIM was not requested.'}</p>
    {policy.records.map((record, index) => <pre className="result-text" key={index}>{record}</pre>)}
    {policy.findings.map((finding, index) => <div className={finding.severity === 'info' ? 'notice' : 'warning'} key={index}><strong>{finding.code}</strong>: {finding.message}</div>)}
  </section>;
}
export function EmailPolicyTool({ reset }: { reset: () => void }) {
  const state = useLiveRequest<ApiResponse<'emailPolicy'>>();
  const [domain, setDomain] = useState('');
  const [dkimSelector, setDkimSelector] = useState('');
  return <div className="panels"><Panel title="Published mail policy"><form onSubmit={(event) => { event.preventDefault(); void state.run((signal) => requestLive('emailPolicy', { domain, ...(dkimSelector.trim() ? { dkimSelector: dkimSelector.trim() } : {}) }, signal), LIMITS.emailTimeoutMs); }}>
    <fieldset disabled={state.busy}><Input label="Email domain" value={domain} required maxLength={253} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" /><Input label="DKIM selector (optional)" value={dkimSelector} maxLength={63} onChange={(event) => setDkimSelector(event.target.value)} placeholder="selector1" />
      <p className="hint">Get the selector from a DKIM-Signature header's s= value. No selector guessing. This inspects DNS records, not actual sender authentication.</p><LiveDisclosure /></fieldset>
    <RunButtons {...state} clear={reset} label="Inspect email policy" /><LiveStatus state={state} /></form></Panel>
    <Report report={state.report}>{(data) => <><p className="warning"><strong>AUTHENTICATION NOT VERIFIED</strong> / DNS records only.</p>
      <Pairs rows={[['Domain', data.domain], ['Organizational domain', data.organizationalDomain ?? 'Not determined'], ['Resolver', data.resolver], ['DNS budget used', `${data.queriesUsed} / ${data.queryBudget}`]]} />
      <Policy title="SPF" policy={data.spf} /><p className="hint">Static exploration: {data.spf.complete ? 'complete' : 'incomplete'} / {data.spf.lookupCount} exploration lookups. This is not the RFC ten-term sender evaluation limit.</p>
      {data.spf.dependencies.length > 0 && <DataTable caption="SPF dependency exploration" headers={['From', 'To', 'Mechanism', 'Status']} rows={data.spf.dependencies.map((dependency) => [dependency.from, dependency.to, dependency.mechanism, dependency.status])} />}
      {data.spf.unevaluated.map((item, index) => <p className="warning" key={index}>Not evaluated: {item}</p>)}
      <Policy title="DMARC" policy={data.dmarc} /><p className="hint">Policy: {data.dmarc.policy ?? 'not established'}; organizational fallback: {data.dmarc.organizationalFallback ? 'yes' : 'no'}.</p>
      <Policy title="DKIM" policy={data.dkim} /><h3>Limitations</h3><ul>{data.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <details><summary>DNS evidence ({data.evidence.length})</summary>{data.evidence.map((evidence, index) => <div key={index}><h3>{evidence.name}</h3><DnsAnswers queries={[evidence.outcome]} /></div>)}</details>
    </>}</Report></div>;
}
export function HttpTool({ reset }: { reset: () => void }) {
  const state = useLiveRequest<ApiResponse<'http'>>();
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<'HEAD' | 'GET'>('HEAD');
  return <div className="tool-stack"><Panel title="Public HTTP target"><form onSubmit={(event) => { event.preventDefault(); void state.run((signal) => requestLive('http', { url, method }, signal), LIMITS.httpTimeoutMs); }}>
    <fieldset disabled={state.busy}><div className="form-grid"><Input label="HTTP or HTTPS URL" value={url} required maxLength={2048} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /><Select label="HTTP method" value={method} onChange={setMethod} options={['HEAD', 'GET']} /></div>
      <p className="hint">HEAD is the default. GET must be selected explicitly and may cause a server-side action. Bodies are not shown. Avoid URLs with tokens or confidential query parameters. Targets and every redirect must pass the API's public-address policy.</p><LiveDisclosure /></fieldset>
    <RunButtons {...state} clear={reset} label={`Inspect with ${method}`} /><LiveStatus state={state} /></form></Panel>
    <Report report={state.report}>{(data) => <><Pairs rows={[['Requested URL', data.requestedUrl], ['Method', data.method], ['Termination', data.termination]]} />
      {data.termination !== 'complete' && <p className="warning">Inspection stopped: {data.termination}. This is not a complete redirect chain.</p>}
      <DataTable caption="HTTP redirect chain" headers={['Hop', 'URL', 'Status', 'Remote IP', 'Time', 'Location']} rows={data.hops.map((hop, index) => [index + 1, hop.url, `${hop.method} ${hop.statusCode}`, hop.remoteAddress, `${hop.durationMs} ms`, hop.location ?? '(none)'])} />
      {data.hops.map((hop, index) => <details key={index} open={index === 0}><summary>Hop {index + 1}: {hop.statusCode} / response headers ({hop.headers.length})</summary><DataTable caption={`Hop ${index + 1} header pairs, duplicates preserved`} headers={['Header name', 'Header value']} rows={hop.headers.map((header) => [header.name, <pre>{header.value}</pre>])} /></details>)}
      <p className="hint">Remote values are displayed as text. No target or redirect is opened in your browser.</p>
    </>}</Report></div>;
}
