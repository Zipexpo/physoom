import { connectToDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import CalendarEvent from "@/models/calendarEvent";
import Course from "@/models/course";
import User from "@/models/user";
import mongoose from "mongoose";
import { includes } from "lodash";
import { auth } from "@/lib/auth";
import moment from "moment";
import { defaultGridLT, defaultGridNVC } from "@/lib/ulti";
import { getOccurrences } from "@/lib/occurrences";
import { canManageClasses } from "@/lib/scope";
import { syncTeachersToGoogle } from "@/lib/googleCalendar";

// Scheduling an imported term inserts many series; allow more than the default.
export const maxDuration = 60;

/**
 * Convert a JS Date to minutes from midnight
 */
function dateToMinutes(date) {
  const d = new Date(date);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * JS day of week (0=Sun) → booking weekday convention (2=Mon…7=Sat, 8=Sun)
 */
function jsWeekdayToBooking(jsDay) {
  if (jsDay === 0) return 8; // Sunday
  return jsDay + 1; // Mon=2 … Sat=7
}

/**
 * Maps minutes from midnight back to a grid label (Tiết)
 */
function minutesToLabel(minutes, gridData) {
  for (let slot of gridData) {
    // Check if minutes fall within start and end (with small buffer for floating point)
    if (minutes >= slot.timeData[0] - 1 && minutes < slot.timeData[1] - 1) {
      return slot.label;
    }
    // Check if exactly at the end
    if (Math.abs(minutes - slot.timeData[1]) < 2) return slot.label;
  }
  return Math.floor(minutes / 45); // Fallback
}

const weekdayNames = { 2: "Thứ 2", 3: "Thứ 3", 4: "Thứ 4", 5: "Thứ 5", 6: "Thứ 6", 7: "Thứ 7", 8: "Chủ nhật" };

// getOccurrences moved to @/lib/occurrences (shared with the term-reschedule
// cascade so both place weekly sessions identically).

export const POST = async (request) => {
  const session = await auth();
  const user = session?.user;
  try {
    await connectToDb();
    let data = await request.json();
    const overrideLocked = new URL(request.url).searchParams.get("overrideLocked") === "true";

    const isAdmin = user && user.isAdmin;

    if (!isAdmin) {
      if (user && data[0] && includes(data[0].teacher_email, user.email)) {
        data = [data[0]];
      } else {
        return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
      }
    }

    const holidays = await CalendarEvent.find({ type: 'holiday', status: 'approved' }).lean();
    const allConflicts = [];
    const allCreated = [];

    // Resolve lecturer email → display name (cached) so a teacher clash names the
    // lecturer, not just their email.
    const nameCache = new Map();
    const resolveNames = async (emails) => {
      const list = [...new Set((emails || []).map((e) => String(e).toLowerCase()).filter(Boolean))];
      const missing = list.filter((e) => !nameCache.has(e));
      if (missing.length) {
        const users = await User.find({ email: { $in: missing } }, "email name").lean();
        const byEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u.name]));
        missing.forEach((e) => nameCache.set(e, byEmail.get(e) || e));
      }
      return list.map((e) => nameCache.get(e));
    };

    for (let d of data) {
      const courseId = d.course?._id || d.course;
      const roomId = d.room?._id || d.room;
      const status = isAdmin ? 'approved' : 'pending';
      const series_id = d.series_id || new mongoose.Types.ObjectId().toString();

      const { weekday, start_time, end_time } = d.time_slot;

      // Require term dates — no arbitrary defaults
      const start_date = d.time_slot.start_date;
      const end_date = d.time_slot.end_date;
      if (!start_date || !end_date) {
        allConflicts.push({
          course: courseId,
          reason: "Missing start_date or end_date. Please select a term."
        });
        continue;
      }

      // minutes are already stored as minutes-from-midnight
      const start_minutes = start_time;
      const end_minutes = end_time;

      // Location comes from the booking payload or room
      const location = d.room?.location || d.location || "NVC";
      const grid = location === "LT" ? defaultGridLT : defaultGridNVC;

      // Is this an overwrite? A course already scheduled at THIS exact slot
      // (weekday + start tiết) is being re-scheduled (e.g. a re-import), not
      // newly booked — report it as "ghi đè", NOT a room/overlap conflict.
      // The slot must include start_time: one subject code (Mã mh) can carry a
      // lecture AND its "Bài tập"/"Thực hành" on the SAME weekday at different
      // tiết, all under one course — those are distinct sessions, not overwrites
      // of each other.
      const prevCount = await CalendarEvent.countDocuments({
        course: courseId,
        type: 'class',
        weekday,
        'time_slot.start_time': start_time,
      });
      const isOverwrite = prevCount > 0;

      // IMPORTANT: do NOT delete the old series yet. A re-schedule that turns out
      // to have zero valid occurrences (all on holidays, or every session clashes)
      // must NOT wipe the existing schedule — that silently pushed the course back
      // to "chờ xếp". We generate + validate first, and only delete right before
      // inserting the replacement (see below). The conflict queries all exclude
      // `course: { $ne: courseId }`, so the not-yet-deleted old events never
      // self-conflict.

      // Generate occurrences
      const occurrences = getOccurrences(start_date, end_date, weekday, start_minutes, end_minutes, holidays);

      if (occurrences.length === 0) {
        allConflicts.push({ course: courseId, reason: "No valid occurrences (all fall on holidays?)" });
        continue;
      }

      // Class conflict: other courses sharing this class's id must not overlap
      // (a class of students can't sit two subjects at once).
      let classConflictCourseIds = [];
      let classIds = Array.isArray(d.course?.class_id)
        ? d.course.class_id
        : (d.course?.class_id ? [d.course.class_id] : null);
      if (!classIds) {
        const c = await Course.findById(courseId, "class_id").lean();
        classIds = Array.isArray(c?.class_id) ? c.class_id : (c?.class_id ? [c.class_id] : []);
      }

      // Locked course: frozen unless the import explicitly overrides ("Ghi đè
      // môn đã khóa"). Otherwise skip + report so the admin knows it wasn't updated.
      const lockDoc = d.course?.isLock !== undefined ? d.course : await Course.findById(courseId, "isLock").lean();
      if (lockDoc?.isLock && !overrideLocked) {
        allConflicts.push({ course: courseId, reason: "Môn đang khoá — lịch được giữ nguyên (mở khoá để đổi)." });
        continue;
      }

      // Scope enforcement: a scoped admin may only schedule classes in their
      // scope. Reject (don't place) out-of-scope courses with a clear reason.
      if (isAdmin && !canManageClasses(user, classIds)) {
        allConflicts.push({
          course: courseId,
          reason: `Ngoài phạm vi quản lý của bạn (${(classIds || []).join(", ")}) — không được xếp lịch.`,
        });
        continue;
      }

      if (classIds?.length) {
        const others = await Course.find(
          { class_id: { $in: classIds }, _id: { $ne: courseId } },
          "_id"
        ).lean();
        classConflictCourseIds = others.map((c) => c._id);
      }

      // Conflict detection across all occurrences
      const courseConflicts = [];
      const validOccurrences = [];

      // Label a conflicting event by course name AND class code — many classes
      // share a course title, so the class_id disambiguates which one clashed.
      const conflictLabel = (ev) => {
        const cls = ev?.course?.class_id;
        const clsStr = Array.isArray(cls) ? cls.filter(Boolean).join(", ") : (cls || "");
        const t = ev?.title || ev?.course?.title || "?";
        return clsStr ? `"${t}" [${clsStr}]` : `"${t}"`;
      };
      // Tiết labels must use the CONFLICTING event's own campus grid — NVC and LT
      // have different period times, so labelling a cross-campus clash with this
      // course's grid would show the wrong tiết.
      const gridDataOf = (ev) =>
        ((ev?.location || ev?.room?.location || location) === "LT" ? defaultGridLT : defaultGridNVC).data;

      // Block against both approved and pending bookings so two requests can't
      // silently claim the same room/teacher slot (which would collide once
      // both get approved). Rejected/cancelled events don't block.
      const BLOCKING = { $in: ['approved', 'pending'] };

      // Batch conflict detection: fetch every blocking event overlapping the
      // whole term window ONCE (3 queries), then test each occurrence in memory.
      // Previously this ran 3 DB queries PER occurrence — dozens per course and
      // >1000 sequential Atlas round-trips for a full import, which made the
      // "Xếp lịch" step crawl and look frozen.
      const winStart = occurrences.reduce((m, o) => (o.start < m ? o.start : m), occurrences[0].start);
      const winEnd = occurrences.reduce((m, o) => (o.end > m ? o.end : m), occurrences[0].end);
      const winOverlap = { start: { $lt: winEnd }, end: { $gt: winStart } };
      const [roomBlocking, teacherBlocking, classBlocking] = await Promise.all([
        CalendarEvent.find({
          room: roomId, course: { $ne: courseId }, status: BLOCKING, isCancelled: { $ne: true }, ...winOverlap,
        }).populate("course", "class_id title").lean(),
        d.teacher_email?.length
          ? CalendarEvent.find({
              teacher_email: { $in: d.teacher_email }, course: { $ne: courseId }, status: BLOCKING, isCancelled: { $ne: true }, ...winOverlap,
            }).populate("course", "class_id title").lean()
          : Promise.resolve([]),
        classConflictCourseIds.length
          ? CalendarEvent.find({
              course: { $in: classConflictCourseIds }, type: 'class', status: BLOCKING, isCancelled: { $ne: true }, ...winOverlap,
            }).populate("course", "class_id title").lean()
          : Promise.resolve([]),
      ]);
      // In-memory overlap test (same semantics as the old per-occurrence query).
      const overlaps = (arr, occ) => arr.find((e) => e.start < occ.end && e.end > occ.start);

      for (const occ of occurrences) {
        const roomOverlap = overlaps(roomBlocking, occ);

        if (roomOverlap) {
          const dayStr = weekdayNames[roomOverlap.weekday] || `Thứ ${roomOverlap.weekday}`;
          const oGrid = gridDataOf(roomOverlap);
          const sLabel = minutesToLabel(roomOverlap.time_slot?.start_time || 0, oGrid);
          const eLabel = minutesToLabel(roomOverlap.time_slot?.end_time || 0, oGrid);
          const when = moment(occ.start).utcOffset(420).format("DD/MM/YYYY");
          courseConflicts.push({
            at: occ.start,
            reason: `PHÒNG trùng với ${conflictLabel(roomOverlap)} — ${dayStr} tiết ${sLabel}–${eLabel} (ngày ${when})`
          });
          continue;
        }

        if (d.teacher_email?.length) {
          const teacherOverlap = overlaps(teacherBlocking, occ);

          if (teacherOverlap) {
            const dayStr = weekdayNames[teacherOverlap.weekday] || `Thứ ${teacherOverlap.weekday}`;
            const oGrid = gridDataOf(teacherOverlap);
            const sLabel = minutesToLabel(teacherOverlap.time_slot?.start_time || 0, oGrid);
            const eLabel = minutesToLabel(teacherOverlap.time_slot?.end_time || 0, oGrid);
            // Name the double-booked lecturer(s): those shared by both bookings.
            const clashEmails = (d.teacher_email || []).filter((e) =>
              (teacherOverlap.teacher_email || []).some((x) => String(x).toLowerCase() === String(e).toLowerCase())
            );
            const names = await resolveNames(clashEmails.length ? clashEmails : d.teacher_email);
            const who = names.filter(Boolean).join(", ");
            const when = moment(occ.start).utcOffset(420).format("DD/MM/YYYY");
            courseConflicts.push({
              at: occ.start,
              reason: `GIẢNG VIÊN ${who} trùng với ${conflictLabel(teacherOverlap)} — ${dayStr} tiết ${sLabel}–${eLabel} (ngày ${when})`
            });
            continue;
          }
        }

        if (classConflictCourseIds.length) {
          const classOverlap = overlaps(classBlocking, occ);

          if (classOverlap) {
            const dayStr = weekdayNames[classOverlap.weekday] || `Thứ ${classOverlap.weekday}`;
            const oGrid = gridDataOf(classOverlap);
            const sLabel = minutesToLabel(classOverlap.time_slot?.start_time || 0, oGrid);
            const eLabel = minutesToLabel(classOverlap.time_slot?.end_time || 0, oGrid);
            const when = moment(occ.start).utcOffset(420).format("DD/MM/YYYY");
            courseConflicts.push({
              at: occ.start,
              reason: `LỚP trùng với ${conflictLabel(classOverlap)} — ${dayStr} tiết ${sLabel}–${eLabel} (ngày ${when})`
            });
            continue;
          }
        }

        validOccurrences.push(occ);
      }

      if (courseConflicts.length > 0) {
        allConflicts.push({
          course: courseId,
          conflictCount: courseConflicts.length,
          totalOccurrences: occurrences.length,
          examples: courseConflicts.slice(0, 3)
        });
      }

      if (validOccurrences.length === 0) {
        continue; // Skip entirely conflicted series
      }

      // Build event docs — store weekday + time_slot for grid queries
      const eventDocs = validOccurrences.map(occ => ({
        title: d.course?.title || "Course Booking",
        type: 'class',
        status,
        start: occ.start,
        end: occ.end,
        course: courseId,
        room: roomId,
        teacher_email: d.teacher_email || [],
        series_id,
        original_start: occ.start,
        weekday,
        location,
        time_slot: {
          start_time: start_minutes,
          end_time: end_minutes
        }
      }));

      // Now that we KNOW there is a clash-free set to insert, replace the old
      // schedule. Deferring the delete to here makes a re-schedule non-destructive:
      // if the new placement had failed (no valid occurrences), we'd have skipped
      // above and the old series would still be intact.
      if (d.series_id) {
        await CalendarEvent.deleteMany({ series_id: d.series_id });
      } else {
        // Fallback or new booking: replace only the SAME slot (weekday + start
        // tiết) for this course. Scoping by start_time is critical — a course
        // with a lecture and its bài tập/thực hành on the same weekday must not
        // have one session delete the other (which silently dropped sessions and
        // caused phantom conflicts on re-import).
        await CalendarEvent.deleteMany({
          course: courseId,
          type: 'class',
          weekday: weekday,
          'time_slot.start_time': start_time,
        });
      }

      await CalendarEvent.insertMany(eventDocs);
      allCreated.push({
        course: courseId,
        series_id,
        created: validOccurrences.length,
        overwritten: isOverwrite, // replaced this course's own previous schedule
      });

      // Persist the scheduling window onto the course so it's no longer "chưa
      // gắn học kì": record the chosen term, the start date, and the session
      // count (= sessions in the window). Admin-only; a lecturer's pending
      // request must not rewrite the course's canonical term/dates.
      if (isAdmin) {
        const courseUpdate = {
          start_date: new Date(start_date),
          duration: occurrences.length,
        };
        if (d.term) courseUpdate.term = d.term;
        try {
          await Course.updateOne({ _id: courseId }, { $set: courseUpdate });
        } catch (e) {
          console.error("persist course term/window failed:", e);
        }
      }

      // The course now has a real, clash-free schedule for this series, so any
      // stale health warnings are obsolete — clear them here too (not just on
      // import) so scheduling manually also makes the ⚠ disappear. Only clears
      // when THIS placement had no conflict; a genuinely conflicting import path
      // still records its own "Trùng lịch" warning afterwards.
      if (courseConflicts.length === 0) {
        try {
          await Course.updateOne(
            { _id: courseId },
            { $pull: { warnings: { $regex: /(chưa xếp|Thiếu giảng viên|GV chưa có|Trùng lịch)/ } } }
          );
        } catch (e) {
          console.error("clear warnings failed:", e);
        }
      }
    }

    revalidateTag("booking");

    // Đồng bộ Google tự động — CHỈ khi CHỈNH LẺ một lớp (dời lịch / đổi phòng /
    // xếp một môn): data 1 phần tử. Import/xếp cả học kỳ (nhiều phần tử) thì KHÔNG
    // auto (tránh dội quota) — giảng viên tự bấm "Đồng bộ ngay". Best-effort, chỉ
    // đẩy cho giảng viên của môn vừa đổi.
    if (data.length === 1) {
      try {
        await syncTeachersToGoogle(data[0]?.teacher_email || []);
      } catch (e) {
        console.error("auto-sync after single reschedule failed:", e?.message);
      }
    }

    return NextResponse.json(
      { success: true, created: allCreated, conflicts: allConflicts },
      { status: 201 }
    );
  } catch (err) {
    console.error(err);
    return NextResponse.json({ success: false, message: "Internal Error" }, { status: 400 });
  }
};
