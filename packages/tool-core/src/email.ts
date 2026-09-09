import PostalMime, { decodeWords } from 'postal-mime';
import { LIMITS, instantSchema, type LocalToolHandler, type LocalToolOutput, type Notice } from '@domos/contracts';
import { ensureUnicode } from './bytes.js';
import { invalid, limit } from './errors.js';

export const email: LocalToolHandler<'email-header-analyzer'> = async (input) => {
  ensureUnicode(input.headers);
  if (/\r(?!\n)|\0/.test(input.headers)) invalid('Headers contain invalid control characters or line endings.');
  const lines = input.headers.replace(/\r\n/g, '\n').split('\n');
  const unfolded: string[] = [];
  let bodyIgnored = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) {
      bodyIgnored = lines.slice(i + 1).some((part) => part.trim() !== '');
      break;
    }
    if (/^[ \t]/.test(line)) {
      if (!unfolded.length) invalid('A folded header must follow a header field.');
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      if (!/^[\x21-\x39\x3b-\x7e]+:/.test(line)) invalid(`Malformed header on line ${i + 1}.`);
      const name = line.slice(0, line.indexOf(':'));
      if (name.length > 256) limit('Header names cannot exceed 256 bytes.');
      unfolded.push(line);
      if (unfolded.length > 2000) limit('At most 2,000 headers can be analyzed.');
    }
  }
  if (!unfolded.length) invalid('Enter at least one email header.');
  const parsed = await PostalMime.parse(unfolded.join('\r\n') + '\r\n\r\n', {
    maxHeadersSize: LIMITS.textBytes, maxNestingDepth: 1, maxRfc822NestingDepth: 0,
  });
  const headers = parsed.headers.map((header) => ({ name: header.originalKey, value: decodeWords(header.value) }));
  const received: LocalToolOutput<'email-header-analyzer'>['received'] = [];
  const authentication: LocalToolOutput<'email-header-analyzer'>['authentication'] = [];
  let missingTimes = 0;
  for (const header of parsed.headers) {
    if (header.key === 'received') {
      if (received.length >= 1000) limit('At most 1,000 Received headers can be analyzed.');
      const raw = header.value;
      const from = /\bfrom\s+(.+?)(?=\s+(?:by|with|via|id|for)\b|;|$)/i.exec(raw)?.[1];
      const by = /\bby\s+(.+?)(?=\s+(?:from|with|via|id|for)\b|;|$)/i.exec(raw)?.[1];
      if ((from && new TextEncoder().encode(from).length > 4096) || (by && new TextEncoder().encode(by).length > 4096)) {
        limit('Received host details exceed 4,096 bytes.');
      }
      const stamp = raw.includes(';') ? raw.slice(raw.lastIndexOf(';') + 1).trim() : '';
      const hasZone = /\s(?:[+-]\d{4}|UT|UTC|GMT|[ECMP][SD]T)(?:\s*\([^)]*\))?\s*$/i.test(stamp);
      const milliseconds = hasZone ? Date.parse(stamp) : NaN;
      const timestamp = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
      const validTime = timestamp !== undefined && instantSchema.safeParse(timestamp).success;
      if (!validTime) missingTimes++;
      received.push({
        index: received.length, raw,
        ...(from ? { from } : {}), ...(by ? { by } : {}),
        ...(validTime ? { timestamp } : {}),
      });
    }
    if (header.key === 'authentication-results' || header.key === 'received-spf' || header.key === 'arc-authentication-results') {
      if (authentication.length >= 1000) limit('At most 1,000 authentication headers can be analyzed.');
      authentication.push({ source: header.key, value: header.value });
    }
  }
  let skews = 0;
  for (let i = 0; i < received.length - 1; i++) {
    const newer = received[i]!;
    const older = received[i + 1]!;
    if (newer.timestamp && older.timestamp) {
      newer.delaySeconds = (Date.parse(newer.timestamp) - Date.parse(older.timestamp)) / 1000;
      if (newer.delaySeconds < 0) skews++;
    }
  }
  const get = (name: string) => headers.find((header) => header.name.toLowerCase() === name)?.value;
  const subject = get('subject');
  const from = get('from');
  const to = get('to');
  const date = get('date');
  if (date && new TextEncoder().encode(date).length > 4096) limit('Date header exceeds 4,096 bytes.');
  const notices: Notice[] = [{
    level: 'warning', code: 'HEADERS_UNVERIFIED',
    text: 'Header claims are untrusted. No DNS, SPF, DKIM, ARC, or sender verification was performed. Received hops remain in header order, newest first.',
  }];
  if (bodyIgnored) notices.push({ level: 'info', code: 'BODY_IGNORED', text: 'Only the header section was analyzed; the message body was ignored.' });
  if (missingTimes) notices.push({ level: 'warning', code: 'RECEIVED_TIME_MISSING', text: `${missingTimes} Received hop(s) have no valid timestamp with an explicit timezone.` });
  if (skews) notices.push({ level: 'warning', code: 'CLOCK_SKEW', text: `${skews} hop delay(s) are negative; clock skew, header order, or forged headers may be responsible.` });
  return {
    kind: 'result', notices, data: {
      headers, received, authentication, verification: 'not-performed',
      ...(subject !== undefined ? { subject } : {}), ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}), ...(date !== undefined ? { date } : {}),
    },
  };
};
