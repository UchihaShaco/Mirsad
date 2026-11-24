import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { passwordFromPipe } from '../../scripts/officer-create.ts';

it('reads one password without removing intentional spaces', async () => {
  await expect(passwordFromPipe(Readable.from([' fake pass', 'word only \r\n']))).resolves.toBe(' fake password only ');
});

it('rejects multiple lines and bounds the size of password input', async () => {
  await expect(passwordFromPipe(Readable.from(['first\nsecond']))).rejects.toThrow('invalid_password');
  await expect(passwordFromPipe(Readable.from(['x'.repeat(1024)]))).rejects.toThrow('invalid_password');
});
