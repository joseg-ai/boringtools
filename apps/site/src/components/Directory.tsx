import { useEffect, useState } from 'react';
import { CATEGORIES, TOOL_CATALOG, type ToolIcon } from '@domos/catalog';
const symbols: Record<ToolIcon, string> = { network: '/24', globe: 'DNS', 'mail-check': '@+', http: 'HTTP', mail: '@', permissions: 'rwx', key: '***', braces: '{ }', binary: '64', link: '://', token: 'JWT', fingerprint: '#', regex: '.*', diff: '+/-', calendar: '* *', clock: 't=' };
export default function Directory({ workspaceOrigin }: { workspaceOrigin: string }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [mode, setMode] = useState('all');
  useEffect(() => {
    const applyCategory = () => { const id = window.location.hash.slice(1); if (Object.hasOwn(CATEGORIES, id)) setCategory(id); };
    applyCategory();
    window.addEventListener('hashchange', applyCategory);
    return () => window.removeEventListener('hashchange', applyCategory);
  }, []);
  const query = search.trim().toLowerCase();
  const tools = TOOL_CATALOG.filter((tool) => (category === 'all' || tool.category === category) && (mode === 'all' || tool.mode === mode) && `${tool.title} ${tool.description} ${CATEGORIES[tool.category]}`.toLowerCase().includes(query));
  return <div><div className="directory-controls">
    <div className="search-row"><label className="field">Find a tool<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search DNS, JSON, passwords..." maxLength={120} autoComplete="off" /></label>
      <label className="field">Processing location<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="all">All processing modes</option><option value="local">Local / in your browser</option><option value="live">Live / diagnostics API</option></select></label></div>
    <div className="filters" role="group" aria-label="Filter by category"><button className="filter" type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All tools</button>{Object.entries(CATEGORIES).map(([id, label]) => <button className="filter" type="button" key={id} id={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}</button>)}</div>
  </div><p className="directory-count" role="status">{tools.length} of 16 tools / nothing to install</p>
    <div className="tool-grid">{tools.map((tool) => <article className="tool-card" key={tool.id}>
      <div className="card-top"><span className="tool-icon" aria-hidden="true">{symbols[tool.icon]}</span><span className={`badge ${tool.mode}`}>{tool.mode === 'local' ? 'LOCAL / BROWSER' : 'LIVE / API'}</span></div>
      <span className="card-category">{CATEGORIES[tool.category]}</span><h3><a href={`${workspaceOrigin}${tool.toolPath}`}>{tool.title}</a></h3><p>{tool.description}</p>
      <div className="card-links"><a href={`${workspaceOrigin}${tool.toolPath}`} aria-label={`Open ${tool.title}`}>Open tool <span aria-hidden="true">&nbsp;&rarr;</span></a><a href={tool.guidePath} aria-label={`Read guide for ${tool.title}`}>Guide</a></div>
    </article>)}</div>
    {!tools.length && <div className="no-results"><h3>No matching tools</h3><p>Try a shorter search or a different category.</p><button className="button" onClick={() => { setSearch(''); setCategory('all'); setMode('all'); }}>Reset filters</button></div>}
  </div>;
}
