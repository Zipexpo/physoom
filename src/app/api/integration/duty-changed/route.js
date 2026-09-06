// Offisoom báo: ca trực của (các) user vừa thay đổi → Physoom đẩy NGAY ca trực
// của họ lên Google (đồng bộ chỉ-ca-trực, nhẹ). Kênh máy-với-máy, xác thực bằng
// khoá dùng chung OFFISOOM_SYNC_SECRET (header x-offisoom-secret) — cùng khoá
// Physoom↔Offisoom đang dùng cho freebusy/duties.
//
// Best-effort: user nào chưa nối Google thì bỏ qua; một user lỗi không chặn user
// khác. Trả tóm tắt để Offisoom log.
import { NextResponse } from "next/server";
import { syncUserToGoogle } from "@/lib/googleCalendar";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = async (request) => {
  const secret = process.env.OFFISOOM_SYNC_SECRET;
  const sent = request.headers.get("x-offisoom-secret");
  if (!secret || sent !== secret) {
    return NextResponse.json({ ok: false, message: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const raw = Array.isArray(body?.emails) ? body.emails : body?.email ? [body.email] : [];
  const emails = [...new Set(raw.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return NextResponse.json({ ok: true, synced: [] });

  const synced = [];
  for (const email of emails) {
    try {
      const r = await syncUserToGoogle(email, { dutiesOnly: true });
      synced.push({ email, ...r });
    } catch (e) {
      console.error("duty-changed sync failed for", email, e?.message);
      synced.push({ email, error: e?.message || "sync failed" });
    }
  }
  return NextResponse.json({ ok: true, synced });
};
