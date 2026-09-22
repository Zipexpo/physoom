"use server";
import { connectToDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import CalendarEvent from "@/models/calendarEvent";
import Course from "@/models/course";
import { auth } from "@/lib/auth";
import { syncTeachersToGoogle } from "@/lib/googleCalendar";

export const POST = async (request) => {
  const session = await auth();
  const user = session?.user;
  if (!user || !user.isAdmin) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    await connectToDb();
    const { id, series_id, start, end, classIds, courseKeys, mode, overrideLocked } = await request.json();

    if (!mode) {
      return NextResponse.json({ success: false, message: "Missing deletion mode" }, { status: 400 });
    }

    let result;
    // Auto-đồng bộ Google CHỈ cho các mode CHỈNH LẺ một môn/series (single/future/
    // series/course) — thu email giảng viên TRƯỚC khi xoá rồi đồng bộ SAU, để bản
    // vừa xoá biến khỏi Google (tránh trùng khi đổi phòng: bản cũ không bị gỡ).
    // Mode 'class'/'courseKeys' là xoá hàng loạt khi re-import → giữ THỦ CÔNG.
    let syncEmails = null;
    const teachersOf = async (filter) => {
      const evs = await CalendarEvent.find(filter, "teacher_email").lean();
      return [...new Set(evs.flatMap((e) => e.teacher_email || []))];
    };
    if (mode === 'single') {
      // Delete only the specific instance
      syncEmails = await teachersOf({ _id: id });
      result = await CalendarEvent.deleteOne({ _id: id });
    } else if (mode === 'future') {
      // Delete from this point forward in the series
      if (!series_id || !start) {
        return NextResponse.json({ success: false, message: "Missing series_id or start date for future deletion" }, { status: 400 });
      }
      const q = { series_id, start: { $gte: new Date(start) } };
      syncEmails = await teachersOf(q);
      result = await CalendarEvent.deleteMany(q);
    } else if (mode === 'series') {
      // Delete the entire series
      if (!series_id) {
        return NextResponse.json({ success: false, message: "Missing series_id for series deletion" }, { status: 400 });
      }
      syncEmails = await teachersOf({ series_id });
      result = await CalendarEvent.deleteMany({ series_id });
    } else if (mode === 'course') {
      // Delete ALL series for a given course (clears the course's "Planned" status entirely)
      if (!id) {
        return NextResponse.json({ success: false, message: "Missing course id for course deletion" }, { status: 400 });
      }
      // A LOCKED course's schedule is protected — unlock it first.
      const co = await Course.findById(id, "isLock").lean();
      if (co?.isLock && !overrideLocked) {
        return NextResponse.json(
          { success: false, locked: true, message: "Môn đang khoá — mở khoá trước khi xoá/đổi lịch." },
          { status: 409 }
        );
      }
      syncEmails = await teachersOf({ course: id, type: 'class' });
      result = await CalendarEvent.deleteMany({ course: id, type: 'class' });
    } else if (mode === 'class') {
      // Delete ALL class schedules for the given class code(s), across EVERY
      // course document that shares those class ids — including duplicate/old
      // course docs left behind by earlier imports. This lets a re-import fully
      // REPLACE the schedule of the classes it contains, independent of any
      // stale leftover data (which used to cause phantom "trùng lịch").
      // Optionally scoped to a term window [start, end] so importing one term
      // does not wipe another term's schedule for the same class code.
      const ids = Array.isArray(classIds) ? classIds : classIds ? [classIds] : [];
      if (!ids.length) {
        return NextResponse.json({ success: false, message: "Missing classIds for class deletion" }, { status: 400 });
      }
      // Never wipe a locked course's schedule.
      const courses = await Course.find({ class_id: { $in: ids }, ...(overrideLocked ? {} : { isLock: { $ne: true } }) }, "_id").lean();
      const courseIds = courses.map((c) => c._id);
      const q = { course: { $in: courseIds }, type: 'class' };
      if (start && end) {
        q.start = { $gte: new Date(start), $lte: new Date(end) };
      }
      result = await CalendarEvent.deleteMany(q);
    } else if (mode === 'courseKeys') {
      // Delete class events for ONLY the specific courses in this import — each
      // identified by (course_id + one of its class_id), across duplicate course
      // docs sharing that identity. Unlike mode 'class' this does NOT touch OTHER
      // courses of the same class, so importing a single course no longer sends
      // that class's other courses to "chờ xếp".
      const keys = Array.isArray(courseKeys) ? courseKeys : [];
      const or = keys
        .map((k) => {
          const cls = Array.isArray(k.class_id) ? k.class_id : k.class_id ? [k.class_id] : [];
          if (!k.course_id || !cls.length) return null;
          const cond = {
            course_id: String(k.course_id).trim(),
            class_id: { $in: cls.map((s) => String(s).trim()) },
          };
          // Course identity is (course_id + course_id_extend + class). Match the
          // extend too so we never touch a sibling that shares only code+class.
          const ext = k.course_id_extend;
          cond.course_id_extend =
            ext === undefined || ext === null || ext === "" ? { $in: [null, ""] } : String(ext).trim();
          return cond;
        })
        .filter(Boolean);
      if (!or.length) {
        return NextResponse.json({ success: false, message: "Missing courseKeys for deletion" }, { status: 400 });
      }
      // Never wipe a locked course's schedule (re-import preserves locked courses).
      const courses = await Course.find({ $or: or, ...(overrideLocked ? {} : { isLock: { $ne: true } }) }, "_id").lean();
      const ckIds = courses.map((c) => c._id);
      result = await CalendarEvent.deleteMany({ course: { $in: ckIds }, type: "class" });
    } else {
      return NextResponse.json({ success: false, message: "Invalid deletion mode" }, { status: 400 });
    }

    revalidateTag("booking");

    // Gỡ các buổi vừa xoá khỏi Google cho giảng viên liên quan (chỉ mode chỉnh lẻ).
    // Best-effort: ai chưa nối Google thì bỏ qua.
    if (syncEmails?.length) {
      try {
        await syncTeachersToGoogle(syncEmails);
      } catch (e) {
        console.error("auto-sync after delete failed:", e?.message);
      }
    }

    return NextResponse.json({
      success: true,
      message: `Successfully deleted using ${mode} mode`,
      count: result.deletedCount
    });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ success: false, message: "Internal Error" }, { status: 500 });
  }
};
