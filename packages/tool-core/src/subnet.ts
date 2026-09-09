import ipaddr from 'ipaddr.js';
import {
  LIMITS, subnetStateSchema,
  type LocalToolHandler, type Notice, type SubnetAllocation, type SubnetRow, type SubnetState,
} from '@domos/contracts';
import { invalid, isRecord, limit, validationFault } from './errors.js';
import { parseJson } from './structured.js';
import { compareNumber, LosslessNumber } from 'lossless-json';

function range(cidr: string) {
  const [address, prefix] = ipaddr.IPv4.parseCIDR(cidr);
  const value = address.octets.reduce((sum, octet) => sum * 256 + octet, 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(value / size) * size;
  return { prefix, size, start, end: start + size - 1, canonical: `${ip(start)}/${prefix}` };
}

function ip(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export function validatePartition(state: SubnetState): SubnetAllocation[] {
  const root = range(state.rootCidr);
  if (root.canonical !== state.rootCidr) invalid('Root CIDR must be canonical.');
  const allocations = [...state.allocations].sort((a, b) => range(a.cidr).start - range(b.cidr).start);
  let cursor = root.start;
  for (const allocation of allocations) {
    const leaf = range(allocation.cidr);
    if (leaf.canonical !== allocation.cidr) invalid(`Allocation ${allocation.cidr} is not canonical.`);
    if (leaf.start !== cursor || leaf.end > root.end || leaf.prefix < root.prefix) {
      invalid('Allocations must be disjoint, contiguous CIDRs that exactly partition the root.');
    }
    cursor += leaf.size;
  }
  if (cursor !== root.end + 1) invalid('Allocations do not cover the entire root.');
  return allocations;
}

function row(allocation: SubnetAllocation): SubnetRow {
  const block = range(allocation.cidr);
  const special = block.prefix >= 31;
  return {
    ...allocation,
    prefix: block.prefix,
    network: ip(block.start),
    broadcast: special ? null : ip(block.end),
    firstAddress: ip(block.start),
    lastAddress: ip(block.end),
    firstUsable: ip(block.start + (special ? 0 : 1)),
    lastUsable: ip(block.end - (special ? 0 : 1)),
    totalAddresses: String(block.size),
    usableHosts: String(special ? block.size : block.size - 2),
    semantics: block.prefix === 32 ? 'host' : block.prefix === 31 ? 'point-to-point' : 'subnet',
  };
}

function csvCell(value: string): string {
  // Spreadsheet formula protection applies to free-form notes.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const subnet: LocalToolHandler<'ipv4-subnet-planner'> = async (input) => {
  let state: SubnetState;
  const notices: Notice[] = [];
  if (input.action === 'create') {
    const canonical = range(input.cidr).canonical;
    state = { version: 1, rootCidr: canonical, allocations: [{ cidr: canonical, ...input.annotation }] };
    if (canonical !== input.cidr) notices.push({
      level: 'info', code: 'NETWORK_NORMALIZED', text: `Host bits were cleared: ${canonical}.`,
    });
  } else if (input.action === 'import') {
    const value = parseJson(input.json);
    if (!isRecord(value) || !(value.version instanceof LosslessNumber) || compareNumber(value.version.value, '1') !== 0) {
      invalid('Subnet imports require exactly version 1.');
    }
    const parsed = subnetStateSchema.safeParse({ ...value, version: 1 });
    if (!parsed.success) throw validationFault(parsed.error.issues);
    state = parsed.data;
  } else {
    state = { ...input.state, allocations: validatePartition(input.state) };
    if (input.action === 'split') {
      const selected = state.allocations.find((leaf) => leaf.cidr === input.cidr);
      if (!selected) invalid('Select an existing allocation to split.');
      const block = range(selected.cidr);
      if (block.prefix === 32) invalid('A /32 host cannot be split.');
      if (state.allocations.length >= LIMITS.subnetLeaves) limit('Subnet allocation limit reached.');
      state.allocations = state.allocations.filter((leaf) => leaf !== selected).concat([
        { ...selected, cidr: `${ip(block.start)}/${block.prefix + 1}` },
        { ...selected, cidr: `${ip(block.start + block.size / 2)}/${block.prefix + 1}` },
      ]);
    } else if (input.action === 'join') {
      const first = state.allocations.find((leaf) => leaf.cidr === input.cidrs[0]);
      const second = state.allocations.find((leaf) => leaf.cidr === input.cidrs[1]);
      if (!first || !second || first === second) invalid('Select two different existing sibling allocations.');
      const a = range(first.cidr);
      const b = range(second.cidr);
      if (a.prefix === 0 || a.prefix !== b.prefix || Math.floor(a.start / (2 * a.size)) !== Math.floor(b.start / (2 * b.size))) {
        invalid('Only equal-size sibling CIDRs can be joined.');
      }
      if (!input.annotation && (first.note !== second.note || first.color !== second.color)) {
        invalid('Sibling notes or colors differ; choose an explicit merged annotation.');
      }
      const annotation = input.annotation ?? { note: first.note, color: first.color };
      state.allocations = state.allocations.filter((leaf) => leaf !== first && leaf !== second).concat({
        cidr: `${ip(Math.min(a.start, b.start))}/${a.prefix - 1}`, ...annotation,
      });
    } else if (input.action === 'annotate') {
      if (!state.allocations.some((leaf) => leaf.cidr === input.cidr)) invalid('Select an existing allocation to annotate.');
      state.allocations = state.allocations.map((leaf) => leaf.cidr === input.cidr ? { ...leaf, ...input.annotation } : leaf);
    }
  }
  state.allocations = validatePartition(state);
  const rows = state.allocations.map(row);
  if (input.action === 'export') {
    const format = input.format;
    if (format === 'csv' && rows.some((item) => /^[=+\-@\t\r]/.test(item.note))) {
      notices.push({
        level: 'info', code: 'CSV_FORMULA_PROTECTION',
        text: 'Spreadsheet-sensitive notes are prefixed with an apostrophe in CSV. JSON export preserves the original annotations verbatim.',
      });
    }
    const text = format === 'json' ? JSON.stringify(state, null, 2) : [
      ['cidr', 'network', 'broadcast', 'firstUsable', 'lastUsable', 'totalAddresses', 'usableHosts', 'note', 'color'].join(','),
      ...rows.map((item) => [
        item.cidr, item.network, item.broadcast ?? '', item.firstUsable, item.lastUsable,
        item.totalAddresses, item.usableHosts, item.note, item.color,
      ].map(csvCell).join(',')),
    ].join('\r\n');
    return {
      kind: 'result', notices, data: {
        state, rows, download: {
          filename: `subnets.${format}`, mime: format === 'json' ? 'application/json' : 'text/csv', text,
        },
      },
    };
  }
  return { kind: 'result', notices, data: { state, rows } };
};
