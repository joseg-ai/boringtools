import { wordlist } from '@scure/bip39/wordlists/english.js';
import { PASSWORD_ALPHABETS, type LocalToolHandler } from '@domos/contracts';
import { checkAbort, unsupported } from './errors.js';

function randomIndex(size: number): number {
  if (!globalThis.crypto?.getRandomValues) unsupported('WebCrypto secure randomness is unavailable.');
  const bound = Math.floor(0x1_0000_0000 / size) * size;
  const sample = new Uint32Array(1);
  do {
    crypto.getRandomValues(sample);
  } while (sample[0]! >= bound);
  return sample[0]! % size;
}

function choose(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)]!;
}

// Inclusion-exclusion counts the uniformly sampled strings containing all
// selected, disjoint classes. BigInt keeps cancellation and large powers exact.
function validCount(sizes: number[], length: number): bigint {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let count = 0n;
  for (let mask = 0; mask < 2 ** sizes.length; mask++) {
    let removed = 0;
    let parity = 0;
    sizes.forEach((size, index) => {
      if ((mask & (1 << index)) !== 0) { removed += size; parity++; }
    });
    count += (parity % 2 ? -1n : 1n) * BigInt(total - removed) ** BigInt(length);
  }
  return count;
}

function log2BigInt(value: bigint): number {
  const bits = value.toString(2).length;
  const shift = Math.max(0, bits - 53);
  return Math.log2(Number(value >> BigInt(shift))) + shift;
}

export const password: LocalToolHandler<'password-generator'> = async (input, context) => {
  const values: string[] = [];
  if (input.mode === 'passphrase') {
    for (let i = 0; i < input.count; i++) {
      checkAbort(context);
      values.push(Array.from({ length: input.words }, () => {
        const word = wordlist[randomIndex(wordlist.length)]!;
        return input.capitalize ? word[0]!.toUpperCase() + word.slice(1) : word;
      }).join(input.separator));
    }
    // Separators containing only letters (or none) can make segmentation
    // ambiguous. The list's three-character minimum bounds multiplicity.
    const uniquelyDelimited = /[^a-z]/i.test(input.separator);
    const entropy = input.words * Math.log2(wordlist.length);
    const collisionBound = (input.words - 1) * Math.log2(8);
    return {
      kind: 'result', notices: [{
        level: 'info', code: 'WORDLIST_ONLY',
        text: 'Words are sampled independently from the BIP39 English list. This is a passphrase, not a wallet recovery seed.',
      }],
      data: {
        values, entropyBits: uniquelyDelimited ? entropy : Math.max(0, entropy - collisionBound),
        entropyLabel: uniquelyDelimited ? 'exact' : 'lower-bound',
        alphabetSize: wordlist.length, wordlist: 'scure-bip39/english', randomness: 'cryptographic',
      },
    };
  }
  const classes = (['uppercase', 'lowercase', 'digits', 'symbols'] as const)
    .filter((key) => input[key])
    .map((key) => [...PASSWORD_ALPHABETS[key]].filter((char) =>
      !input.excludeAmbiguous || !PASSWORD_ALPHABETS.ambiguous.includes(char)).join(''));
  const alphabet = classes.join('');
  for (let i = 0; i < input.count; i++) {
    let value: string;
    do {
      checkAbort(context);
      value = Array.from({ length: input.length }, () => choose(alphabet)).join('');
    } while (input.requireEachClass && !classes.every((group) => [...value].some((char) => group.includes(char))));
    values.push(value);
  }
  const possibilities = input.requireEachClass
    ? validCount(classes.map((group) => group.length), input.length)
    : BigInt(alphabet.length) ** BigInt(input.length);
  return {
    kind: 'result', notices: [], data: {
      values, entropyBits: log2BigInt(possibilities), entropyLabel: 'exact',
      alphabetSize: alphabet.length, wordlist: null, randomness: 'cryptographic',
    },
  };
};
