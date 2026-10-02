//#region 设置

export interface RuntimeConfig {
  agentUrl: string;
  agentToken: string;
}

//#endregion


export interface ActionResult<T = unknown> {
  status: string;
  message?: string;
  data?: T;
}

//#region 推理

export interface DBPrompts {
  id?: number;
  userId: number;
  nickName?: string;
  job?: string;
  description?: string;
  instruction?: string;
}

//#endregion


//#region 流式传输

export const AISSEToken = {
  Prefix: 'data: ',
  Postfix: '\n\n',
  DONE: '[DONE]',
} as const;

export interface AISSEObject {
  event: string;
  data?: string;
}

//#endregion
