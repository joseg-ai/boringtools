import { useEffect, useState } from 'react';
import { LIMITS, localOutputSchemas, type SubnetOutput, type SubnetAnnotation } from '@domos/contracts';
import { Check, DataTable, Download, Empty, ErrorBox, Input, Panel, Pairs, RunState, Select, TextInput, useLocalTool } from './ui';

export function SubnetTool({ reset }: { reset: () => void }) {
  const state = useLocalTool('ipv4-subnet-planner', localOutputSchemas['ipv4-subnet-planner'].parse);
  const [cidr, setCidr] = useState('');
  const [plan, setPlan] = useState<SubnetOutput | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [color, setColor] = useState<SubnetAnnotation['color']>('teal');
  const [json, setJson] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!state.data) return;
    const accepted = state.data;
    setPlan(accepted);
    setSelected((previous) => previous.filter((item) => state.data?.state.allocations.some((allocation) => allocation.cidr === item)));
    setPage((previous) => Math.min(previous, Math.floor((accepted.rows.length - 1) / 100)));
  }, [state.data]);
  function select(value: string, checked: boolean) {
    setSelectionError('');
    if (checked && selected.length >= 2) { setSelectionError('Select at most two allocations. Deselect one before selecting another.'); return; }
    const next = checked ? [...selected, value] : selected.filter((entry) => entry !== value);
    setSelected(next);
    const allocation = plan?.state.allocations.find((entry) => entry.cidr === next[0]);
    if (allocation) { setNote(allocation.note); setColor(allocation.color); }
  }
  const current = plan?.rows.find((entry) => entry.cidr === selected[0]);
  const addressCount = plan?.rows.reduce((total, row) => total + Number(row.totalAddresses), 0) ?? 1;
  return <div className="tool-stack">
    <Panel title="Base network">
      <form onSubmit={(event) => { event.preventDefault(); setSelected([]); void state.run({ action: 'create', cidr }); }}>
        <fieldset disabled={state.busy}><div className="form-grid"><Input label="Base IPv4 CIDR" value={cidr} required maxLength={18} onChange={(event) => setCidr(event.target.value)} placeholder="10.42.0.0/16" /></div>
          <p className="hint">Create or replace the in-memory plan. Existing allocations are replaced only when the new CIDR succeeds.</p>
          <div className="actions"><button className="button primary" type="submit">Create / replace plan</button><button className="button" type="button" onClick={() => setCidr('10.42.0.0/16')}>Load sample CIDR</button></div></fieldset>
      </form>
      <div className="actions"><button className="button" type="button" disabled={!state.busy} onClick={state.cancel}>Cancel</button><button className="button" type="button" onClick={reset}>Clear / reset</button></div>
      <RunState state={state} />
    </Panel>
    {plan ? <Panel title={`Allocation map / ${plan.state.rootCidr}`}>
      <div className="tags"><span className="badge">{plan.rows.length} / {LIMITS.subnetLeaves} leaves</span><span className="badge">{addressCount.toLocaleString()} addresses</span>{plan.state.rootCidr.endsWith('/0') && <span className="badge">/0: entire IPv4 space</span>}</div>
      <div className="allocation-map" role="group" aria-label="Proportional IPv4 allocation diagram">
        {plan.rows.map((row) => <button key={row.cidr} type="button" tabIndex={-1} className={`allocation color-${row.color}`} style={{ flexBasis: 0, flexGrow: Number(row.totalAddresses) / addressCount }} disabled={state.busy} aria-pressed={selected.includes(row.cidr)} aria-label={`Select allocation ${row.cidr}: ${row.note || 'no note'}, ${row.totalAddresses} addresses`} title={`${row.cidr} / ${row.note || 'unnamed'} / ${row.totalAddresses} addresses`} onClick={() => select(row.cidr, !selected.includes(row.cidr))}><span>{row.cidr}</span><span>{row.note}</span></button>)}
      </div>
      <p className="hint">Widths show each allocation's share of the base network. Tiny blocks may not have a visible label; the table below provides the same selection controls by keyboard.</p>
      <ErrorBox message={selectionError} />
      <div className="panels"><div>
        <h3>Selection commands</h3><p className="mono">{selected.length ? selected.join(' + ') : 'Select an allocation below.'}</p>
        <div className="actions"><button className="button" type="button" disabled={state.busy || selected.length !== 1 || current?.prefix === 32 || plan.rows.length >= LIMITS.subnetLeaves} onClick={() => { const target = selected[0]; if (target) void state.run({ action: 'split', state: plan.state, cidr: target }); }}>Split selected block</button>
          <button className="button" type="button" disabled={state.busy || selected.length !== 2} onClick={() => { const [first, second] = selected; if (first && second) void state.run({ action: 'join', state: plan.state, cidrs: [first, second], annotation: { note, color } }); }}>Join selected siblings</button></div>
        <p className="hint">Join requires two equal-size sibling leaves. The engine rejects overlaps, gaps and invalid joins. Joining explicitly uses the note and color shown here.</p>
        {current && <Pairs rows={[['Address range', `${current.firstAddress} - ${current.lastAddress}`], ['Usable range', `${current.firstUsable} - ${current.lastUsable}`], ['Broadcast', current.broadcast ?? 'Not applicable'], ['Usable hosts', current.usableHosts], ['Semantics', current.prefix === 31 ? '/31 point-to-point: both addresses usable' : current.prefix === 32 ? '/32 host route: one address' : current.prefix === 0 ? '/0: entire IPv4 address space' : 'Network and broadcast excluded from usable hosts']]} />}
      </div><form onSubmit={(event) => { event.preventDefault(); const target = selected[0]; if (target) void state.run({ action: 'annotate', state: plan.state, cidr: target, annotation: { note, color } }); }}>
        <fieldset disabled={state.busy || selected.length === 0}><legend>Selected allocation annotation</legend><TextInput label="Allocation note" value={note} onChange={setNote} maxLength={1024} compact />
          <Select label="Allocation color" value={color} onChange={setColor} options={['slate', 'teal', 'blue', 'amber', 'rose', 'violet']} /><button className="button" type="submit" disabled={selected.length !== 1}>Save note and color</button></fieldset>
      </form></div>
      <p className="hint">Scroll horizontally for all columns; focus the table to use Left/Right arrow keys. On narrow screens, scroll back left for selection controls.</p>
      <DataTable className="allocation-table" caption={`Keyboard allocation table / page ${page + 1}`} headers={['Select', 'CIDR', 'Usable range', 'Addresses / hosts', 'Kind', 'Note / color']} rows={plan.rows.slice(page * 100, (page + 1) * 100).map((row) => [
        <Check label={`Select ${row.cidr}`} checked={selected.includes(row.cidr)} onChange={(checked) => select(row.cidr, checked)} />,
        <code>{row.cidr}</code>, <span className="mono">{row.firstUsable}<br />{row.lastUsable}</span>, `${row.totalAddresses} / ${row.usableHosts}`,
        row.prefix === 31 ? '/31 point-to-point' : row.prefix === 32 ? '/32 host' : row.prefix === 0 ? '/0 IPv4 space' : row.semantics,
        <><span className={`badge color-${row.color}`}>{row.color}</span> {row.note || '(no note)'}</>,
      ])} />
      <div className="actions"><button className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous 100</button><span className="hint">Page {page + 1} of {Math.ceil(plan.rows.length / 100)}</span><button className="button" disabled={(page + 1) * 100 >= plan.rows.length} onClick={() => setPage(page + 1)}>Next 100</button></div>
      <div className="actions">{(['json', 'csv'] as const).map((format) => <button type="button" className="button" key={format} disabled={state.busy} onClick={() => { void state.run({ action: 'export', state: plan.state, format }); }}>Prepare {format.toUpperCase()} export</button>)}
        {state.data?.download && <Download {...state.data.download} label={`Download ${state.data.download.filename}`} />}</div>
    </Panel> : <Empty text="Create a base network or import a saved JSON plan to begin allocating address space." />}
    <Panel title="Import a saved plan"><form onSubmit={(event) => { event.preventDefault(); void state.run({ action: 'import', json }); }}>
      <fieldset disabled={state.busy}><TextInput label="Subnet plan JSON" value={json} onChange={setJson} maxLength={LIMITS.outputBytes} compact hint="Paste a version 1 JSON export, up to 2 MiB. All leaves must canonically and exactly partition the base CIDR." />
        <button className="button" type="submit">Import JSON plan</button></fieldset>
      <p className="hint">Import a JSON export to restore the plan, notes and colors. CSV exports are for spreadsheets. Invalid imports leave your last valid plan intact.</p>
    </form></Panel>
  </div>;
}
