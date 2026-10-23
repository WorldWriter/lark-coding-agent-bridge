import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

/**
 * End-to-end through the real `startChannel` with `tenant: 'wecom'`: a fake
 * WeCom SDK client stands in for the gateway, everything else (WecomChannel,
 * intake, pending queue, run-flow, session store) is real.
 */

interface StreamCall {
  reqId: string;
  streamId: string;
  content: string;
  finish: boolean;
}

class FakeWecomSdk extends EventEmitter {
  readonly streams: StreamCall[] = [];
  readonly sent: Array<{ chatid: string; body: Record<string, unknown> }> = [];
  connected = false;
  constructor(readonly options: Record<string, unknown>) {
    super();
  }
  connect(): this {
    setImmediate(() => {
      this.connected = true;
      this.emit('connected');
      this.emit('authenticated');
    });
    return this;
  }
  disconnect(): void {
    this.connected = false;
  }
  async replyStream(frame: { headers: { req_id: string } }, streamId: string, content: string, finish = false) {
    this.streams.push({ reqId: frame.headers.req_id, streamId, content, finish });
    return {};
  }
  async sendMessage(chatid: string, body: Record<string, unknown>) {
    this.sent.push({ chatid, body });
    return {};
  }
  async downloadFile() {
    return { buffer: Buffer.from(''), filename: undefined };
  }
  async uploadMedia() {
    return { media_id: 'm' };
  }
  async replyMedia() {
    return {};
  }
  async sendMediaMessage() {
    return {};
  }
  async replyWelcome() {
    return {};
  }
  get isConnected(): boolean {
    return this.connected;
  }
  inbound(body: Record<string, unknown>, reqId: string): void {
    this.emit('message', { cmd: 'aibot_msg_callback', headers: { req_id: reqId }, body });
  }
}

const sdkMock = vi.hoisted(() => ({ instance: undefined as unknown }));
vi.mock('@wecom/aibot-node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wecom/aibot-node-sdk')>();
  return {
    ...actual,
    WSClient: vi.fn((options: Record<string, unknown>) => {
      const sdk = new FakeWecomSdk(options);
      sdkMock.instance = sdk;
      return sdk;
    }),
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  sdkMock.instance = undefined;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('WeCom tenant through startChannel', () => {
  it('runs the agent for a DM and streams the reply back on the inbound frame', async () => {
    const h = await createHarness([
      [{ type: 'text', delta: '你好，我是企微里的回复' }, { type: 'done', terminationReason: 'normal' }],
    ]);
    const sdk = await startBridge(h);
    expect(sdk.options).toMatchObject({ botId: 'bot-int', secret: 'secret' });

    sdk.inbound(
      { msgid: 'dm-1', chattype: 'single', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '在吗' } },
      'req-dm-1',
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt).toContain('在吗');
    expect(h.agent.runOptions[0]?.prompt).toContain('企业微信');

    await waitFor(() => sdk.streams.some((f) => f.finish && f.content.includes('你好，我是企微里的回复')));
    expect(sdk.streams.every((f) => f.reqId === 'req-dm-1')).toBe(true);
    expect(sdk.sent).toHaveLength(0);
    expect(h.agent.botIdentity).toMatchObject({ openId: 'bot-int', platform: 'wecom' });
  });

  it('answers a non-allowlisted group with the invite hint instead of running the agent', async () => {
    const h = await createHarness([[{ type: 'done', terminationReason: 'normal' }]]);
    const sdk = await startBridge(h);
    sdk.inbound(
      { msgid: 'g-1', chattype: 'group', chatid: 'wrGroup1', from: { userid: 'wangwu' }, msgtype: 'text', text: { content: '@bot hi' } },
      'req-g-1',
    );
    await waitFor(() => sdk.streams.length === 1);
    expect(sdk.streams[0]).toMatchObject({ reqId: 'req-g-1', finish: true });
    expect(sdk.streams[0]?.content).toContain('/invite group');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('handles /help as a flattened text reply', async () => {
    const h = await createHarness([[{ type: 'done', terminationReason: 'normal' }]]);
    const sdk = await startBridge(h);
    sdk.inbound(
      { msgid: 'dm-2', chattype: 'single', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '/help' } },
      'req-dm-2',
    );
    await waitFor(() => sdk.streams.length === 1);
    expect(sdk.streams[0]?.content).toContain('使用帮助');
    expect(sdk.streams[0]?.content).toContain('/status');
    expect(h.agent.runOptions).toHaveLength(0);
  });
});

async function createHarness(events: FakeAgentEvents) {
  const tmp = await createTmpProfile('wecom-run-flow-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'bot-int', secret: 'secret', tenant: 'wecom' } },
    access: { allowedUsers: ['zhangsan'] },
    codex: { binaryPath: '/usr/local/bin/codex' },
  });
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'codex', displayName: 'Codex', events });
  const controls = {
    profile: 'wecom',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_wecom',
  };
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, agent, sessions, workspaces, profileConfig, controls };
}

async function startBridge(h: Awaited<ReturnType<typeof createHarness>>): Promise<FakeWecomSdk> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
  const sdk = sdkMock.instance as FakeWecomSdk | undefined;
  if (!sdk) throw new Error('fake wecom sdk not constructed');
  return sdk;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
