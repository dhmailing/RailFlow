import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { watchErrorResponse } from "@/lib/watch/http";
import { getWatchJob } from "@/lib/watch/store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(request);
    const { id } = await context.params;
    return NextResponse.json({ job: getWatchJob(id, user.id) });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
