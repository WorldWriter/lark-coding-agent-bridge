import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import { createRuntimeAgent } from '../../../src/runtime/agent-runtime';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

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

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

describe('CodexAdapter system prompt wiring', () => {
  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}


describe('WeCom runtime factory after supervisor migration', () => {
  it.each([undefined, 'session-model'])('preserves the profile model unless a run overrides it (%s)', async (model) => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const agent = createRuntimeAgent(createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'bot-test', secret: 'test-only', tenant: 'wecom' } },
      codex: { binaryPath: '/usr/local/bin/codex', model: 'profile-model' },
    }), { profileDir: '/tmp/wecom-test', rootDir: '/tmp/bridge-test', profile: 'wecom-test' });
    agent.setBotIdentity?.({ openId: 'bot-test', platform: 'wecom' });
    agent.run({ runId: 'wecom-model', prompt: '查本地产品', cwd: '/tmp', threadId: 'thread-test', model });

    const [, args, options] = spawnMock.spawnProcess.mock.calls[0]!;
    expect(args.filter((arg: string) => arg === '--model')).toHaveLength(1);
    expect(args[args.indexOf('--model') + 1]).toBe(model ?? 'profile-model');
    expect(args.indexOf('--model')).toBeGreaterThan(args.indexOf('resume'));
    expect(options.env.LARK_CHANNEL).toBe(process.env.LARK_CHANNEL);
    expect(options.env.LARK_CHANNEL_PROFILE).toBe(process.env.LARK_CHANNEL_PROFILE);
    expect(await readAll(child.stdin)).toContain('企业微信');
  });

  it('keeps Claude WeCom prompts in a file and skips Feishu binding', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const agent = createRuntimeAgent(createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'bot-test', secret: 'test-only', tenant: 'wecom' } },
    }), { profileDir: '/tmp/wecom-test', rootDir: '/tmp/bridge-test', profile: 'wecom-test' });
    agent.setBotIdentity?.({ openId: 'bot-test', platform: 'wecom' });
    agent.run({ runId: 'wecom-claude', prompt: '查本地产品', cwd: '/tmp', permissionMode: 'plan' });

    const [, args, options] = spawnMock.spawnProcess.mock.calls[0]!;
    expect(args).toContain('--setting-sources');
    expect(options.env.LARK_CHANNEL).toBe(process.env.LARK_CHANNEL);
    expect(options.env.LARK_CHANNEL_PROFILE).toBe(process.env.LARK_CHANNEL_PROFILE);
    expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toContain('企业微信');
    expect(await readAll(child.stdin)).toBe('查本地产品');
  });
});
