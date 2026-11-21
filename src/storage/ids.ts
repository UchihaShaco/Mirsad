import { randomUUID } from 'node:crypto';

/** ID prefixes of design section 4. */
export type IdPrefix =
  | 'ws' | 'prn' | 'acct' | 'chat' | 'msg' | 'mev' | 'cap' | 'art' | 'rev'
  | 'fnd' | 'det' | 'cref' | 'act' | 'dsp' | 'wle' | 'wob' | 'wrv' | 'wmt';

/** `<prefix>_<32 hex>` from crypto.randomUUID(). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
