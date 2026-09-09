import { useState, type ReactNode } from 'react';
import { LIMITS, localOutputSchemas, type HashAlgorithm } from '@domos/contracts';
import { Check, Copy, DataTable, Download, Empty, Field, Input, Pairs, Panel, RunButtons, RunState, Select, TextInput, TextResult, useLocalTool } from './ui';

type ToolProps = { reset: () => void };
function submit(event: { preventDefault: () => void }, action: () => void) { event.preventDefault(); action(); }
function Result({ children }: { children: ReactNode }) { return <Panel title="Result">{children ?? <Empty />}</Panel>; }

export function JsonYamlTool({ reset }: ToolProps) {
  const state = useLocalTool('json-yaml-workbench', localOutputSchemas['json-yaml-workbench'].parse);
  const [text, setText] = useState('');
  const [source, setSource] = useState<'json' | 'yaml'>('json');
  const [action, setAction] = useState<'validate' | 'format' | 'minify' | 'convert'>('format');
  const [target, setTarget] = useState<'json' | 'yaml'>('yaml');
  const [indent, setIndent] = useState<'2' | '4'>('2');
  return <div className="panels"><Panel title="Structured input"><form autoComplete="off" onSubmit={(event) => submit(event, () => { void state.run({ text, source, action, indent: indent === '2' ? 2 : 4, ...(action === 'convert' ? { target } : {}) }); })}>
    <fieldset disabled={state.busy}><div className="form-grid"><Select label="Input format" value={source} onChange={setSource} options={['json', 'yaml']} /><Select label="Action" value={action} onChange={setAction} options={['format', 'validate', 'minify', 'convert']} />
      {action === 'convert' && <Select label="Convert to" value={target} onChange={setTarget} options={['json', 'yaml']} />}<Select label="Indent spaces" value={indent} onChange={setIndent} options={['2', '4']} /></div>
      <TextInput label="JSON or YAML input" value={text} onChange={setText} hint="Up to 1 MiB. JSON minification only; conversion may remove comments." />
      <button className="button" type="button" onClick={() => { setSource('json'); setText('{\n  "service": "edge",\n  "replicas": 3,\n  "enabled": true\n}'); }}>Load sample</button>
    </fieldset><RunButtons {...state} clear={reset} label={action === 'validate' ? 'Validate document' : 'Transform document'} /><RunState state={state} />
  </form></Panel><Result>{state.data && <><p className="badge local">VALID {state.data.format.toUpperCase()}</p><p className="hint">Comments: {state.data.comments}. {state.data.changed ? 'Output changed.' : 'No formatting changes.'}</p>{state.data.text !== null ? <TextResult text={state.data.text} filename={`domos-document.${state.data.format}`} /> : <p>The document passed validation. No transformed text was requested.</p>}</>}</Result></div>;
}

export function Base64Tool({ reset }: ToolProps) {
  const state = useLocalTool('base64', localOutputSchemas.base64.parse);
  const [text, setText] = useState('');
  const [operation, setOperation] = useState<'encode' | 'decode'>('encode');
  const [byteFormat, setByteFormat] = useState<'utf8' | 'hex'>('utf8');
  const [alphabet, setAlphabet] = useState<'standard' | 'url-safe'>('standard');
  const [padding, setPadding] = useState(true);
  return <div className="panels"><Panel title="Bytes & encoding"><form onSubmit={(event) => submit(event, () => { void state.run({ operation, text, byteFormat, alphabet, padding }); })}>
    <fieldset disabled={state.busy}><div className="form-grid"><Select label="Operation" value={operation} onChange={setOperation} options={['encode', 'decode']} /><Select label="Raw byte format" value={byteFormat} onChange={setByteFormat} options={['utf8', 'hex']} /><Select label="Base64 alphabet" value={alphabet} onChange={setAlphabet} options={['standard', 'url-safe']} /></div>
      <Check label="Include padding when encoding" checked={padding} onChange={setPadding} /><TextInput label={operation === 'encode' ? 'Text or hexadecimal bytes' : 'Base64 input'} value={text} onChange={setText} />
      <p className="hint">Base64 is reversible encoding, not encryption. Decode accepts valid padded or unpadded input.</p></fieldset>
    <RunButtons {...state} clear={reset} label={operation === 'encode' ? 'Encode bytes' : 'Decode Base64'} /><RunState state={state} />
  </form></Panel><Result>{state.data && <><p className="hint">{state.data.byteLength.toLocaleString()} bytes / {state.data.format}</p><TextResult text={state.data.text} /></>}</Result></div>;
}

