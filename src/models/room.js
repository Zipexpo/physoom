import mongoose, { Schema } from "mongoose";
import { locationList, categoryList } from "@/models/ulti";

const roomSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      unique: true,
    },
    limit: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isInteger,
        message: "{VALUE} is not an integer value",
      },
    },
    location: {
      type: String,
      enum: locationList.short,
      required: true,
    },
    category: [
      {
        type: String,
        enum: categoryList.short,
        required: true,
      },
    ],
    isBookable: { type: Boolean, default: false },
    // Giới hạn đặt phòng theo bộ môn: danh sách tên bộ môn (chuẩn hoá) được phép
    // đặt phòng này. RỖNG = mọi bộ môn đều đặt được (mặc định, như cũ). Admin luôn
    // bỏ qua giới hạn này.
    allowedDepartments: { type: [String], default: [] },
    note: String,
  },
  { timestamps: true }
);

export default mongoose.models?.Room || mongoose.model("Room", roomSchema);
