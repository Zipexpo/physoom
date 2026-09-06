// Google Calendar integration: link a user's Google account (OAuth) and push
// their Physoom schedule (approved classes + event bookings) into a dedicated
// "Physoom" calendar. One-way sync (Physoom → Google) with full reconciliation:
// changes/cancellations on Physoom are reflected in Google.
import { google } from "googleapis";
import moment from "moment";
import CalendarEvent from "@/models/calendarEvent";
import User from "@/models/user";
import "@/models/course";
import "@/models/room";
import { connectToDb } from "@/lib/mongodb";
import { fetchUserDuties, dutiesConfigured } from "@/lib/duties";

const CLIENT_ID = process.env.NEXT_GOOGLE_ID;
const CLIENT_SECRET = process.env.NEXT_GOOGLE_SECRET;
// Least-privilege scope: Physoom can create AND manage events on ONLY the
// secondary calendars IT creates (the dedicated "Physoom" calendar). It cannot
// see, edit, or delete any of the user's other calendars — so the consent screen
// no longer shows the alarming "manage all your calendars" wording.
const SCOPES = ["https://www.googleapis.com/auth/calendar.app.created"];
const CAL_NAME = "Physoom";
const TAG = "physoom"; // extendedProperties.private.physoomSource

export function isGoogleConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

function baseUrl() {
  return (process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

function oauthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, `${baseUrl()}/api/google/callback`);
}

// Calendar client authorised as a specific user (by refresh token).
function calFor(refreshToken) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth: client });
}

// Only sync a bounded window: recent-past through the future. Past events beyond
// this are frozen (never touched) — bounds volume + avoids re-churning history.
const WINDOW_PAST_DAYS = 7;
function windowStart() {
  return new Date(Date.now() - WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000);
}

// Participants of an event who might have a linked calendar.
function eventParticipants(ev) {
  return [
    ...new Set([...(ev.teacher_email || []), ...(ev.host || []), ...(ev.attendees || [])].filter(Boolean)),
  ];
}

/** Consent URL — offline + consent so we always get a refresh token.
 * NOT incremental: we deliberately omit include_granted_scopes so Google asks
 * ONLY for our minimal calendar.app.created scope and never silently re-attaches
 * broader calendar scopes a user may have granted in the past. */
export function googleAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

/** Exchange the OAuth code, store the refresh token + ensure a Physoom calendar. */
export async function connectGoogle(code, email) {
  await connectToDb();
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) throw new Error("No refresh token returned (revoke access and retry with prompt=consent).");
  client.setCredentials(tokens);

  // Reuse a previously created Physoom calendar (if still there) so reconnecting
  // never spawns a duplicate.
  const existing = await User.findOne({ email }, "google").lean();
  const calendarId = await ensureCalendar(client, existing?.google?.calendarId);
  await User.updateOne(
    { email },
    { $set: { "google.refreshToken": refreshToken, "google.calendarId": calendarId, "google.connectedAt": new Date() } }
  );
  return { calendarId };
}

export async function disconnectGoogle(email) {
  await connectToDb();
  await User.updateOne({ email }, { $unset: { google: "" } });
}

/** Find (or create) the dedicated "Physoom" secondary calendar, and make sure
 * it's shown in the user's calendar list so its events appear automatically —
 * the user never has to hunt for it and tick it on. */
async function ensureCalendar(authClient, existingId) {
  const cal = google.calendar({ version: "v3", auth: authClient });
  let calendarId;

  // 1) Reuse the previously created calendar if it still exists.
  if (existingId) {
    try {
      await cal.calendars.get({ calendarId: existingId });
      calendarId = existingId;
    } catch {
      // gone (user deleted it) — fall through to find/create
    }
  }

  // 2) Otherwise look for an existing "Physoom" calendar we own.
  if (!calendarId) {
    try {
      const list = await cal.calendarList.list({ maxResults: 250 });
      const found = (list.data.items || []).find((c) => c.summary === CAL_NAME && c.accessRole === "owner");
      if (found) calendarId = found.id;
    } catch (e) {
      console.error("calendarList.list failed:", e?.message);
    }
  }

  // 3) Create it if we still don't have one.
  if (!calendarId) {
    const created = await cal.calendars.insert({
      requestBody: { summary: CAL_NAME, description: "Lịch giảng dạy & sự kiện đồng bộ từ Physoom", timeZone: "Asia/Ho_Chi_Minh" },
    });
    calendarId = created.data.id;
  }

  // Force it visible + selected in the user's calendar list so events overlay on
  // their grid right after connecting — no manual "tick the Physoom calendar".
  try {
    await cal.calendarList.patch({
      calendarId,
      requestBody: { selected: true, hidden: false },
    });
  } catch (e) {
    console.error("calendarList visibility patch failed:", e?.message);
  }

  return calendarId;
}

