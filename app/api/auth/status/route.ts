import { NextResponse } from "next/server";

import { getAuthStoreMode, isAuthStoreUsable } from "@/lib/auth/feature-flags";

export const dynamic = "force-dynamic";

// 인증이 필요 없는 공개 엔드포인트. 사용자별 정보를 담지 않으며, 클라이언트가
// 로그인/회원가입 폼을 보여줄지 "준비 중" 안내를 보여줄지 판단하는 데만 쓴다.
export async function GET() {
  const response = NextResponse.json({ mode: getAuthStoreMode(), enabled: isAuthStoreUsable() });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
