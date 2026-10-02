import { type Request, type Response } from "express";

export function getHealth(_request: Request, response: Response): void {
  response.json({
    ok: true,
  });
}
