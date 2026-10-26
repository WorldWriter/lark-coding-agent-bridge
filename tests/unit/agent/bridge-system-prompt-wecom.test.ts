import { describe, expect, it } from 'vitest';
import {
  BRIDGE_SYSTEM_PROMPT,
  WECOM_PLATFORM_NOTES,
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';

describe('bridge system prompt on WeCom', () => {
  it('appends the WeCom notes and labels the identity as BotID', () => {
    const prompt = buildBridgeSystemPrompt({ openId: 'bot-9', name: '小天才' }, 'wecom');
    expect(prompt).toContain(BRIDGE_SYSTEM_PROMPT);
    expect(prompt).toContain(WECOM_PLATFORM_NOTES);
    expect(prompt).toContain('你的 BotID 是 `bot-9`，名字是「小天才」');
    expect(prompt).not.toContain('你的 open_id 是');
  });

  it('keeps the Feishu prompt byte-identical when platform is omitted', () => {
    const before = buildBridgeSystemPrompt({ openId: 'ou_1' });
    expect(before).toBe(buildBridgeSystemPrompt({ openId: 'ou_1' }, 'feishu'));
    expect(before).not.toContain('企业微信');
    expect(prefixBridgeSystemPrompt('hi', { openId: 'ou_1' })).toContain('## user_message\n\nhi');
  });
});
