export function publicOrigin(value: string, allowLocal?: boolean): string;
export function buildOrigins(env: Record<string, string | undefined>): {
  site: string;
  workspace: string;
  api: string;
};
