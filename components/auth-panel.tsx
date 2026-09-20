"use client";

import { useState } from "react";
import { LoaderCircle, LogOut, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export type AuthUser = { id: string; email: string; createdAt: string };

export default function AuthPanel({
  user,
  loading,
  onAuthChanged,
}: {
  user: AuthUser | null;
  loading: boolean;
  onAuthChanged: (user: AuthUser | null) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const submit = async () => {
    if (!email || password.length < 8) {
      toast.error("이메일과 8자 이상의 비밀번호를 입력해주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json()) as { user?: AuthUser; error?: { message: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "처리하지 못했습니다.");
      toast.success(mode === "login" ? "로그인했어요" : "RailFlow 계정을 만들었어요");
      setPassword("");
      onAuthChanged(payload.user ?? null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "처리하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    setSubmitting(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      onAuthChanged(null);
      toast("로그아웃했어요");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteAccount = async () => {
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/account", { method: "DELETE" });
      if (!response.ok) throw new Error("계정을 삭제하지 못했습니다.");
      onAuthChanged(null);
      setConfirmingDelete(false);
      toast("계정과 감시 작업 데이터를 삭제했어요");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "계정을 삭제하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div role="status" className="rounded-[26px] border border-white/10 bg-[#111] p-5 text-sm text-white/50">
        <LoaderCircle className="mb-2 size-5 animate-spin text-orange-400" /> 로그인 상태 확인 중
      </div>
    );
  }

  if (user) {
    return (
      <div className="rounded-[26px] border border-white/10 bg-[#111] p-5">
        <p className="text-sm text-white/42">RailFlow 계정</p>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-[#ff8a1f]/12 text-[#ff8a1f]">
              <ShieldCheck className="size-6" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-extrabold">{user.email}</p>
              <p className="mt-1 text-xs text-white/38">취소표 감시 작업은 이 계정에만 저장됩니다.</p>
            </div>
          </div>
          <Button variant="outline" disabled={submitting} onClick={logout} className="rounded-xl border-white/12 bg-transparent text-white/70">
            <LogOut className="size-4" /> 로그아웃
          </Button>
        </div>
        <div className="mt-4 border-t border-white/[0.07] pt-4">
          {confirmingDelete ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-5 text-orange-300">계정과 모든 감시 작업·알림 기록·알림 수신 기기가 삭제됩니다. 되돌릴 수 없어요.</p>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" disabled={submitting} onClick={() => setConfirmingDelete(false)} className="text-white/50">취소</Button>
                <Button size="sm" disabled={submitting} onClick={deleteAccount} className="bg-red-500/90 text-white hover:bg-red-500">삭제 확정</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <Button variant="ghost" disabled={submitting} onClick={() => setConfirmingDelete(true)} className="text-xs text-white/40 hover:text-red-300">
                <Trash2 className="size-3.5" /> 계정 삭제
              </Button>
              <a href="/privacy" className="text-[11px] text-white/30 underline">개인정보처리방침</a>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[26px] border border-white/10 bg-[#111] p-5">
      <p className="text-sm text-white/42">RailFlow 계정</p>
      <div className="mt-3 flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/[0.05] text-white/40">
          <UserRound className="size-6" />
        </span>
        <div>
          <p className="font-extrabold">로그인이 필요합니다</p>
          <p className="mt-1 text-xs text-white/38">취소표 감시를 등록하려면 RailFlow 계정으로 로그인해주세요.</p>
        </div>
      </div>

      <div className="mt-4 flex gap-2 rounded-xl bg-black/30 p-1">
        <button type="button" onClick={() => setMode("login")} className={`flex-1 rounded-lg py-2 text-sm font-bold transition ${mode === "login" ? "bg-[#ff8a1f] text-black" : "text-white/50"}`}>로그인</button>
        <button type="button" onClick={() => setMode("signup")} className={`flex-1 rounded-lg py-2 text-sm font-bold transition ${mode === "signup" ? "bg-[#ff8a1f] text-black" : "text-white/50"}`}>회원가입</button>
      </div>

      <div className="mt-4 space-y-3">
        <input type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl border border-white/10 bg-black/35 p-3 text-white" />
        <input type="password" placeholder="비밀번호 (8자 이상)" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-xl border border-white/10 bg-black/35 p-3 text-white" />
        <Button type="button" disabled={submitting} onClick={submit} className="h-11 w-full rounded-xl bg-[#ff8a1f] font-extrabold text-black hover:bg-[#ff9d45]">
          {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null} {mode === "login" ? "로그인" : "RailFlow 계정 만들기"}
        </Button>
      </div>
      <p className="mt-3 text-[11px] leading-5 text-white/32">
        이 계정은 RailFlow 자체 계정입니다. 코레일 계정과 다르며, 코레일 아이디·비밀번호를 요청하거나 저장하지 않습니다.{" "}
        <a href="/privacy" className="underline">개인정보처리방침</a>
      </p>
    </div>
  );
}
