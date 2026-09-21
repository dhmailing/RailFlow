import { NextRequest } from "next/server";

import { authErrorResponse, authJson } from "@/lib/auth/http";
import { requireAuth } from "@/lib/auth/require-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    return authJson({ user });
  } catch (error) {
    return authErrorResponse(error);
  }
}