/** Build a Google event body from a Physoom CalendarEvent (or a duty pseudo-event). */
function toGoogleEvent(ev) {
  // Ca trực (đồng bộ từ Offisoom) — không có course/room, chỉ giờ + nhãn.
  if (ev.__duty) {
    return {
      summary: ev.title || "Ca trực",
      description: "Ca trực (đồng bộ từ Offisoom).",
      location: ev.location || "",
      start: { dateTime: new Date(ev.start).toISOString(), timeZone: "Asia/Ho_Chi_Minh" },
      end: { dateTime: new Date(ev.end).toISOString(), timeZone: "Asia/Ho_Chi_Minh" },
      extendedProperties: { private: { physoomSource: TAG, physoomId: String(ev._id) } },
    };
  }
  const cls = Array.isArray(ev.course?.class_id) ? ev.course.class_id.filter(Boolean).join(", ") : ev.course?.class_id || "";
  const name = ev.course?.title || ev.title || "Sự kiện";
  const room = ev.room?.title || "";
  // Room-event note lives in tags[]; it must ride along to Google (esp. for
  // no-room events where the note says how the room will be arranged).
  const note = Array.isArray(ev.tags) ? ev.tags.filter(Boolean).join("; ") : "";
  const summary = [name, cls, room].filter(Boolean).join(" · ");
  const desc = [
    ev.course?.title ? `Môn: ${ev.course.title}` : null,
    cls ? `Lớp: ${cls}` : null,
    room ? `Phòng: ${room}` : null,
    (ev.teacher_email || []).length ? `Giảng viên: ${(ev.teacher_email || []).join(", ")}` : null,
    note ? `Ghi chú: ${note}` : null,
  ].filter(Boolean).join("\n");
  return {
    summary,
    description: desc,
    location: room,
    start: { dateTime: new Date(ev.start).toISOString(), timeZone: "Asia/Ho_Chi_Minh" },
    end: { dateTime: new Date(ev.end).toISOString(), timeZone: "Asia/Ho_Chi_Minh" },
    extendedProperties: { private: { physoomSource: TAG, physoomId: String(ev._id) } },
  };
}

/**
 * All approved events that belong to a user — the same set their personal
 * calendar shows (classes they teach + meetings/events they host or are invited
 * to), minus holidays/terms. A single $or on teacher/host/attendees matches how
 * the personal calendar fetches, so no event type is accidentally dropped.
 */
async function userEvents(email) {
  return CalendarEvent.find({
    type: { $nin: ["holiday", "term"] },
    isCancelled: { $ne: true },
    status: { $ne: "rejected" }, // rejected never syncs
    end: { $gte: windowStart() }, // only recent-past → future; freeze older history
    $and: [
      { $or: [{ teacher_email: email }, { host: email }, { attendees: email }] },
      // Lịch DẠY (class) LUÔN đồng bộ — đó là lịch giảng thật, kể cả khi bản ghi
      // chưa ở trạng thái "approved" (một số lớp import/đặt lại nằm ở pending mà
      // vẫn hiện trên lịch cá nhân → phải lên Google). Còn sự kiện/họp/đặt phòng
      // thì CHỈ đồng bộ khi ĐÃ DUYỆT, để yêu cầu chưa duyệt không đẩy lên Google.
      { $or: [{ type: "class" }, { status: "approved" }] },
    ],
  })
    .sort({ _id: 1 }) // stable order so paginated syncing (offset/limit) is consistent
    .populate("course room")
    .lean();
}