export function UrlTool({ reset }: ToolProps) {
  const state = useLocalTool('url-workbench', localOutputSchemas['url-workbench'].parse);
  const [action, setAction] = useState<'parse' | 'build' | 'encode' | 'decode'>('parse');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'component' | 'form'>('component');
  const [replaceQuery, setReplaceQuery] = useState(true);
  const [parameters, setParameters] = useState([{ name: '', value: '' }]);
  function run() {
    if (action === 'parse') void state.run({ action, url: text });
    else if (action === 'build') void state.run({ action, baseUrl: text, parameters, replaceQuery });
    else void state.run({ action, text, mode });
  }
  return <div className="panels"><Panel title="URL workbench"><form onSubmit={(event) => submit(event, run)}>
    <fieldset disabled={state.busy}><Select label="URL action" value={action} onChange={setAction} options={['parse', 'build', 'encode', 'decode']} />
      {(action === 'encode' || action === 'decode') && <Select label="Encoding rules" value={mode} onChange={setMode} options={[['component', 'URI component (%20 spaces)'], ['form', 'Form encoding (+ spaces)']]} />}
      <TextInput label={action === 'parse' || action === 'build' ? 'Absolute URL' : 'Text input'} value={text} onChange={setText} compact maxLength={action === 'parse' || action === 'build' ? 16384 : LIMITS.textBytes} hint="No address is visited. URLs and credentials are displayed only as text." />
      {action === 'build' && <><Check label="Replace existing query" checked={replaceQuery} onChange={setReplaceQuery} /><h3>Ordered query parameters</h3>{parameters.map((parameter, index) => <div className="form-grid" key={index}>
        <Input label={`Parameter ${index + 1} name`} value={parameter.name} maxLength={8192} onChange={(event) => setParameters(parameters.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry))} />
        <Input label={`Parameter ${index + 1} value`} value={parameter.value} maxLength={8192} onChange={(event) => setParameters(parameters.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry))} />
        <button className="button" type="button" aria-label={`Remove parameter ${index + 1}`} onClick={() => setParameters(parameters.filter((_, i) => i !== index))}>Remove</button>
      </div>)}<button type="button" className="button" disabled={parameters.length >= 1000} onClick={() => setParameters([...parameters, { name: '', value: '' }])}>Add parameter</button></>}
    </fieldset><RunButtons {...state} clear={reset} label="Process URL" /><RunState state={state} />
  </form></Panel><Result>{state.data && <><TextResult text={state.data.text} />{state.data.components && <>
    <Pairs rows={Object.entries(state.data.components).filter(([key]) => key !== 'parameters').map(([key, value]) => [key, String(value)] as const)} />
    <DataTable caption="Ordered query parameters (duplicates preserved)" headers={['Name', 'Value']} rows={state.data.components.parameters.map((item) => [item.name, item.value])} />
  </>}</>}</Result></div>;
}

