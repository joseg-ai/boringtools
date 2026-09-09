import { CronExpressionParser } from 'cron-parser';
import { instantSchema, type LocalToolHandler, type LocalToolOutput } from '@domos/contracts';
import { checkAbort, InputFault, invalid, unsupported } from './errors.js';

export function zonedInstant(date: Date, timezone: string) {
  if (!Number.isFinite(date.getTime())) invalid('Timestamp is outside the supported calendar range.');
  const iso = date.toISOString();
  if (!instantSchema.safeParse(iso).success) unsupported('Only ISO calendar years 0000 through 9999 are supported.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, timeZoneName: 'longOffset',
  }).formatToParts(date);
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
  let offsetMinutes = 0;
  if (offset !== 'GMT' && offset !== 'UTC') {
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? '');
    if (!match) unsupported('Historical sub-minute timezone offsets are not representable by this contract.');
    offsetMinutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
  }
  const local = `${new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    hourCycle: 'h23', timeZoneName: 'longOffset', era: date.getUTCFullYear() <= 0 ? 'short' : undefined,
  }).format(date)} [${timezone}]`;
  return { iso, local, offsetMinutes };
}

function epochMillis(value: string, unit: 'seconds' | 'milliseconds'): bigint {
  if (unit === 'milliseconds') return BigInt(value);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const result = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return negative ? -result : result;
}

function secondsString(milliseconds: bigint): string {
  const negative = milliseconds < 0;
  const abs = negative ? -milliseconds : milliseconds;
  const fraction = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / 1000n}${fraction ? `.${fraction}` : ''}`;
}

export const epoch: LocalToolHandler<'epoch-time'> = async (input) => {
  let milliseconds: bigint;
  if (input.operation === 'from-epoch') milliseconds = epochMillis(input.value, input.unit);
  else {
    const parsed = Date.parse(input.value);
    if (!Number.isFinite(parsed)) invalid('Invalid ISO timestamp.');
    milliseconds = BigInt(parsed);
  }
  if (milliseconds > 8640000000000000n || milliseconds < -8640000000000000n) {
    invalid('Epoch is outside the JavaScript calendar range.');
  }
  const zoned = zonedInstant(new Date(Number(milliseconds)), input.timezone);
  return {
    kind: 'result', notices: [], data: {
      ...zoned, epochSeconds: secondsString(milliseconds), epochMilliseconds: milliseconds.toString(),
      timezone: input.timezone,
    },
  };
};

export const cron: LocalToolHandler<'cron-helper'> = async (input, context) => {
  const nextRuns: LocalToolOutput<'cron-helper'>['nextRuns'] = [];
  try {
    const expression = CronExpressionParser.parse(input.expression, {
      currentDate: input.from, tz: input.timezone, strict: false,
    });
    for (let i = 0; i < input.count; i++) {
      checkAbort(context);
      nextRuns.push(zonedInstant(expression.next().toDate(), input.timezone));
    }
  } catch (error) {
    if (error instanceof Error && /^(?:Invalid (?:cron expression|characters|step|range|list value|repeat|explicit day of month)|Constraint error|Validation error, cannot resolve alias|Cron(?:Second|Minute|Hour|DayOfMonth|Month|DayOfWeek) Validation error|CronDate: unhandled timestamp|Out of the time span range)/.test(error.message)) {
      invalid(error.message.slice(0, 1000));
    }
    if (error instanceof Error && error.message === 'Invalid expression, loop limit exceeded') {
      throw new InputFault('LIMIT_EXCEEDED', 'No next occurrence was found within the cron parser search limit.');
    }
    throw error;
  }
  const [minute, hour, day, month, weekday] = input.expression.split(/\s+/);
  return {
    kind: 'result', notices: [{
      level: 'info', code: 'CRON_DST_POLICY',
      text: 'Uses cron-parser timezone/DST behavior. Missing wall times may shift forward; a repeated fall-back wall time is not guaranteed to run twice. Preview the listed instants.',
    }], data: {
      expression: input.expression, timezone: input.timezone, nextRuns,
      description: `Minute ${minute}; hour ${hour}; day of month ${day}; month ${month}; weekday ${weekday}. When both day fields are restricted, either may match. Runs strictly after the reference instant.`,
      dayMatching: 'or', dstPolicy: 'cron-parser',
    },
  };
};
