import NextAuth from "next-auth";
import User from "@/models/user";
// import GitHub from "next-auth/providers/github"
import GoogleProvider from "next-auth/providers/google";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import { authConfig } from "./auth.config";
import CredentialsProvider from "next-auth/providers/credentials";
import { connectToDb } from "@/lib/mongodb";
import bcrypt from "bcryptjs";
import AzureADProvider from "next-auth/providers/azure-ad";
const env = process.env;

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    async session({ session, token }) {
      session.token = token;
      if (token) {
        session.isAdmin = token.isAdmin;
        session.teacher_id = token.teacher_id;
        session.user = token.user;
        session.user.isAdmin = token.isAdmin;
        session.user.isSuperAdmin = token.isSuperAdmin;
        session.user.adminScope = token.adminScope || [];
        session.user.teacher_id = token.teacher_id;
        session.user.department = token.department || "";
        // Định danh bất biến của user, để app ngoài (Offisoom, ACADsoom) khoá hồ
        // sơ vào đây thay vì vào email — email đổi thì hồ sơ vẫn là một.
        if (token.uid) session.user.id = token.uid;
        session.error = token.error;
        session.accessToken = token.accessToken;
      }
      return session;
    },
    async jwt({ token, user, account }) {
      if (account && user) {
        token.accessToken = account.accessToken;
        token.accessTokenExpires = Date.now() + account.expires_in * 1000;
      }
      if (user) {
        token.user = user;
        token.isAdmin = user.isAdmin;
        token.isSuperAdmin = !!user.isSuperAdmin;
        token.adminScope = Array.isArray(user.adminScope) ? user.adminScope.map((s) => String(s)) : [];
        token.teacher_id = user.teacher_id;
      }

      // Always refresh role/scope from the DB so role changes (grant super,
      // set a scope, backfills) take effect on the next request WITHOUT a
      // re-login — and old tokens issued before these fields existed get them
      // populated. Best-effort; never break auth on a DB hiccup.
      if (token?.user?.email) {
        try {
          await connectToDb();
          const dbUser = await User.findOne(
            { email: token.user.email },
            "isAdmin isSuperAdmin adminScope teacher_id department"
          ).lean();
          if (dbUser) {
            token.uid = String(dbUser._id);
            if (token.user) token.user.id = token.uid;
            token.isAdmin = !!dbUser.isAdmin;
            token.isSuperAdmin = !!dbUser.isSuperAdmin;
            token.adminScope = Array.isArray(dbUser.adminScope) ? dbUser.adminScope.map((s) => String(s)) : [];
            token.teacher_id = dbUser.teacher_id;
            token.department = dbUser.department || "";
            token.user.isAdmin = token.isAdmin;
            token.user.isSuperAdmin = token.isSuperAdmin;
            token.user.adminScope = token.adminScope;
            token.user.teacher_id = token.teacher_id;
            token.user.department = token.department;
          }
        } catch (e) {
          console.error("jwt role refresh failed", e);
        }
      }
      // if (token.user&&token.user.email) {
      //   const isAdmin = user.isAdmin;
      //   token.isAdmin = isAdmin;
      // }
      // if (Date.now() < token.accessTokenExpires - 100000 || 0) {
      //   return token;
      // }
      // return refreshAccessToken(token);
      if (Date.now() < token.accessTokenExpires) {
        return token;
      }
      // Refresh the token
      try {
        const refreshedToken = await refreshAccessToken(token);
        return {
          ...token,
          accessToken: refreshedToken.accessToken,
          accessTokenExpires: Date.now() + refreshedToken.expires_in * 1000,
        };
      } catch (error) {
        console.error("Error refreshing access token", error);
        return {
          ...token,
          error: "RefreshAccessTokenError",
        };
      }
    },
    async signIn({ user, account, profile }) {
      if (account.provider === "google") {
        await connectToDb();
        const existingUser = await User.findOne({ email: user.email });

        // KHÓA ĐĂNG NHẬP theo danh sách cho phép.
        //
        // "Danh sách" = collection User (được đổ đầy từ web Khoa qua nút Đồng bộ,
        // hoặc do super-admin thêm tay). Vì NextAuth ở đây KHÔNG có adapter và
        // KHÔNG tự tạo user khi đăng nhập, chặn ngay tại đây cũng chặn luôn việc
        // tự tạo tài khoản — không cần xử lý riêng.
        //
        // Bật/tắt bằng cờ ENFORCE_ALLOWLIST (mặc định TẮT). Quy trình an toàn:
        // deploy khi TẮT → bấm "Đồng bộ từ web Khoa" → kiểm tra tài khoản admin
        // hiện tại nằm trong danh sách → rồi mới đặt ENFORCE_ALLOWLIST=true.
        if (process.env.ENFORCE_ALLOWLIST === "true" && !existingUser) {
          return false; // NextAuth chặn phiên (trang AccessDenied)
        }

        const isAdmin = existingUser && existingUser.isAdmin;
        const teacher_id = existingUser && existingUser.teacher_id;
        user.isAdmin = isAdmin;
        user.isSuperAdmin = !!existingUser?.isSuperAdmin;
        // Plain array of strings — a Mongoose document array can't be structured-
        // cloned by the JWT encoder (DataCloneError).
        user.adminScope = Array.isArray(existingUser?.adminScope)
          ? existingUser.adminScope.map((s) => String(s))
          : [];
        user.teacher_id = teacher_id;
      }
      return true;
    },
    async redirect({ url, baseUrl }) {
      // Redirect logic after sign-in
      return url.startsWith(baseUrl) ? url : baseUrl;
    },
    ...authConfig.callbacks,
  },
});

async function refreshAccessToken(token) {
  // Implement your logic to refresh the token
  return {
    accessToken: "newAccessToken",
    expires_in: 86400,
  };
}
