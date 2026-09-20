import { NextRequest, NextResponse } from "next/server";

import { clearSessionCookie, extractSessionToken } from "@/lib/auth/session";
import { getAuthStore } from "@/lib/auth/store";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const token = extractSessionToken(request);
  if (token) {
    await getAuthStore().deleteSession(token);
  }
  await clearSessionCookie();
  return NextResponse.json({ loggedOut: true });
}
