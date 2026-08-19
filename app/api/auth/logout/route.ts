import { clearSessionCookie, isSecureRequest, revokeSession } from "../../../../lib/auth";

export async function POST(request: Request) {
  await revokeSession(request);
  const response = Response.json({ ok: true });
  response.headers.set("Set-Cookie", clearSessionCookie(isSecureRequest(request)));
  return response;
}
