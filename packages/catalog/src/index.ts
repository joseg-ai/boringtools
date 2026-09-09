export const TOOL_IDS = [
  'ipv4-subnet-planner',
  'dns-explorer',
  'email-dns-policy',
  'http-inspector',
  'email-header-analyzer',
  'chmod',
  'password-generator',
  'json-yaml-workbench',
  'base64',
  'url-workbench',
  'jwt-decoder',
  'sha-checksums',
  'regex-tester',
  'text-diff',
  'cron-helper',
  'epoch-time',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];
export type ToolMode = 'local' | 'live';

export const TOOL_MODES = {
  'ipv4-subnet-planner': 'local',
  'dns-explorer': 'live',
  'email-dns-policy': 'live',
  'http-inspector': 'live',
  'email-header-analyzer': 'local',
  chmod: 'local',
  'password-generator': 'local',
  'json-yaml-workbench': 'local',
  base64: 'local',
  'url-workbench': 'local',
  'jwt-decoder': 'local',
  'sha-checksums': 'local',
  'regex-tester': 'local',
  'text-diff': 'local',
  'cron-helper': 'local',
  'epoch-time': 'local',
} as const satisfies Record<ToolId, ToolMode>;

export type LocalToolId = {
  [K in ToolId]: (typeof TOOL_MODES)[K] extends 'local' ? K : never;
}[ToolId];
export type LiveToolId = Exclude<ToolId, LocalToolId>;

export const LOCAL_TOOL_IDS = Object.freeze(
  TOOL_IDS.filter((id): id is LocalToolId => TOOL_MODES[id] === 'local'),
);
export const LIVE_TOOL_IDS = Object.freeze(
  TOOL_IDS.filter((id): id is LiveToolId => TOOL_MODES[id] === 'live'),
);

export const CATEGORIES = {
  network: 'Network & DNS',
  security: 'Security & identity',
  development: 'Development & data',
  text: 'Text & encoding',
  time: 'Time & scheduling',
} as const;
export type ToolCategory = keyof typeof CATEGORIES;
export type ToolIcon =
  | 'network' | 'globe' | 'mail-check' | 'http' | 'mail'
  | 'permissions' | 'key' | 'braces' | 'binary' | 'link'
  | 'token' | 'fingerprint' | 'regex' | 'diff' | 'calendar' | 'clock';

export const PUBLIC_ORIGINS = Object.freeze({
  site: 'https://domosdigial.com',
  workspace: 'https://tools.domosdigial.com',
  api: 'https://api.domosdigial.com',
});

export const PRIVACY_LABELS = Object.freeze({
  local: 'Local: processed in this browser',
  live: 'Live: sends the submitted target for inspection',
});

export interface ToolMetadata {
  readonly id: ToolId;
  readonly title: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly icon: ToolIcon;
  readonly mode: ToolMode;
  readonly privacyLabel: string;
  readonly privacyDetail: string;
  readonly toolPath: `/tools/${ToolId}/`;
  readonly guidePath: `/guides/${ToolId}/`;
  readonly guideTitle: string;
}

type EditorialMetadata = Pick<ToolMetadata, 'title' | 'description' | 'category' | 'icon' | 'guideTitle'>;

