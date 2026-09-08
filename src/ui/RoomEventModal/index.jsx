"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Chip,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { UsersIcon } from "lucide-react";
import { fetcher } from "@/lib/ulti";
import { DEPARTMENTS, normalizeDepartment } from "@/lib/departments";
import moment from "moment";
import { useSession } from "next-auth/react";
import { useI18n } from "@/i18n/I18nProvider";

// ─── QuickAddByDept ──────────────────────────────────────────────────────────
// Thêm nhanh toàn bộ email của một bộ môn (hoặc tất cả) vào danh sách đã chọn —
// tiện khi mời cả bộ môn dự sự kiện, khỏi gõ từng người.
function QuickAddByDept({ users, selectedEmails, onAdd }) {
  const groups = useMemo(() => {
    const m = new Map();
    (users ?? []).forEach((u) => {
      if (!u.email) return;
      const dept = normalizeDepartment(u.department) || "Khác";
      if (!m.has(dept)) m.set(dept, []);
      m.get(dept).push(u.email);
    });
    return m;
  }, [users]);

  const items = useMemo(() => {
    const order = DEPARTMENTS.map((d) => d.name);
    const keys = [...groups.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    const all = (users ?? []).map((u) => u.email).filter(Boolean);
    return [
      { key: "__all", label: `Tất cả (${all.length})`, emails: all },
      ...keys.map((d) => ({ key: d, label: `${d} (${groups.get(d).length})`, emails: groups.get(d) })),
    ];
  }, [groups, users]);

  const add = (emails) => {
    const set = new Set(selectedEmails);
    emails.forEach((e) => set.add(e));
    onAdd([...set]);
  };

  if (items.length <= 1) return null; // chưa có ai/không có bộ môn → ẩn

  return (
    <Dropdown>
      <DropdownTrigger>
        <Button size="sm" variant="flat" color="secondary" startContent={<UsersIcon size={14} />}>
          Thêm nhanh theo bộ môn
        </Button>
      </DropdownTrigger>
      <DropdownMenu
        aria-label="Thêm theo bộ môn"
        onAction={(key) => {
          const it = items.find((i) => i.key === key);
          if (it) add(it.emails);
        }}
      >
        {items.map((it) => (
          <DropdownItem key={it.key} startContent={it.key === "__all" ? <UsersIcon size={15} /> : null}>
            {it.label}
          </DropdownItem>
        ))}
      </DropdownMenu>
    </Dropdown>
  );
}

// ─── UserPicker ────────────────────────────────────────────────────────────────
export function UserPicker({ label, users, selectedEmails, onChange, multiple = true }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [dropdownStyle, setDropdownStyle] = useState({});
  const inputRef = useRef(null);

  const available = useMemo(
    () =>
      (users ?? []).filter(
        (u) =>
          !selectedEmails.includes(u.email) &&
          (u.name?.toLowerCase().includes(query.toLowerCase()) ||
            u.email.toLowerCase().includes(query.toLowerCase()))
      ),
    [users, selectedEmails, query]
  );

  const openDropdown = () => {
    const el = inputRef.current?.querySelector("input");
    if (el) {
      const rect = el.getBoundingClientRect();
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 9999,
      });
    }
    setOpen(true);
  };

  const select = (user) => {
    onChange(multiple ? [...selectedEmails, user.email] : [user.email]);
    setQuery("");
    setOpen(false);
  };

  const remove = (email) => onChange(selectedEmails.filter((e) => e !== email));

  const displayLabel = (email) => {
    const u = (users ?? []).find((u) => u.email === email);
    return u?.name ? `${u.name} (${email})` : email;
  };

  return (
    <div className="flex flex-col gap-1">
      <div ref={inputRef}>
        <Input
          label={label}
          placeholder={t("re.searchNameEmail")}
          value={query}
          onValueChange={(v) => { setQuery(v); openDropdown(); }}
          onFocus={openDropdown}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          size="sm"
        />
      </div>
      {open && available.length > 0 && (
        <div
          style={dropdownStyle}
          className="bg-content1 border border-default-200 rounded-xl shadow-lg max-h-44 overflow-y-auto"
        >
          {available.map((u) => (
            <button
              key={u.email}
              className="w-full text-left px-3 py-2 text-sm hover:bg-default-100 transition-colors"
              onMouseDown={(e) => { e.preventDefault(); select(u); }}
            >
              <span className="font-medium">{u.name || u.email}</span>
              {u.name && <span className="text-default-400 ml-2 text-xs">{u.email}</span>}
            </button>
          ))}
        </div>
      )}
      {selectedEmails.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {selectedEmails.map((email) => (
            <Chip key={email} onClose={() => remove(email)} size="sm" variant="flat">
              {displayLabel(email)}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RoomEventModal ────────────────────────────────────────────────────────────
/**
 * Shared create/edit modal for room events.
 *
 * Props:
 *   isOpen / onOpenChange  — HeroUI disclosure
 *   event                  — existing CalendarEvent object (edit mode) or null (create mode)
 *   rooms                  — array of room objects to select from
 *   isPrivileged           — true if admin/manager (auto-approve, no re-approval warning)
 *   createdBy              — email shown in "Created by" field (create mode only)
 *   onSuccess              — called after successful create/edit
 *   initialStart / initialEnd / initialRoomId — pre-fill for create mode (e.g. from slot click)
 */
export function RoomEventModal({
  isOpen,
  onOpenChange,
  event = null,
  rooms,
  isPrivileged = false,
  createdBy = "",
  onSuccess,
  initialStart,
  initialEnd,
  initialRoomId,
  initialAttendees,
  initialHost,
}) {
  const { t } = useI18n();
  const isEdit = !!event;
  const { data: users } = useSWR("/api/user/list", fetcher);
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAdmin;
  // Earliest selectable time = now (admins may pick past for backfill). Set on
  // the client when the modal opens to avoid an SSR/CSR hydration mismatch.
  const [minDT, setMinDT] = useState("");
  useEffect(() => {
    if (isOpen) setMinDT(moment().format("YYYY-MM-DDTHH:mm"));
  }, [isOpen]);
  const timeMin = isAdmin ? undefined : minDT || undefined;

  const [form, setForm] = useState({ roomId: "", title: "", start: "", end: "", duration: "", note: "" });
  const [roomInput, setRoomInput] = useState("");
  const [host, setHost] = useState([]);
  const [attendees, setAttendees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Track original time/room to know if re-approval will be triggered
  const origRef = useRef({ roomId: "", start: "", end: "" });

  // Giới hạn theo bộ môn: ẩn phòng mà người dùng không được phép đặt (admin thấy
  // hết; phòng không giới hạn thì ai cũng thấy). Server vẫn chặn lần cuối.
  const myDept = normalizeDepartment(session?.user?.department);
  const canBookRoom = (r) => {
    const allowed = (r.allowedDepartments || []).filter(Boolean);
    if (isAdmin || !allowed.length) return true;
    return !!myDept && allowed.map(normalizeDepartment).includes(myDept);
  };
  const filteredRooms = useMemo(
    () =>
      (rooms ?? []).filter(
        (r) => canBookRoom(r) && r.title?.toLowerCase().includes(roomInput.toLowerCase())
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, roomInput, isAdmin, myDept]
  );

  const formatDuration = (mins) => {
    const m = parseInt(mins);
    if (!m || m <= 0) return "";
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return [h && `${h}h`, rem && `${rem}m`].filter(Boolean).join(" ");
  };

  const handleStartChange = (v) => {
    setForm((f) => {
      if (f.duration && v) {
        const newEnd = moment(v).add(parseInt(f.duration), "minutes").format("YYYY-MM-DDTHH:mm");
        return { ...f, start: v, end: newEnd };
      }
      if (f.end && v) {
        const mins = moment(f.end).diff(moment(v), "minutes");
        return { ...f, start: v, duration: mins > 0 ? String(mins) : "" };
      }
      return { ...f, start: v };
    });
  };

  const handleEndChange = (v) => {
    setForm((f) => {
      if (f.start && v) {
        const mins = moment(v).diff(moment(f.start), "minutes");
        return { ...f, end: v, duration: mins > 0 ? String(mins) : "" };
      }
      return { ...f, end: v };
    });
  };

  const handleDurationChange = (v) => {
    const mins = parseInt(v);
    setForm((f) => {
      if (f.start && !isNaN(mins) && mins > 0) {
        const newEnd = moment(f.start).add(mins, "minutes").format("YYYY-MM-DDTHH:mm");
        return { ...f, duration: v, end: newEnd };
      }
      return { ...f, duration: v };
    });
  };

  // Reset form when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setError("");
    if (isEdit) {
      const initStart = moment(event.start).format("YYYY-MM-DDTHH:mm");
      const initEnd = moment(event.end).format("YYYY-MM-DDTHH:mm");
      const initDuration = String(moment(event.end).diff(moment(event.start), "minutes"));
      const roomId = String(event.room?._id ?? event.room ?? "");
      const matchedRoom = (rooms ?? []).find((r) => String(r._id) === roomId);
      setForm({ roomId, title: event.title || "", start: initStart, end: initEnd, duration: initDuration, note: (event.tags ?? [])[0] || "" });
      setRoomInput(matchedRoom?.title || "");
      setHost(event.host ?? []);
      setAttendees(event.attendees ?? []);
      origRef.current = { roomId, start: initStart, end: initEnd };
    } else {
      const preRoom = (rooms ?? []).find((r) => String(r._id) === String(initialRoomId));
      const initStart = initialStart ? moment(initialStart).format("YYYY-MM-DDTHH:mm") : "";
      const initEnd = initialEnd ? moment(initialEnd).format("YYYY-MM-DDTHH:mm") : "";
      const initDuration = initStart && initEnd ? String(moment(initEnd).diff(moment(initStart), "minutes")) : "";
      setForm({ roomId: initialRoomId || "", title: "", start: initStart, end: initEnd, duration: initDuration, note: "" });
      setRoomInput(preRoom?.title || "");
      // Pre-fill host / attendees (e.g. the meeting planner passes the selected
      // department's members so booking a group meeting adds them automatically).
      setHost(Array.isArray(initialHost) ? [...new Set(initialHost.filter(Boolean))] : []);
      setAttendees(Array.isArray(initialAttendees) ? [...new Set(initialAttendees.filter(Boolean))] : []);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the current values would trigger re-approval
  const timeOrRoomChanged =
    isEdit &&
    (form.roomId !== origRef.current.roomId ||
      form.start !== origRef.current.start ||
      form.end !== origRef.current.end);

  const handleSubmit = async (onClose) => {
    setError("");
    if (!form.title || !form.start || !form.end) {
      setError("Vui lòng nhập tiêu đề và thời gian.");
      return;
    }
    if (new Date(form.end) <= new Date(form.start)) {
      setError(t("re.invalidRange") || "Giờ kết thúc phải sau giờ bắt đầu.");
      return;
    }
    if (!isAdmin && new Date(form.start).getTime() < Date.now()) {
      setError(t("re.noPast") || "Không thể đặt phòng cho thời gian trong quá khứ.");
      return;
    }
    setLoading(true);
    try {
      const url = isEdit ? `/api/room-event/${event._id}` : "/api/room-event";
      const method = isEdit ? "PUT" : "POST";
      // Normalize the naive datetime-local strings to full ISO on the client,
      // where the user's timezone is known. Otherwise `new Date(str)` on the
      // server parses them in the SERVER timezone (UTC in production), which
      // shifts every booking by the local offset.
      const startISO = form.start ? new Date(form.start).toISOString() : form.start;
      const endISO = form.end ? new Date(form.end).toISOString() : form.end;
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: form.roomId, title: form.title, start: startISO, end: endISO, note: form.note, host, attendees }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          setError(`Conflict with "${data.conflict?.title}" (${moment(data.conflict?.start).format("HH:mm")}–${moment(data.conflict?.end).format("HH:mm")})`);
        } else {
          setError(data.message || (isEdit ? "Failed to update booking." : "Failed to create booking."));
        }
      } else {
        // Pass the saved event back so the parent can update its calendar
        // immediately instead of waiting on a background revalidation.
        onSuccess?.(data.event);
        onClose();
      }
    } catch {
      setError("Server error.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} scrollBehavior="inside">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>{isEdit ? `${t("re.editPrefix")} — ${event?.title || t("re.booking")}` : t("re.addBooking")}</ModalHeader>
            <ModalBody>
              {error && <p className="text-danger text-sm bg-danger-50 rounded-lg px-3 py-2">{error}</p>}

              {/* Re-approval warning (edit mode, non-privileged only) */}
              {isEdit && !isPrivileged && (
                <div className="text-sm bg-warning-50 text-warning-700 rounded-lg px-3 py-2 flex flex-col gap-0.5">
                  <span className="font-medium">{t("re.reapprovalTitle")}</span>
                  <span>{t("re.reapprovalBody")}</span>
                  {timeOrRoomChanged && (
                    <span className="mt-1 text-warning-800 font-semibold">{t("re.timeRoomChanged")}</span>
                  )}
                </div>
              )}

              {/* Room autocomplete */}
              <Autocomplete
                label={t("rb.colRoom")}
                description="Có thể để trống nếu chưa gắn phòng — tự liên hệ trường & ghi vào Ghi chú."
                items={filteredRooms}
                inputValue={roomInput}
                onInputChange={(v) => { setRoomInput(v); if (!v) setForm((f) => ({ ...f, roomId: "" })); }}
                selectedKey={form.roomId || null}
                onSelectionChange={(key) => {
                  setForm((f) => ({ ...f, roomId: key || "" }));
                  const found = (rooms ?? []).find((r) => String(r._id) === key);
                  setRoomInput(found?.title || "");
                }}
              >
                {(r) => (
                  <AutocompleteItem key={String(r._id)} textValue={r.title}>
                    {r.title}{r.isBookable ? "" : t("re.notPublic")}
                  </AutocompleteItem>
                )}
              </Autocomplete>

              <Input label={t("re.title")} isRequired value={form.title} onValueChange={(v) => setForm((f) => ({ ...f, title: v }))} />
              <Input label={t("re.start")} type="datetime-local" isRequired min={timeMin} value={form.start} onValueChange={handleStartChange} />
              <Input
                label={t("re.durationMin")}
                type="number"
                min={1}
                value={form.duration}
                onValueChange={handleDurationChange}
                description={formatDuration(form.duration) || undefined}
                placeholder={t("re.durationEg")}
              />
              <Input label={t("re.end")} type="datetime-local" isRequired min={form.start || timeMin} value={form.end} onValueChange={handleEndChange} />
              <UserPicker label={t("re.hostBy")} users={users} selectedEmails={host} onChange={setHost} multiple />
              <div className="flex flex-col gap-1">
                <div className="flex justify-end">
                  <QuickAddByDept users={users} selectedEmails={attendees} onAdd={setAttendees} />
                </div>
                <UserPicker label={t("re.members")} users={users} selectedEmails={attendees} onChange={setAttendees} multiple />
              </div>
              <Input label={t("event.note")} placeholder="VD: Sẽ liên hệ trường mượn hội trường B — sẽ cập nhật phòng sau." description="Ghi chú được đồng bộ luôn vào Google Calendar." value={form.note} onValueChange={(v) => setForm((f) => ({ ...f, note: v }))} />

              {/* Created by (create mode only) */}
              {!isEdit && createdBy && (
                <Input label={t("rb.createdBy")} value={createdBy} isReadOnly classNames={{ input: "text-default-400" }} />
              )}

              {/* Approval note for create mode when not privileged */}
              {!isEdit && !isPrivileged && (
                <p className="text-xs text-warning-600 bg-warning-50 rounded-lg p-2">
                  {t("re.willReview")}
                </p>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>{t("common.cancel")}</Button>
              <Button color="primary" isLoading={loading} onPress={() => handleSubmit(onClose)}>
                {isEdit ? t("common.save") : t("re.create")}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
