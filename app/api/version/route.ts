import { APP_VERSION } from "../../../lib/app-version";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { version: APP_VERSION },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    },
  );
}
