import { getSessionUser } from "../../../../lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  return user ? Response.json({ user }) : Response.json({ error: "unauthorized" }, { status: 401 });
}