export function JwtTool({ reset }: ToolProps) {
  const state = useLocalTool('jwt-decoder', localOutputSchemas['jwt-decoder'].parse);
  const [token, setToken] = useState('');
  const [referenceTime, setReferenceTime] = useState('');
  return <div className="tool-stack"><div className="warning"><strong>UNVERIFIED</strong> / Decoding does not verify the signature, issuer, audience, or authorization. Never trust a token merely because it decodes.</div>
    <div className="panels"><Panel title="Encoded token"><form onSubmit={(event) => submit(event, () => { void state.run({ token, ...(referenceTime ? { referenceTime } : {}) }); })}><fieldset disabled={state.busy}>
      <TextInput label="JWT token" value={token} onChange={setToken} hint="Three dot-separated segments. Keep real bearer tokens private." />
      <Input label="Reference time (ISO with offset; blank uses now)" value={referenceTime} onChange={(event) => setReferenceTime(event.target.value)} placeholder="2026-01-01T12:00:00Z" /></fieldset>
      <RunButtons {...state} clear={reset} label="Decode unverified token" /><RunState state={state} /></form></Panel>
      <Result>{state.data && <><p className="warning"><strong>UNVERIFIED / signature not checked</strong></p><h3>Header</h3><TextResult text={state.data.headerText} filename="jwt-header.txt" /><h3>Payload</h3><TextResult text={state.data.payloadText} filename="jwt-payload.txt" />
        <DataTable caption="Timestamp claims relative to reference time" headers={['Claim', 'Raw value', 'ISO time', 'Status']} rows={state.data.claims.map((claim) => [claim.name, claim.rawValue, claim.isoTime ?? 'Not a timestamp', claim.status])} />
        <details><summary>Encoded signature (not verified)</summary><pre className="result-text">{state.data.signature}</pre></details></>}</Result>
    </div></div>;
}

export function HashTool({ reset }: ToolProps) {
  const state = useLocalTool('sha-checksums', localOutputSchemas['sha-checksums'].parse);
  const [source, setSource] = useState<'text' | 'file'>('text');
  const [text, setText] = useState('');
  const [inputEncoding, setInputEncoding] = useState<'utf8' | 'hex'>('utf8');
  const [algorithms, setAlgorithms] = useState<HashAlgorithm[]>(['SHA-256']);
  const [file, setFile] = useState<File | null>(null);
  const result = state.data ?? state.fileData;
  return <div className="panels"><Panel title="Checksum source"><form onSubmit={(event) => submit(event, () => {
    if (source === 'file' && file) void state.runFile(file, { algorithms, fileName: file.name });
    else if (source === 'text') void state.run({ text, inputEncoding, algorithms });
  })}><fieldset disabled={state.busy}><Select label="Hash source" value={source} onChange={(value) => { setSource(value); state.clear(); }} options={['text', 'file']} />
    <fieldset><legend>Hash algorithms</legend>{(['SHA-256', 'SHA-384', 'SHA-512'] as const).map((algorithm) => <Check key={algorithm} label={algorithm} checked={algorithms.includes(algorithm)} onChange={(checked) => setAlgorithms(checked ? [...algorithms, algorithm] : algorithms.filter((value) => value !== algorithm))} />)}</fieldset>
    {source === 'text' ? <><Select label="Input encoding" value={inputEncoding} onChange={setInputEncoding} options={['utf8', 'hex']} /><TextInput label="Text to hash" value={text} onChange={setText} /></> :
      <Field label="Local file (maximum 250 MiB)" hint="Read in bounded chunks by a worker. The file is never uploaded."><input type="file" required onChange={(event) => { setFile(event.target.files?.[0] ?? null); state.clear(); }} /></Field>}
    <p className="hint">A checksum detects changes; it does not establish who published a file.</p></fieldset><RunButtons {...state} clear={reset} label="Calculate checksums" /><RunState state={state} /></form></Panel>
    <Result>{result && <><p className="hint">{result.byteLength.toLocaleString()} bytes / {result.source}{result.fileName ? ` / ${result.fileName}` : ''}</p>{result.hashes.map((hash) => <section key={hash.algorithm}><h3>{hash.algorithm}</h3><TextResult text={hash.digest} filename={`${hash.algorithm.toLowerCase()}.txt`} /></section>)}</>}</Result>
  </div>;
}