const editorial = {
  'ipv4-subnet-planner': {
    title: 'IPv4 Subnet Planner', category: 'network', icon: 'network',
    description: 'Divide an IPv4 network into named allocations and join sibling blocks without losing sight of the address space.',
    guideTitle: 'Plan IPv4 allocations with split and join',
  },
  'dns-explorer': {
    title: 'DNS Explorer', category: 'network', icon: 'globe',
    description: 'Inspect public DNS records with clear distinctions between answers, missing records and resolver failures.',
    guideTitle: 'Read DNS answers, TTLs and negative responses',
  },
  'email-dns-policy': {
    title: 'Email DNS Policy', category: 'network', icon: 'mail-check',
    description: 'Inspect published SPF, DMARC and a supplied DKIM selector, with the limits of DNS-only analysis made explicit.',
    guideTitle: 'Understand what email DNS policy can tell you',
  },
  'http-inspector': {
    title: 'HTTP Inspector', category: 'network', icon: 'http',
    description: 'Follow a bounded public redirect chain and examine status codes and response headers without loading the page.',
    guideTitle: 'Investigate HTTP headers and redirect chains',
  },
  'email-header-analyzer': {
    title: 'Email Header Analyzer', category: 'network', icon: 'mail',
    description: 'Unfold message headers and inspect routing and reported authentication locally, without claiming to verify the sender.',
    guideTitle: 'Trace a message through its email headers',
  },
  chmod: {
    title: 'Chmod Calculator', category: 'security', icon: 'permissions',
    description: 'Translate Unix permission bits, octal modes and symbolic changes, including setuid, setgid and sticky bits.',
    guideTitle: 'Translate Unix permissions without executing commands',
  },
  'password-generator': {
    title: 'Password & Passphrase Generator', category: 'security', icon: 'key',
    description: 'Generate secrets with browser cryptographic randomness and clearly stated character or word selection rules.',
    guideTitle: 'Choose passwords and passphrases with useful entropy',
  },
  'json-yaml-workbench': {
    title: 'JSON & YAML Workbench', category: 'development', icon: 'braces',
    description: 'Validate, format and convert structured text while protecting large numeric values from silent rounding.',
    guideTitle: 'Convert JSON and YAML without hiding data loss',
  },
  base64: {
    title: 'Base64 Encoder & Decoder', category: 'text', icon: 'binary',
    description: 'Encode UTF-8 text or hexadecimal bytes and decode standard or URL-safe Base64 with explicit error reporting.',
    guideTitle: 'Use Base64 alphabets, padding and byte formats',
  },
  'url-workbench': {
    title: 'URL Workbench', category: 'development', icon: 'link',
    description: 'Inspect URL components and ordered query parameters or transform encoded text without visiting any address.',
    guideTitle: 'Work with URL components and duplicate query parameters',
  },
  'jwt-decoder': {
    title: 'JWT Decoder', category: 'security', icon: 'token',
    description: 'Read a three-part token and its timestamp claims locally; decoded content always remains unverified.',
    guideTitle: 'Read a JWT without mistaking decoding for verification',
  },
  'sha-checksums': {
    title: 'SHA Checksums', category: 'security', icon: 'fingerprint',
    description: 'Calculate SHA-256, SHA-384 and SHA-512 for text or bounded local files, with progress and cancellation.',
    guideTitle: 'Compare SHA checksums for text and files',
  },
  'regex-tester': {
    title: 'Regex Tester', category: 'development', icon: 'regex',
    description: 'Explore JavaScript regular expressions in a terminable worker with bounded input, match counts and execution time.',
    guideTitle: 'Test JavaScript regex patterns with execution limits',
  },
  'text-diff': {
    title: 'Text Diff', category: 'text', icon: 'diff',
    description: 'Compare text by line or word and export a unified difference without rendering input as HTML.',
    guideTitle: 'Compare changes by line, word and whitespace',
  },
  'cron-helper': {
    title: 'Cron Helper', category: 'time', icon: 'calendar',
    description: 'Inspect five-field cron schedules and upcoming instants in an explicit timezone using the documented parser rules.',
    guideTitle: 'Read five-field cron schedules across timezones',
  },
  'epoch-time': {
    title: 'Epoch Time Converter', category: 'time', icon: 'clock',
    description: 'Convert explicitly selected seconds or milliseconds to timestamp displays without guessing the unit or timezone.',
    guideTitle: 'Convert epoch values with explicit units and offsets',
  },
} as const satisfies Record<ToolId, EditorialMetadata>;

export const TOOL_CATALOG: readonly ToolMetadata[] = Object.freeze(TOOL_IDS.map((id) => {
  const mode = TOOL_MODES[id];
  return Object.freeze({
    id,
    ...editorial[id],
    mode,
    privacyLabel: PRIVACY_LABELS[mode],
    privacyDetail: mode === 'local'
      ? 'Inputs stay in browser memory. Saving or downloading is an explicit action; there is no automatic input history.'
      : 'The target is sent to the diagnostics API and its resolver or inspected server. Do not submit confidential targets.',
    toolPath: `/tools/${id}/` as const,
    guidePath: `/guides/${id}/` as const,
  });
}));

export function getTool(id: ToolId): ToolMetadata {
  const tool = TOOL_CATALOG.find((entry) => entry.id === id);
  if (!tool) throw new Error(`Catalog entry missing: ${id}`);
  return tool;
}
