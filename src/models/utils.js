import { z } from "zod";
export const courseSchema = z.object({
  title: z.string().nonempty("Title is required"),
  teacher_email: z.array(z.string().email("Invalid email address")).nonempty(),
  course_id: z.string().optional(),
  course_id_extend: z.string().nullable() // allow null
    .transform((val) => (val === null ? undefined : val)).optional(),
  class_id: z
    .array(z.string())
    .min(1, "class_id must have at least one element"),
  population: z.number().int("Population must be an integer"),
  start_date: z.string().optional(),//.nonempty("Start date is required"),
  credit: z
  .number()
  .refine((val) => /^\d+(\.\d)?$/.test(val.toString()), {
    message: "Credit must have at most 1 decimal place",
  }),
  duration: z.number().int("Duration must be an integer"),
  location: z.string().nonempty("Location is required"),
  isLock: z.boolean().optional(),
  note: z.string().optional(),
  term: z.string().nullable().optional(),
});

export const roomSchema = z.object({
  title: z.string().nonempty("Title is required"),
  limit: z.number().int("Limit must be an integer"),
  location: z.string().nonempty("Location is required"),
  category: z.array(z.string()).optional().default([]),
  // Bộ môn được phép đặt phòng này (rỗng = mọi bộ môn).
  allowedDepartments: z.array(z.string()).optional().default([]),
  note: z.string().optional(),
});