export function RegexTool({ reset }: ToolProps) {
  const state = useLocalTool('regex-tester', localOutputSchemas['regex-tester'].parse);
  const [pattern, setPattern] = useState('');
  const [text, setText] = useState('');
  const [flags, setFlags] = useState('g');
  const [maxMatches, setMaxMatches] = useState(1000);
  return <div className="panels"><Panel title="JavaScript regular expression"><form onSubmit={(event) => submit(event, () => { void state.run({ pattern, text, flags, maxMatches }); })}><fieldset disabled={state.busy}>
    <Input label="Regex pattern (without enclosing slashes)" value={pattern} maxLength={LIMITS.regexPatternBytes} onChange={(event) => setPattern(event.target.value)} placeholder="(?<name>[A-Za-z]+)" />
    <div className="form-grid"><Input label="Regex flags" value={flags} maxLength={8} onChange={(event) => setFlags(event.target.value)} /><Input label="Maximum matches" type="number" min={1} max={1000} value={maxMatches} onChange={(event) => setMaxMatches(event.target.valueAsNumber)} /></div>
    <TextInput label="Test input" value={text} onChange={setText} maxLength={LIMITS.regexTextBytes} hint="Up to 200 KiB. A dedicated worker is terminated at the 1-second deadline." />
    <p className="hint">Match inspection only. Replacement is not supported by this release's execution contract.</p></fieldset><RunButtons {...state} clear={reset} label="Test expression" /><RunState state={state} /></form></Panel>
    <Result>{state.data && <><p>{state.data.matches.length} matches / flags: <code>{state.data.flags || '(none)'}</code></p>{state.data.truncated && <p className="warning">Match limit reached. These results are truncated.</p>}
      {state.data.matches.length ? <DataTable caption="Regex matches and capture groups" headers={['Index', 'Match', 'Groups']} rows={state.data.matches.map((match) => [match.index, <pre>{match.text || '(empty match)'}</pre>, <><pre>{match.groups.map((group, i) => `${i + 1}: ${group ?? '(unmatched)'}`).join('\n')}</pre>{Object.entries(match.namedGroups).map(([name, value]) => <div key={name}><strong>{name}</strong>: {value ?? '(unmatched)'}</div>)}</>])} /> : <p>No matches found.</p>}</>}</Result>
  </div>;
}

export function DiffTool({ reset }: ToolProps) {
  const state = useLocalTool('text-diff', localOutputSchemas['text-diff'].parse);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [mode, setMode] = useState<'line' | 'word'>('line');
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [contextLines, setContextLines] = useState(3);
  return <div className="tool-stack"><Panel title="Compare two versions"><form onSubmit={(event) => submit(event, () => { void state.run({ before, after, mode, ignoreWhitespace, contextLines }); })}><fieldset disabled={state.busy}>
    <div className="panels"><TextInput label="Before text" value={before} onChange={setBefore} maxLength={LIMITS.diffSideBytes} /><TextInput label="After text" value={after} onChange={setAfter} maxLength={LIMITS.diffSideBytes} /></div>
    <div className="form-grid"><Select label="Comparison mode" value={mode} onChange={setMode} options={['line', 'word']} /><Input label="Unified context lines" type="number" min={0} max={20} value={contextLines} onChange={(event) => setContextLines(event.target.valueAsNumber)} /></div><Check label="Ignore whitespace differences" checked={ignoreWhitespace} onChange={setIgnoreWhitespace} />
    <p className="hint">512 KiB per side. Diff computation has a 2-second worker deadline.</p></fieldset><RunButtons {...state} clear={reset} label="Compare text" /><RunState state={state} /></form></Panel>
    <Result>{state.data && <><div className="tags"><span className="badge local">+ {state.data.stats.added} added</span><span className="badge">- {state.data.stats.removed} removed</span><span className="badge">{state.data.stats.unchanged} unchanged</span></div>
      <div className="result-text" tabIndex={0} aria-label="Readable text differences">{state.data.parts.map((part, index) => <div className={`diff-part diff-${part.kind}`} key={index}><span aria-label={part.kind}>{part.kind === 'added' ? '+ ' : part.kind === 'removed' ? '- ' : '  '}</span>{part.text}</div>)}</div>
      <div className="actions"><Copy text={state.data.unified} label="Copy unified diff" /><Download text={state.data.unified} filename="domos-changes.diff" label="Download diff" /></div></>}</Result></div>;
}

