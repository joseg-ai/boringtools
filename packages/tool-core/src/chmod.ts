import type { LocalToolHandler } from '@domos/contracts';

export const chmod: LocalToolHandler<'chmod'> = async (input) => {
  let mode = input.operation === 'from-bits'
    ? input.owner * 64 + input.group * 8 + input.other
      + Number(input.setuid) * 2048 + Number(input.setgid) * 1024 + Number(input.sticky) * 512
    : Number.parseInt(input.operation === 'from-octal' ? input.value : input.base, 8);
  if (input.operation === 'apply-symbolic') {
    for (const clause of input.expression.split(',')) {
      const match = /^([ugoa]+)([+=-])([rwxst]*)$/.exec(clause)!;
      const targets = match[1]!;
      const operator = match[2]!;
      const permissions = match[3]!;
      for (const [target, shift, special] of [['u', 6, 2048], ['g', 3, 1024], ['o', 0, 512]] as const) {
        if (!targets.includes(target) && !targets.includes('a')) continue;
        let bits = (Number(permissions.includes('r')) * 4 + Number(permissions.includes('w')) * 2
          + Number(permissions.includes('x'))) << shift;
        if (permissions.includes(target === 'o' ? 't' : 's')) bits |= special;
        if (operator === '=') mode = (mode & ~(7 << shift) & ~special) | bits;
        else if (operator === '+') mode |= bits;
        else mode &= ~bits;
      }
    }
  }
  const bits = {
    owner: (mode >> 6) & 7, group: (mode >> 3) & 7, other: mode & 7,
    setuid: Boolean(mode & 2048), setgid: Boolean(mode & 1024), sticky: Boolean(mode & 512),
  };
  const symbolic = [
    [bits.owner, bits.setuid, 's', 'S'],
    [bits.group, bits.setgid, 's', 'S'],
    [bits.other, bits.sticky, 't', 'T'],
  ] as const;
  const octal = mode.toString(8).padStart(4, '0');
  return {
    kind: 'result', notices: [], data: {
      mode, bits, octal, command: `chmod ${octal} <path>`,
      symbolic: symbolic.map(([value, special, lower, upper]) =>
        `${value & 4 ? 'r' : '-'}${value & 2 ? 'w' : '-'}${special ? value & 1 ? lower : upper : value & 1 ? 'x' : '-'}`).join(''),
    },
  };
};
