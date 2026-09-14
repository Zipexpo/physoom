"use server";
import { connectToDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import Course from "@/models/course";
import CalendarEvent from "@/models/calendarEvent";
import { auth } from "@/lib/auth";
import { dayVN, fetchHolidays, regenerateCourseSchedule } from "@/lib/reschedule";
import { syncTeachersToGoogle } from "@/lib/googleCalendar";

export const PUT = async (req, { params }) => {
  const { id } = params;
  const token = await auth();
  const user = token?.user;

  try {
    await connectToDb();

    if (user && user.isAdmin) {
      let courseData = await req.json();

      const old = await Course.findById(id).lean();
      if (!old) {
        return NextResponse.json({ message: "Course not found." }, { status: 404 });
      }

      // Update the course information
      const updatedCourse = await Course.findByIdAndUpdate(
        id,
        { $set: courseData },
        { new: true, runValidators: true }
      );

      const teachers = courseData.teacher_email !== undefined
        ? courseData.teacher_email
        : old.teacher_email || [];
      const startChanged =
        courseData.start_date !== undefined && dayVN(courseData.start_date) !== dayVN(old.start_date);

      if (old.isLock) {
        // Frozen: only a teacher correction (which doesn't move the schedule) is
        // applied to existing events; the dates stay put (unlock to reschedule).
        if (courseData.teacher_email !== undefined) {
          await CalendarEvent.updateMany(
            { course: updatedCourse._id, type: "class" },
            { $set: { teacher_email: teachers } }
          );
        }
      } else if (startChanged) {
        // Start date moved → rebuild the series from the new start (same weeks/
        // tiết/room) with the current teacher — reusing the importer's logic so
        // the timetable updates immediately.
        await regenerateCourseSchedule(id, new Date(courseData.start_date), teachers, await fetchHolidays());
      } else if (courseData.teacher_email !== undefined) {
        // Teacher only → update in place, keep the schedule.
        await CalendarEvent.updateMany(
          { course: updatedCourse._id, type: "class" },
          { $set: { teacher_email: teachers } }
        );
      }

      // Auto-đồng bộ Google cho giảng viên liên quan khi lịch/giảng viên đổi
      // (chỉnh lẻ một môn → nhẹ). Đồng bộ CẢ giảng viên MỚI lẫn CŨ: đổi giảng viên
      // thì lớp phải biến khỏi Google của người cũ và hiện ở người mới. Best-effort.
      const teacherChanged =
        courseData.teacher_email !== undefined &&
        JSON.stringify([...(old.teacher_email || [])].sort()) !==
          JSON.stringify([...(teachers || [])].sort());
      if (teacherChanged || startChanged) {
        try {
          await syncTeachersToGoogle([...(teachers || []), ...(old.teacher_email || [])]);
        } catch (e) {
          console.error("auto-sync after course edit failed:", e?.message);
        }
      }

      revalidateTag("course");
      revalidateTag("booking");
      return NextResponse.json(updatedCourse, { status: 200 });
    } else {
      return NextResponse.json(
        { success: false },
        {
          status: 401,
        }
      );
    }
  } catch (error) {
    console.error("Failed to update course:", error);

    if (error.code === 11000) {
      return NextResponse.json(
        {
          message:
            "Combination of course_id, class_id and course_id_extend must be unique.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { message: "Internal server error." },
      { status: 500 }
    );
  }
};
