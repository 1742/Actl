import { AISSEToken } from '../types/common';

export function getGUID(): string {
  const guid = crypto.randomUUID();
  return guid.replace(/-/g, '');
}


export function getContrastColor(hex: string): string {
  // 去掉 #
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // 使用经典的 YIQ 公式计算亮度
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  // 亮度 > 128 返回黑色，否则返回白色 (这里阈值可以微调，比如 150)
  return yiq > 150 ? '#000000' : '#ffffff';
}


// 处理流式分片
export function parseSSEChunk(chunk: string): string[] {
  let buffer = chunk;
  const result: string[] = [];

  while (true) {
    const idx = buffer.indexOf(AISSEToken.Postfix);
    if (idx === -1) break; // 不完整帧

    const frame = buffer.slice(0, idx); // 完整数据帧
    buffer = buffer.slice(idx + AISSEToken.Postfix.length); // 移除当前帧

    if (frame.startsWith(AISSEToken.Prefix)) {
      const data = frame.slice(AISSEToken.Prefix.length); // 移除前缀
      result.push(data);
    }
  }

  return result;
}
