import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { ClaudeAdapter } from '../../../src/agent/claude/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

function spawnedArgs(): string[] {
  return spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
}

describe('ClaudeAdapter setting-sources isolation', () => {
  it('does not restrict setting sources for bypassPermissions (owner) runs', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(spawnedArgs()).not.toContain('--setting-sources');
  });

  it.each(['acceptEdits', 'plan', 'default'] as const)(
    'restricts %s runs to user-level settings so project allow rules cannot leak',
    (permissionMode) => {
      spawnMock.spawnProcess.mockReturnValue(fakeChild());
      const adapter = new ClaudeAdapter();

      adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', permissionMode });

      const args = spawnedArgs();
      const flagIndex = args.indexOf('--setting-sources');
      expect(flagIndex).toBeGreaterThan(-1);
      expect(args[flagIndex + 1]).toBe('user');
    },
  );
});