/**
 * Reconcile a user's Physoom schedule into their Physoom Google calendar:
 * insert new, patch changed, delete removed. Returns counts.
 */
export async function syncUserToGoogle(email, { offset = 0, limit = Infinity, dutiesOnly = false } = {}) {
  if (!isGoogleConfigured()) return { skipped: "not-configured" };
  await connectToDb();
  const user = await User.findOne({ email }, "google").lean();
  const refreshToken = user?.google?.refreshToken;
  // Không có refresh token thì thực sự chưa kết nối — người dùng phải bấm "Kết nối
  // Google" (không tự lấy lại token được).
  if (!refreshToken) return { skipped: "not-connected", detail: "no-refresh-token" };

  const authClient = oauthClient();
  authClient.setCredentials({ refresh_token: refreshToken });

  // Có token nhưng THIẾU calendarId (kết nối cũ, hoặc lịch "Physoom" đã bị xoá):
  // TỰ TẠO LẠI lịch rồi lưu, thay vì báo "chưa kết nối" khó hiểu (trước đây nút
  // vẫn hiện "Đã kết nối" vì status chỉ xét refreshToken → sync 400 vô cớ).
  let calendarId = user?.google?.calendarId;
  if (!calendarId) {
    try {
      calendarId = await ensureCalendar(authClient, null);
      await User.updateOne({ email }, { $set: { "google.calendarId": calendarId } });
    } catch (e) {
      console.error("ensureCalendar (recover) failed:", e?.message);
      return { skipped: "not-connected", detail: `ensureCalendar: ${e?.message || "?"}` };
    }
  }

  const cal = calFor(refreshToken);

  // Liệt kê sự kiện Physoom đã có trên Google (map physoomId → thông tin) để biết
  // cái nào chèn/cập nhật/bỏ qua. Tách hàm để có thể chạy lại sau khi tạo lại lịch.
  const listExisting = async () => {
    const map = new Map();
    let pageToken;
    do {
      const res = await cal.events.list({
        calendarId,
        privateExtendedProperty: [`physoomSource=${TAG}`],
        showDeleted: false,
        maxResults: 2500,
        pageToken,
      });
      (res.data.items || []).forEach((it) => {
        const pid = it.extendedProperties?.private?.physoomId;
        // Lưu các trường ta đồng bộ để BỎ QUA patch nếu không đổi (lấy free từ
        // list, giúp không dồn quota Google/phút khi đồng bộ lại).
        if (pid)
          map.set(pid, {
            gid: it.id,
            summary: it.summary || "",
            location: it.location || "",
            description: it.description || "",
            start: it.start?.dateTime || it.start?.date || "",
            end: it.end?.dateTime || it.end?.date || "",
          });
      });
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return map;
  };

  let existing;
  try {
    existing = await listExisting();
  } catch (e) {
    // Lịch "Physoom" đã lưu KHÔNG truy cập được — thường vì calendarId cũ được tạo
    // dưới scope KHÁC, nay scope calendar.app.created chỉ thấy lịch do CHÍNH app
    // này tạo. Tạo/tìm lại lịch app-created rồi thử lại. Chỉ xử lý lỗi "không thấy/
    // không được phép"; lỗi token (invalid_grant) hay tạm thời để catch ngoài lo.
    const code = e?.code || e?.response?.status;
    const reason = e?.errors?.[0]?.reason || "";
    const calInaccessible =
      code === 404 || code === 403 || /notFound|forbidden|insufficient/i.test(reason);
    if (!calInaccessible) throw e;
    console.error("stored calendar inaccessible, recreating:", e?.message);
    const newId = await ensureCalendar(authClient, null); // ném nếu token hỏng thật
    if (newId && newId !== calendarId) {
      calendarId = newId;
      await User.updateOne({ email }, { $set: { "google.calendarId": newId } });
    }
    existing = await listExisting();
  }

  // dutiesOnly: chỉ đồng bộ ca trực (dùng cho webhook Offisoom báo đổi ca) — bỏ
  // qua lớp học để nhẹ và nhanh.
  const physEvs = dutiesOnly ? [] : await userEvents(email);

  // Ca trực (Offisoom) cũng đưa lên Google. Chúng KHÔNG phải CalendarEvent nên
  // tạo "pseudo-event" với id ổn định (duty:<giờ bắt đầu>:<cơ sở>) để cùng luồng
  // chèn/cập nhật/xoá & bỏ-qua-nếu-không-đổi như mọi sự kiện khác. Best-effort:
  // Offisoom lỗi → [] → không ảnh hưởng phần còn lại.
  const cutoffW = windowStart();
  const manageDuties = dutiesConfigured();
  let dutyPseudos = [];
  if (manageDuties) try {
    const duties = await fetchUserDuties(email);
    dutyPseudos = duties
      .map((d) => ({
        _id: `duty:${new Date(d.start).toISOString()}:${d.location || ""}`,
        __duty: true,
        title: d.title,
        location: d.location,
        note: d.note,
        start: new Date(d.start),
        end: new Date(d.end),
      }))
      .filter((d) => d.end >= cutoffW)
      .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  } catch (e) {
    console.error("duty fetch for gcal failed:", e?.message);
  }

  // physEvs đã sort theo _id; nối duties (đã sort) sau → thứ tự tổng ổn định để
  // phân trang (offset/limit) nhất quán giữa các lô.
  const evs = [...physEvs, ...dutyPseudos];
  const seen = new Set(evs.map((ev) => String(ev._id)));
  const counts = { inserted: 0, updated: 0, deleted: 0 };
  const failed = []; // { id, title, error } — surfaced so a partial sync isn't silent

  // DIAGNOSTIC (chỉ tính ở lô đầu): những buổi ĐANG HIỆN trên lịch cá nhân của
  // người dùng nhưng KHÔNG đủ điều kiện đồng bộ, kèm lý do. Đây là cách trả lời
  // dứt điểm câu "vẫn thiếu lớp": nếu lớp thiếu nằm ở đây → do trạng thái/huỷ;
  // nếu KHÔNG nằm ở đây và cũng không trên Google → lớp đó không gắn với email
  // này (vấn đề dữ liệu, không phải đồng bộ).
  let unsynced;
  if (offset === 0 && !dutiesOnly) {
    const cutoff2 = windowStart();
    const onCalendar = await CalendarEvent.find(
      {
        type: { $nin: ["holiday", "term"] },
        $or: [{ teacher_email: email }, { host: email }, { attendees: email }],
      },
      "title status isCancelled end course"
    )
      .populate("course", "title")
      .lean();
    const eligibleIds = new Set(evs.map((e) => String(e._id)));
    const byTitle = new Map();
    for (const ev of onCalendar) {
      if (eligibleIds.has(String(ev._id))) continue; // đã đủ điều kiện, sẽ đồng bộ
      if (new Date(ev.end) < cutoff2) continue; // đã qua (đóng băng theo thiết kế)
      const reason = ev.isCancelled
        ? "đã huỷ"
        : ev.status !== "approved"
        ? `chưa duyệt (${ev.status})`
        : "khác";
      const title = ev.course?.title || ev.title || "(không tên)";
      if (!byTitle.has(title)) byTitle.set(title, reason); // gộp theo môn, khỏi lặp từng buổi
    }
    unsynced = [...byTitle].slice(0, 12).map(([title, reason]) => ({ title, reason }));
  }

  // Paginated sync: the client processes the schedule in bounded batches
  // (offset/limit) so a full term never exceeds the serverless time limit in one
  // request, and can show a progress bar. `limit = Infinity` = sync everything in
  // one call (used by the post-connect initial sync).
  const total = evs.length;
  const batch = Number.isFinite(limit) ? evs.slice(offset, offset + limit) : evs;
  const processed = Number.isFinite(limit) ? Math.min(offset + batch.length, total) : total;
  const done = processed >= total;

  // Retry a TRANSIENT Google error (rate-limit / 5xx) with EXPONENTIAL BACKOFF.
  // Google Calendar caps "queries per minute per user", so a burst of inserts/
  // patches gets 403/429 rateLimitExceeded. One quick retry isn't enough (the
  // quota is per-minute); we back off 1s→2s→4s→8s and honour Retry-After.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTransient = (e) => {
    const code = e?.code || e?.response?.status;
    const reason = e?.errors?.[0]?.reason || "";
    return code === 403 || code === 429 || (code >= 500 && code < 600) ||
      reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
  };
  const withRetry = async (fn) => {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (e) {
        if (!isTransient(e) || attempt >= 4) throw e;
        const retryAfter = Number(e?.response?.headers?.["retry-after"]) || 0;
        const wait = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
        attempt++;
        await sleep(wait);
      }
    }
  };

  // Run Google API calls with LOW concurrency. High concurrency bursts past
  // Google's "queries per minute per user" quota (→ 403/429). 3 in flight keeps
  // throughput steady without tripping the limit; withRetry handles the rest.
  const runPool = async (items, worker, limit = 3) => {
    let i = 0;
    const next = async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await worker(item);
        } catch (e) {
          console.error("gcal op failed:", e?.message);
          failed.push({
            id: String(item?._id || ""),
            title: item?.course?.title || item?.title || "",
            error: e?.errors?.[0]?.message || e?.message || "unknown",
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  };

  // Split by insert vs patch and do INSERTS FIRST. On a large first sync that may
  // exceed the serverless time budget, this guarantees MISSING events get created
  // before any time is spent re-patching events that already exist — so coverage
  // converges over repeated syncs instead of stalling. (Previously inserts and
  // patches were interleaved, so a timeout could leave most events uncreated.)
  const toInsert = batch.filter((ev) => !existing.has(String(ev._id)));

  // Patch ONLY events that actually changed. Comparing the fields we sync against
  // what Google already has (captured free from the list above) means a steady-
  // state re-sync makes ZERO patch calls — which is what stops the per-minute
  // quota errors. `counts.skipped` = unchanged events left as-is.
  // Compare start/end as INSTANTS, not strings: Google returns them with a
  // +07:00 offset while toGoogleEvent emits UTC "…Z" — same moment, different
  // text. A string compare would mark every event "changed" and defeat the skip.
  const sameTime = (a, b) => {
    const ta = a ? new Date(a).getTime() : NaN;
    const tb = b ? new Date(b).getTime() : NaN;
    return ta === tb;
  };
  const changed = (ev) => {
    const hit = existing.get(String(ev._id));
    const body = toGoogleEvent(ev);
    return (
      (hit.summary || "") !== (body.summary || "") ||
      (hit.location || "") !== (body.location || "") ||
      (hit.description || "") !== (body.description || "") ||
      !sameTime(hit.start, body.start?.dateTime) ||
      !sameTime(hit.end, body.end?.dateTime)
    );
  };
  const toPatch = batch.filter((ev) => existing.has(String(ev._id)) && changed(ev));
  // "unchanged" — KHÔNG đặt tên `skipped`: route dùng `result.skipped` làm CỜ CHUỖI
  // ("not-connected"/"not-configured"); một con số > 0 ở đây sẽ bị hiểu nhầm là cờ
  // → trả 400 "chưa kết nối" oan. (Đây chính là bug đã gặp.)
  counts.unchanged = batch.length - toInsert.length - toPatch.length;

  await runPool(toInsert, async (ev) => {
    await withRetry(() => cal.events.insert({ calendarId, requestBody: toGoogleEvent(ev) }));
    counts.inserted++;
  });
  await runPool(toPatch, async (ev) => {
    const hit = existing.get(String(ev._id));
    await withRetry(() =>
      cal.events.patch({ calendarId, eventId: hit.gid, requestBody: toGoogleEvent(ev) })
    );
    counts.updated++;
  });

  // Delete Google events no longer in Physoom — but only inside the active
  // window (past events beyond the window are frozen, never deleted). Guard:
  // if Physoom returned nothing yet Google has many tagged events, treat it as
  // a suspicious/empty query and skip deletes entirely (avoids mass-wipe).
  // Deletes run ONLY on the final chunk (done) — otherwise an early batch would
  // delete every event the later batches haven't inserted yet. `seen` is the full
  // schedule (not just this batch), so the final delete pass is correct.
  const cutoff = windowStart();
  // dutiesOnly: chỉ xét trên tập ca trực (đừng để "0 lớp" bị coi là đáng ngờ và
  // đừng đụng vào lớp học). Full sync: như cũ.
  const dutyKeys = () => [...existing.keys()].filter((k) => String(k).startsWith("duty:"));
  const suspicious = dutiesOnly
    ? dutyPseudos.length === 0 && dutyKeys().length >= 3
    : evs.length === 0 && existing.size >= 3;
  if (done && !suspicious) {
    const stale = [...existing].filter(
      ([pid, info]) =>
        !seen.has(pid) &&
        (!info.start || new Date(info.start) >= cutoff) &&
        // dutiesOnly: CHỈ xoá ca trực (không đụng lớp học).
        (!dutiesOnly || String(pid).startsWith("duty:")) &&
        // KHÔNG xoá ca trực khi tích hợp Offisoom TẮT/không kéo được (fetch [] →
        // seen thiếu duty → xoá nhầm). Chỉ dọn duty khi đang quản lý duty.
        (manageDuties || !String(pid).startsWith("duty:"))
    );
    await runPool(stale, async ([, info]) => {
      await cal.events.delete({ calendarId, eventId: info.gid });
      counts.deleted++;
    });
  }

  return {
    ...counts,
    total,
    processed,
    done,
    failedCount: failed.length,
    failed: failed.slice(0, 10), // sample for the UI; full list is in server logs
    ...(unsynced ? { unsynced } : {}),
    ...(suspicious ? { guarded: true } : {}),
  };
}

/**
 * Push ONE event into every connected participant's Physoom calendar
 * (insert or patch). Cheap + awaited → reliable on serverless without any
 * post-response hook. Used for meetings/events, which sync immediately.
 * If the event isn't syncable anymore (rejected/cancelled), it's removed.
 */
export async function pushEventToGoogle(eventOrId) {
  if (!isGoogleConfigured()) return;
  await connectToDb();
  // Always load a fully-populated copy by id — the caller's object may have room/
  // course as bare ObjectIds (e.g. a freshly-created doc), which would drop the
  // room name (and course info) from the Google event. Also gives fresh status.
  const ev = await CalendarEvent.findById(eventOrId?._id || eventOrId)
    .populate("course room")
    .lean();
  if (!ev) return;
  const pid = String(ev._id);
  const emails = eventParticipants(ev);
  const syncable = ev.status === "approved" && !ev.isCancelled && !["holiday", "term"].includes(ev.type);
  if (!syncable) return removeEventFromGoogle(pid, emails);

  const users = await User.find(
    { email: { $in: emails }, "google.refreshToken": { $exists: true } },
    "email google"
  ).lean();
  const body = toGoogleEvent(ev);
  await Promise.all(
    users.map(async (u) => {
      try {
        const cal = calFor(u.google.refreshToken);
        const cid = u.google.calendarId;
        const found = await cal.events.list({
          calendarId: cid,
          privateExtendedProperty: [`physoomId=${pid}`],
          maxResults: 1,
        });
        const gid = found.data.items?.[0]?.id;
        if (gid) await cal.events.patch({ calendarId: cid, eventId: gid, requestBody: body });
        else await cal.events.insert({ calendarId: cid, requestBody: body });
      } catch (e) {
        console.error("pushEvent failed for", u.email, e?.message);
      }
    })
  );
}

/** Remove ONE event (by Physoom id) from the given participants' calendars. */
export async function removeEventFromGoogle(physoomId, emails) {
  if (!isGoogleConfigured() || !physoomId) return;
  await connectToDb();
  const pid = String(physoomId);
  const list = [...new Set((emails || []).filter(Boolean))];
  if (!list.length) return;
  const users = await User.find(
    { email: { $in: list }, "google.refreshToken": { $exists: true } },
    "email google"
  ).lean();
  await Promise.all(
    users.map(async (u) => {
      try {
        const cal = calFor(u.google.refreshToken);
        const cid = u.google.calendarId;
        const found = await cal.events.list({
          calendarId: cid,
          privateExtendedProperty: [`physoomId=${pid}`],
          maxResults: 5,
        });
        for (const it of found.data.items || []) {
          await cal.events.delete({ calendarId: cid, eventId: it.id });
        }
      } catch (e) {
        console.error("removeEvent failed for", u.email, e?.message);
      }
    })
  );
}
