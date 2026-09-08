import { connectToDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import CalendarEvent from "@/models/calendarEvent";
import Room from "@/models/room";
import User from "@/models/user";
import { auth } from "@/lib/auth";
import { notify } from "@/lib/notify";
import { pushEventToGoogle } from "@/lib/googleCalendar";
import { normalizeDepartment } from "@/lib/departments";
import moment from "moment";

// Immediate event sync can hit the Google API for several participants — allow
// a little more time than the default so the awaited push completes reliably.
export const maxDuration = 60;

export const GET = async (request) => {
  try {
    const session = await auth();
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get("room");

    await connectToDb();

    const mine = searchParams.get("mine");
    if (mine === "true") {
      // Return all events where the current user is a teacher, host, or attendee
      if (!session?.user) {
        return NextResponse.json([], { status: 401 });
      }
      const email = session.user.email;
      const events = await CalendarEvent.find({
        type: { $ne: "class" },
        $or: [
          { teacher_email: email },
          { host: email },
          { attendees: email },
        ],
      })
        .populate("room")
        .sort({ start: -1 });
      return NextResponse.json(events);
    }

    if (!roomId) return NextResponse.json([], { status: 400 });

    const events = await CalendarEvent.find({
      room: roomId,
      type: { $ne: "class" },
    })
      .populate("room")
      .sort({ start: 1 });

    return NextResponse.json(events);
  } catch (err) {
    console.log(err);
    return NextResponse.json([], { status: 400 });
  }
};

export const POST = async (request) => {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ success: false, message: "Login required" }, { status: 401 });
  }

  try {
    await connectToDb();
    const { roomId, title, start, end, note, host, attendees } = await request.json();

    // Room is OPTIONAL: an event may have no room (organiser will arrange one
    // with the university directly — noted in the note). Title/time still required.
    if (!title || !start || !end) {
      return NextResponse.json({ success: false, message: "Missing required fields" }, { status: 400 });
    }

    const isAdmin = session.user.isAdmin;
    // Only admins auto-approve; everyone else's request goes to pending.

    const startDate = new Date(start);
    const endDate = new Date(end);

    // Reject invalid / past time windows — can't book a room for a time that has
    // already passed.
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || endDate <= startDate) {
      return NextResponse.json(
        { success: false, message: "Khoảng thời gian không hợp lệ." },
        { status: 400 }
      );
    }
    // Admins may backfill past bookings; everyone else is blocked.
    if (!isAdmin && startDate.getTime() < Date.now()) {
      return NextResponse.json(
        { success: false, message: "Không thể đặt phòng cho thời gian trong quá khứ." },
        { status: 400 }
      );
    }

    // Giới hạn đặt phòng theo bộ môn: phòng có thể chỉ cho một số bộ môn đặt.
    // Admin bỏ qua; người thường phải thuộc bộ môn được phép. Rỗng = ai cũng đặt.
    if (roomId && !isAdmin) {
      const room = await Room.findById(roomId, "allowedDepartments title").lean();
      const allowed = (room?.allowedDepartments || []).filter(Boolean);
      if (allowed.length) {
        const me = await User.findOne({ email: session.user.email }, "department").lean();
        const myDept = normalizeDepartment(me?.department);
        const ok = myDept && allowed.map(normalizeDepartment).includes(myDept);
        if (!ok) {
          return NextResponse.json(
            {
              success: false,
              message: `Phòng "${room.title}" chỉ dành cho bộ môn: ${allowed.join(", ")}. Tài khoản của bạn không thuộc bộ môn được phép — vui lòng liên hệ quản trị.`,
            },
            { status: 403 }
          );
        }
      }
    }

    // Room-clash only matters when a room is actually chosen (no room → nothing
    // to double-book).
    const conflict = roomId
      ? await CalendarEvent.findOne({
          room: roomId,
          status: "approved",
          start: { $lt: endDate },
          end: { $gt: startDate },
        }).populate("room")
      : null;

    if (conflict) {
      return NextResponse.json(
        {
          success: false,
          message: "Time slot conflict with existing approved booking",
          conflict: {
            title: conflict.title,
            start: conflict.start,
            end: conflict.end,
          },
        },
        { status: 409 }
      );
    }

    const autoApprove = isAdmin;
    const newEvent = new CalendarEvent({
      title,
      type: "custom",
      status: autoApprove ? "approved" : "pending",
      start: startDate,
      end: endDate,
      room: roomId || undefined,
      teacher_email: [session.user.email],
      tags: note ? [note] : [],
      host: Array.isArray(host) && host.length ? host : [],
      attendees: Array.isArray(attendees) && attendees.length ? attendees : [],
    });

    await newEvent.save();

    // Notify the invited people (host + attendees) so the meeting/event shows on
    // their personal calendar and they get a heads-up. Exclude the creator.
    try {
      const invited = [
        ...(newEvent.host ?? []),
        ...(newEvent.attendees ?? []),
      ].filter((e) => e && e !== session.user.email);
      if (invited.length) {
        const room = roomId ? await Room.findById(roomId, "title").lean() : null;
        const where = room?.title || "(chưa gắn phòng)";
        const when = `${moment(startDate).format("DD/MM HH:mm")}–${moment(endDate).format("HH:mm")}`;
        await notify(invited, {
          type: "info",
          title: autoApprove ? "Bạn được mời tham dự" : "Bạn được mời tham dự (chờ duyệt)",
          message: `"${title}" tại ${where} — ${when}`,
          link: "/booking",
          event: newEvent._id,
        });
      }
    } catch (e) {
      console.error("notify(invite) failed:", e);
    }

    // Notify admins when a request needs approval (only admins approve bookings;
    // there is no room-manager role in use) → link to the admin approval page.
    if (!autoApprove) {
      try {
        const creator = session.user.email;
        const room = roomId ? await Room.findById(roomId, "title").lean() : null;
        const admins = await User.find({ isAdmin: true }, "email").lean();
        const adminRecips = admins.map((a) => a.email).filter((e) => e && e !== creator);
        const where = room?.title || "(chưa gắn phòng — xem ghi chú)";
        await notify(adminRecips, {
          type: "approval",
          title: "Yêu cầu sự kiện cần duyệt",
          message: `${creator} tạo sự kiện tại ${where} — ${moment(startDate).format("DD/MM HH:mm")}–${moment(endDate).format("HH:mm")}: "${title}"`,
          link: "/admin/room-booking",
          event: newEvent._id,
        });
      } catch (e) {
        console.error("notify(create) failed:", e);
      }
    }

    // If the event is already approved, push it to the participants' linked
    // Google Calendars right away (awaited, single-event → reliable; no-op for
    // anyone not connected). Events sync immediately, unlike class schedules.
    if (autoApprove) {
      try {
        await pushEventToGoogle(newEvent.toObject());
      } catch (e) {
        console.error("gcal push (create) failed:", e?.message);
      }
    }

    return NextResponse.json({ success: true, event: newEvent }, { status: 201 });
  } catch (err) {
    console.log(err);
    return NextResponse.json({ success: false, message: "Server error" }, { status: 500 });
  }
};