export function CronTool({ reset }: ToolProps) {
  const state = useLocalTool('cron-helper', localOutputSchemas['cron-helper'].parse);
  const [expression, setExpression] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [from, setFrom] = useState('');
  return <div className="panels"><Panel title="Five-field schedule"><form onSubmit={(event) => submit(event, () => { void state.run({ expression, timezone, count: 10, ...(from ? { from } : {}) }); })}><fieldset disabled={state.busy}>
    <Input label="Cron expression" value={expression} required maxLength={256} onChange={(event) => setExpression(event.target.value)} placeholder="*/15 9-17 * * MON-FRI" />
    <p className="mono hint">minute / hour / day of month / month / day of week</p>
    <Input label="IANA timezone" value={timezone} required maxLength={100} onChange={(event) => setTimezone(event.target.value)} />
    <Input label="Reference time (ISO with offset; blank uses now)" value={from} onChange={(event) => setFrom(event.target.value)} placeholder="2026-01-01T00:00:00Z" />
    <button className="button" type="button" onClick={() => setExpression('*/15 9-17 * * MON-FRI')}>Load weekday sample</button>
    <p className="hint">Five fields only, no seconds or extensions. Day-of-month and day-of-week use OR matching. DST follows cron-parser.</p></fieldset><RunButtons {...state} clear={reset} label="Show next 10 runs" /><RunState state={state} /></form></Panel>
    <Result>{state.data && <><p>{state.data.description}</p><p className="badge">{state.data.timezone}</p><DataTable caption="Next ten scheduled instants" headers={['#', 'Local time', 'ISO instant', 'UTC offset (minutes)']} rows={state.data.nextRuns.map((run, index) => [index + 1, run.local, run.iso, run.offsetMinutes])} /><p className="hint">Day matching: {state.data.dayMatching}; DST policy: {state.data.dstPolicy}. Preview only; nothing is scheduled.</p></>}</Result></div>;
}

export function EpochTool({ reset }: ToolProps) {
  const state = useLocalTool('epoch-time', localOutputSchemas['epoch-time'].parse);
  const [operation, setOperation] = useState<'from-epoch' | 'from-iso'>('from-epoch');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<'seconds' | 'milliseconds'>('seconds');
  const [timezone, setTimezone] = useState('UTC');
  return <div className="panels"><Panel title="Time conversion"><form onSubmit={(event) => submit(event, () => { void state.run({ operation, value, unit, timezone }); })}><fieldset disabled={state.busy}>
    <Select label="Conversion direction" value={operation} onChange={setOperation} options={[['from-epoch', 'Epoch to date'], ['from-iso', 'ISO date to epoch']]} />
    <Input label={operation === 'from-epoch' ? 'Epoch value' : 'ISO timestamp with offset'} value={value} required onChange={(event) => setValue(event.target.value)} placeholder={operation === 'from-epoch' ? '1704067200' : '2024-01-01T00:00:00Z'} />
    <div className="form-grid"><Select label="Epoch unit (never guessed)" value={unit} onChange={setUnit} options={['seconds', 'milliseconds']} /><Input label="Display timezone" value={timezone} required maxLength={100} onChange={(event) => setTimezone(event.target.value)} /></div>
    <button className="button" type="button" onClick={() => { setOperation('from-iso'); setValue(new Date().toISOString()); }}>Use current time</button>
    <p className="hint">ISO input must include Z or an offset. Fractional seconds support millisecond precision; milliseconds must be integers.</p></fieldset><RunButtons {...state} clear={reset} label="Convert time" /><RunState state={state} /></form></Panel>
    <Result>{state.data && <><Pairs rows={[['Epoch seconds', state.data.epochSeconds], ['Epoch milliseconds', state.data.epochMilliseconds], ['ISO instant', state.data.iso], ['Local display', state.data.local], ['Timezone', state.data.timezone], ['Offset minutes', state.data.offsetMinutes]]} /><Copy text={unit === 'seconds' ? state.data.epochSeconds : state.data.epochMilliseconds} label={`Copy epoch ${unit}`} /></>}</Result></div>;
}

