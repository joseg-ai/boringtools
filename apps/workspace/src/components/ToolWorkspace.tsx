import { useEffect, useState } from 'react';
import type { ToolId } from '@domos/catalog';
import { Base64Tool, ChmodTool, CronTool, DiffTool, EmailHeaderTool, EpochTool, HashTool, JsonYamlTool, JwtTool, PasswordTool, RegexTool, UrlTool } from './LocalTools';
import { SubnetTool } from './SubnetTool';
import { DnsTool, EmailPolicyTool, HttpTool } from './LiveTools';

const tools = {
  'ipv4-subnet-planner': SubnetTool,
  'dns-explorer': DnsTool,
  'email-dns-policy': EmailPolicyTool,
  'http-inspector': HttpTool,
  'email-header-analyzer': EmailHeaderTool,
  chmod: ChmodTool,
  'password-generator': PasswordTool,
  'json-yaml-workbench': JsonYamlTool,
  base64: Base64Tool,
  'url-workbench': UrlTool,
  'jwt-decoder': JwtTool,
  'sha-checksums': HashTool,
  'regex-tester': RegexTool,
  'text-diff': DiffTool,
  'cron-helper': CronTool,
  'epoch-time': EpochTool,
} satisfies Record<ToolId, (props: { reset: () => void }) => React.JSX.Element>;

export default function ToolWorkspace({ id }: { id: ToolId }) {
  const [version, setVersion] = useState(0);
  const [resetStatus, setResetStatus] = useState('');
  function reset() { setVersion((value) => value + 1); setResetStatus('Workspace reset. Inputs and results cleared from this page, not from any clipboard or downloaded file.'); }
  useEffect(() => {
    setVersion((value) => value + 1);
    const restore = (event: PageTransitionEvent) => { if (event.persisted) { setVersion((value) => value + 1); setResetStatus('Restored page reset to avoid retaining previous inputs.'); } };
    const hide = () => { setVersion((value) => value + 1); };
    window.addEventListener('pageshow', restore); window.addEventListener('pagehide', hide);
    return () => { window.removeEventListener('pageshow', restore); window.removeEventListener('pagehide', hide); };
  }, []);
  const Component = tools[id];
  return <><p className="status" role="status">{resetStatus}</p><Component key={version} reset={reset} /></>;
}
