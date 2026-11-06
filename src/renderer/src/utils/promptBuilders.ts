import type { DBPrompts } from '../types/common';

const defaultInstruction = '你是一个AI助手。请如实回答用户的问题。';

export function buildPrompt(promptObj?: DBPrompts): string {
  const segments: string[] = [];

  const resolvedPrompt: DBPrompts = promptObj ?? {
    userId: -1,
    instruction: defaultInstruction,
  };

  if (resolvedPrompt.nickName || resolvedPrompt.job || resolvedPrompt.description) {
    segments.push('[User Information]');
    if (resolvedPrompt.nickName) segments.push(`Nick name: ${resolvedPrompt.nickName}`);
    if (resolvedPrompt.job) segments.push(`Job: ${resolvedPrompt.job}`);
    if (resolvedPrompt.description) segments.push(`Description: ${resolvedPrompt.description}`);
    segments.push('');
  }

  segments.push('[Instruction]');
  segments.push(resolvedPrompt.instruction || defaultInstruction);
  segments.push('');

  segments.push('[Response Principles]');
  segments.push('1. Try to provide more suitable responses based on the user\'s background.');
  segments.push('2. There is no need to proactively mention this background information.');
  segments.push(
    '3. When user asks a question, if you don\'t know, just answer directly that you don\'t know. Don\'t try to make up an answer.',
  );

  segments.push(`Session created time: ${new Date().toLocaleString()}`);

  return segments.join('\n');
}