export function ChmodTool({ reset }: ToolProps) {
  const state = useLocalTool('chmod', localOutputSchemas.chmod.parse);
  const [operation, setOperation] = useState<'from-octal' | 'from-bits' | 'apply-symbolic'>('from-octal');
  const [value, setValue] = useState('0644');
  const [expression, setExpression] = useState('');
  const [bits, setBits] = useState({ owner: 6, group: 4, other: 4, setuid: false, setgid: false, sticky: false });
  function run() {
    if (operation === 'from-octal') void state.run({ operation, value });
    else if (operation === 'from-bits') void state.run({ operation, ...bits });
    else void state.run({ operation, base: value, expression });
  }
  return <div className="panels"><Panel title="Unix permission mode"><form onSubmit={(event) => submit(event, run)}><fieldset disabled={state.busy}>
    <Select label="Permission input" value={operation} onChange={setOperation} options={[['from-octal', 'Octal mode'], ['from-bits', 'Permission checkboxes'], ['apply-symbolic', 'Apply symbolic change']]} />
    {operation !== 'from-bits' && <Input label={operation === 'apply-symbolic' ? 'Base octal mode' : 'Octal mode'} value={value} maxLength={4} required onChange={(event) => setValue(event.target.value)} />}
    {operation === 'apply-symbolic' && <><Input label="Symbolic changes" value={expression} maxLength={256} required onChange={(event) => setExpression(event.target.value)} placeholder="u+x,g-w,o=" /><p className="hint">Explicit u/g/o/a targets; rwxst supported. Conditional X and copying permission classes are not supported.</p></>}
    {operation === 'from-bits' && <><div className="form-grid">{(['owner', 'group', 'other'] as const).map((group) => <fieldset key={group}><legend>{group}</legend>{([[4, 'Read'], [2, 'Write'], [1, 'Execute']] as const).map(([bit, label]) => <Check key={bit} label={`${group} ${label}`} checked={Boolean(bits[group] & bit)} onChange={(checked) => setBits({ ...bits, [group]: checked ? bits[group] | bit : bits[group] & ~bit })} />)}</fieldset>)}</div>
      {(['setuid', 'setgid', 'sticky'] as const).map((bit) => <Check key={bit} label={bit} checked={bits[bit]} onChange={(checked) => setBits({ ...bits, [bit]: checked })} />)}</>}
    <p className="hint">Calculator only. No filesystem access or commands are executed. Review special bits before use.</p></fieldset><RunButtons {...state} clear={reset} label="Calculate permissions" /><RunState state={state} /></form></Panel>
    <Result>{state.data && <><Pairs rows={[['Octal', state.data.octal], ['Symbolic', state.data.symbolic], ['Numeric mode', state.data.mode], ['Owner / group / other', `${state.data.bits.owner} / ${state.data.bits.group} / ${state.data.bits.other}`], ['Special bits', `setuid ${state.data.bits.setuid}, setgid ${state.data.bits.setgid}, sticky ${state.data.bits.sticky}`]]} /><h3>Command preview (not executed)</h3><TextResult text={state.data.command} /></>}</Result></div>;
}

