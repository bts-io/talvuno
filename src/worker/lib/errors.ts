import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Thrown anywhere in a route; app.onError turns it into `{ error, message }` with this status. */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
