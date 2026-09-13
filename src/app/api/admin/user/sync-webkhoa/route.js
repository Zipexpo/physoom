import { connectToDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import User from "@/models/user";
import { auth } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/scope";
import { fetchWebkhoaStaff, webkhoaConfigured } from "@/lib/webkhoa";

// Chạy có thể lâu (kéo toàn bộ roster + bulk upsert).
export const maxDuration = 60;

// POST /api/admin/user/sync-webkhoa — KÉO danh sách nhân sự từ web Khoa về.
//
// Hai chế độ (body JSON):
//   { dryRun: true } → CHỈ XEM TRƯỚC: tính sẽ tạo/cập nhật/bỏ qua ai, KHÔNG ghi DB.
//   {}               → ÁP DỤNG: ghi thật vào DB.
//
// QUAN TRỌNG — chỉ đồng bộ ĐỊNH DANH: email + tên (+ MSCB). TUYỆT ĐỐI không đụng
// isAdmin / isSuperAdmin / adminScope / rank / degree / department: chức vị và
// quyền do Physoom tự giữ. Người đã nghỉ (removed) thì bỏ qua, không xoá người cũ.
export const POST = async (request) => {
  const session = await auth();
  if (!isSuperAdmin(session?.user))
    return NextResponse.json({ success: false, message: "Chỉ super admin" }, { status: 401 });
  if (!webkhoaConfigured())
    return NextResponse.json(
      { success: false, message: "Chưa cấu hình WEBKHOA_BASE_URL / WEBKHOA_SYNC_SECRET" },
      { status: 400 }
    );

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;

  try {
    await connectToDb();
    const data = await fetchWebkhoaStaff(); // toàn bộ (không truyền since)
    const items = Array.isArray(data?.items) ? data.items : [];

    // Ảnh chụp user hiện có để so sánh (email → {name, teacher_id}).
    const existing = await User.find({}, "email name teacher_id").lean();
    const byEmail = new Map(
      existing.map((u) => [String(u.email || "").toLowerCase(), u])
    );

    const toCreate = [];   // { email, name, teacher_id }
    const toUpdate = [];    // { email, name, teacher_id, changes }
    let unchanged = 0;
    let skipped = 0;

    for (const it of items) {
      const email = String(it?.email || "").trim().toLowerCase();
      if (!email) { skipped++; continue; }
      if (it?.removed === true || it?.active === false) { skipped++; continue; }

      const name = it.name ? String(it.name).trim() : "";
      const teacher_id = it.teacherId ? String(it.teacherId).trim() : "";
      const cur = byEmail.get(email);

      if (!cur) {
        toCreate.push({ email, name, teacher_id });
        continue;
      }
      const changes = {};
      // TÊN: chỉ ĐIỀN khi Physoom đang trống, KHÔNG ghi đè tên đã có. Tên bên web
      // khoa hay bị đảo thứ tự (Võ Hoàng Nguyên → Nguyên Võ Hoàng) hoặc mất dấu
      // (Lê Nguyễn Hoa Tiên → Le Nguyen Hoa Tien) — tệ hơn tên đúng của Physoom.
      if (name && !(cur.name || "").trim())
        changes.name = { from: cur.name || "", to: name };
      if (teacher_id && teacher_id !== (cur.teacher_id || ""))
        changes.teacher_id = { from: cur.teacher_id || "", to: teacher_id };
      if (Object.keys(changes).length) toUpdate.push({ email, name, teacher_id, changes });
      else unchanged++;
    }

    // XEM TRƯỚC: trả kế hoạch, không ghi gì.
    if (dryRun) {
      return NextResponse.json({
        success: true,
        preview: true,
        total: items.length,
        counts: {
          create: toCreate.length,
          update: toUpdate.length,
          unchanged,
          skipped,
        },
        toCreate,
        toUpdate,
      });
    }

    // ÁP DỤNG: ghi đúng theo kế hoạch (chỉ động vào người thật sự tạo/đổi).
    const ops = [];
    for (const c of toCreate) {
      const set = {};
      if (c.name) set.name = c.name;
      if (c.teacher_id) set.teacher_id = c.teacher_id;
      const update = { $setOnInsert: { email: c.email } };
      if (Object.keys(set).length) update.$set = set;
      ops.push({ updateOne: { filter: { email: c.email }, update, upsert: true } });
    }
    for (const u of toUpdate) {
      const set = {};
      if (u.changes.name) set.name = u.changes.name.to;
      if (u.changes.teacher_id) set.teacher_id = u.changes.teacher_id.to;
      ops.push({ updateOne: { filter: { email: u.email }, update: { $set: set } } });
    }

    let created = 0, updated = 0;
    if (ops.length) {
      const r = await User.bulkWrite(ops, { ordered: false });
      created = r.upsertedCount || 0;
      updated = r.modifiedCount || 0;
    }

    return NextResponse.json({
      success: true,
      total: items.length,
      created,
      updated,
      skipped,
      unchanged,
    });
  } catch (e) {
    console.error("sync-webkhoa failed", e);
    return NextResponse.json({ success: false, message: e.message }, { status: 502 });
  }
};
