import { NextRequest, NextResponse } from "next/server";

import { authErrorResponse } from "@/lib/auth/http";
import { requireAuth } from "@/lib/auth/require-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    return NextResponse.json({ user });
  } catch (error) {
    return authErrorResponse(error);
  }
}
