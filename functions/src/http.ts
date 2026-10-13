import type { Request, Response } from "express";
import { auth } from "./firebase.js";

export function applyCors(request: Request, response: Response): boolean {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") {
    response.status(204).send("");
    return true;
  }
  return false;
}

export async function requireUserId(request: Request): Promise<string> {
  const header = request.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "unauthenticated", "Missing bearer token");
  }
  const decoded = await auth.verifyIdToken(header.slice("Bearer ".length));
  return decoded.uid;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(response: Response, error: unknown): void {
  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: error.code,
      message: error.message,
    });
    return;
  }
  console.error(error);
  response.status(500).json({
    error: "internal",
    message: "Unexpected server error",
  });
}
