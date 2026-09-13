"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import { fetcher } from "@/lib/ulti";
import LoadingWrapper from "../LoadingWrapper";
import { Calendar, momentLocalizer } from "react-big-calendar";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import moment from "moment";
import { Trash2Icon, LockIcon } from "lucide-react";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import "./custom-calendar.css";
import {
    Modal,
    ModalContent,
    ModalHeader,
    ModalBody,
    ModalFooter,
    Button,
    Chip,
} from "@heroui/react";
import { useI18n } from "@/i18n/I18nProvider";

// Start the week on Monday so Sunday is the LAST (right-most) column — matching
// the tiết grid, compact schedule and meeting planner. Other week math here uses
// startOf('isoWeek') explicitly, so it's unaffected by this locale tweak.
moment.updateLocale(moment.locale(), { week: { dow: 1 } });
const localizer = momentLocalizer(moment);
const DnDCalendar = withDragAndDrop(Calendar);

function DragConfirmModal({ isOpen, event, newStart, newEnd, onConfirm, onCancel, loading }) {
    const { t } = useI18n();
    return (
        <Modal isOpen={isOpen} onClose={onCancel} isDismissable={!loading}>
            <ModalContent>
                <ModalHeader>{t("dnd.title")}</ModalHeader>
                <ModalBody>
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <p className="text-sm font-semibold">{event?.title}</p>
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-default-500">{t("dnd.current")}:</span>
                                <Chip size="sm" variant="flat" color="default">
                                    {event?.start ? moment(event.start).format("DD/MM/YYYY HH:mm") : "—"}
                                </Chip>
                                <span className="text-default-400">→</span>
                                <Chip size="sm" variant="flat" color="primary">
                                    {newStart ? moment(newStart).format("DD/MM/YYYY HH:mm") : "—"}
                                </Chip>
                            </div>
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-default-500">{t("rb.colEnd")}:</span>
                                <Chip size="sm" variant="flat" color="default">
                                    {event?.end ? moment(event.end).format("DD/MM/YYYY HH:mm") : "—"}
                                </Chip>
                                <span className="text-default-400">→</span>
                                <Chip size="sm" variant="flat" color="primary">
                                    {newEnd ? moment(newEnd).format("DD/MM/YYYY HH:mm") : "—"}
                                </Chip>
                            </div>
                        </div>
                        <p className="text-sm text-warning-600 bg-warning-50 rounded-lg p-2">
                            {t("dnd.reapprove")}
                        </p>
                    </div>
                </ModalBody>
                <ModalFooter>
                    <Button variant="flat" onPress={onCancel} isDisabled={loading}>
                        {t("common.cancel")}
                    </Button>
                    <Button color="primary" onPress={onConfirm} isLoading={loading}>
                        {t("common.done")}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}

export default function CalendarByUser({_events=[],overlayEvents=[],isLoading,selectedID, onClickEvent, onDoubleClick, onEventUpdate, readOnly = false, onDelete, defaultView = "week", jumpTo, onEditDates}) {
    const { data: session } = useSession();
    const { t } = useI18n();
    const [date, setDate] = useState(new Date());
    const [view, setView] = useState(defaultView);

    // Trên màn hình hẹp (điện thoại), chế độ "Tuần" dồn 7 cột vào ~360px nên vỡ
    // layout, chữ không đọc được. Mặc định mở "Lịch biểu" (agenda) — danh sách sự
    // kiện theo ngày, đọc tốt trên mobile. Chỉ đặt MỘT lần lúc mở; sau đó người
    // dùng tự đổi lại tuỳ ý. (Đặt trong effect để tránh lệch hydration SSR.)
    const [viewInit, setViewInit] = useState(false);
    useEffect(() => {
        if (viewInit) return;
        setViewInit(true);
        if (typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches) {
            setView("agenda");
        }
    }, [viewInit]);

    // Auto-jump: when the parent asks (jumpTo is a timestamp), navigate the
    // calendar to that day. Keyed on the primitive so it fires once per change.
    useEffect(() => {
        if (jumpTo) setDate(new Date(jumpTo));
    }, [jumpTo]);

    // App-wide rule: prefer a user's NAME over their email whenever we know it.
    const isAdmin = !!session?.user?.isAdmin;
    const myEmail = session?.user?.email;
    const { data: _userList } = useSWR("/api/user/list", fetcher);
    const nameByEmail = useMemo(() => {
        const m = {};
        (_userList ?? []).forEach((u) => { if (u.email) m[u.email.toLowerCase()] = u.name; });
        return m;
    }, [_userList]);
    const nameOf = useCallback((addr) => nameByEmail[addr?.toLowerCase?.()] || addr, [nameByEmail]);
    const nameList = useCallback((arr) => (arr ?? []).map(nameOf).filter(Boolean).join(", "), [nameOf]);
    // Built-in info popup: cells are small and truncate the title, so a click
    // opens the full details (respecting the admin/owner visibility rule).
    const [info, setInfo] = useState(null);
    const [pendingDrop, setPendingDrop] = useState(null);
    const [dropLoading, setDropLoading] = useState(false);
    // Optimistic time overrides (id -> {start, end}) so a dragged event stays at
    // its new position even when the parent view doesn't refetch its data.
    const [timeOverrides, setTimeOverrides] = useState({});

    const onNavigate = useCallback((newDate) => setDate(newDate), []);
    const onView = useCallback((newView) => setView(newView), []);

    // Drop overrides whenever fresh data arrives from the parent (it already
    // reflects the saved change, so the local override is no longer needed).
    useEffect(() => { setTimeOverrides({}); }, [_events]);

    // Holidays / breaks — shown as all-day background context on the calendar.
    const { data: holidays } = useSWR("/api/calendar-events?type=holiday", fetcher);

    // _events are coming from CalendarEvent API. All occurrences are now returned.
    const events = useMemo(()=>{
        const base = (_events ?? []).map((e) => {
            if (e.start && e.end) {
                const ov = timeOverrides[e._id];
                const roomTitle = e.room?.title || (typeof e.room === "string" ? "" : "");
                const baseTitle = e.title || (e.course ? (typeof e.course === 'object' ? e.course.title : "Class") : "Event");
                return {
                    id: e._id,
                    title: roomTitle ? `${baseTitle} · ${roomTitle}` : baseTitle,
                    start: new Date(ov?.start ?? e.start),
                    end: new Date(ov?.end ?? e.end),
                    resource: e
                };
            }
            return null;
        }).filter(Boolean);

        const hol = (holidays ?? []).map((h) => ({
            id: `hol-${h._id}`,
            title: `🎉 ${h.title}`,
            // All-day range: react-big-calendar treats the end as exclusive, so
            // add a day to include the final holiday date.
            start: moment(h.start).startOf("day").toDate(),
            end: moment(h.end).add(1, "day").startOf("day").toDate(),
            allDay: true,
            resource: { ...h, isHoliday: true },
        }));

        // Read-only overlays (e.g. Offisoom duty shifts). Same shape as _events
        // but never editable — kept separate so they don't affect the parent's
        // ranges/compact view.
        const overlay = (overlayEvents ?? [])
            .filter((e) => e?.start && e?.end)
            .map((e) => ({
                id: e._id,
                title: e.title || "",
                start: new Date(e.start),
                end: new Date(e.end),
                resource: e,
            }))
            .filter((e) => !isNaN(e.start) && !isNaN(e.end));

        return [...hol, ...base, ...overlay];
    }, [_events, timeOverrides, holidays, overlayEvents]);

    const eventStyleGetter = useCallback((event) => {
        const type = event.resource?.type || 'class';
        const location = event.resource?.room?.location || event.resource?.location || 'NVC';

        let backgroundColor = '#3b82f6'; // Default Blue (Class NVC)

        if (type === 'class') {
            if (location === 'LT') backgroundColor = '#a855f7'; // Purple (Class LT)
        } else if (type === 'holiday') {
            backgroundColor = '#f59e0b'; // Amber
        } else if (type === 'exam') {
            backgroundColor = '#ef4444'; // Red
        } else if (type === 'personal') {
            backgroundColor = '#ec4899'; // Pink
        } else if (type === 'duty') {
            backgroundColor = '#6366f1'; // Indigo — Ca trực (read-only, from Offisoom)
        } else {
            backgroundColor = '#10b981'; // Emerald (Other/Custom)
        }

        if (selectedID && (event.resource?.course?._id?.toString() === selectedID.toString() || event.id?.toString() === selectedID.toString())) {
            backgroundColor = '#059669'; // Darker Emerald for selected
        }

        return {
            style: {
                backgroundColor,
                borderRadius: '6px',
                opacity: 0.85,
                color: 'white',
                border: 'none',
                display: 'block',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
            }
        };
    }, [selectedID]);

    const canDragResize = useCallback((event) => {
        if (readOnly) return false;
        if (event.resource?.isHoliday || event.resource?.type === 'holiday') return false;
        if (event.resource?.type === 'class' || event.resource?.type === 'duty') return false;
        if (session?.user?.isAdmin) return true;
        const email = session?.user?.email;
        if (!email) return false;
        return (
            (event.resource?.teacher_email ?? []).includes(email) ||
            (event.resource?.host ?? []).includes(email)
        );
    }, [readOnly, session]);

    const onEventDrop = useCallback(
        ({ event, start, end }) => {
            if (event.resource?.isHoliday || event.resource?.type === 'holiday') return;
            if (event.resource?.type === 'class' || event.resource?.type === 'duty') return;
            setPendingDrop({ event, start, end });
        },
        []
    );

    const handleConfirmDrop = useCallback(async () => {
        if (!pendingDrop) return;
        setDropLoading(true);
        try {
            const res = await fetch(`/api/room-event/${pendingDrop.event.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    // Date objects serialize to full ISO (UTC) — timezone-safe.
                    start: pendingDrop.start,
                    end: pendingDrop.end,
                }),
            });
            if (res.ok) {
                // Keep the event at its new time locally even if the parent
                // doesn't refetch, so it no longer snaps back to the old slot.
                setTimeOverrides((prev) => ({
                    ...prev,
                    [pendingDrop.event.id]: { start: pendingDrop.start, end: pendingDrop.end },
                }));
                if (onEventUpdate) onEventUpdate();
            }
        } catch (e) {
            console.error(e);
        } finally {
            setDropLoading(false);
            setPendingDrop(null);
        }
    }, [pendingDrop, onEventUpdate]);

    const handleCancelDrop = useCallback(() => {
        setPendingDrop(null);
    }, []);

    return (
        <LoadingWrapper isLoading={isLoading}>
            {/* overflow-x-auto + max-w-full: lưới lịch (chế độ Tuần/Ngày) rộng hơn
                màn hình hẹp sẽ CUỘN NGANG TRONG thẻ này, thay vì tràn ra ngoài làm
                cả trang cuộn ngang / lộ khoảng trống bên phải trên mobile. */}
            <div className="h-[760px] w-full max-w-full overflow-x-auto bg-white dark:bg-zinc-900 p-4 rounded-xl">
                <DnDCalendar
                    localizer={localizer}
                    messages={{
                        today: t("cal.today"), previous: t("cal.back"), next: t("cal.next"),
                        month: t("cal.month"), week: t("cal.week"), day: t("cal.day"), agenda: t("cal.agenda"),
                        date: t("cal.date"), time: t("cal.time"), event: t("cal.event"),
                        noEventsInRange: t("cal.noEventsRange"),
                    }}
                    events={events}
                    date={date}
                    view={view}
                    onNavigate={onNavigate}
                    onView={onView}
                    startAccessor="start"
                    endAccessor="end"
                    style={{ height: "100%" }}
                    eventPropGetter={eventStyleGetter}
                    components={{
                        event: (props) => {
                          const e = props.event.resource || {};
                          if (e.isHoliday || e.type === "holiday") {
                            return (
                              <div className="h-full w-full overflow-hidden leading-tight">
                                <div className="text-[11px] font-semibold truncate">{props.event.title}</div>
                              </div>
                            );
                          }
                          const courseTitle = e.course?.title || props.event.title;
                          const cls = Array.isArray(e.course?.class_id)
                            ? e.course.class_id.join(", ")
                            : (e.course?.class_id || "");
                          const room = e.room?.title || (typeof e.room === "string" ? "" : "");
                          const teachers = nameList(e.teacher_email);
                          return (
                            <div className="relative group h-full w-full overflow-hidden leading-tight">
                              {/* Course name — largest + bold (the primary info). */}
                              <div className="text-[12px] font-bold line-clamp-2">{courseTitle}</div>
                              {/* Class code (emphasised) · room (medium). */}
                              {(cls || room) && (
                                <div className="text-[10px] truncate mt-px">
                                  {cls && <span className="font-semibold">{cls}</span>}
                                  {cls && room && <span className="opacity-50"> · </span>}
                                  {room && <span className="font-medium opacity-90">{room}</span>}
                                </div>
                              )}
                              {/* Lecturer — smallest + lightest (secondary). */}
                              {teachers && <div className="text-[9px] font-light opacity-75 truncate">{teachers}</div>}
                              {!readOnly && onDelete && e.type !== "duty" && (
                                <button
                                  className="delete-btn absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 p-0.5 bg-white text-danger rounded-full hover:bg-danger hover:text-white transition-opacity z-50 shadow-sm flex items-center justify-center border border-danger/20"
                                  style={{ width: '18px', height: '18px' }}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    onDelete(props.event.resource);
                                  }}
                                  title="Delete this schedule"
                                >
                                  <Trash2Icon size={10} />
                                </button>
                              )}
                            </div>
                          );
                        }
                    }}
                    formats={{
                        eventTimeRangeFormat: ({ start, end }, culture, loc) =>
                            `${loc.format(start, "HH:mm", culture)}–${loc.format(end, "HH:mm", culture)}`,
                    }}
                    onSelectEvent={(e, ...rest) => {
                        if (e?.resource?.isHoliday) return;
                        // Ca trực: chỉ đọc, nhưng VẪN cho bấm để xem chi tiết —
                        // luôn dùng popup read-only sẵn có (bỏ qua onClickEvent vốn
                        // để mở form sửa của môn học).
                        if (e?.resource?.type === 'duty') { setInfo(e.resource || e); return; }
                        if (onClickEvent) { onClickEvent(e, ...rest); return; }
                        setInfo(e.resource || e); // read-only view → built-in popup
                    }}
                    onDoubleClickEvent={(e, ...rest) => { if (e?.resource?.isHoliday || e?.resource?.type === 'duty') return; onDoubleClick?.(e, ...rest); }}
                    onEventDrop={!readOnly ? onEventDrop : undefined}
                    onEventResize={!readOnly ? onEventDrop : undefined}
                    resizable={!readOnly}
                    draggableAccessor={canDragResize}
                    resizableAccessor={canDragResize}
                    views={['month', 'week', 'day', 'agenda']}
                    min={new Date(0, 0, 0, 7, 0, 0)} // Start at 7 AM
                    max={new Date(0, 0, 0, 20, 0, 0)} // End at 8 PM
                    scrollToTime={new Date(0, 0, 0, 7, 0, 0)} // pin view to 7 AM so 6–8 PM stays visible (no auto-scroll to now)
                />
            </div>
            <DragConfirmModal
                isOpen={!!pendingDrop}
                event={pendingDrop?.event?.resource}
                newStart={pendingDrop?.start}
                newEnd={pendingDrop?.end}
                onConfirm={handleConfirmDrop}
                onCancel={handleCancelDrop}
                loading={dropLoading}
            />

            {/* Built-in event info popup (read-only views). Respects the
                admin/owner visibility rule and prefers names over emails. */}
            <Modal isOpen={!!info} onOpenChange={(o) => !o && setInfo(null)} size="md">
                <ModalContent>
                    {(onClose) => {
                        const canSee =
                            isAdmin ||
                            (info?.teacher_email ?? []).includes(myEmail) ||
                            (info?.host ?? []).includes(myEmail);
                        const when = info?.start
                            ? `${moment(info.start).format("DD/MM/YYYY HH:mm")} – ${moment(info.end).format("HH:mm")}`
                            : "";
                        const roomTitle = info?.room?.title || (typeof info?.room === "string" ? "" : "");
                        return (
                            <>
                                <ModalHeader className="flex flex-col gap-1.5 pb-2">
                                    <span className="text-base font-semibold">
                                        {info?.title || info?.course?.title || t("event.details")}
                                    </span>
                                    {info?.status && (
                                        <Chip size="sm" variant="flat" className="w-fit capitalize"
                                            color={info.status === "approved" ? "success" : info.status === "rejected" ? "danger" : "warning"}>
                                            {info.status}
                                        </Chip>
                                    )}
                                    {info?.type === "duty" && (
                                        <Chip size="sm" variant="flat" color="secondary" className="w-fit">Ca trực</Chip>
                                    )}
                                </ModalHeader>
                                {/* Ca trực đến từ Offisoom — chỉ có giờ; hiện công khai (là ca của
                                    chính người dùng), không áp giới hạn canSee, không nút sửa. */}
                                <ModalBody className="text-sm">
                                    {info?.type === "duty" ? (
                                        <div className="flex flex-col gap-1.5">
                                            {when && <p><span className="text-default-500">{t("event.time")}:</span> {when}</p>}
                                            <p className="mt-1 italic text-default-400">
                                                Ca trực (đồng bộ từ Offisoom) — chỉ xem, quản lý tại trang phân công trực.
                                            </p>
                                        </div>
                                    ) : (
                                    <div className="flex flex-col gap-1.5">
                                        {(() => {
                                            const cls = Array.isArray(info?.course?.class_id)
                                                ? info.course.class_id.filter(Boolean).join(", ")
                                                : (info?.course?.class_id || "");
                                            return cls ? <p><span className="text-default-500">{t("event.class")}:</span> {cls}</p> : null;
                                        })()}
                                        {roomTitle && <p><span className="text-default-500">{t("event.room")}:</span> {roomTitle}</p>}
                                        {when && <p><span className="text-default-500">{t("event.time")}:</span> {when}</p>}
                                        {canSee ? (
                                            <>
                                                {(info?.teacher_email ?? []).length > 0 && (
                                                    <p><span className="text-default-500">{t("event.teacher")}:</span> {nameList(info.teacher_email)}</p>
                                                )}
                                                {(info?.host ?? []).length > 0 && (
                                                    <p><span className="text-default-500">{t("event.host")}:</span> {nameList(info.host)}</p>
                                                )}
                                                {(info?.attendees ?? []).length > 0 && (
                                                    <p><span className="text-default-500">{t("event.attendees")}:</span> {nameList(info.attendees)}</p>
                                                )}
                                                {(info?.course?.note || (info?.tags ?? []).length > 0) && (
                                                    <p><span className="text-default-500">{t("event.note")}:</span> {info?.course?.note || info.tags.join(", ")}</p>
                                                )}
                                                {(info?.course?.warnings ?? []).length > 0 && (
                                                    <p className="text-warning-600"><span className="text-default-500">⚠</span> {info.course.warnings.join("; ")}</p>
                                                )}
                                            </>
                                        ) : (
                                            <p className="text-default-400 italic mt-1">{t("event.restricted")}</p>
                                        )}
                                    </div>
                                    )}
                                </ModalBody>
                                <ModalFooter>
                                    <Button variant="flat" onPress={onClose}>{t("common.close")}</Button>
                                    {onEditDates && canSee && info?.course && info?.type !== "custom" && info?.time_slot?.start_time != null && (
                                        info.course.isLock ? (
                                            // Locked course → schedule is frozen; show the action
                                            // disabled with a lock so it's clear WHY it's unavailable.
                                            <Button
                                                color="default"
                                                variant="flat"
                                                isDisabled
                                                startContent={<LockIcon size={16} />}
                                                title={t("booking.lockedFrozen")}
                                            >
                                                {t("sched.editDates")}
                                            </Button>
                                        ) : (
                                            <Button color="secondary" variant="flat" onPress={() => { onClose(); onEditDates(info); }}>
                                                {t("sched.editDates")}
                                            </Button>
                                        )
                                    )}
                                </ModalFooter>
                            </>
                        );
                    }}
                </ModalContent>
            </Modal>
        </LoadingWrapper>
    );
}