export function PasswordTool({ reset }: ToolProps) {
  const state = useLocalTool('password-generator', localOutputSchemas['password-generator'].parse);
  const [mode, setMode] = useState<'password' | 'passphrase'>('password');
  const [length, setLength] = useState(20);
  const [count, setCount] = useState(1);
  const [words, setWords] = useState(6);
  const [separator, setSeparator] = useState('-');
  const [capitalize, setCapitalize] = useState(false);
  const [options, setOptions] = useState({ uppercase: true, lowercase: true, digits: true, symbols: true, excludeAmbiguous: false, requireEachClass: true });
  return <div className="panels"><Panel title="Secret generation"><form onSubmit={(event) => submit(event, () => {
    if (mode === 'password') void state.run({ mode, length, count, ...options });
    else void state.run({ mode, words, count, separator, capitalize });
  })}><fieldset disabled={state.busy}><Select label="Secret type" value={mode} onChange={setMode} options={['password', 'passphrase']} />
    <div className="form-grid">{mode === 'password' ? <Input label="Password length" type="number" min={4} max={256} value={length} onChange={(event) => setLength(event.target.valueAsNumber)} /> : <Input label="Word count" type="number" min={4} max={24} value={words} onChange={(event) => setWords(event.target.valueAsNumber)} />}
      <Input label="Number to generate" type="number" min={1} max={20} value={count} onChange={(event) => setCount(event.target.valueAsNumber)} /></div>
    {mode === 'password' ? <fieldset><legend>Character rules</legend>{([['uppercase', 'Uppercase A-Z'], ['lowercase', 'Lowercase a-z'], ['digits', 'Digits 0-9'], ['symbols', 'Symbols'], ['excludeAmbiguous', 'Exclude ambiguous characters'], ['requireEachClass', 'Require every selected class']] as const).map(([key, label]) => <Check key={key} label={label} checked={options[key]} onChange={(checked) => setOptions({ ...options, [key]: checked })} />)}</fieldset> : <><Input label="Word separator" value={separator} maxLength={8} onChange={(event) => setSeparator(event.target.value)} /><Check label="Capitalize words" checked={capitalize} onChange={setCapitalize} /></>}
    <p className="hint">Generated only when requested using cryptographic randomness. No automatic copy, download, or storage. Clipboard contents may be visible to other apps.</p></fieldset><RunButtons {...state} clear={reset} label="Generate secrets" /><RunState state={state} /></form></Panel>
    <Result>{state.data && <><p className="badge local">CRYPTOGRAPHIC RANDOMNESS</p><p className="hint">Entropy: {state.data.entropyBits.toFixed(1)} bits ({state.data.entropyLabel}); selection pool: {state.data.alphabetSize}.{state.data.wordlist ? ` Wordlist: ${state.data.wordlist}.` : ''} This is a generation estimate, not a guarantee of account security.</p><ol className="secrets">{state.data.values.map((secret, index) => <li key={index}><code>{secret}</code><Copy text={secret} label={`Copy secret ${index + 1}`} /></li>)}</ol></>}</Result></div>;
}

export function EmailHeaderTool({ reset }: ToolProps) {
  const state = useLocalTool('email-header-analyzer', localOutputSchemas['email-header-analyzer'].parse);
  const [headers, setHeaders] = useState('');
  return <div className="tool-stack"><div className="warning"><strong>Reported, not verified.</strong> Authentication headers are assertions written by mail systems. This tool does not authenticate the sender or verify DKIM signatures.</div>
    <div className="panels"><Panel title="Raw message headers"><form onSubmit={(event) => submit(event, () => { void state.run({ headers }); })}><fieldset disabled={state.busy}>
      <TextInput label="Email headers" value={headers} onChange={setHeaders} hint="Paste only the header block, not the email body. Up to 1 MiB; content stays in this browser." /></fieldset><RunButtons {...state} clear={reset} label="Analyze headers" /><RunState state={state} /></form></Panel>
      <Result>{state.data && <><p className="badge">VERIFICATION NOT PERFORMED</p><Pairs rows={[['Subject', state.data.subject ?? '(not present)'], ['From (reported)', state.data.from ?? '(not present)'], ['To (reported)', state.data.to ?? '(not present)'], ['Date (reported)', state.data.date ?? '(not present)']]} />
        <h3>Received hops</h3>{state.data.received.length ? <DataTable caption="Reported mail routing" headers={['Hop', 'From', 'By', 'Timestamp', 'Delay seconds']} rows={state.data.received.map((hop) => [hop.index, hop.from ?? '-', hop.by ?? '-', hop.timestamp ?? 'Unparsed', hop.delaySeconds ?? '-'])} /> : <p>No Received headers were found.</p>}
        <h3>Reported authentication</h3>{state.data.authentication.length ? state.data.authentication.map((entry, index) => <div className="notice" key={index}><strong>{entry.source}</strong><pre>{entry.value}</pre></div>) : <p>No authentication assertions were found.</p>}
        <details><summary>All unfolded headers ({state.data.headers.length})</summary><DataTable caption="Unfolded header pairs" headers={['Name', 'Value']} rows={state.data.headers.map((header) => [header.name, <pre>{header.value}</pre>])} /></details>
      </>}</Result></div></div>;
}
