export interface ActionResult<T = unknown> {
  status: string;
  message?: string;
  data?: T;
}
